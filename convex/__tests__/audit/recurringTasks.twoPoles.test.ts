/// <reference types="vite/client" />
/**
 * AUDIT RED reproduction, group R2 — recurringTasks:create / recurringTasks:list.
 *
 * Identity: member(org-a) = Clerk org member (editor), NOT master, NOT the
 * service account. org-b carries the same roster name so only the stamp separates them.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
const asMember = (t: T) =>
	t.withIdentity({
		subject: "member-of-org-a",
		organizationSlug: "org-a",
		org_role: "org:editor",
	} as Identity);

async function world(): Promise<T> {
	const t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
	return t;
}

const row = (orgId: string, title: string) => ({
	title,
	assignedTo: "sigma",
	priority: "low" as const,
	cronExpression: "0 9 * * *",
	nextRunAt: Date.now() + 1000,
	active: true,
	createdBy: "sigma",
	orgId,
	createdAt: Date.now(),
	updatedAt: Date.now(),
});

describe("recurringTasks:create — a registered agent of the caller's own org", () => {
	test("positive control: the human path (no createdBy) creates a schedule stamped with the member's org", async () => {
		const t = await world();
		const id = await asMember(t).mutation(api.recurringTasks.create, {
			title: "h",
			assignedTo: "sigma",
			priority: "low",
			cronExpression: "0 9 * * *",
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.orgId).toBe("org-a");
	});

	test("recurringTasks:create — a member of org-a acting as its registered agent 'sigma' is served (the door must give a credential path)", async () => {
		const t = await world();
		await t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: "org-a",
				name: "sigma",
				normalizedName: "sigma",
				isActive: true,
				createdAt: Date.now(),
			}),
		);
		let ok = true;
		let text = "";
		try {
			await asMember(t).mutation(api.recurringTasks.create, {
				title: "as-agent",
				assignedTo: "sigma",
				priority: "low",
				cronExpression: "0 9 * * *",
				createdBy: "sigma",
			});
		} catch (e) {
			ok = false;
			const x = e as { data?: unknown; message?: string };
			text = `${typeof x.data === "string" ? x.data : ""} ${x.message ?? ""}`.slice(0, 160);
		}
		expect({ ok, text }, "rightful agent of org-a refused with no argument to present its credential").toEqual({
			ok: true,
			text: "",
		});
	});
});

describe("recurringTasks:list — tenant predicate inside the read", () => {
	test("positive control: with no newer foreign rows the member of org-a is served its schedule", async () => {
		const t = await world();
		await t.run((ctx) => ctx.db.insert("recurringTasks", row("org-a", "mine")));
		const rows = await asMember(t).query(api.recurringTasks.list, {});
		expect(Array.isArray(rows) ? rows.map((r) => r.title) : rows).toEqual(["mine"]);
	});

	test("recurringTasks:list — a member of org-a is served its schedule when 60 newer org-b rows sit ahead of it", async () => {
		const t = await world();
		await t.run(async (ctx) => {
			await ctx.db.insert("recurringTasks", row("org-a", "mine"));
			for (let i = 0; i < 60; i++) {
				await ctx.db.insert("recurringTasks", row("org-b", `theirs-${i}`));
			}
		});
		const rows = await asMember(t).query(api.recurringTasks.list, {});
		expect(
			Array.isArray(rows) ? rows.map((r) => r.title) : rows,
			"org-a's own schedule withheld: tenant filter applied after take(limit)",
		).toEqual(["mine"]);
	});
});
