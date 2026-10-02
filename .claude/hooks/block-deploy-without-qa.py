#!/usr/bin/env python3
"""PreToolUse(Bash) — refuse un deploiement Convex vers la production tant que
la QA n'a pas ete passee recemment (temoin /tmp/.qa-passed).

VERSION 3.0.0 — Day 131 (2026-07-11) — MIGRE SUR LE PREDICAT PARTAGE

INCIDENT QUI JUSTIFIE CE HOOK (hook-doctrine, critere 1)
--------------------------------------------------------
Day 35 : Tau a deploye en production sans QA. Le hook est ne de la.

INCIDENT QUI JUSTIFIE LA v2 (critere 2 : faux positifs + bypass)
----------------------------------------------------------------
Day 127/128 : `npx convex deploy --yes # convex dev` -> rc=0 (BYPASS) et
`grep -rn "convex deploy --prod" CLAUDE.md` -> rc=2 (faux positif). La v1
decidait sur le TEXTE de la commande. La v2 a introduit un tokenizer qui decide
sur l'ACTION REELLEMENT EXECUTEE.

INCIDENT QUI JUSTIFIE LA v3 (critere 2, encore : la DUPLICATION)
-----------------------------------------------------------------
Day 131, 8e tour adverse. Sigma mesure 12 bypasses REELS (`watch npx convex
deploy`, `strace ...`, `proxychains ...`, `systemd-run ...`, `parallel ...`,
`runuser -u ci -- ...`, `su -c '...'`, `at now <<< '...'`) — IDENTIQUES sur ce
hook ET sur `enforce-pi-authorization-before-prod-deploy.py`. Cause : les deux
hooks portaient DEUX COPIES de la meme logique, donc DEUX COPIES des memes
trous. Une faille trouvee d'un cote ne protegeait jamais l'autre.

Ce hook ne porte donc PLUS de copie inline de TRANSPARENT / INTERPRETER_RE /
strip_transparent / split_commands / strip_comments. Il CONSOMME
`_lib/command_predicate.py`, comme son jumeau. Le point du module partage n'est
pas la reutilisation de code : c'est que le CORPUS DE BYPASS devient PARTAGE —
une faille fermee une fois protege les DEUX consommateurs. C'est la seule sortie
de la course aux tours.

Ce qui reste PROPRE a ce hook (sa politique, pas sa tokenisation) : le marqueur
`# allow-no-qa:`, la sentinelle /tmp/.qa-passed et sa fraicheur, et la
declaration LOUD de ses angles morts.

LE PREDICAT (fourni par _lib ; v3 : FAIL-CLOSED SUR L'INCONNU)
---------------------------------------------------------------
  1. Commentaires retires (quote-aware), continuations de ligne ecrasees.
  2. Decoupage quote-aware en commandes reelles (; && || | () `` $()).
  3. Prefixes transparents retires (sudo, env, VAR=val, npx, exec, watch,
     timeout, flock... + npm/pnpm/yarn/bun/deno run|exec|dlx|x).
  4. Recursion dans les interpretes (bash -c, eval, env -S, script -c,
     watch "...", ssh host "...", npx -c "...").
  5. TETE == `convex` et sous-commande == `deploy` -> DEPLOY (sauf SAFE_FLAGS).
  6. NOUVEAU v3 : tete NI deploy NI LECTEUR connu (SAFE_HEADS) portant
     `convex deploy` en tokens ADJACENTS -> DEPLOY (wrapper non reconnu).
     On cesse d'enumerer les wrappers (ensemble OUVERT) ; on enumere les
     LECTEURS (ensemble FERME). `grep "convex deploy" f` passe toujours : la
     phrase y est UN SEUL token cite, pas deux tokens adjacents.

FAIL-OPEN OBLIGATOIRE sur exception inattendue -> exit 0. Un hook fleet ne
casse jamais une session (hook-doctrine).

OVERRIDE PROPRE (critere 3) :
    # allow-no-qa: <raison >= 6 caracteres>
Reserve au hotfix client-impacting documente. Usage unique, puis on corrige la
cause (la QA manquante doit devenir explicite dans le cycle suivant).

VERSION 4.0.0 — the second pole: dev-activation before prod
--------------------------------------------------------------
Before this version a commit could reach production having run NOWHERE: the
QA breadcrumb only proves *some* QA ran recently, never that THIS commit was
ever deployed to and read back from a development deployment. This version
adds that second, independent pole. A production deploy is now refused
unless BOTH hold:

  1. the QA breadcrumb is fresh (unchanged from v3), AND
  2. a proof file `/tmp/.convex-dev-activation-<git HEAD sha>.json` exists,
     names the exact current commit, carries a non-empty development
     deployment identity and a non-empty SEPARATE read-back against it, and
     is not older than `DEV_ACTIVATION_MAX_AGE_SECONDS`.

Each pole fails LOUD and NAMES which one failed -- collapsing both into one
undifferentiated "BLOCKED" message is exactly the defect this version closes.
Every failure mode on the proof file (absent, unreadable, malformed JSON,
missing key, wrong commit, empty field, expired) is a NAMED reason, never a
silent pass: fail-closed on the unknown, per hook-doctrine and
measurement-integrity.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import command_predicate as cp  # noqa: E402
from _lib.command_predicate import (  # noqa: E402
    carries_action_signature,
    has_safe_flag,
    head_matches,
    iter_real_commands,
)

VERSION = "4.1.0"

BREADCRUMB = "/tmp/.qa-passed"
MAX_AGE_SECONDS = 3600  # 1 heure

DEV_ACTIVATION_PATH_TEMPLATE = "/tmp/.convex-dev-activation-{sha}.json"
DEV_ACTIVATION_MAX_AGE_SECONDS = 24 * 3600  # 24 hours

# A `read_back` that merely echoes the deploy command's own success line
# (e.g. "Deployed Convex functions to ...", a checkmark-prefixed line) is not
# a SEPARATE read against the deployment -- it is the same command talking
# about itself. Anchored at the start of the trimmed string only, so a real
# read-back mentioning the word deep in a sentence (e.g. "0 rows undeployed")
# is not falsely rejected.
DEPLOY_OWN_EXIT_LINE_RE = re.compile(r"^\s*(?:[✔✓]|deployed\b)", re.IGNORECASE)

OVERRIDE_RE = re.compile(r"#\s*allow-no-qa:\s*(\S.{5,})", re.IGNORECASE)

# Indirection shell non resoluble statiquement : `FOO=convex; npx $FOO deploy`,
# `alias cvx='npx convex deploy'`. On ne BLOQUE pas (faux positifs massifs sur
# `echo $HOME`), mais on ne se TAIT pas : on DECLARE l'angle mort.
INDIRECTION_RE = re.compile(r"\$\{?\w+|\balias\s+\w+\s*=")


def _warn_if_uninspectable(piece: str) -> None:
    """LOUD fail-open sur l'indirection shell. Un tokenizer STATIQUE ne peut pas
    resoudre `$FOO` ni un alias : la valeur n'existe qu'a l'EXECUTION, dans un
    shell qu'on n'a pas.

    On ne BLOQUE pas (bloquer tout segment portant un `$VAR` ferait des faux
    positifs massifs, et un faux garde est pire qu'un trou). On ne se TAIT pas
    non plus : la regle qui a produit tous les bypasses de ce hook est
    precisement PASSER EN SILENCE ce qu'on n'a pas su inspecter.

    Le declencheur est `convex` OU `deploy` -- pas les deux : le cas canonique
    `FOO=convex; npx $FOO deploy` repartit les deux mots sur deux segments
    distincts, et le mot cache par l'indirection est justement celui qu'on
    cherche -- on ne peut pas exiger de le voir."""
    low = piece.lower()
    if ("convex" in low or "deploy" in low) and INDIRECTION_RE.search(piece):
        print(
            "block-deploy-without-qa: ANGLE MORT — le segment contient une "
            "indirection shell ($VAR / alias) NON RESOLUBLE statiquement, et "
            f"mentionne 'convex' : {piece!r}\n"
            "  Ce hook decide sur les TOKENS ; il ne peut pas savoir ce que "
            "l'indirection vaudra a l'execution.\n"
            "  Il LAISSE PASSER (aucun blocage sur presomption), mais le "
            "signale : si c'est un deploy prod, la QA n'a PAS ete verifiee.\n"
            "  Ecrivez la commande en clair pour que le garde puisse faire "
            "son travail.",
            file=sys.stderr,
        )


def _warn_unknown_wrapper_flags(piece: str) -> None:
    """ANGLE MORT n.2 : un flag INCONNU sur un wrapper CONNU.

    Supposer qu'un flag inconnu consomme le token suivant ferait manger `convex`
    LUI-MEME par `npx --un-nouveau-flag convex deploy` : on echangerait "la
    valeur devient la tete" contre "la CIBLE est avalee", strictement pire.
    Aucun defaut n'est sur parce que LE PROBLEME EST QU'ON NE SAIT PAS. Donc pas
    de blocage (generateur de faux positifs), pas de silence (generateur de
    bypass) : une DECLARATION.

    Le collecteur est rempli par _lib._skip_wrapper_flags() et remis a zero par
    _lib.iter_real_commands() a chaque segment."""
    if not cp.UNKNOWN_FLAGS:
        return
    low = piece.lower()
    if "convex" not in low and "deploy" not in low:
        return
    for wrapper, flag in cp.UNKNOWN_FLAGS:
        print(
            f"block-deploy-without-qa: ANGLE MORT — flag INCONNU '{flag}' sur le "
            f"wrapper '{wrapper}', dans un segment mentionnant convex/deploy : "
            f"{piece!r}\n"
            "  Ce hook ne sait pas si ce flag consomme le token suivant. Les deux "
            "hypotheses sont dangereuses (la valeur devient la tete, ou la cible "
            "est avalee), donc il n'en fait AUCUNE.\n"
            "  Il LAISSE PASSER, mais le declare : si c'est un deploy prod, la QA "
            "n'a PAS ete verifiee.\n"
            f"  Corrigez la cause : declarez '{flag}' dans VALUE_FLAGS ou "
            "KNOWN_BOOLEAN_FLAGS.",
            file=sys.stderr,
        )


# A deploy is NOT production only when the command itself names a development
# deploy key: a variable one of whose `_`-separated name segments is exactly
# `DEV` (and none is `PROD`), or a literal value starting `dev:`. Anything else
# -- no key named, an unrecognised shape, a prod name -- stays production
# (fail-closed). Without this carve-out a dev deploy, the very act that
# produces the dev-activation proof, could never be run.
#
# The key is read ONLY from the deploy segment itself: an inline prefix
# (`KEY=v <cmd>`) or `env KEY=v <cmd>`. Nothing is carried across segments --
# not `export`, not a bare assignment -- because what the deploy process
# receives is decided by the shell (unset, subshell scope, `env -u`), not by
# the text of earlier segments, and every form the parser misses would fail
# open. A development push still goes through `convex dev --once`.
DEPLOY_KEY_ASSIGN_RE = re.compile(r"^CONVEX_DEPLOY_KEY=(.*)$", re.DOTALL)
ASSIGN_WORD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
VAR_REF_RE = re.compile(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$")


def _own_key(piece: str):
    """Value of CONVEX_DEPLOY_KEY set on THIS segment as an inline prefix (or
    after a leading `env`), or None. None for `export`, a bare assignment, and
    any segment where `env` is given an unset flag. Quotes are removed by
    shlex, `$VAR` stays literal."""
    try:
        words = shlex.split(piece)
    except ValueError:
        return None
    i = 0
    if i < len(words) and words[i] == "env":
        i += 1
    value = None
    while i < len(words) and ASSIGN_WORD_RE.match(words[i]):
        m = DEPLOY_KEY_ASSIGN_RE.match(words[i])
        if m:
            value = m.group(1)
        i += 1
    if value is None or i >= len(words):
        return None  # no key, or a bare assignment with no command after it
    if any(w.startswith("-u") or w.startswith("--unset") for w in words[i:]):
        return None
    return value


def _is_dev_key(value) -> bool:
    if value is None:
        return False
    if value.startswith("dev:"):
        return True
    m = VAR_REF_RE.match(value)
    if not m:
        return False
    parts = m.group(1).split("_")
    return "DEV" in parts and "PROD" not in parts


def _resolve_dir(arg: str):
    """`(absolute dir, None)` a `cd <arg>` lands in, or `(None, reason)` when
    the shell would resolve it by something this guard cannot see."""
    if arg == "-" or "$" in arg or "`" in arg:
        return None, f"`cd {arg}` cannot be resolved statically"
    path = os.path.expanduser(arg)
    if not os.path.isabs(path):
        path = os.path.join(os.getcwd(), path)
    return os.path.normpath(path), None


def _segment_is_deploy(tokens) -> bool:
    """TETE == `convex` (basename + version-suffix normalises), sous-commande ==
    `deploy`, sans flag inoffensif. `convex dev` n'est pas un deploy."""
    if not head_matches(tokens, "convex"):
        return False
    rest = tokens[1:]
    if not rest or rest[0] != "deploy":
        return False
    if has_safe_flag(rest):
        return False  # --dry-run / --preview / --help : inoffensif
    return True


def is_prod_deploy(cmd: str) -> bool:
    return find_prod_deploy(cmd) is not None


def find_prod_deploy(cmd: str):
    """None unless the command really runs a production Convex deploy; then
    `(cd_arg, None)`: the argument of the last `cd` preceding the deploy in the
    command (None = no cd, the hook's own cwd applies).

    Reellement execute, au sens des tokens (pas du texte) :

    Toute la tokenisation (commentaires, continuations de ligne, decoupage
    quote-aware, prefixes transparents, recursion interpretes) vient de _lib :
    ce hook n'en garde AUCUNE copie."""
    cd_arg = None
    for piece, tokens in iter_real_commands(cmd):
        _warn_if_uninspectable(piece)

        if tokens is None:
            # Segment NON TOKENISABLE (guillemet non ferme...). Le decoupeur
            # etant quote-aware, un ValueError ici est RARE, donc reellement
            # suspect. On n'ESCALADE en BLOCK que si le texte BRUT porte de
            # facon plausible un deploy (`convex` ET `deploy`) ; sinon fail-open
            # LOUD. Ce pre-filtre par sous-chaine est acceptable ICI -- et
            # seulement ici -- parce qu'il ne peut QUE remonter vers une
            # decision visible par un humain : il n'autorise rien.
            # An environment-variable NAME is not a command. `CONVEX_DEPLOY_KEY`
            # carries both words this prefilter looks for, and it names the
            # credential that a READ also needs -- so an untokenisable segment
            # that merely EXPORTS it was escalated to BLOCK and refused
            # `npx convex data`, a read. Measured 2026-09-30, on a production
            # read of a single table.
            # SCREAMING_SNAKE identifiers are erased before the substring test,
            # never the lowercase `convex deploy` that an actual invocation
            # carries: `CONVEX_DEPLOY_KEY=x npx convex deploy --yes` still
            # escalates, because the invocation survives the erasure.
            low = re.sub(r"\b[A-Z][A-Z0-9_]*[A-Z0-9]\b", " ", piece).lower()
            if "convex" in low and "deploy" in low:
                print(
                    "block-deploy-without-qa: segment NON TOKENISABLE contenant "
                    f"'convex'+'deploy' -- traite comme deploy potentiel: {piece!r}",
                    file=sys.stderr,
                )
                return (cd_arg, None)
            print(
                "block-deploy-without-qa: segment non tokenisable, AUCUNE trace de "
                f"deploy Convex -- laisse passer (fail-open explicite): {piece!r}",
                file=sys.stderr,
            )
            continue

        _warn_unknown_wrapper_flags(piece)

        dev_key = _is_dev_key(_own_key(piece))

        if not tokens:
            continue

        if tokens[0] == "cd" and len(tokens) > 1:
            cd_arg = tokens[1]

        if _segment_is_deploy(tokens):
            if dev_key:
                continue
            return (cd_arg, None)

        # FAIL-CLOSED SUR L'INCONNU (v3). La tete n'est ni un deploy ni un
        # LECTEUR declare, et l'argv porte quand meme `convex deploy` en deux
        # tokens ADJACENTS : c'est un wrapper que personne n'a pense a ecrire
        # dans TRANSPARENT (`strace`, `proxychains`, `systemd-run`, `parallel`,
        # `runuser`, `su`, `at`...) qui execute un VRAI deploy.
        if carries_action_signature(tokens, "convex", "deploy"):
            print(
                "block-deploy-without-qa: WRAPPER NON RECONNU portant un "
                f"`convex deploy` -- tete `{tokens[0]}` inconnue: {piece!r}\n"
                "  Ce garde n'enumere plus les wrappers (ensemble OUVERT : 7 tours "
                "perdus a ca) ; il enumere les LECTEURS (ensemble FERME). Une tete "
                "inconnue qui porte l'action est BLOQUEE par defaut.\n"
                "  Si cette tete est un LECTEUR legitime (elle n'execute pas ses "
                "arguments), declarez-la dans SAFE_HEADS "
                "(.claude/hooks/_lib/command_predicate.py).",
                file=sys.stderr,
            )
            if dev_key:
                continue
            return (cd_arg, None)

    return None


def qa_is_fresh() -> bool:
    try:
        return (time.time() - os.path.getmtime(BREADCRUMB)) <= MAX_AGE_SECONDS
    except OSError:
        return False


def _git_head(run_dir=None):
    """Return `(sha, None)` for the 40-char git HEAD of `run_dir` (the hook's
    cwd when None), or `(None, reason)` on anything short of a clean success
    (missing dir, not a repo, git absent, timeout, non-hex output). The reason
    is NAMED and reported LOUD by the caller -- never silently treated as "no
    proof required"."""
    where = run_dir if run_dir is not None else os.getcwd()
    if not os.path.isdir(where):
        return None, f"the directory the deploy runs in does not exist: {where}"
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=where,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"`git rev-parse HEAD` could not run in {where} ({exc})"
    if proc.returncode != 0:
        return None, f"`git rev-parse HEAD` failed in {where} (not a git checkout?)"
    sha = proc.stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        return None, f"`git rev-parse HEAD` in {where} did not return a sha"
    return sha, None


def dev_activation_status(run_dir=None, dir_error=None):
    """Second pole: has THIS commit already been deployed to, and read back
    from, a development deployment?

    Returns (True, None) when the proof holds, or (False, "<named reason>")
    for every other case -- absent HEAD, absent file, unreadable/malformed
    JSON, a missing key, a commit mismatch, an empty deployment/read_back, a
    read_back indistinguishable from the deploy command's own exit line, or
    an expired/future timestamp. Fail-closed on the unknown, always LOUD:
    each case names exactly what it hit, never a generic refusal."""
    if dir_error is not None:
        return False, f"could not determine the tree the deploy runs in: {dir_error}"
    sha, sha_error = _git_head(run_dir)
    if sha is None:
        return False, f"could not determine git HEAD: {sha_error}"

    path = DEV_ACTIVATION_PATH_TEMPLATE.format(sha=sha)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return False, f"no dev-activation proof for commit {sha} (expected {path})"

    try:
        proof = json.loads(raw)
    except json.JSONDecodeError as exc:
        return False, f"dev-activation proof at {path} is not valid JSON ({exc})"

    if not isinstance(proof, dict):
        return False, f"dev-activation proof at {path} is not a JSON object"

    for key in ("commit", "deployment", "read_back", "at"):
        if key not in proof:
            return False, f"dev-activation proof at {path} is missing key '{key}'"

    proof_commit = proof["commit"]
    if proof_commit != sha:
        return False, (
            f"dev-activation proof commit mismatch: proof={proof_commit!r} "
            f"HEAD={sha!r}"
        )

    deployment = proof["deployment"]
    if not isinstance(deployment, str) or not deployment.strip():
        return False, "dev-activation proof 'deployment' is empty"

    read_back = proof["read_back"]
    if not isinstance(read_back, str) or not read_back.strip():
        return False, "dev-activation proof 'read_back' is empty"
    if DEPLOY_OWN_EXIT_LINE_RE.match(read_back.strip()):
        return False, (
            "dev-activation proof 'read_back' looks like the deploy command's "
            "own exit line, not a separate read against the deployment"
        )

    at = proof["at"]
    if isinstance(at, bool) or not isinstance(at, (int, float)):
        return False, "dev-activation proof 'at' is not a numeric unix timestamp"
    age = time.time() - at
    if age < 0:
        return False, "dev-activation proof 'at' is in the future"
    if age > DEV_ACTIVATION_MAX_AGE_SECONDS:
        return False, (
            f"dev-activation proof expired ({age:.0f}s old, "
            f"max {DEV_ACTIVATION_MAX_AGE_SECONDS}s)"
        )

    return True, None


def main() -> int:
    data = json.load(sys.stdin)
    if data.get("tool_name") != "Bash":
        return 0

    command = data.get("tool_input", {}).get("command", "") or ""

    # Override documente, lu sur la commande BRUTE : il VIT DANS UN COMMENTAIRE,
    # et le tokenizer retire les commentaires. Le lire apres nettoyage tuerait
    # l'override EN SILENCE (piege verifie 4x).
    if OVERRIDE_RE.search(command):
        return 0

    found = find_prod_deploy(command)
    if found is None:
        return 0
    cd_arg, _ = found
    run_dir, dir_error = None, None
    if cd_arg is not None:
        run_dir, dir_error = _resolve_dir(cd_arg)

    qa_ok = qa_is_fresh()
    dev_ok, dev_reason = dev_activation_status(run_dir, dir_error)

    if qa_ok and dev_ok:
        return 0

    lines = [
        "BLOCKED by block-deploy-without-qa: production deploy refused -- two "
        "independent proofs are required, each reported separately below:",
    ]
    if qa_ok:
        lines.append("  [QA] OK -- fresh QA breadcrumb.")
    else:
        lines.append(f"  [QA] The QA breadcrumb ({BREADCRUMB}) is absent or stale (> 1h).")
    if dev_ok:
        lines.append("  [DEV-ACTIVATION] OK -- this commit was activated and read back in dev.")
    else:
        lines.append(f"  [DEV-ACTIVATION] {dev_reason}")
    lines.append(
        "\n"
        "  Run QA, then activate this exact commit on a development deployment "
        "(deploy it, then read its state back with a SEPARATE command) before "
        "retrying the production deploy.\n"
        "\n"
        "  Documented override (client-impacting hotfix only, skips BOTH proofs):\n"
        "    npx convex deploy --yes  # allow-no-qa: <reason >= 6 characters>\n"
        "\n"
        "  This guard decides on the ACTION, never on the raw text: a trailing "
        "comment cannot open it."
    )
    print("\n".join(lines), file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # FAIL-OPEN structurel : un hook fleet ne casse jamais une session.
        sys.exit(0)
