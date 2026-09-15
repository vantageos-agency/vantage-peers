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
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import command_predicate as cp  # noqa: E402
from _lib.command_predicate import (  # noqa: E402
    carries_action_signature,
    has_safe_flag,
    head_matches,
    iter_real_commands,
    raw_carries_action_words,
)

VERSION = "4.1.0"

# `convex run <module>:<fn>` executes an existing function; it pushes no code.
# (`run --push` does, and raw_carries_action_words keeps that case closed.)
NON_DEPLOY_SUBCOMMANDS = frozenset({"run"})

BREADCRUMB = "/tmp/.qa-passed"
SHA_RE = re.compile(r"^[0-9a-f]{7,40}$", re.IGNORECASE)

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
    """True SEULEMENT si la commande execute reellement un deploy Convex.

    Toute la tokenisation (commentaires, continuations de ligne, decoupage
    quote-aware, prefixes transparents, recursion interpretes) vient de _lib :
    ce hook n'en garde AUCUNE copie."""
    for piece, tokens in iter_real_commands(cmd):
        _warn_if_uninspectable(piece)

        if tokens is None:
            # Segment NON TOKENISABLE (guillemet non ferme...). Le decoupeur
            # etant quote-aware, un ValueError ici est RARE, donc reellement
            # suspect. On n'ESCALADE en BLOCK que si le texte BRUT porte de
            # facon plausible un deploy (`convex` ET `deploy`) ; sinon fail-open
            # LOUD. v4.1.0 : ce pre-filtre porte sur des MOTS, plus sur des
            # sous-chaines -- le NOM de variable CONVEX_DEPLOY_KEY n'est pas un
            # signal de deploy, et `convex run` (sans --push) non plus.
            if raw_carries_action_words(piece, "convex", "deploy",
                                        NON_DEPLOY_SUBCOMMANDS):
                print(
                    "block-deploy-without-qa: segment NON TOKENISABLE contenant "
                    f"'convex'+'deploy' -- traite comme deploy potentiel: {piece!r}",
                    file=sys.stderr,
                )
                return True
            print(
                "block-deploy-without-qa: segment non tokenisable, AUCUNE trace de "
                f"deploy Convex -- laisse passer (fail-open explicite): {piece!r}",
                file=sys.stderr,
            )
            continue

        _warn_unknown_wrapper_flags(piece)
        if not tokens:
            continue

        if _segment_is_deploy(tokens):
            return True

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
            return True

    return False


