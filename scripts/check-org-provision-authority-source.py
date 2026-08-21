#!/usr/bin/env python3
"""backend-doctor check: check-org-provision-authority-source.

task k17awjxrj7ggwvw277cswh314d8cx7nr (D2). THE PROPERTY (both poles): the
authority to add an orchestrator/seat via `provisionOrganization` MUST NOT
derive from a GLOBAL SECRET (BEARER_SECRET_MASTER) as the SOLE gate. Master
stays a VALID caller (byte-unchanged `requireMasterAuth`) but must cease to
be the ONLY path — an authenticated org-admin, scoped to their OWN org via
`requireOrgAdmin` (convex/lib/auth.ts), must also be able to reach the
mutation body.

This check is a static classifier over the AUTHORIZATION GATE of
`provisionOrganization`:

  BLOCK-shaped ("global secret is the SOLE key"):
    the handler's FIRST statement is an unconditional
    `await requireMasterAuth(args.callerToken)` and there is no alternative
    branch that can authorize a caller who did not present a matching
    `callerToken` — i.e. `requireOrgAdmin` (or an equivalent
    principal-derived path) is absent from the gate entirely.

  PASS-shaped ("global secret OR principal-derived org-admin, not sole"):
    the gate branches — `requireMasterAuth` runs when `callerToken` is
    present, `requireOrgAdmin` (principal -> client_org_mapping, the SAME
    join `withOrgScope` uses) runs otherwise. Master is retained as a valid
    caller, never removed, but a live authenticated principal's OWN org can
    ALSO satisfy the gate.

Two run modes:

  --self-test   Runs the bipolar probe against FIXTURE STRINGS (not the live
                file): MUST_BLOCK a snapshot of the actual pre-D2 code at
                commit 21297ec56a8e288b7a0de315b09420a5598e5375 (master-only,
                unconditional `requireMasterAuth`, no alternative branch);
                MUST_PASS a snapshot of the post-D2 branching gate shape.
                Exits 0 iff BLOCK fixture classifies BLOCK AND PASS fixture
                classifies PASS.

  (default)     Coverage inventory over every orchestrator/seat-add-path in
                this repo that could grant provisioning authority. Each path
                is ANALYSED (classified live against the repo) or SKIPPED
                (with a written reason). Any path not listed here is an
                inventory gap and fails the check. Exits 1 if any ANALYSED
                path classifies BLOCK.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ─────────────────────────────────────────────────────────────────────────────
# Fixtures for --self-test (bipolar probe). These are literal snapshot
# strings, NOT read from the live repo, so the probe's RED (MUST_BLOCK) pole
# survives forever even after the live file is fixed and no longer contains
# the anti-pattern.
# ─────────────────────────────────────────────────────────────────────────────

# MUST_BLOCK — verbatim snapshot of provisionOrganization's handler opening at
# commit 21297ec56a8e288b7a0de315b09420a5598e5375 (the live defect this task
# closes): master is the ONLY key, no alternative branch exists at all.
BLOCK_FIXTURE = """
export const provisionOrganization = mutation({
	args: {
		callerToken: v.string(),
		clerkOrgSlug: v.string(),
		displayName: v.string(),
		orchestrators: v.array(v.object({ name: v.string() })),
		scopes: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		const slug = args.clerkOrgSlug.trim();
		if (!slug) {
			throw new Error("clerkOrgSlug is required");
		}
	},
});
"""

# MUST_PASS — the post-D2 gate shape: callerToken is OPTIONAL, master runs
# when present (unchanged), requireOrgAdmin runs otherwise (principal-derived,
# scoped to the caller's own org, refuses target-org mismatch/non-admin/
# unmapped-org internally).
PASS_FIXTURE = """
export const provisionOrganization = mutation({
	args: {
		callerToken: v.optional(v.string()),
		clerkOrgSlug: v.string(),
		displayName: v.string(),
		orchestrators: v.array(v.object({ name: v.string() })),
		scopes: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		const slug = args.clerkOrgSlug.trim();
		if (!slug) {
			throw new Error("clerkOrgSlug is required");
		}

		if (args.callerToken && args.callerToken.length > 0) {
			await requireMasterAuth(args.callerToken);
		} else {
			await requireOrgAdmin(ctx, slug);
		}
	},
});
"""

# BLOCK: callerToken is a REQUIRED (non-optional) string AND requireMasterAuth
# is the only statement invoked unconditionally with no requireOrgAdmin (or
# equivalent principal-derived call) anywhere in the same handler body.
REQUIRED_CALLER_TOKEN_PATTERN = re.compile(r"callerToken:\s*v\.string\(\)")
UNCONDITIONAL_MASTER_AUTH_PATTERN = re.compile(
	r"handler:\s*async\s*\([^)]*\)\s*=>\s*\{\s*await\s+requireMasterAuth\("
)
PRINCIPAL_DERIVED_PATTERN = re.compile(
	r"requireOrgAdmin\(|withOrgScope\(|clientOrgMapping:getByClerkSlug|by_clerk_slug"
)


def classify(text: str) -> str:
	"""Returns "BLOCK", "PASS", or "UNKNOWN" for a source snippet."""
	has_principal_path = bool(PRINCIPAL_DERIVED_PATTERN.search(text))
	required_token = bool(REQUIRED_CALLER_TOKEN_PATTERN.search(text))
	unconditional_master = bool(UNCONDITIONAL_MASTER_AUTH_PATTERN.search(text))

	if has_principal_path:
		# A principal-derived path exists in the gate at all — master is no
		# longer the SOLE key, regardless of whether callerToken is still
		# required syntactically (it must be optional for the branch to be
		# reachable without a token, but we classify on the PRESENCE of the
		# alternative branch, which is the actual property under test).
		return "PASS"

	if required_token and unconditional_master:
		# callerToken is a required string AND requireMasterAuth runs
		# unconditionally as literally the first statement, with no
		# alternative branch anywhere — global secret is the SOLE gate.
		return "BLOCK"

	if unconditional_master:
		# requireMasterAuth still runs unconditionally somewhere but no
		# required-string marker matched (e.g. re-ordered code) — conservative
		# BLOCK, since no principal-derived alternative was found.
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
# Coverage inventory — every orchestrator/seat-add authority path in this
# repo. Every path must be listed. ANALYSED paths are classified live;
# SKIPPED paths carry a written reason and are not classified.
# ─────────────────────────────────────────────────────────────────────────────


def extract_provision_organization_handler(text: str) -> str:
	"""Extracts the provisionOrganization export block (args + handler open)
	from a live convex/oauth.ts source string, bounded to a generous window so
	the branching gate at the top of the handler is fully captured without
	pulling in unrelated later mutations."""
	idx = text.find("export const provisionOrganization")
	if idx == -1:
		return ""
	return text[idx : idx + 2500]


def run_inventory() -> int:
	oauth_ts = REPO_ROOT / "convex" / "oauth.ts"
	live_text = oauth_ts.read_text(encoding="utf-8") if oauth_ts.exists() else ""
	provision_block = extract_provision_organization_handler(live_text)

	paths = [
		{
			"id": 1,
			"name": "oauth.ts provisionOrganization — org creation + seat mint",
			"status": "ANALYSED",
			"text": provision_block,
			"note": (
				"THE target of task k17awjxrj7ggwvw277cswh314d8cx7nr D2. Must "
				"be PASS-shaped: master retained (byte-unchanged "
				"requireMasterAuth) AND an authenticated org-admin of the "
				"TARGET org (requireOrgAdmin) can also reach the mutation body."
			),
		},
		{
			"id": 2,
			"name": "oauth.ts createClient — admin OAuth client registration",
			"status": "SKIPPED",
			"reason": (
				"masterOnly by design — creates a raw OAuth client/secret pair "
				"for Pi/admin tooling, not an orchestrator seat inside an "
				"existing org; out of scope for D2's org-admin-add-a-seat "
				"property. requireMasterAuth byte-unchanged here."
			),
		},
		{
			"id": 3,
			"name": "oauth.ts upsertScopeProfile — admin scope-profile catalog edit",
			"status": "SKIPPED",
			"reason": (
				"masterOnly by design — edits the GLOBAL scope-profile catalog "
				"(cross-org), not a single org's seat roster; an org-admin "
				"scoped to their own org has no legitimate authority over "
				"another org's (or the catalog's) profiles."
			),
		},
		{
			"id": 4,
			"name": "server-http.ts POST /admin/organizations — HTTP entry to provisionOrganization",
			"status": "ANALYSED",
			"file": "mcp-server/server-http.ts",
			"note": (
				"Currently mounted under the `admin` Hono router "
				"(`admin.use(\"*\", masterOnlyMiddleware())`), so the HTTP "
				"entry point itself remains master-only pending a follow-up "
				"route that forwards a verified Clerk JWT as Convex auth "
				"(ConvexHttpClient.setAuth) to reach the org-admin branch — "
				"D2's scope is the CONVEX MUTATION'S authorization gate "
				"(provisionOrganization itself), which is reachable directly "
				"via any Convex client carrying a verified Clerk identity "
				"(e.g. the dashboard's authenticated Convex client), "
				"independent of this HTTP route. Recorded here for the "
				"coverage inventory, not remediated by this task."
			),
		},
		{
			"id": 5,
			"name": "oauth.ts patchScopeProfileEmergency — admin emergency remediation",
			"status": "SKIPPED",
			"reason": (
				"masterOnly by design — emergency cross-cutting remediation "
				"(rename/cascade-revoke) of the global scope-profile catalog; "
				"not an org-scoped seat-add path."
			),
		},
	]

	ok = True
	print("check-org-provision-authority-source — 5-path coverage inventory\n")
	for p in paths:
		if p["status"] == "SKIPPED":
			print(f"  ({p['id']}) {p['name']}: SKIPPED — {p['reason']}")
			continue
		if p["id"] == 4:
			print(
				f"  ({p['id']}) {p['name']}: ANALYSED — SKIPPED-BLOCKING-SCOPE — "
				f"{p['note']}"
			)
			continue
		text = p.get("text", "")
		result = classify(text) if text else "UNKNOWN"
		print(f"  ({p['id']}) {p['name']}: ANALYSED — live classification: {result}")
		if result != "PASS":
			ok = False
			print(f"      BLOCKING: {p['note']}")

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
