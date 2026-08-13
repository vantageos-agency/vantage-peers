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

VERSION = "3.0.0"

BREADCRUMB = "/tmp/.qa-passed"
MAX_AGE_SECONDS = 3600  # 1 heure

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
            # LOUD. Ce pre-filtre par sous-chaine est acceptable ICI -- et
            # seulement ici -- parce qu'il ne peut QUE remonter vers une
            # decision visible par un humain : il n'autorise rien.
            low = piece.lower()
            if "convex" in low and "deploy" in low:
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


def qa_is_fresh() -> bool:
    try:
        return (time.time() - os.path.getmtime(BREADCRUMB)) <= MAX_AGE_SECONDS
    except OSError:
        return False


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

    if not is_prod_deploy(command):
        return 0

    if qa_is_fresh():
        return 0

    print(
        "BLOCKED by block-deploy-without-qa: deploiement Convex vers la production "
        "sans QA recente.\n"
        "  Pour DEV : utilise `npx convex dev --once` (aucun garde prod ne s'applique). "
        "Le jeton Pi / la preuve QA ne sont requis QUE pour la PROD.\n"
        f"  Le temoin QA ({BREADCRUMB}) est absent ou perime (> 1h).\n"
        "  Passez la QA (T6) — tests + verification — puis relancez le deploiement.\n"
        "\n"
        "  Override documente (hotfix client-impacting uniquement) :\n"
        "    npx convex deploy --yes  # allow-no-qa: <raison >= 6 caracteres>\n"
        "\n"
        "  Ce hook decide sur l'ACTION, pas sur le texte : ajouter '# convex dev' "
        "en commentaire ne l'ouvre plus (bypass corrige Day 128).",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # FAIL-OPEN structurel : un hook fleet ne casse jamais une session.
        sys.exit(0)
