#!/usr/bin/env python3
"""PreToolUse(Bash) — exige la signature orchestrateur sur toute PR / tout commentaire gh.

    Orchestrator: <Nom> — <Equipe> | YYYY-MM-DD

VERSION 2.0.0 — Day 128 (2026-07-11)

INCIDENT QUI JUSTIFIE CETTE REECRITURE (hook-doctrine, criteres 1 + 2)
----------------------------------------------------------------------
Sonde adversariale de Sigma (briefings js78pgx5cph2v1yfa589swg2c18a8sgr et
js7a028jbs03vp91zm8r7jzkdn8aa985), rejouee de la main de Pi contre le hook v1
(sha256 b7d1a1362b51f9e2fe238bdb6884c3220cd96e387e264cfa0705086ea38b764b) :
**4/10 conformes, 6 defauts.**

  FAIL-OPEN (du contenu NON signe qui PASSE — la face grave) :
    A1  gh pr create --body-file body.md      -> ALLOW  (fichier jamais lu)
    A2  gh pr create -b "..."                 -> ALLOW  (flag court non matche)
    A3  gh pr create --body="..."             -> ALLOW  (`\\s+` ne matche pas `=`)
    A4  gh issue comment 5 -F body.md         -> ALLOW  (jamais inspecte)

  OVER-BLOCK (un body correctement SIGNE, bloque a tort — la face genante) :
    B1  --body "fix v.id(\\"tasks\\") ...\\n\\nOrchestrator: ..."  -> BLOCK
    B2  --body 'it'\\''s done ...\\n\\nOrchestrator: ...'          -> BLOCK

RACINE : la v1 decidait sur une SOUS-CHAINE — `re.search(r'--body\\s+"([^"]*)"')`.
`[^"]*` s'arrete a la premiere quote interne, donc la signature (derniere clause du
body) est tronquee -> over-block. Et `--body` non suivi d'un espace (`--body=`,
`--body-file`) ou le flag court `-b` ne matchent JAMAIS -> fail-open. Le heredoc
etait fige sur le delimiteur `EOF`.

C'est la QUATRIEME occurrence du motif « extraction naive » dans le meme cycle
(enforce-eta-approval : strip_quoted_strings effacait la commande ; enforce-clerk-jwt-smoke :
sous-chaine dans un corps de message ; enforce-full-ids). La classe est la meme :
DECIDER SUR UNE SOUS-CHAINE AU LIEU DES ARGUMENTS REELS.

LE PRINCIPE
-----------
On decide sur les ARGUMENTS, jamais sur une sous-chaine :
  1. `shlex.split()` resout le quoting shell EXACTEMENT comme le shell le ferait —
     les quotes internes cessent d'etre un piege.
  2. On lit le body dans TOUTES les formes que `gh` accepte :
     `--body V`, `--body=V`, `-b V`, `-b=V`, `--body-file P` / `-F P` (le fichier est
     LU sur disque), et les heredocs sous N'IMPORTE QUEL delimiteur.
  3. Un body que le hook ne peut PAS lire n'est plus silencieusement autorise.

FAIL-CLOSED ASSUME (arbitrage Pi, Day 128 — trou #1 declare par Sigma)
-----------------------------------------------------------------------
Si une source de body existe mais est ILLISIBLE par le hook (`-F -` sur stdin, fichier
inexistant, commande non parsable), le hook BLOQUE avec guidance.

    « Laisser passer ce qu'on ne peut pas inspecter EST le fail-open qu'on supprime. »

C'est un CHANGEMENT de comportement assume : avant, `printf ... | gh pr comment -F -`
passait silencieusement NON signe. Pour le pipe legitime, une porte de sortie NOMMEE
existe (voir OVERRIDE). Un garde qui s'ouvre sur ce qu'il ne voit pas n'est pas un garde.

OVERRIDE PROPRE (critere 3)
---------------------------
    # allow-unverifiable-body: <raison >= 6 caracteres>

Reserve au cas ou le body arrive par un canal que le hook ne peut structurellement pas
lire (pipe stdin), ET ou l'appelant garantit la signature. Greppable, tracable.

VERDICT — PIEGE POUR QUI ECRIT UNE SUITE
-----------------------------------------
Ce hook n'utilise PAS l'exit code : il imprime {"decision":"block"} sur stdout et sort
TOUJOURS en 0 (les appelants lisent `decision`). Asserter sur l'exit code = faux negatif
garanti. La sonde `sig_probe.py` lit bien le JSON de stdout.
"""
import json
import os
import re
import shlex
import sys

VERSION = "2.0.0"

SIGNATURE_PATTERN = re.compile(
    r"Orchestrator:\s+\w+\s+—\s+.+\s*\|\s*\d{4}-\d{2}-\d{2}"
)

