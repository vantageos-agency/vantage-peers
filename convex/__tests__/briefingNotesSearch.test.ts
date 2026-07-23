/// <reference types="vite/client" />
//
// PR #754 v2.11.0 — Eta REVISE fix: cross-org isolation for
// searchBriefingNotesByKeyword.
//
// A Clerk-scoped (non-master) caller MUST NOT read briefingNotes from foreign
// orgs. Eta blocker on first review: the original handler was FAIL-OPEN
// (no withOrgScope, no orgId filter). This test pins the fix.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

async function seedOrgMapping(
	t: ReturnType<typeof createTestConvex>,
	clerkOrgSlug: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["victor"],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedNote(
	t: ReturnType<typeof createTestConvex>,
	opts: { title: string; content: string; orgId?: string },
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("briefingNotes", {
			title: opts.title,
			topic: "daily",
			participants: ["sigma"],
			content: opts.content,
			createdBy: "sigma",
			createdAt: Date.now(),
			orgId: opts.orgId,
		});
	});
}

describe("searchBriefingNotesByKeyword — cross-org isolation", () => {
	test("Clerk-scoped caller cannot read foreign-org briefingNotes", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "acme-hr");
		await seedOrgMapping(t, "other-org");
		await seedNote(t, {
			title: "iris secret",
			content: "alpha bravo charlie iris",
			orgId: "acme-hr",
		});
		await seedNote(t, {
			title: "other secret",
			content: "alpha bravo charlie other",
			orgId: "other-org",
		});
		await seedNote(t, {
			title: "fleet master note",
			content: "alpha bravo charlie fleet",
		});

		const tIris = t.withIdentity({
			subject: "user-iris",
			organizationId: "acme-hr",
		} as Parameters<typeof t.withIdentity>[0]);

		const results = await tIris.query(
			api.briefingNotes.searchBriefingNotesByKeyword,
			{ query: "alpha bravo charlie" },
		);

		const titles = results.map((r) => r.title).sort();
		expect(titles).not.toContain("other secret");
		expect(titles).not.toContain("fleet master note");
	});

	test("master (no identity) sees all briefingNotes", async () => {
		const t = createTestConvex();
		await seedNote(t, {
			title: "iris note",
			content: "match query token",
			orgId: "acme-hr",
		});
		await seedNote(t, {
			title: "other note",
			content: "match query token",
			orgId: "other-org",
		});
		await seedNote(t, {
			title: "fleet note",
			content: "match query token",
		});

		const results = await t.query(
			api.briefingNotes.searchBriefingNotesByKeyword,
			{ query: "match query token" },
		);

		expect(results.length).toBe(3);
	});
});
