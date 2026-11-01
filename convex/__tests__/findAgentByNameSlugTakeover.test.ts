/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * An organisation slug is a renamable label: an organisation can release it and
 * another can take it. The label lookup (`resolveAgentRef`, once `findAgentByName`) once selected agents by `orgSlug`, so
 * the organisation holding a released slug resolved the PREVIOUS holder's agent
 * row by name (task k1768vtsgr0cg8jb6z5bkgnzts8hchbe).
 *
 * How the takeover is modelled: NO door in convex/ renames a
 * `client_org_mapping.clerkOrgSlug` (measured: no `db.patch` anywhere writes that
 * field outside tests), so the release and the takeover are direct database
 * writes, which is also how an operator edit or an import would make them:
 *   1. org A (clerkOrgId X) holds slug "shared-slug" and owns agent "nadia"
 *      (agents row: orgSlug "shared-slug", clerkOrgId X);
 *   2. A's mapping row is renamed to "renamed-a" (its agents rows keep the old
 *      stamp, as no door rewrites them);
 *   3. org B (clerkOrgId Y) is mapped with slug "shared-slug".
 *
 * Poles, direct on the lookup and through a public door (tasks:create by org B):
 *   REFUSE   B asks for "nadia" -> A's row is NOT returned / stamped.
 *   ALLOW    A asks for "nadia" under its current slug, a correctly stamped
 *            agent of B is found by B, an untouched org keeps resolving.
 *   LEGACY   an agent row with no clerkOrgId is refused, never matched by slug.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { resolveAgentRef } from "../lib/agentIdentity";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const SLUG = "shared-slug";
const RENAMED = "renamed-a";
const ORG_A_ID = testClerkOrgId("org-a-permanent");
const ORG_B_ID = testClerkOrgId("org-b-permanent");

type World = { t: T; agentA: Id<"agents">; agentB: Id<"agents"> };

async function takeover(): Promise<World> {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		const mappingA = await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_A_ID,
			allowedOrchestrators: ["nadia"],
			scopes: ["view-own-tasks"],
			displayName: "A",
			isActive: true,
			createdAt: 1,
		});
		const agentA = await ctx.db.insert("agents", {
			orgSlug: SLUG,
			clerkOrgId: ORG_A_ID,
			name: "nadia",
			normalizedName: "nadia",
			isActive: true,
			createdAt: 1,
		});
		// A releases the slug (renamed). Its agents rows keep the old stamp.
		await ctx.db.patch(mappingA, { clerkOrgSlug: RENAMED });
		// B takes the released slug.
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_B_ID,
			allowedOrchestrators: ["nadia", "bruno"],
			scopes: ["view-own-tasks"],
			displayName: "B",
			isActive: true,
			createdAt: 2,
		});
		const agentB = await ctx.db.insert("agents", {
			orgSlug: SLUG,
			clerkOrgId: ORG_B_ID,
			name: "bruno",
			normalizedName: "bruno",
			isActive: true,
			createdAt: 2,
		});
		return { agentA, agentB };
	});
	return { t, ...ids };
}

const lookup = (t: T, slug: string, name: string) =>
	t.run(async (ctx) => (
			await resolveAgentRef(ctx, {
				label: name,
				orgSlug: slug,
				door: "test:lookup",
				arg: "name",
				measure: false,
			})
		)?._id ?? null);

describe("resolveAgentRef (label only): a slug is a label, the permanent org ID is the key", () => {
	test("REFUSE: org B (holds the released slug) asking for A's agent by name gets nothing", async () => {
		const w = await takeover();
		expect(await lookup(w.t, SLUG, "nadia")).toBeNull();
	});

	test("ALLOW: org B still finds its own correctly stamped agent under the slug", async () => {
		const w = await takeover();
		expect(await lookup(w.t, SLUG, "bruno")).toBe(w.agentB);
	});

	test("ALLOW: org A finds its own agent under its CURRENT slug (the stamp's old slug is irrelevant)", async () => {
		const w = await takeover();
		expect(await lookup(w.t, RENAMED, "nadia")).toBe(w.agentA);
	});

	test("ALLOW: an organisation that never changed slug keeps resolving", async () => {
		const t = createT();
		const id = await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "steady",
				clerkOrgId: testClerkOrgId("steady"),
				allowedOrchestrators: ["quill"],
				scopes: [],
				displayName: "steady",
				isActive: true,
				createdAt: 1,
			});
			return await ctx.db.insert("agents", {
				orgSlug: "steady",
				clerkOrgId: testClerkOrgId("steady"),
				name: "Quill",
				normalizedName: "quill",
				isActive: true,
				createdAt: 1,
			});
		});
		expect(await lookup(t, "steady", "quill")).toBe(id);
		// The raw label still selects (the index is a shortcut, `name` is the truth).
		expect(await lookup(t, "steady", "Quill")).toBe(id);
	});

	test("LEGACY: an agent row with no clerkOrgId is refused, not matched by slug", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "legacy-org",
				clerkOrgId: testClerkOrgId("legacy-org"),
				allowedOrchestrators: ["old"],
				scopes: [],
				displayName: "legacy",
				isActive: true,
				createdAt: 1,
			});
			await ctx.db.insert("agents", {
				orgSlug: "legacy-org",
				name: "old",
				normalizedName: "old",
				isActive: true,
				createdAt: 1,
			});
		});
		expect(await lookup(t, "legacy-org", "old")).toBeNull();
	});

	test("REFUSE: an organisation whose mapping carries no ID resolves nobody", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "no-id-org",
				allowedOrchestrators: ["x"],
				scopes: [],
				displayName: "no id",
				isActive: true,
				createdAt: 1,
			});
			await ctx.db.insert("agents", {
				orgSlug: "no-id-org",
				name: "x",
				normalizedName: "x",
				isActive: true,
				createdAt: 1,
			});
		});
		expect(await lookup(t, "no-id-org", "x")).toBeNull();
	});
});