GH_COMMANDS = [
    "gh pr create",
    "gh pr edit",
    "gh pr comment",
    "gh pr review",
    "gh issue comment",
    "gh issue create",
]

# Heredoc sous N'IMPORTE QUEL delimiteur (la v1 figeait `EOF` et ratait le reste).
HEREDOC_RE = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?\r?\n(.*?)\r?\n\1\b", re.DOTALL)

OVERRIDE_RE = re.compile(r"#\s*allow-unverifiable-body:\s*(\S.{5,})", re.IGNORECASE)

BODY_FLAGS = ("--body", "-b")
FILE_FLAGS = ("--body-file", "-F")


def _read_body_file(path, bodies, unverifiable):
    """Lit un argument --body-file / -F. Illisible => unverifiable, JAMAIS autorise."""
    if path == "-":
        # Body pipe sur stdin : le hook ne peut pas le voir avant l'execution.
        unverifiable.append("stdin (-)")
        return
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            bodies.append(handle.read())
    except OSError:
        unverifiable.append(path)


def extract_bodies(command):
    """Retourne (bodies, unverifiable) pour une commande gh."""
    bodies = []
    unverifiable = []

    # Heredocs, quel que soit le delimiteur.
    for match in HEREDOC_RE.finditer(command):
        bodies.append(match.group(2))

    # On tokenise comme le shell — c'est ce qui rend les quotes internes inoffensives.
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        unverifiable.append("<commande non parsable>")
        return bodies, unverifiable

    index = 0
    while index < len(tokens):
        token = tokens[index]

        if token in BODY_FLAGS:
            if index + 1 < len(tokens):
                bodies.append(tokens[index + 1])
                index += 1
        elif token.startswith("--body="):
            bodies.append(token[len("--body="):])
        elif token.startswith("-b="):
            bodies.append(token[len("-b="):])
        elif token in FILE_FLAGS:
            if index + 1 < len(tokens):
                _read_body_file(tokens[index + 1], bodies, unverifiable)
                index += 1
        elif token.startswith("--body-file="):
            _read_body_file(token.split("=", 1)[1], bodies, unverifiable)

        index += 1

    return bodies, unverifiable


def decide(command):
    """LE chemin de decision UNIQUE. Retourne (verdict, unverifiable). 0=allow, 2=block.

    Un seul chemin : `main()` delegue ici. La v1 de Sigma avait DEUX chemins (un pur
    pour les tests, une copie des regles dans main()) — sa premiere preuve par mutation
    n'a donc rien mesure : la sonde exercait le chemin qu'il ne mutait pas. Piege
    fix-pattern m97cahtjf04979pa29f2d3eqr588ytvv. Un seul chemin, ou la mutation ment.
    """
    if not any(gh in command for gh in GH_COMMANDS):
        return 0, []

    # Porte de sortie documentee, lue sur la commande BRUTE (elle vit dans un commentaire).
    if OVERRIDE_RE.search(command):
        return 0, []

    bodies, unverifiable = extract_bodies(command)

    if any(SIGNATURE_PATTERN.search(body) for body in bodies):
        return 0, unverifiable

    if bodies:
        return 2, unverifiable

    # Aucun body lisible, mais une source de body que le hook n'a PAS pu lire -> BLOQUE.
    if unverifiable:
        return 2, unverifiable

    return 0, unverifiable


def evaluate_command(command):
    """Fine enveloppe autour de decide(), pour les tests."""
    return decide(command)[0]


def _block(reason_extra=""):
    print(json.dumps({
        "decision": "block",
        "reason": (
            "BLOCKED by enforce-signature: signature orchestrateur manquante.\n"
            "Toute PR et tout commentaire doit contenir :\n"
            "  Orchestrator: <Nom> — <Equipe> | YYYY-MM-DD\n\n"
            "Exemple : Orchestrator: Pi — ElPi Corp | 2026-07-11"
            + reason_extra
        ),
    }))


def main():
    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        sys.exit(0)  # fail-open structurel : un hook fleet ne casse jamais une session

    if data.get("tool_name", "") != "Bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    if not command:
        sys.exit(0)

    verdict, unverifiable = decide(command)

    if verdict == 2:
        extra = ""
        if unverifiable:
            extra = (
                "\n\nCe hook n'a PAS PU LIRE le body "
                f"({', '.join(unverifiable)}) — sa signature est donc invérifiable.\n"
                "Un garde ne laisse pas passer en silence ce qu'il ne peut pas inspecter.\n"
                "Passez le body en ligne (--body) ou pointez --body-file vers un fichier\n"
                "existant et lisible.\n\n"
                "Si le body arrive par un canal structurellement illisible (pipe stdin)\n"
                "ET que vous garantissez la signature, la porte de sortie est :\n"
                "  # allow-unverifiable-body: <raison >= 6 caracteres>"
            )
        _block(extra)

    sys.exit(0)


if __name__ == "__main__":
    main()
