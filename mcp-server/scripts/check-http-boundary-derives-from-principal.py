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

# MUST_PASS (mapping-derived) — the real post-Path-B-fix shape: a
# `clientOrgMapping:getByClerkSlug` join IS present in the branch, and the
# grant fields (`scopes` / `fromAllowList`) are assigned FROM the resolved
# `mapping` variable, never a hardcoded literal.
MAPPING_DERIVED_PASS_FIXTURE = """
const mapping = await internalClient().query(
	"clientOrgMapping:getByClerkSlug" as any,
	{ orgSlug: orgId },
);
const isMaster = mapping.allowedOrchestrators.includes("*");
c.set("oauthContext", {
	clientId: `dcr-clerk-${orgId}`,
	userId: clerkResult.sub,
	scopes: mapping.scopes,
	scopeProfile: isMaster ? "master" : "team-member",
	fromAllowList: mapping.allowedOrchestrators,
	namespaceReadPrefixes: [`team/${orgId}`],
	namespaceWritePrefixes: [`team/${orgId}`],
	expiresAt: clerkResult.exp * 1000,
	isMaster,
});
"""

# ETA-M40 MUST_BLOCK (re-hardcoded grant despite a present join) — the
# `clientOrgMapping:getByClerkSlug` join is present in the branch (so a
# join-presence-only check incorrectly PASSes this), but `scopes` is
# re-hardcoded to a non-empty literal instead of being read off `mapping`.
# This is the defect Eta's mutation caught and the doctor's OLD classifier
# missed (ETA-M40): presence of a join is NOT the same property as absence
# of a hardcoded grant.
REHARDCODED_GRANT_DESPITE_JOIN_FIXTURE = """
const mapping = await internalClient().query(
	"clientOrgMapping:getByClerkSlug" as any,
	{ orgSlug: orgId },
);
const isMaster = mapping.allowedOrchestrators.includes("*");
c.set("oauthContext", {
	clientId: `dcr-clerk-${orgId}`,
	userId: clerkResult.sub,
	scopes: ["mcp:full"],
	scopeProfile: isMaster ? "master" : "team-member",
	fromAllowList: mapping.allowedOrchestrators,
	namespaceReadPrefixes: [`team/${orgId}`],
	namespaceWritePrefixes: [`team/${orgId}`],
	expiresAt: clerkResult.exp * 1000,
	isMaster,
});
"""

POPULATED_GRANT_PATTERN = re.compile(
	r'scopeProfile:\s*"(?!legacy-tenant-generic|client-generic)[^"]+"'
)
EMPTY_ARRAY_PATTERN = re.compile(r"fromAllowList:\s*\[\]")
PRINCIPAL_JOIN_PATTERN = re.compile(
	r"clientOrgMapping:getByClerkSlug|by_clerk_slug|withOrgScope\("
)

# The grant fields that MUST derive from the resolved mapping variable (never
# a hardcoded literal) once a principal-derived join is present in the
# branch. A literal array/string assigned to either of these — even with the
# join present elsewhere in the same branch — is a re-hardcoded grant: the
# ETA-M40 defect class. `mapping\.` (optionally through a ternary like
# `isMaster ? ... : mapping.scopes`) is the only accepted derivation; a bare
# literal (`["mcp:full"]`, `["*"]`, a non-generic string, etc.) is not.
GRANT_FIELD_PATTERN = re.compile(
	r"(scopes|fromAllowList)\s*:\s*(\[[^\]]*\]|`[^`]*`|\"[^\"]*\"|'[^']*')"
)
LITERAL_ARRAY_CONTENT_PATTERN = re.compile(r"^\[\s*\]$")


def has_rehardcoded_grant_field(text: str) -> bool:
	"""True if `scopes:` or `fromAllowList:` is assigned a literal
	(non-`mapping.`-derived) value that is NOT an empty array — i.e. a
	populated, hardcoded grant, regardless of whether a principal-derived
	join is ALSO present elsewhere in the branch (ETA-M40)."""
	for match in GRANT_FIELD_PATTERN.finditer(text):
		value = match.group(2)
		if LITERAL_ARRAY_CONTENT_PATTERN.match(value):
			continue  # empty literal array — never a grant, always safe
		return True
	return False


