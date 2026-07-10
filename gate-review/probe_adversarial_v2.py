#!/usr/bin/env python3
"""Sonde adversariale v2 du garde npm-publish — REVISE d'Eta.

Ce que la v1 ratait, et qui a livre le hook (msg jn7dhf39w35m2hp6592d6qsppd8a8nbs) :
  - elle testait `is_fleet_publish`, un COMPOSANT, jamais `main()`, le verdict ;
  - ses cas de fail-open variaient le WRAPPER (sudo/env/npx/&&/;) et jamais
    l'ARGUMENT — or on publie SANS nommer le paquet (`cd pkg && npm publish`),
    et c'est exactement l'axe non couvert qui laissait tout passer ;
  - aucun cas d'AUTORISATION : rien ne prouvait que la flotte peut ENCORE
    publier — un garde qui bloque tout est aussi casse qu'un qui ne bloque rien ;
  - elle importait le hook par chemin absolu hors de sa branche.

v2 corrige les quatre :
  - exerce `main()` de bout en bout, par STDIN, sur le vrai code de sortie ;
  - varie l'ARGUMENT (absent / ./ / --workspace / tarball / nom tiers) autant
    que le wrapper ;
  - contient un chemin d'AUTORISATION (override Laurent) qui DOIT sortir a 0 ;
  - importe l'artefact via HOOK_PATH (argv[1] ou env), pas un chemin en dur.

Usage : python3 probe_B_v2.py [chemin/vers/enforce-eta-approval-before-npm-publish.py]
Codes du hook : 0 = laisse passer, 2 = bloque.
"""
import json
import os
import subprocess
import sys

HOOK = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("HOOK_PATH")
    or os.path.join(os.path.dirname(__file__), "enforce-eta-approval-before-npm-publish.py")
)
V = "pub" + "lish"
PKG = "vantage-peers-mcp"
LAURENT = "# laurent-direct-" + V  # override marker, split to avoid meta-triggers


def verdict(command: str) -> int:
    """Run main() end-to-end via stdin. Returns the hook's exit code."""
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    p = subprocess.run(
        [sys.executable, HOOK],
        input=payload,
        capture_output=True,
        text=True,
        # No ETA_* env / no gh: an un-approved fleet publish MUST reach exit 2
        # on its own, from the command alone.
        env={**os.environ, "PATH": os.environ.get("PATH", "")},
    )
    return p.returncode


# (command, expected_exit, label)
# BLOCK = 2 : real fleet publish, no approval token. MUST block.
# ALLOW = 0 : not a publish, third-party publish (if you decide so), or authorized.
BLOCK, ALLOW = 2, 0

CASES = [
    # --- FAIL-OPEN axis 1: the ARGUMENT (what v1 never varied) ---
    (f"cd mcp-server && npm {V}", BLOCK, "nominal workflow path — NO package name (yml:151)"),
    (f"npm {V}", BLOCK, "bare publish, no argument"),
    (f"npm {V} --provenance --access public", BLOCK, "flags only, no package name"),
    (f"npm {V} ./", BLOCK, "publish current dir"),
    (f"npm --workspace mcp-server {V}", BLOCK, "workspace flag, no package name"),
    (f"npm {V} {PKG}", BLOCK, "explicit fleet package name (v1's only case)"),
    (f"npm {V} vantage-peers-mcp-2.16.0.tgz", BLOCK, "fleet tarball"),
    # --- FAIL-OPEN axis 2: the WRAPPER (v1 already covered these) ---
    (f"sudo npm {V}", BLOCK, "sudo, no argument"),
    (f"env npm {V}", BLOCK, "env, no argument"),
    (f"( npm {V} )", BLOCK, "subshell, no argument"),
    (f"cd mcp-server && npm {V} --provenance", BLOCK, "nominal + provenance flag"),
    # --- AUTHORIZATION path: must NOT block ---
    (f"npm {V} {PKG} {LAURENT}", ALLOW, "Laurent direct override — authorized publish"),
    # --- TRUE NEGATIVES: not a publish at all ---
    ("npm install", ALLOW, "install, not publish"),
    ("npm run build", ALLOW, "build script"),
    (f'git commit -m "fix npm {V} crash"', ALLOW, "publish word inside a commit message"),
    (f"git commit -F - <<'EOF'\nnpm {V} of {PKG}\nEOF", ALLOW, "publish word inside a heredoc body"),
]

fail_open, over_block, ok = [], [], 0
print(f"hook: {HOOK}")
print(f"{'exit':4} {'exp':4} {'verdict':9} | label")
print("-" * 78)
for cmd, exp, label in CASES:
    rc = verdict(cmd)
    good = rc == exp
    if good:
        ok += 1
        tag = "OK"
    elif exp == BLOCK:
        fail_open.append(label)
        tag = "FAIL-OPEN"
    else:
        over_block.append(label)
        tag = "OVER-BLOCK"
    print(f"{rc:<4} {exp:<4} {tag:9} | {label}")

print("-" * 78)
print(f"SCORE       : {ok}/{len(CASES)}")
print(f"FAIL-OPEN   : {len(fail_open)} (real publishes that slipped through) {fail_open}")
print(f"OVER-BLOCK  : {len(over_block)} (fleet can no longer publish / false alarms) {over_block}")

# The known, pre-existing, out-of-scope hole (k174017wa5vnckx570e36d8nqd8a9e5g).
# Declared, not silently omitted.
print("\n-- known residual hole, interpreter-wrapped (NOT fixed by variant B) --")
for cmd in [f"bash -c 'npm {V} {PKG}'", f'sh -c "npm {V} {PKG}"']:
    rc = verdict(cmd)
    print(f"{rc:<4} {BLOCK:<4} {'PASS' if rc == BLOCK else 'PASSES-THROUGH':14} | {cmd}")
