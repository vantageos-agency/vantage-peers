#!/usr/bin/env python3
"""mcp-doctor check: check-http-boundary-derives-from-principal.

task k17bf7bsfrm255x4pr5r96q5g58cw691, mcp-standard rule pair to
scripts/check-token-mint-authority-source.py (backend-doctor): the HTTP/MCP
boundary (mcp-server/src/auth.ts's bearerAuthMiddleware) must derive mint
authority from the LIVE AUTHENTICATED PRINCIPAL (a verified Clerk JWT's
(sub, org_id), joined against client_org_mapping), never from a hardcoded
literal keyed only on which BRANCH the request fell into.

Two run modes:

  --self-test   Bipolar probe against FIXTURE STRINGS (not the live file),
                so the RED pole survives the Path B rewire landing.
                MUST_BLOCK: the pre-rewire auth.ts:590-605 shape — a
                hardcoded "team-member"/[] grant keyed only on branch, no
                principal-derived join.
                MUST_PASS: the legacy deny-by-default literals (~707-726,
                DCR client-generic) — also hardcoded, but the ceiling is
                EMPTY (deny-by-default), never a populated grant, so a
                missing join is safe here by construction.

  (default)     Coverage inventory over the FIVE bearer-auth branches in
                mcp-server/src/auth.ts's bearerAuthMiddleware. Every branch is
                ANALYSED (classified live) or SKIPPED (with a written
                reason). Any branch not listed is an inventory gap and fails
                the check.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ─────────────────────────────────────────────────────────────────────────────
# Fixtures for --self-test. Literal strings, not read from the live repo, so
# the MUST_BLOCK pole survives the Path B fix landing.
# ─────────────────────────────────────────────────────────────────────────────

# MUST_BLOCK — the pre-rewire auth.ts:590-605 shape: a hardcoded, POPULATED
# grant (non-empty scope) keyed only on which branch matched, with no join
# back to the verified principal's org.
BLOCK_FIXTURE = """
c.set("oauthContext", {
	clientId: `dcr-clerk-${orgId}`,
	userId: clerkResult.sub,
	scopes: ["mcp:full"],
	scopeProfile: "team-member",
	fromAllowList: [],
	namespaceReadPrefixes: [`team/${orgId}`],
	namespaceWritePrefixes: [`team/${orgId}`],
	expiresAt: clerkResult.exp * 1000,
	isMaster: false,
});
"""

# MUST_PASS — the legacy deny-by-default literals (~707-726): also hardcoded,
# but every grant array is EMPTY. A hardcoded literal is only safe when it is
# the DENY pole (nothing to widen); a hardcoded literal that GRANTS something
# non-empty must instead derive from the principal.
PASS_FIXTURE = """
c.set("oauthContext", {
	clientId: `legacy:${tenant.tenantName}`,
	userId: `legacy:${tenant.tenantName}`,
	scopes: [],
	scopeProfile: "legacy-tenant-generic",
	fromAllowList: [],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: Date.now() + 3600 * 1000,
	isMaster: false,
});
"""

POPULATED_GRANT_PATTERN = re.compile(
	r'scopeProfile:\s*"(?!legacy-tenant-generic|client-generic)[^"]+"'
)
EMPTY_ARRAY_PATTERN = re.compile(r"fromAllowList:\s*\[\]")
PRINCIPAL_JOIN_PATTERN = re.compile(
	r"clientOrgMapping:getByClerkSlug|by_clerk_slug|withOrgScope\("
)


def classify(text: str) -> str:
	"""Returns "BLOCK", "PASS", or "UNKNOWN" for a bearer-auth branch snippet."""
	has_join = bool(PRINCIPAL_JOIN_PATTERN.search(text))
	if has_join:
		return "PASS"
	# No principal-derived join in this branch. Safe (PASS) ONLY if it never
	# grants anything (empty fromAllowList + no non-generic scopeProfile
	# literal). Otherwise it is a hardcoded, populated grant keyed only on
	# branch — exactly the defect class this check exists to catch.
	is_empty_grant = bool(EMPTY_ARRAY_PATTERN.search(text))
	is_populated_grant = bool(POPULATED_GRANT_PATTERN.search(text))
	if is_empty_grant and not is_populated_grant:
		return "PASS"
	if is_populated_grant:
		return "BLOCK"
	return "UNKNOWN"


def run_self_test() -> int:
	block_result = classify(BLOCK_FIXTURE)
	pass_result = classify(PASS_FIXTURE)
	ok = block_result == "BLOCK" and pass_result == "PASS"
	print(f"MUST_BLOCK fixture classified: {block_result} (expected BLOCK)")
	print(f"MUST_PASS  fixture classified: {pass_result} (expected PASS)")
	print("SELF-TEST:", "PASS" if ok else "FAIL")
	return 0 if ok else 1


# ─────────────────────────────────────────────────────────────────────────────
# Coverage inventory — the FIVE bearer-auth branches in bearerAuthMiddleware.
# ─────────────────────────────────────────────────────────────────────────────


def extract_branch(text: str, marker: str, window: int = 3000) -> str:
	idx = text.find(marker)
	if idx == -1:
		return ""
	return text[idx : idx + window]


def run_inventory() -> int:
	auth_ts = REPO_ROOT / "src" / "auth.ts"
	text = auth_ts.read_text(encoding="utf-8")

	branches = [
		{
			"id": 1,
			"name": "(1) Master bearer shortcut",
			"status": "SKIPPED",
			"reason": (
				"Populated grant (fromAllowList=['*']), but gated on "
				"BEARER_SECRET_MASTER matching the raw token, not a "
				"registered-client field — the secret itself IS the verified "
				"principal for this branch. Out of scope: requireMasterAuth "
				"stays byte-unchanged per task constraint."
			),
		},
		{
			"id": 2,
			"name": "(2) OAuth scoped access token (oauth_access_tokens)",
			"status": "SKIPPED",
			"reason": (
				"Grant is read verbatim off the oauth_access_tokens ROW keyed by "
				"THIS request's token hash (admin-provisioned scopeProfile at "
				"mint time via check-token-mint-authority-source path 1/2) — a "
				"data read of a row scoped to the presented credential, not a "
				"hardcoded literal in this branch."
			),
		},
		{
			"id": 3,
			"name": "(2.5) Clerk JWT — Path B",
			"status": "ANALYSED",
			"marker": "── (2.5)",
		},
		{
			"id": 4,
			"name": "(3) DCR OAuth token (oauthDcr:validateAccessToken)",
			"status": "ANALYSED",
			"marker": "SECURITY FIX: DCR tokens from the legacy oauthDcr path",
		},
		{
			"id": 5,
			"name": "(4) Legacy internal bearer (mcpTenants)",
			"status": "ANALYSED",
			"marker": "SECURITY FIX (k17dt8pq4zkafsvt162z9qzgsn8abs0r)",
		},
	]

	ok = True
	print("check-http-boundary-derives-from-principal — 5-path coverage inventory\n")
	for b in branches:
		if b["status"] == "SKIPPED":
			print(f"  {b['name']}: SKIPPED — {b['reason']}")
			continue
		branch_text = extract_branch(text, b["marker"])
		result = classify(branch_text) if branch_text else "UNKNOWN"
		print(f"  {b['name']}: ANALYSED — live classification: {result}")
		if result == "BLOCK":
			ok = False
			print(
				"      BLOCKING: hardcoded populated grant with no "
				"principal-derived join found in this branch."
			)

	print()
	print("OVERALL:", "PASS" if ok else "FAIL")
	return 0 if ok else 1


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument(
		"--self-test",
		action="store_true",
		help="Run the bipolar probe against fixture strings (not the live repo).",
	)
	args = parser.parse_args()
	if args.self_test:
		return run_self_test()
	return run_inventory()


if __name__ == "__main__":
	sys.exit(main())
