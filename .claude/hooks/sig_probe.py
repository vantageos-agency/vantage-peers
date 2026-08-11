#!/usr/bin/env python3
"""Sonde adversariale de enforce-signature.py (Sigma -> Pi, Day 127/128, motif #4).

Rejouer : python3 sig_probe.py <chemin-du-hook>
Exit 0 quand 10/10. Exit 1 tant qu'un defaut subsiste.

PIEGE : ce hook n'utilise PAS l'exit code. Il imprime {"decision":"block"} sur
stdout et sort TOUJOURS en 0. Asserter sur l'exit code = faux negatif garanti.
"""
import json
import os
import subprocess
import sys

HOOK = sys.argv[1] if len(sys.argv) > 1 else os.environ["HOOK_PATH"]
SIG = "Orchestrator: Sigma — VantagePeers | 2026-07-10"


def verdict(cmd):
    p = subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}}),
        capture_output=True, text=True)
    out = p.stdout.strip()
    if out:
        try:
            if json.loads(out).get("decision") == "block":
                return "BLOCK"
        except json.JSONDecodeError:
            pass
    return "ALLOW"


BLOCK, ALLOW = "BLOCK", "ALLOW"
CASES = [
    # Controles : la sonde et le hook doivent s'accorder sur le facile.
    ('gh pr create --title x --body "no signature at all here"', BLOCK, "control", "plain unsigned -> BLOCK"),
    (f'gh pr create --body "all good\n\n{SIG}"', ALLOW, "control", "plain signed -> ALLOW"),

    # AXE A — FAIL-OPEN d'abord : du contenu NON signe qui passe.
    ('gh pr create --title x --body-file body.md', BLOCK, "fail-open", "A1 --body-file aveugle"),
    ('gh pr create --title x -b "no signature here at all"', BLOCK, "fail-open", "A2 flag court -b"),
    ('gh pr create --title x --body="no signature here at all"', BLOCK, "fail-open", "A3 forme --body="),
    ('gh issue comment 5 -F body.md', BLOCK, "fail-open", "A4 -F fichier"),
    ("gh pr comment 5 --body \"$(cat <<'BODY'\nno signature\nBODY\n)\"", BLOCK, "fail-open", "A5 heredoc non-EOF"),

    # AXE B — OVER-BLOCK : un body correctement SIGNE bloque a tort.
    (f'gh pr comment 5 --body "fix v.id(\\"tasks\\") id guard\n\n{SIG}"', ALLOW, "over-block", "B1 quote double interne"),
    (f"gh pr create --body 'it'\\''s done, ships now\n\n{SIG}'", ALLOW, "over-block", "B2 quote simple interne"),
    (f'gh pr edit 5 --body "see `npm publish` note\n\n{SIG}"', ALLOW, "over-block", "B3 sanity signe -> ALLOW"),

    # A6 — le cas que la clause HEREDOC protege : corps SIGNE livre par tuyau, sous un
    # delimiteur NON-EOF. Sans parsing heredoc, seul `-F -` est vu -> illisible -> BLOCK
    # a tort. Ajoute Day 128 : la mutation M3 (heredoc refige sur EOF) survivait a la
    # sonde d'origine, ce qui prouvait un TROU DE LA SONDE, pas une clause morte.
    (f"gh pr comment 5 -F - <<'BODY'\nrapport du jour\n\n{SIG}\nBODY", ALLOW, "heredoc", "A6 corps signe par heredoc non-EOF"),
]

fails = []
for cmd, correct, axis, label in CASES:
    got = verdict(cmd)
    ok = got == correct
    if not ok:
        fails.append((axis, label, correct, got))
    print(f"{'OK ' if ok else 'XXX'} correct={correct:5} got={got:5} [{axis}] {label}")

print(f"\n{len(CASES) - len(fails)}/{len(CASES)} conformes")
sys.exit(1 if fails else 0)
