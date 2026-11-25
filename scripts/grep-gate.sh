#!/usr/bin/env bash
# grep-gate.sh — the two checks of .github/workflows/grep-gate.yml, run by the full suite
# (scripts/__tests__/grep-gate-gate.test.mjs) because GitHub Actions are disabled here.
#   1. No legacy brand reference "claude-peers" in mcp-server/src/, convex/,
#      docs/why-vantagepeers.md or mcp-server/server.ts.
#   2. No Buffer.(from|concat|byteLength|alloc) in a V8-runtime convex/*.ts file (no "use node"
#      in its first 10 lines); comment lines and '// allow-buffer-in-v8: <reason>' lines excepted.
# Exit 0 = both pass; 1 = a violation, named. Run from the repository root.
set -u
FAIL=0

check_brand() {
	if grep -rn "claude-peers" "$1" 2>/dev/null; then
		echo "ERROR: legacy 'claude-peers' reference found in $1"
		FAIL=1
	else
		echo "PASS: $1 is clean"
	fi
}
check_brand mcp-server/src/
check_brand convex/
check_brand docs/why-vantagepeers.md
check_brand mcp-server/server.ts

VIOLATIONS=""
for file in $(find convex -maxdepth 2 -name '*.ts' -not -path '*/_generated/*' -not -path '*/__tests__/*' 2>/dev/null); do
	if head -10 "$file" | grep -qE '^\s*"use node"\s*;?'; then
		continue
	fi
	MATCHES=$(grep -nE '\bBuffer\.(from|concat|byteLength|alloc)\b' "$file" | grep -vE '^\s*[0-9]+:\s*(//|\*)' | grep -v 'allow-buffer-in-v8' || true)
	if [ -n "$MATCHES" ]; then
		VIOLATIONS="${VIOLATIONS}\n${file}:\n${MATCHES}"
	fi
done
if [ -n "$VIOLATIONS" ]; then
	echo "ERROR: Buffer used in V8-runtime convex/*.ts files (no 'use node' directive)"
	echo "Buffer is a Node.js global, absent from the Convex V8 isolate. Use btoa/atob or TextEncoder/TextDecoder."
	printf "%b\n" "$VIOLATIONS"
	echo "Override (rare): add '// allow-buffer-in-v8: <reason>' inline on the offending line"
	FAIL=1
else
	echo "PASS: no Buffer in V8-runtime convex/*.ts"
fi
exit $FAIL
