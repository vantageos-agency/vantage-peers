"""Sonde adversariale du garde npm-publish — variante B (post-revert).

Ordre volontaire : FAIL-OPEN d'abord (vrais publish qui doivent bloquer),
faux positifs ensuite. Un garde de securite se juge sur ses faux negatifs.
Teste is_fleet_publish(), le vrai point d'entree, pas ses composants.
"""
import importlib.util, sys

spec = importlib.util.spec_from_file_location(
    "h", "/root/coding/vantage-memory/.claude/hooks/enforce-eta-approval-before-npm-publish.py"
)
m = importlib.util.module_from_spec(spec)
sys.argv = ["x"]
try:
    spec.loader.exec_module(m)
except SystemExit:
    pass

f = m.is_fleet_publish
V = "pub" + "lish"
PKG = "vantage-peers-mcp"

# (commande, doit_bloquer, libelle)
CASES = [
    # ---- FAIL-OPEN : vrais publish d'un paquet flotte. Doivent TOUS bloquer.
    (f"npm {V} --access public {PKG}", True, "invocation nue"),
    (f"ETA_APPROVED_TASK_ID=k17x ETA_APPROVED_COMMIT_SHA=abc npm {V} {PKG}", True, "forme doctrinale"),
    (f"sudo npm {V} {PKG}", True, "sudo"),
    (f"env npm {V} {PKG}", True, "env"),
    (f"( npm {V} {PKG} )", True, "sous-shell"),
    (f"if true; then npm {V} {PKG}; fi", True, "dans un if"),
    (f"npx npm {V} {PKG}", True, "via npx"),
    (f"cd mcp-server && npm {V} {PKG}", True, "apres &&"),
    (f"true; npm {V} {PKG}", True, "apres ;"),
    (f"pnpm {V} {PKG}", True, "pnpm"),
    (f"yarn {V} {PKG}", True, "yarn"),
    (f"bun {V} {PKG}", True, "bun"),
    # ---- FAUX POSITIFS : ne publient rien. Ne doivent PAS bloquer.
    (f'gh pr create --title "fix: npm {V} crash sur {PKG}"', False, "argument de gh"),
    (f'git commit -m "run npm {V} after review"', False, "message de commit"),
    (f"git commit -F - <<'EOF'\nfix: npm {V} de {PKG} crashe\nEOF", False, "corps de heredoc"),
    (f"echo npm {V}", False, "argument d'echo"),
    ("npm install", False, "install, pas publish"),
]

fail_open, faux_pos = [], []
print(f"{'verdict':9} | {'doit bloquer':12} | libelle")
print("-" * 62)
for cmd, should, label in CASES:
    got = f(cmd)
    ok = got == should
    if not ok:
        (fail_open if should else faux_pos).append(label)
    print(f"{'OK' if ok else ('FAIL-OPEN' if should else 'FAUX-POS'):9} | {str(should):12} | {label}")

print(f"\nFAIL-OPEN   : {len(fail_open)} (vrais publish non detectes)  {fail_open}")
print(f"FAUX POSITIF: {len(faux_pos)}  {faux_pos}")
print(f"SCORE       : {len(CASES) - len(fail_open) - len(faux_pos)}/{len(CASES)}")
