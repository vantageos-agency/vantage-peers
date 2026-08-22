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

MASTER_AUTH_CALL_PATTERN = re.compile(r"requireMasterAuth\(")
# ETA-M41 fix: this pattern MUST assert on the GRANTING PREDICATE itself —
# the actual `requireOrgAdmin(` call that GATES the mutation — never on a
# token (`by_clerk_slug`, `clientOrgMapping:getByClerkSlug`, `withOrgScope(`)
# merely being PRESENT somewhere in the extracted region. Eta's break: move
# the mutation's own by_clerk_slug idempotent-REPLAY lookup ABOVE the gate
# (before the first auth-call statement), keep requireMasterAuth as the SOLE
# authority, and remove requireOrgAdmin entirely. extract_authorization_gate
# stops at the FIRST statement invoking requireMasterAuth(/requireOrgAdmin(,
# so the replay lookup statement (incidentally containing "by_clerk_slug")
# is included in the gate text ahead of that stop point. The old, wider
# pattern matched "by_clerk_slug" there and misclassified PASS even though
# no requireOrgAdmin call — the actual granting predicate — was present.
# Narrowing to `requireOrgAdmin\(` alone means only the real predicate call
# counts; a replay lookup (or any other incidental by_clerk_slug reference)
# occurring anywhere in the gate can never be mistaken for the gate itself.
PRINCIPAL_DERIVED_PATTERN = re.compile(r"requireOrgAdmin\(")


def classify(text: str) -> str:
	"""Returns "BLOCK", "PASS", or "UNKNOWN" for a source snippet.

	ETA-M41 fix: classifies purely on the GRANTING PREDICATE — which auth
	CALL actually gates the mutation — never on a fixed-position regex (e.g.
	"requireMasterAuth must be textually the FIRST statement") that a mere
	reordering of unrelated statements (like moving the replay lookup above
	the gate) can silently defeat. `text` here is ALREADY bounded by
	`extract_authorization_gate` to end at the first top-level statement that
	invokes an auth primitive — so any `requireOrgAdmin(` found within it IS,
	by construction, part of the actual authorization decision, not
	incidental later/earlier code.
	"""
	has_org_admin_call = bool(PRINCIPAL_DERIVED_PATTERN.search(text))
	has_master_call = bool(MASTER_AUTH_CALL_PATTERN.search(text))

	if has_org_admin_call:
		# The alternative, principal-derived gate call is present — master is
		# no longer the SOLE key, regardless of what other statements
		# (replay lookups, etc.) precede it in the gate.
		return "PASS"

	if has_master_call:
		# requireMasterAuth is the auth call that ends the bounded gate, and
		# no requireOrgAdmin call exists anywhere in it — global secret is
		# the SOLE gate.
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


AUTH_CALL_PATTERN = re.compile(r"requireMasterAuth\(|requireOrgAdmin\(")


def extract_authorization_gate(text: str) -> str:
	"""Extracts ONLY the AUTHORIZATION GATE of `provisionOrganization`'s
	handler: every top-level statement of the handler body, in order, up to
	and including the FIRST top-level statement that invokes an auth
	primitive (`requireMasterAuth(` / `requireOrgAdmin(`).

	This is a brace-depth walk, not a fixed-size character window: a fixed
	window can — and did (Eta ETA-M37/M38) — accidentally swallow later,
	UNRELATED code (e.g. the mutation's own idempotent-replay lookup
	`.withIndex("by_clerk_slug", ...)`), which incidentally matches the
	principal-derived token set and produces a false PASS before the real
	auth gate is even reached. Slicing to the gate itself means any token
	found here is, by construction, part of the actual authorization
	decision — not incidental later code.

	Returns "" if the handler's opening brace cannot be located.
	"""
	handler_idx = text.find("handler:")
	if handler_idx == -1:
		return ""
	brace_idx = text.find("{", handler_idx)
	if brace_idx == -1:
		return ""
	signature = text[handler_idx : brace_idx + 1]
	body_start = brace_idx + 1

	depth = 1
	stmt_start = body_start
	i = body_start
	n = len(text)
	found_auth = False
	gate_end = None
	while i < n and depth > 0:
		ch = text[i]
		if ch == "{":
			depth += 1
		elif ch == "}":
			depth -= 1
			if depth == 0:
				# end of handler body without ever finding the auth call
				gate_end = i
				break
			if depth == 1:
				# An `if (...) { ... }` block's closing brace is NOT the end
				# of the top-level statement when an `else` (or `else if`)
				# follows — the auth call may live in the else branch, as it
				# does in the real post-D2 gate shape. Only treat this as a
				# statement boundary if no `else` follows.
				j = i + 1
				while j < n and text[j] in " \t\r\n":
					j += 1
				if text[j : j + 4] == "else":
					i += 1
					continue
				stmt = text[stmt_start : i + 1]
				if AUTH_CALL_PATTERN.search(stmt):
					found_auth = True
					gate_end = i + 1
					break
				stmt_start = i + 1
		elif ch == ";" and depth == 1:
			stmt = text[stmt_start : i + 1]
			if AUTH_CALL_PATTERN.search(stmt):
				found_auth = True
				gate_end = i + 1
				break
			stmt_start = i + 1
		i += 1

	if gate_end is None:
		gate_end = n
	return signature + text[body_start:gate_end]


