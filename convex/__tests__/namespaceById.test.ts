/// <reference types="vite/client" />
// allow-missing-refs: new file this agent creates
//
// Team namespaces are keyed by the organisation's permanent Clerk org ID
// (`team/<clerkOrgId>`), never by `team/<orgSlug>`. A slug is a renamable label:
// a rename must not strand an org's namespace, and a freed slug taken by a NEW
// organisation must not re-point the old namespace to it.
//
// Every pole runs under an ordinary scoped, NON-master identity. A suite
// authenticated as the service account would pass with the gate deleted.
//
// Fictitious identifiers only. Hermetic: no deployment is touched.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

// storeMemory schedules a RAG sync; freeze time so it is queued, never run.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const ACME = { id: "org_ACMEID1", slug: "acme-old" };
const BETA = { id: "org_BETAID1", slug: "beta-co" };
const NOW = 1_700_000_000_000;

async function seedMapping(
	t: T,
	org: { id: string; slug: string },
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: org.slug,
			clerkOrgId: org.id,
			allowedOrchestrators: ["seat-x"],
			scopes: ["view-own-tasks"],
			displayName: org.slug,
			isActive: true,
			createdAt: NOW,
		});
	});
}

async function renameOrg(t: T, orgId: string, toSlug: string): Promise<void> {
	await t.run(async (ctx) => {
		const rows = await ctx.db.query("client_org_mapping").collect();
		const row = rows.find((r) => r.clerkOrgId === orgId);
		if (row === undefined) throw new Error(`no mapping for ${orgId}`);
		await ctx.db.patch(row._id, { clerkOrgSlug: toSlug, displayName: toSlug });
	});
}

async function seedMemory(
	t: T,
	namespace: string,
	content: string,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("memories", {
			namespace,
			type: "project",
			content,
			createdBy: "seat-x",
			relations: [],
			isLatest: true,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

// An ordinary member session: the org_id claim is the identity, the slug claim
// is display text and follows the rename.
const member = (t: T, org: { id: string }, slugClaim: string) =>
	t.withIdentity({
		subject: `user-of-${org.id}`,
		organizationId: slugClaim,
		org_slug: slugClaim,
		org_id: org.id,
	} as Parameters<T["withIdentity"]>[0]);

describe("team namespace is keyed by the org ID", () => {
	test("a renamed org keeps its team namespace (same clerkOrgId, new slug)", async () => {
		const t = createT();
		await seedMapping(t, ACME);
		await seedMemory(t, `team/${ACME.id}`, "acme own memory");
		await seedMemory(
			t,
			`team/${ACME.id}/docs`,
			"acme own sub-namespace memory",
		);

		await renameOrg(t, ACME.id, "acme-renamed");
		const asAcme = member(t, ACME, "acme-renamed");

		const own = await asAcme.query(api.memories.listMemories, {
			namespace: `team/${ACME.id}`,
		});
		expect(own.value.map((m) => m.content)).toEqual(["acme own memory"]);

		const sub = await asAcme.query(api.memories.listMemories, {
			namespace: `team/${ACME.id}/docs`,
		});
		expect(sub.value.length).toBe(1);

		// The write door admits the same namespace after the rename.
		const id = await asAcme.mutation(api.memories.storeMemory, {
			namespace: `team/${ACME.id}`,
			type: "project",
			content: "written after the rename",
			createdBy: "seat-x",
		});
		expect(typeof id).toBe("string");
	});

	test("a reused slug does not see the old org's rows", async () => {
		const t = createT();
		// Acme owned the slug "shared-slug" and its rows are stored under it
		// (the pre-migration form), then Acme is renamed away and the slug is
		// freed.
		await seedMapping(t, { id: ACME.id, slug: "shared-slug" });
		await seedMemory(t, "team/shared-slug", "acme legacy row");
		await renameOrg(t, ACME.id, "acme-renamed");
		// A NEW organisation takes the freed slug.
		await seedMapping(t, { id: BETA.id, slug: "shared-slug" });

		const asBeta = member(t, BETA, "shared-slug");
		const seen = await asBeta.query(api.memories.listMemories, {
			namespace: "team/shared-slug",
		});
		expect(seen.value).toEqual([]);

		// The slug-keyed namespace is not writable by the slug's new holder.
		await expect(
			asBeta.mutation(api.memories.storeMemory, {
				namespace: "team/shared-slug",
				type: "project",
				content: "beta writing into the old slug",
				createdBy: "seat-x",
			}),
		).rejects.toThrow("RBAC_DENIED");
	});

	test("RBAC_DENIED: another org is refused at the write door, by ID, never an empty success", async () => {
		const t = createT();
		await seedMapping(t, ACME);
		await seedMapping(t, BETA);
		await seedMemory(t, `team/${ACME.id}`, "acme secret");

		const asBeta = member(t, BETA, BETA.slug);
		await expect(
			asBeta.mutation(api.memories.storeMemory, {
				namespace: `team/${ACME.id}`,
				type: "project",
				content: "beta into acme",
				createdBy: "seat-x",
			}),
		).rejects.toThrow("RBAC_DENIED");

		// A namespace whose segment is a PREFIX of the caller's own ID is not the
		// caller's: the match is on a segment boundary.
		await expect(
			asBeta.mutation(api.memories.storeMemory, {
				namespace: `team/${BETA.id}x`,
				type: "project",
				content: "segment boundary",
				createdBy: "seat-x",
			}),
		).rejects.toThrow("RBAC_DENIED");
	});

	test("the org's own namespace is served by ID under its current slug", async () => {
		const t = createT();
		await seedMapping(t, ACME);
		await seedMemory(t, `team/${ACME.id}`, "acme own memory");
		const asAcme = member(t, ACME, ACME.slug);
		const own = await asAcme.query(api.memories.listMemories, {
			namespace: `team/${ACME.id}`,
		});
		expect(own.value.length).toBe(1);
	});
});