def shipped_sha(cwd: str | None = None) -> str | None:
    """Resolve the commit actually being deployed via `git rev-parse HEAD`.
    Returns None (never raises) if git is unavailable — callers treat None as
    an instrument failure, not as an automatic pass."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        if result.returncode != 0:
            return None
        out = result.stdout.strip()
        return out or None
    except Exception:
        return None


def read_qa_breadcrumb() -> tuple[str, str]:
    """Reads BREADCRUMB (JSON: {"sha": <hex>, "writer": <name>}) and returns
    (sha, writer). Raises FileNotFoundError / OSError / ValueError on any
    failure to read or parse — the caller distinguishes ABSENCE from
    UNREADABILITY from MALFORMED, each a NAMED refusal, never collapsed."""
    with open(BREADCRUMB, "r", encoding="utf-8") as fh:
        raw = fh.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"malformed JSON: {exc}") from exc
    sha = (data.get("sha") or "").strip()
    writer = (data.get("writer") or "unknown").strip()
    if not SHA_RE.match(sha):
        raise ValueError(f"breadcrumb 'sha' field is not a valid hex SHA: {sha!r}")
    return sha, writer


def qa_pins_shipped_commit(cwd: str | None = None) -> tuple[str, str]:
    """Returns (verdict, message). verdict in {"pass", "block", "refuse"}.

    Replaces the age window (v3.0.0 qa_is_fresh) with the property that
    actually matters: does the QA witness NAME the commit being shipped.
    Recent evidence pinning ANOTHER commit is a BLOCK, not a silent PASS —
    that was the wrong-acceptance hole an age window can never close."""
    try:
        evidence_sha, writer = read_qa_breadcrumb()
    except FileNotFoundError:
        return "refuse", (
            f"REFUSING TO JUDGE: QA breadcrumb ({BREADCRUMB}) — absent, "
            "no QA evidence has been written for any commit"
        )
    except OSError as exc:
        return "refuse", (
            f"REFUSING TO JUDGE: QA breadcrumb ({BREADCRUMB}) — unreadable: {exc}"
        )
    except ValueError as exc:
        return "refuse", (
            f"REFUSING TO JUDGE: QA breadcrumb ({BREADCRUMB}) — malformed: {exc}"
        )

    ship_sha = shipped_sha(cwd=cwd)
    if not ship_sha:
        return "refuse", (
            "REFUSING TO JUDGE: git HEAD — `git rev-parse HEAD` failed, cannot "
            "resolve the commit being deployed"
        )

    match = (
        evidence_sha.lower() == ship_sha.lower()
        or ship_sha.lower().startswith(evidence_sha.lower())
        or evidence_sha.lower().startswith(ship_sha.lower())
    )
    if not match:
        return "block", (
            f"QA evidence pins commit {evidence_sha} (written by {writer}), but the "
            f"commit being deployed is {ship_sha}. MISMATCH — this evidence does not "
            "cover this deploy, however recent it is."
        )
    return "pass", f"QA evidence pins {evidence_sha} (written by {writer}), matches deployed {ship_sha}."


def _resolve_deploy_cwd(command: str, data: dict) -> str | None:
    """Resolve the directory the deploy actually runs in (v4.0.0), same shape
    as enforce-eta-approval-before-npm-publish.resolve_publish_dir: a leading
    `cd <abspath>` on the first line wins, else the PreToolUse payload cwd,
    else the hook process cwd. Needed because `git rev-parse HEAD` run from
    the hook's OWN cwd (often the session root, not the deploy target) names
    the wrong commit as "shipped"."""
    first_line = command.split("\n", 1)[0]
    m = re.match(r"""^\s*cd\s+(['"]?)([^\s&;|'"]+)\1""", first_line)
    if m:
        candidate = m.group(2).strip()
        if os.path.isabs(candidate) and os.path.isdir(candidate):
            return candidate
    payload_cwd = (data.get("cwd") or "").strip()
    if payload_cwd and os.path.isdir(payload_cwd):
        return payload_cwd
    return os.getcwd()


def main() -> int:
    data = json.load(sys.stdin)
    if data.get("tool_name") != "Bash":
        return 0

    command = data.get("tool_input", {}).get("command", "") or ""
    deploy_cwd = _resolve_deploy_cwd(command, data)

    # Override documente, lu sur la commande BRUTE : il VIT DANS UN COMMENTAIRE,
    # et le tokenizer retire les commentaires. Le lire apres nettoyage tuerait
    # l'override EN SILENCE (piege verifie 4x).
    if OVERRIDE_RE.search(command):
        return 0

    if not is_prod_deploy(command):
        return 0

    verdict, detail = qa_pins_shipped_commit(cwd=deploy_cwd)
    if verdict == "pass":
        return 0

    if verdict == "refuse":
        print(f"BLOCKED by block-deploy-without-qa: {detail}", file=sys.stderr)
        return 2

    print(
        "BLOCKED by block-deploy-without-qa: deploiement Convex vers la production "
        "sans QA pour CE commit.\n"
        f"  {detail}\n"
        "  Pour DEV : utilise `npx convex dev --once` (aucun garde prod ne s'applique). "
        "Le jeton Pi / la preuve QA ne sont requis QUE pour la PROD.\n"
        "  Passez la QA (T6) — tests + verification SUR CE COMMIT — puis relancez le "
        "deploiement.\n"
        "\n"
        "  Override documente (hotfix client-impacting uniquement) :\n"
        "    npx convex deploy --yes  # allow-no-qa: <raison >= 6 caracteres>\n"
        "\n"
        "  Ce hook decide sur l'ACTION, pas sur le texte : ajouter '# convex dev' "
        "en commentaire ne l'ouvre plus (bypass corrige Day 128). Il decide "
        "desormais sur le COMMIT PINNE par la preuve QA, pas sur son AGE "
        "(v4.0.0 — un delai plus large n'aurait jamais ferme le trou de "
        "l'acceptation a tort).",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # FAIL-OPEN structurel : un hook fleet ne casse jamais une session.
        sys.exit(0)