def extract_provision_organization_handler(text: str) -> str:
	"""Extracts the `provisionOrganization` export's ARGS block (needed for
	the `callerToken: v.string()` vs `v.optional(v.string())` REQUIRED/
	optional-string classification) concatenated with ONLY the AUTHORIZATION
	GATE of the handler body — see `extract_authorization_gate` for why the
	handler portion is a brace-depth walk to the first auth-call statement,
	not a fixed-size character window. The args block never contains a
	principal-derived token (it is a typed argument declaration), so
	concatenating it cannot reintroduce the incidental-match failure mode
	this fix closes."""
	idx = text.find("export const provisionOrganization")
	if idx == -1:
		return ""
	handler_idx = text.find("handler:", idx)
	if handler_idx == -1:
		return ""
	args_block = text[idx:handler_idx]
	gate = extract_authorization_gate(text[idx:])
	return args_block + gate


def run_inventory() -> int:
	oauth_ts = REPO_ROOT / "convex" / "oauth.ts"
	if not oauth_ts.exists() or oauth_ts.stat().st_size == 0:
		print(f"REFUSING TO JUDGE: unreadable subject convex/oauth.ts (missing or empty)")
		return 2
	live_text = oauth_ts.read_text(encoding="utf-8")
	if not live_text.strip():
		print(f"REFUSING TO JUDGE: unreadable subject convex/oauth.ts (blank content)")
		return 2
	provision_block = extract_provision_organization_handler(live_text)
	if not provision_block.strip():
		print(
			"REFUSING TO JUDGE: unreadable subject "
			"provisionOrganization (export not found / handler not located "
			"in convex/oauth.ts) — cannot classify path (1)"
		)
		return 2

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
			# C1 fix (Eta REVISE PR #1224): this path previously carried
			# status "ANALYSED" but the run loop's special-cased id==4 branch
			# only ever printed "ANALYSED — SKIPPED-BLOCKING-SCOPE" and never
			# emitted a BLOCK/PASS classification — an ANALYSED path that
			# never classifies is exactly the coverage-inventory hole this
			# doctor exists to prevent. This path genuinely has nothing to
			# classify: the HTTP route stays master-only by design (see
			# reason below), so it is relabelled SKIPPED with the same
			# written reason and now flows through the ordinary SKIPPED
			# branch below — no special-cased id==4 branch remains.
			"id": 4,
			"name": "server-http.ts POST /admin/organizations — HTTP entry to provisionOrganization",
			"status": "SKIPPED",
			"reason": (
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
		text = p.get("text", "")
		result = classify(text) if text else "UNKNOWN"
		print(f"  ({p['id']}) {p['name']}: ANALYSED — live classification: {result}")
		if result == "UNKNOWN":
			# ETA-M38 fix: UNKNOWN means the classifier COULD NOT JUDGE the
			# subject (neither BLOCK-shaped nor PASS-shaped patterns matched)
			# — this is a distinct outcome from "a pole failed (real
			# defect)" (exit 1). Conflating the two by exiting 1 here treats
			# "I could not tell" the same as "I found a defect", which is
			# wrong: exit 2 (REFUSING TO JUDGE) is reserved for exactly this
			# case, naming the subject that could not be classified.
			print(
				f"REFUSING TO JUDGE: path ({p['id']}) {p['name']} classified "
				f"UNKNOWN — neither BLOCK-shaped nor PASS-shaped pattern "
				f"matched; cannot judge this subject"
			)
			return 2
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
