/// <reference types="vite/client" />
/**
 * memories.storeMemory / memories.softDeleteMemory — write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): both mutations performed no identity/scope
 * check at all — no ctx.auth.getUserIdentity, no withOrgScope, no
 * namespace-prefix check. A direct call to the public Convex deployment
 * (bypassing the MCP server's guardWrite/guardMasterOnly layer) could write
 * into, or supersede/delete, any organisation's namespace. This is the class
 * of defect .claude/rules/authority-attached-to-anonymous-object.md and
 * .claude/rules/http-boundary-derives-from-principal.md describe: a write
 * surface must derive authority from the verified caller (withOrgScope),
 * never trust the client-supplied namespace/memoryId alone.
 *
 * Reads (listMemories/getMemory) already enforce scope via
 * isNamespaceAllowedForScope + withOrgScope (convex/memories.ts). This suite
 * proves the two writes now match that same enforcement, both poles.
 */

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

// Freeze time so scheduled functions (ctx.scheduler.runAfter, used by
// storeMemory/softDeleteMemory for RAG sync) are queued but never executed
// by convex-test's setTimeout — mirrors convex/tests.test.ts's pattern to
// avoid "Write outside of transaction" errors from the excluded ragSync
// module.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["dummy-a"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedOrgBMemory(t: ReturnType<typeof createT>, namespace = "team/org-b/secrets") {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("memories", {
			namespace,
			type: "project",
			content: "org-b secret content",
			createdBy: "dummy-b",
			relations: [],
			isLatest: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

describe("memories.storeMemory — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await expect(
			t.mutation(api.memories.storeMemory, {
				namespace: "team/org-a/notes",
				type: "project",
				content: "anonymous write attempt",
				createdBy: "dummy-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a-scoped caller storing into org-b's namespace is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.memories.storeMemory, {
				namespace: "team/org-b/secrets",
				type: "project",
				content: "cross-tenant write attempt",
				createdBy: "dummy-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a-scoped caller superseding an org-b memory via 'updates' is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const orgBMemoryId = await seedOrgBMemory(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.memories.storeMemory, {
				namespace: "team/org-a/notes",
				type: "project",
				content: "org-a memory that tries to supersede org-b's",
				createdBy: "dummy-a",
				relations: [{ targetId: orgBMemoryId, type: "updates" }],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller storing into its own namespace succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		const memoryId = await tA.mutation(api.memories.storeMemory, {
			namespace: "team/org-a/notes",
			type: "project",
			content: "org-a's own memory",
			createdBy: "dummy-a",
		});
		expect(memoryId).toBeDefined();
	});

	test("an org-a caller superseding its own memory via 'updates' succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		const originalId = await tA.mutation(api.memories.storeMemory, {
			namespace: "team/org-a/notes",
			type: "project",
			content: "org-a original",
			createdBy: "dummy-a",
		});

		const updatedId = await tA.mutation(api.memories.storeMemory, {
			namespace: "team/org-a/notes",
			type: "project",
			content: "org-a updated",
			createdBy: "dummy-a",
			relations: [{ targetId: originalId, type: "updates" }],
		});
		expect(updatedId).toBeDefined();

		const original = await t.run(async (ctx) => await ctx.db.get(originalId));
		expect(original?.isLatest).toBe(false);
	});

	test("the master/service-account identity (no org attached, service-account subject) stores as today", async () => {
		const t = createT();
		const tMaster = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		const memoryId = await tMaster.mutation(api.memories.storeMemory, {
			namespace: "team/org-a/notes",
			type: "project",
			content: "master write into any namespace",
			createdBy: "master",
		});
		expect(memoryId).toBeDefined();
	});
});

describe("memories.softDeleteMemory — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const memoryId = await seedOrgBMemory(t, "team/org-a/notes");

		await expect(
			t.mutation(api.memories.softDeleteMemory, { memoryId }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller calling softDeleteMemory on an org-b memory is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const orgBMemoryId = await seedOrgBMemory(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.memories.softDeleteMemory, { memoryId: orgBMemoryId }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller soft-deleting its own memory succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		const memoryId = await tA.mutation(api.memories.storeMemory, {
			namespace: "team/org-a/notes",
			type: "project",
			content: "org-a's own memory to delete",
			createdBy: "dummy-a",
		});

		await tA.mutation(api.memories.softDeleteMemory, { memoryId });

		const memory = await t.run(async (ctx) => await ctx.db.get(memoryId));
		expect(memory?.isLatest).toBe(false);
	});

	test("the master/service-account identity soft-deletes as today", async () => {
		const t = createT();
		const orgBMemoryId = await seedOrgBMemory(t);
		const tMaster = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		await tMaster.mutation(api.memories.softDeleteMemory, {
			memoryId: orgBMemoryId,
		});

		const memory = await t.run(async (ctx) => await ctx.db.get(orgBMemoryId));
		expect(memory?.isLatest).toBe(false);
	});
});
