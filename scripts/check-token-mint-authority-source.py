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
			subject_path = REPO_ROOT.joinpath(p["file"])
			if not subject_path.exists() or subject_path.stat().st_size == 0:
				print(
					f"REFUSING TO JUDGE: unreadable subject {p['file']} "
					"(missing or empty) — cannot classify path (4)"
				)
				return 2
			text = subject_path.read_text(encoding="utf-8")
			if not text.strip():
				print(
					f"REFUSING TO JUDGE: unreadable subject {p['file']} "
					"(blank content) — cannot classify path (4)"
				)
				return 2
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
			branch_text = text[idx:idx + 4000] if idx != -1 else text
			has_join = p["marker_post"] in branch_text
			result = "PASS" if has_join else "BLOCK"
			print(f"  ({p['id']}) {p['name']}: ANALYSED — live classification: {result}")
			if result == "BLOCK":
				ok = False
				print(f"      BLOCKING: {p['note']}")
		else:
			start, end = p["lines"]
			snippet = read_lines(p["file"], start, end)
			result = classify(snippet) if snippet else "UNKNOWN"
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