describe("through a public door: tasks:create by org B stamps no foreign agent ID", () => {
	const adminOf = (w: World, slug: string, orgId: string) =>
		w.t.withIdentity({
			subject: `user_admin_${slug}`,
			org_slug: slug,
			org_id: orgId,
			org_role: "org:admin",
		});
	const seedWriters = (w: World) =>
		w.t.run((ctx) =>
			ctx.db.insert("memberWriterRoles", { roles: ["org:admin"], updatedAt: 1 }),
		);
	const base = { title: "takeover", priority: "low" as const, status: "todo" as const };
	const tasks = (w: World) =>
		w.t.run(async (ctx) => await ctx.db.query("tasks").collect());

	test("REFUSE: B assigns \"nadia\" (on B's roster by label) -> A's agent ID is never stamped", async () => {
		const w = await takeover();
		await seedWriters(w);
		let refused = false;
		try {
			await adminOf(w, SLUG, ORG_B_ID).mutation(api.tasks.create, {
				...base,
				assignedTo: "nadia",
			} as never);
		} catch {
			refused = true;
		}
		const rows = await tasks(w);
		expect(rows.map((r) => r.assignedToId)).not.toContain(w.agentA);
		// The door says no: the label names no agent of B, so nothing is written.
		expect(refused).toBe(true);
		expect(rows).toHaveLength(0);
	});

	test("ALLOW: B assigns its own agent \"bruno\" -> B's agent ID is stamped", async () => {
		const w = await takeover();
		await seedWriters(w);
		await adminOf(w, SLUG, ORG_B_ID).mutation(api.tasks.create, {
			...base,
			assignedTo: "bruno",
		} as never);
		const rows = await tasks(w);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.assignedToId).toBe(w.agentB);
	});
});

describe("a waiter task stamped before the takeover is notified by ITS org's ID", () => {
	test("UNBLOCK: A's blocked task (old slug, clerkOrgId A, no assignedToId) names A's nadia, never B's", async () => {
		const w = await takeover();
		await seedFleetAgents(w.t, ["eta"]);
		// B has its OWN agent labelled "nadia" under the slug B now holds.
		const agentBNadia = await w.t.run(async (ctx) =>
			ctx.db.insert("agents", {
				orgSlug: SLUG,
				clerkOrgId: ORG_B_ID,
				name: "nadia",
				normalizedName: "nadia",
				isActive: true,
				createdAt: 3,
			}),
		);
		const svc = w.t.withIdentity({ subject: "test-service-account-user-id" });
		const blocker = (await svc.mutation(api.tasks.create, {
			title: "blocker",
			assignedTo: "eta",
			priority: "low",
			status: "todo",
			createdBy: "eta",
		} as never)) as Id<"tasks">;
		const waiter = await w.t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "A waits",
				// The stamp A wrote while it still held the slug: old slug, A's ID.
				orgId: SLUG,
				clerkOrgId: ORG_A_ID,
				assignedTo: "nadia",
				createdBy: "nadia",
				priority: "low",
				status: "blocked",
				blockedOnTaskId: blocker,
				isReviewTask: false,
				createdAt: 1,
				updatedAt: 1,
			} as never),
		);
		await svc.mutation(api.tasks.complete, {
			taskId: blocker,
			callerOrchestrator: "eta",
			completionNote: "Shipped fix in PR #999, all tests pass 12/12",
		} as never);
		const receipts = await w.t.run(async (ctx) => {
			const msgs = await ctx.db.query("messages").collect();
			const mine = msgs.filter((m) => m.content.includes(String(waiter)));
			const all = await ctx.db.query("messageReceipts").collect();
			return all.filter((r) => mine.some((m) => m._id === r.messageId));
		});
		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.recipientId).toBe(w.agentA);
		expect(receipts[0]?.recipientId).not.toBe(agentBNadia);
	});
});
