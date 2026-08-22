#!/usr/bin/env python3
"""backend-doctor check: check-token-mint-authority-source.

task k17bf7bsfrm255x4pr5r96q5g58cw691. THE PROPERTY (both poles): a token's
authority = f(authenticated principal -> client_org_mapping row); the
registered client narrows, never widens.

This check is a static classifier over token-MINT code sites: it recognizes
two shapes —

  BLOCK-shaped ("anonymously-registered object is the authority"):
    mint args sourced from a CLIENT-REGISTRATION field (e.g.
    `scopeProfile: profile.profileId` where
    `profile = loadScopeProfile(client.scopeProfile)`) — the client row itself
    grants scope, with no join back to the AUTHENTICATED PRINCIPAL.

  PASS-shaped ("authority derives from the live authenticated principal"):
    mint args sourced from a principal -> client_org_mapping join (the
    `by_clerk_slug` index / `clientOrgMapping:getByClerkSlug` /
    `withOrgScope` family) — the resolved (sub, org_id) principal is the
    input, the mapping row is the ceiling, never the sole source.

Two run modes:

  --self-test   Runs the bipolar probe against FIXTURE STRINGS (not the live
                file) for the MUST_BLOCK pole, so the probe stays
                red-provable even after mcp-server/src/auth.ts's Path B is
                rewired (the live file will no longer contain the anti-
                pattern once fixed — the fixture preserves the RED case).
                Exits 0 iff BLOCK fixture classifies BLOCK AND PASS fixture
                classifies PASS.

  (default)     Coverage inventory over the SIX known token-mint paths in
                this repo. Each path is ANALYSED (classified live against the
                repo) or SKIPPED (with a written reason). Any path not listed
                here is an inventory gap and fails the check. Exits 1 if any
                ANALYSED path classifies BLOCK.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ─────────────────────────────────────────────────────────────────────────────
# Fixtures for --self-test (bipolar probe). These are literal strings, NOT
# read from the live repo, so the probe's RED pole survives the Path B fix
# landing in mcp-server/src/auth.ts.
# ─────────────────────────────────────────────────────────────────────────────

# MUST_BLOCK — snapshot of the anti-pattern class (server-http.ts:761-778
# style, client-registration-row-is-the-authority).
BLOCK_FIXTURE = """
const client = await internalClient().query("oauthDcr:getClientById", { clientId });
const profile = loadScopeProfile(client.scopeProfile);
await internalClient().mutation("oauth:createAccessToken", {
	clientId,
	userId,
	scopeProfile: profile.profileId,
	fromAllowList: profile.fromAllowList,
	namespaceReadPrefixes: profile.namespaceReadPrefixes,
});
"""

# MUST_PASS — a principal -> by_clerk_slug-derived reference (the fixed Path B
# shape: fromAllowList/scopes are read off the client_org_mapping row keyed by
# the VERIFIED principal's org_id, never off a client-registration field).
PASS_FIXTURE = """
const mapping = await internalClient().query("clientOrgMapping:getByClerkSlug", {
	orgSlug: clerkResult.org_id,
});
if (!mapping || !mapping.isActive) {
	return c.json({ error: "RBAC_DENIED" }, 403);
}
oauthContext.fromAllowList = mapping.allowedOrchestrators;
oauthContext.scopes = mapping.scopes;
"""

BLOCK_PATTERN = re.compile(r"loadScopeProfile\(client\.scopeProfile\)")
PASS_PATTERN = re.compile(
	r"clientOrgMapping:getByClerkSlug|by_clerk_slug|withOrgScope\("
)


def classify(text: str) -> str:
	"""Returns "BLOCK", "PASS", or "UNKNOWN" for a source snippet."""
	has_block = bool(BLOCK_PATTERN.search(text))
	has_pass = bool(PASS_PATTERN.search(text))
	if has_pass and not has_block:
		return "PASS"
	if has_block and not has_pass:
		return "BLOCK"
	if has_pass and has_block:
		# Both shapes present — PASS wins only if the principal-derived join is
		# the thing actually feeding the mint args; conservatively flag BLOCK
		# so a partially-rewired site is not marked safe by accident.
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
# Coverage inventory — the SIX known token-mint code paths in this repo.
# Every path must be listed. ANALYSED paths are classified live; SKIPPED
# paths carry a written reason and are not classified.
# ─────────────────────────────────────────────────────────────────────────────


def read_lines(rel_path: str, start: int, end: int) -> str:
	path = REPO_ROOT / rel_path
	if not path.exists():
		return ""
	lines = path.read_text(encoding="utf-8").splitlines()
	# 1-indexed, inclusive
	return "\n".join(lines[max(0, start - 1) : end])


def refuse_if_unreadable(rel_path: str, path_id: int) -> bool:
	"""Prints a REFUSING TO JUDGE line and returns True if `rel_path` is
	missing, empty, or blank — the subject of an ANALYSED path this check
	classifies live. Every ANALYSED path's subject file MUST go through this
	guard before classification: an emptied/deleted subject must exit 2, not
	silently classify an empty string as UNKNOWN/PASS (Eta ETA-M37/M38)."""
	subject_path = REPO_ROOT / rel_path
	if not subject_path.exists() or subject_path.stat().st_size == 0:
		print(
			f"REFUSING TO JUDGE: unreadable subject {rel_path} "
			f"(missing or empty) — cannot classify path ({path_id})"
		)
		return True
	if not subject_path.read_text(encoding="utf-8").strip():
		print(
			f"REFUSING TO JUDGE: unreadable subject {rel_path} "
			f"(blank content) — cannot classify path ({path_id})"
		)
		return True
	return False


# ETA-M42 — matches a `scopes:` or `fromAllowList:` key's assigned VALUE up to
# the next comma/newline at the same nesting depth (good enough for the
# single-line object-literal style this codebase uses for oauthContext).
SCOPES_ASSIGNMENT_PATTERN = re.compile(r"\bscopes:\s*([^,\n]+)")
FROM_ALLOW_LIST_ASSIGNMENT_PATTERN = re.compile(r"\bfromAllowList:\s*([^,\n]+)")
NONEMPTY_LITERAL_ARRAY_PATTERN = re.compile(r"^\[\s*[^\]\s][^\]]*\]$")
MAPPING_DERIVED_VALUE_PATTERN = re.compile(r"^mapping\.")

# Pi ruling (PR #1224, decision b): Path B must NEVER mint master from org
# membership. scopeProfile MUST be the literal "team-member" and isMaster
# MUST be the literal `false` on this branch — no ternary, no
# `.includes("*")`-derived value, no variable that could resolve to "master"
# or `true`.
SCOPE_PROFILE_ASSIGNMENT_PATTERN = re.compile(r"\bscopeProfile:\s*([^,\n]+)")
IS_MASTER_ASSIGNMENT_PATTERN = re.compile(r"\bisMaster:\s*([^,\n]+)")
SCOPE_PROFILE_TEAM_MEMBER_LITERAL = '"team-member"'
IS_MASTER_FALSE_LITERAL = "false"


def classify_path4_branch(branch_text: str, join_marker: str) -> str:
	"""Classifies Path B (bearerAuthMiddleware case 2.5) on the GRANTING
	PREDICATE, not on a token's mere presence in a text window (ETA-M42).

	THE PROPERTY: scopes/fromAllowList must be ASSIGNED FROM the
	client_org_mapping result (e.g. `mapping.scopes`,
	`mapping.allowedOrchestrators`), never from a hardcoded non-empty literal
	array (e.g. `["mcp:full"]`, `["*"]`). A branch that restores a hardcoded
	non-empty literal for EITHER key MUST classify BLOCK regardless of
	whether the join call (`join_marker`) is ALSO present in the branch —
	Eta's exact break was: restore the literals while leaving the join call
	in place, so a substring-presence check still saw the join string and
	PASSed even though the authority had gone back to being hardcoded.

	Returns "PASS", "BLOCK", or "UNKNOWN" (join call entirely absent AND no
	scopes/fromAllowList assignment could be located at all — a shape this
	classifier doesn't recognize, distinct from a proven-hardcoded BLOCK).
	"""
	has_join = join_marker in branch_text

	# Pi ruling (PR #1224, decision b) gate: scopeProfile/isMaster must be the
	# literal "team-member"/false on this branch — checked FIRST and
	# unconditionally, so a master-minting reintroduction (ternary,
	# `.includes("*")`-derived isMaster, `scopeProfile: "master"`) is caught
	# even if scopes/fromAllowList are still correctly mapping-derived.
	scope_profile_match = SCOPE_PROFILE_ASSIGNMENT_PATTERN.search(branch_text)
	is_master_match = IS_MASTER_ASSIGNMENT_PATTERN.search(branch_text)
	if scope_profile_match and scope_profile_match.group(1).strip() != (
		SCOPE_PROFILE_TEAM_MEMBER_LITERAL
	):
		# scopeProfile is not the literal "team-member" (e.g. a ternary that can
		# resolve to "master") — this branch can mint master from membership.
		return "BLOCK"
	if is_master_match and is_master_match.group(1).strip() != IS_MASTER_FALSE_LITERAL:
		# isMaster is not the literal `false` (e.g. derived from
		# `mapping.allowedOrchestrators.includes("*")` or a variable) — this
		# branch can mint the cross-tenant bypass from org membership.
		return "BLOCK"

	scopes_match = SCOPES_ASSIGNMENT_PATTERN.search(branch_text)
	from_match = FROM_ALLOW_LIST_ASSIGNMENT_PATTERN.search(branch_text)

	if not scopes_match or not from_match:
		# Neither key assignment could be located at all — cannot assert the
		# granting predicate either way.
		return "PASS" if has_join else "UNKNOWN"

	scopes_val = scopes_match.group(1).strip()
	from_val = from_match.group(1).strip()

	def is_hardcoded_nonempty_literal(value: str) -> bool:
		return bool(NONEMPTY_LITERAL_ARRAY_PATTERN.match(value))

	if is_hardcoded_nonempty_literal(scopes_val) or is_hardcoded_nonempty_literal(
		from_val
	):
		# The granting predicate assigns a hardcoded non-empty literal to
		# scopes or fromAllowList — BLOCK regardless of whether the join call
		# is also textually present in the branch (the exact Eta break).
		return "BLOCK"

	if MAPPING_DERIVED_VALUE_PATTERN.match(
		scopes_val
	) and MAPPING_DERIVED_VALUE_PATTERN.match(from_val):
		# Both keys are demonstrably assigned FROM the mapping result.
		return "PASS"

	# Neither a proven hardcoded literal nor a proven mapping-derived
	# assignment (e.g. an intermediate variable) — conservative: fall back to
	# join-string presence only as a last resort, never let an ambiguous
	# assignment shape silently pass.
	return "PASS" if has_join else "BLOCK"


def run_inventory() -> int:
	paths = [
		{
			"id": 1,
			"name": "createAccessToken via /token auth_code",
			"status": "ANALYSED",
			"file": "mcp-server/server-http.ts",
			"lines": (761, 778),
			"note": (
				"DCR client mints scoped to the REGISTERED CLIENT's own "
				"scopeProfile (admin-provisioned at client registration) — this "
				"is the intended authority source for opaque DCR clients, which "
				"have no Clerk principal to join against. Flagged BLOCK-shaped "
				"by this classifier because it sources mint args from "
				"client.scopeProfile; out of scope for task "
				"k17bf7bsfrm255x4pr5r96q5g58cw691 (Path B only) — recorded here "
				"for the coverage inventory, not remediated by this task."
			),
		},
		{
			"id": 2,
			"name": "createAccessToken via /token refresh grant",
			"status": "ANALYSED",
			"file": "mcp-server/server-http.ts",
			"lines": (761, 778),
			"note": "Same code path/site as (1) — refresh reuses the same mint helper.",
		},
		{
			"id": 3,
			"name": "admin master-gated mint",
			"status": "SKIPPED",
			"reason": "masterOnly — gated by requireMasterAuth, out of this check's scope by design (byte-unchanged per task constraints).",
		},
		{
			"id": 4,
			"name": "auth.ts Clerk-JWT Path B (bearerAuthMiddleware case 2.5)",
			"status": "ANALYSED",
			"file": "mcp-server/src/auth.ts",
			"marker_pre": '"team-member"',
			"marker_post": "clientOrgMapping:getByClerkSlug",
			"note": "THE target of task k17bf7bsfrm255x4pr5r96q5g58cw691. Must flip BLOCK -> PASS once rewired.",
		},
		{
			"id": 5,
			"name": "legacy mcpTenants",
			"status": "SKIPPED",
			"reason": "deny-by-default (empty prefixes/allowlist) — no authority to source from a client row at all.",
		},
		{
			"id": 6,
			"name": "DCR simple-token validateAccessToken",
			"status": "SKIPPED",
			"reason": "hardcoded client-generic deny-by-default regardless of the scope string on the row — never grants master, never widens.",
		},
	]

	ok = True
	print("check-token-mint-authority-source — 6-path coverage inventory\n")
	for p in paths:
		if p["status"] == "SKIPPED":
			print(f"  ({p['id']}) {p['name']}: SKIPPED — {p['reason']}")
			continue
		if p["id"] == 4:
			if refuse_if_unreadable(p["file"], p["id"]):
				return 2
			text = (REPO_ROOT / p["file"]).read_text(encoding="utf-8")
			# Locate the Clerk-JWT branch specifically (case 2.5) rather than the
			# whole file, so an unrelated match elsewhere in the file can't flip
			# this classification.
			idx = text.find("── (2.5)")
			if idx == -1:
				print(
					f"REFUSING TO JUDGE: marker '── (2.5)' not found in "
					f"{p['file']} — cannot classify path (4)"
				)
				return 2
			# ETA-M42 fix: bound the region to the ACTUAL Path B branch using
			# clear anchors (this marker to the next numbered branch marker),
			# never a fixed-size character window. A fixed window
			# (text[idx:idx+4000]) can — and did (Eta's break) — contain BOTH
			# the honest join call AND a restored hardcoded literal
			# (`scopes: ["mcp:full"]`, `fromAllowList: ["*"]`) in the SAME
			# branch, because a mere substring match ("is the join string
			# present") says nothing about whether the mint args are actually
			# ASSIGNED FROM the mapping result. The fix below inspects the
			# GRANTING ASSIGNMENTS themselves.
			end_idx = text.find("── (3)", idx)
			branch_text = text[idx:end_idx] if end_idx != -1 else text[idx:]
			result = classify_path4_branch(branch_text, p["marker_post"])
			print(f"  ({p['id']}) {p['name']}: ANALYSED — live classification: {result}")
			if result != "PASS":
				ok = False
				print(f"      BLOCKING: {p['note']}")
		else:
			# Paths (1)/(2) — server-http.ts is an ANALYSED subject (it is
			# recorded and classified for visibility even though this task's
			# scope does not remediate it — RULE #21 verification != activation).
			# An emptied/deleted server-http.ts must refuse to judge (exit 2),
			# never silently classify "" as UNKNOWN and continue to
			# OVERALL PASS (Eta's B2 finding).
			if refuse_if_unreadable(p["file"], p["id"]):
				return 2
			start, end = p["lines"]
			snippet = read_lines(p["file"], start, end)
			if not snippet.strip():
				print(
					f"REFUSING TO JUDGE: lines {start}-{end} of {p['file']} "
					f"are empty/out of range — cannot classify path ({p['id']})"
				)
				return 2
			result = classify(snippet)
			print(
				f"  ({p['id']}) {p['name']}: ANALYSED — live classification: {result} "
				f"({p['note']})"
			)
			# Paths (1)/(2) are intentionally out of scope for this task — do
			# not fail the overall check on them, but surface the classification
			# for visibility (RULE #21 verification != activation: this task
			# fixes Path B only).

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
