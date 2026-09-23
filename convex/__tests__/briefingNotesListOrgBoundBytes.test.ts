/// <reference types="vite/client" />
//
// briefingNotesListOrgBoundBytes.test.ts — GitHub issue #1294 RED-first.
//
// Production error (recurring, 24h+, fleet-wide): `briefingNotes:list` threw
// "Uncaught Error: Too many bytes read in a single function execution
// (limit: 16777216 bytes)". The GitHub issue cited convex/briefingNotes.ts:372
// as the offending line, but that reference is STALE — it now lands inside
// the RBAC_DENIED scope guard added by #1316, which reads zero bytes. The
// scan that actually reads the bytes is `list`'s non-updatedSince fetch,
// further down the handler.
//
// Root cause: a non-master (org-scoped, multi-tenant) caller ALWAYS has
// `needsVisibilityFilter=true` (every org caller needs its own orgId
// isolation check), so it ALWAYS reached the widened
// `fetchCap = BRIEFING_NOTES_LIST_SCAN_CAP + 1` path -- regardless of
// whether `updatedSince` was supplied. When no `topic` filter was given
// either, the pre-fix code ran `ctx.db.query("briefingNotes").order("desc")
// .take(fetchCap)` -- a full, UNINDEXED scan across EVERY tenant's rows,
// reading full `content` bytes for organizations the caller doesn't even
// belong to, THEN filtering to the caller's own orgId afterward. Growth
// tracked the GLOBAL cross-tenant corpus, not the caller's own org's data.
// The topic-filtered branch had the identical defect one level narrower:
// `by_topic` alone, with no orgId prefix, read every OTHER org's rows that
// merely share a topic.
//
// The fix pushes the org bound INTO the query via a new orgId-prefixed
// index (`by_orgId` / `by_orgId_topic`, convex/schema.ts) for every
// non-master caller -- growth now tracks THIS org's own row count, never
// the platform-wide corpus -- and wraps every non-updatedSince scan branch
// in the same `fetchCappedOrOverflow` helper already used by the
// updatedSince branches, so any residual overflow degrades to our own
// SCAN_CAP_EXCEEDED ConvexError instead of the raw platform crash.
//
// RED-before / GREEN-after: run with `git stash` on convex/briefingNotes.ts
// + convex/schema.ts to see the no-topic case throw the raw "Read too much
// data ... (limit: 16777216 bytes)" platform error for an org-scoped caller
// that owns ZERO of the seeded rows; GREEN on HEAD (that caller's own org
// has no matching rows, so the indexed scan reads ~0 bytes and returns an
// empty page instead of touching the other org's content at all).
//
// convex-test's HeadroomTracker (`transactionLimits: true`) enforces the
// REAL platform ceiling (16777216 bytes) locally -- this is not a proxy
// assertion, it is the same numeric limit production hits.
//
// Fictitious identifiers only -- no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

async function seedOrgMapping(
	t: ReturnType<typeof createTestConvex>,
	slug: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: ["*"],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrg(t: ReturnType<typeof createTestConvex>, orgSlug: string) {
	return t.withIdentity({
		subject: `user-${orgSlug}`,
		organizationId: orgSlug,
	} as Parameters<typeof t.withIdentity>[0]);
}

// ~220KB per row -- same fixture scale as the existing #1260
// briefing-notes-updatedsince-bytes.test.ts regression, proven there to blow
// the 16MB ceiling at 90 rows.
const LARGE_CONTENT = "x".repeat(220_000);
const OTHER_ORG_ROW_COUNT = 90;
const WRITE_CHUNK = 30; // keep each seed transaction's own bytesWritten under 16MB.

async function seedOtherOrgRows(
	t: ReturnType<typeof createTestConvex>,
	opts: { topic: string; orgId: string },
) {
	for (let chunk = 0; chunk < OTHER_ORG_ROW_COUNT; chunk += WRITE_CHUNK) {
		const end = Math.min(chunk + WRITE_CHUNK, OTHER_ORG_ROW_COUNT);
		await t.run(async (ctx) => {
			for (let i = chunk; i < end; i++) {
				await ctx.db.insert("briefingNotes", {
					title: `cross-tenant-fixture-note-${i}`,
					topic: opts.topic,
					participants: [],
					content: LARGE_CONTENT,
					createdBy: "system",
					createdAt: Date.now() + i,
					orgId: opts.orgId,
				} as never);
			}
		});
	}
}

describe("briefingNotes.list -- non-master scan is org-bound, not corpus-bound (issue #1294)", () => {
	test("no-topic branch: a caller's own org has zero rows, but 90x220KB rows exist in ANOTHER org -- must not read those bytes at all", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		await seedOrgMapping(t, "acme-hr");
		await seedOtherOrgRows(t, { topic: "some-shared-topic", orgId: "other-org" });

		// GREEN (post-fix): the by_orgId index for "acme-hr" matches nothing --
		// zero bytes of the other org's content are ever read.
		const result = await asOrg(t, "acme-hr").query(api.briefingNotes.list, {
			fields: "full",
		});
		expect(Array.isArray(result) ? result.length : 0).toBe(0);
	});

	test("topic branch: a caller's own org has zero rows for a topic shared with ANOTHER org's 90x220KB rows -- must not read those bytes at all", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const TOPIC = "cross-tenant-shared-topic";
		await seedOrgMapping(t, "acme-hr");
		await seedOtherOrgRows(t, { topic: TOPIC, orgId: "other-org" });

		const result = await asOrg(t, "acme-hr").query(api.briefingNotes.list, {
			topic: TOPIC,
			fields: "full",
		});
		expect(Array.isArray(result) ? result.length : 0).toBe(0);
	});

	test("cross-tenant isolation is preserved: the caller's OWN org's rows are still returned in full", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		await seedOrgMapping(t, "acme-hr");
		await seedOtherOrgRows(t, { topic: "some-shared-topic", orgId: "other-org" });
		await t.run(async (ctx) => {
			await ctx.db.insert("briefingNotes", {
				title: "acme-hr-own-note",
				topic: "some-shared-topic",
				participants: [],
				content: "small own-org content",
				createdBy: "system",
				createdAt: Date.now() + 1_000_000,
				orgId: "acme-hr",
			} as never);
		});

		const result = await asOrg(t, "acme-hr").query(api.briefingNotes.list, {
			fields: "full",
		});
		const items = (result ?? []) as Array<Record<string, unknown>>;
		expect(items.length).toBe(1);
		expect(items[0].title).toBe("acme-hr-own-note");
	});
});