def classify(text: str) -> str:
	"""Returns "BLOCK", "PASS", or "UNKNOWN" for a bearer-auth branch snippet.

	The property under test is the ABSENCE of a hardcoded populated grant on
	`scopes`/`fromAllowList` — NOT merely the presence of a
	`clientOrgMapping:getByClerkSlug` join. A join can be present in a branch
	purely for an unrelated lookup while the actual grant fields are still
	re-hardcoded literals (ETA-M40); classifying on join-presence alone
	produces a false PASS in exactly that case.
	"""
	has_join = bool(PRINCIPAL_JOIN_PATTERN.search(text))
	has_rehardcoded_grant = has_rehardcoded_grant_field(text)

	if has_rehardcoded_grant:
		# A populated, literal (non-`mapping.`-derived) scopes/fromAllowList
		# assignment is a hardcoded grant — BLOCK regardless of whether a
		# join is also present in the branch.
		return "BLOCK"

	if has_join:
		return "PASS"

	# No principal-derived join in this branch, and no re-hardcoded grant
	# field matched the literal-array/string form above. Fall back to the
	# scopeProfile literal check for branches that grant via a bare
	# `scopeProfile` string instead of `scopes`/`fromAllowList` arrays (e.g.
	# the pre-rewire shape, which had no `scopes:`/`fromAllowList:` populated
	# literal caught by GRANT_FIELD_PATTERN's empty-array carve-out).
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
	mapping_derived_result = classify(MAPPING_DERIVED_PASS_FIXTURE)
	rehardcoded_despite_join_result = classify(
		REHARDCODED_GRANT_DESPITE_JOIN_FIXTURE
	)
	ok = (
		block_result == "BLOCK"
		and pass_result == "PASS"
		and mapping_derived_result == "PASS"
		and rehardcoded_despite_join_result == "BLOCK"
	)
	print(f"MUST_BLOCK fixture classified: {block_result} (expected BLOCK)")
	print(f"MUST_PASS  fixture classified: {pass_result} (expected PASS)")
	print(
		f"MUST_PASS (mapping-derived) fixture classified: "
		f"{mapping_derived_result} (expected PASS)"
	)
	print(
		f"MUST_BLOCK (ETA-M40 re-hardcoded grant despite join) fixture "
		f"classified: {rehardcoded_despite_join_result} (expected BLOCK)"
	)
	print("SELF-TEST:", "PASS" if ok else "FAIL")
	return 0 if ok else 1


# ─────────────────────────────────────────────────────────────────────────────
# Coverage inventory — the FIVE bearer-auth branches in bearerAuthMiddleware.
# ─────────────────────────────────────────────────────────────────────────────


def extract_branch(text: str, marker: str, window: int = 6000) -> str:
	"""Extracts a bearer-auth branch from its section marker up to the START
	of the NEXT `// ── (n)` branch marker, falling back to a generous fixed
	`window` only if no next marker is found (e.g. the last branch in the
	file). A fixed window alone is unsafe here: an early fixed cutoff can
	truncate BEFORE the branch's actual `c.set("oauthContext", ...)` grant
	assignment, silently excluding the very field (`scopes:` /
	`fromAllowList:`) this check exists to classify (observed truncating
	before line 662's `scopes:` literal at a 3000-char window)."""
	idx = text.find(marker)
	if idx == -1:
		return ""
	search_from = idx + len(marker)
	next_idx = text.find("// ── (", search_from)
	if next_idx != -1:
		return text[idx:next_idx]
	return text[idx : idx + window]


def run_inventory() -> int:
	auth_ts = REPO_ROOT / "src" / "auth.ts"
	if not auth_ts.exists() or auth_ts.stat().st_size == 0:
		print(
			"REFUSING TO JUDGE: unreadable subject mcp-server/src/auth.ts "
			"(missing or empty)"
		)
		return 2
	text = auth_ts.read_text(encoding="utf-8")
	if not text.strip():
		print(
			"REFUSING TO JUDGE: unreadable subject mcp-server/src/auth.ts "
			"(blank content)"
		)
		return 2

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
		if not branch_text:
			print(
				f"REFUSING TO JUDGE: marker {b['marker']!r} not found in "
				"mcp-server/src/auth.ts — cannot classify branch "
				f"{b['name']}"
			)
			return 2
		result = classify(branch_text)
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
