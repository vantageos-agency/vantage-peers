/// <reference types="vite/client" />
/**
 * AUDIT RED reproduction, group R2 — missions:create / missions:update.
 *
 * Identity: viewer(org-a) = Clerk org member of org-a with role org:viewer
 * (NOT in memberWriterRoles), NOT master, NOT the service account.
 * editor(org-a) = same org, role org:editor (a writer) — allow-pole control.
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
const asRole = (t: T, role: string) =>
	t.withIdentity({
		subject: `member-${role}`,
		organizationSlug: "org-a",
		org_role: role,
	} as Identity);

async function world(): Promise<T> {
	const t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
	return t;
}
const args = {
	name: "m",
	project: "p",
	status: "plan" as const,
	priority: "low" as const,
	agents: ["sigma"],
	pilot: "sigma",
};
const outcomeOf = async (p: Promise<unknown>) => {
	try {
		await p;
		return { ok: true, text: "" };
	} catch (e) {
		const x = e as { data?: unknown; message?: string };
		return { ok: false, text: `${typeof x.data === "string" ? x.data : ""} ${x.message ?? ""}` };
	}
};
const missionCount = (t: T) => t.run(async (ctx) => (await ctx.db.query("missions").collect()).length);

describe("missions:create — writer-role gate", () => {
	test("positive control: an editor member creates a mission on the human path", async () => {
		const t = await world();
		await asRole(t, "org:editor").mutation(api.missions.create, args);
		expect(await missionCount(t)).toBe(1);
	});

	test("deny pole that exists: a viewer member on the human path (no createdBy) is refused role-not-writer", async () => {
		const t = await world();
		const r = await outcomeOf(asRole(t, "org:viewer").mutation(api.missions.create, args));
		expect(r.ok).toBe(false);
		expect(r.text).toMatch(/role-not-writer/);
	});

	test("missions:create — a viewer member of org-a cannot skip the writer-role gate by supplying createdBy:'sigma'", async () => {
		const t = await world();
		const r = await outcomeOf(
			asRole(t, "org:viewer").mutation(api.missions.create, { ...args, createdBy: "sigma" }),
		);
		expect(
			{ ok: r.ok, missions: await missionCount(t) },
			"viewer-role member created a mission by naming createdBy",
		).toEqual({ ok: false, missions: 0 });
	});
});

describe("missions:update — writer-role / admin gates", () => {
	const seedMission = (t: T) =>
		t.run((ctx) =>
			ctx.db.insert("missions", {
				name: "m",
				project: "p",
				status: "execute",
				priority: "low",
				pilot: "sigma",
				agents: ["sigma"],
				createdBy: "sigma",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				orgId: "org-a",
			}),
		);

	test("deny pole that exists: a viewer member on the human path (no callerOrchestrator) cannot cancel", async () => {
		const t = await world();
		const id = await seedMission(t);
		const r = await outcomeOf(
			asRole(t, "org:viewer").mutation(api.missions.update, {
				missionId: id,
				status: "cancelled",
				cancelReason: "x",
			}),
		);
		expect(r.ok).toBe(false);
		expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("execute");
	});

	test("missions:update — a viewer member of org-a cannot cancel by typing the creator's name as callerOrchestrator", async () => {
		const t = await world();
		const id = await seedMission(t);
		const r = await outcomeOf(
			asRole(t, "org:viewer").mutation(api.missions.update, {
				missionId: id,
				callerOrchestrator: "sigma",
				status: "cancelled",
				cancelReason: "x",
			}),
		);
		expect(
			{ ok: r.ok, status: (await t.run((ctx) => ctx.db.get(id)))?.status },
			"viewer-role member cancelled the mission",
		).toEqual({ ok: false, status: "execute" });
	});
});
