/// <reference types="vite/client" />
/**
 * RED reproduction, group R5 — profiles doors (getProfile, upsertProfile, updateDynamic,
 * getProfileWithMemories). Harness origin: convex/__tests__/dashboardSummaryTenant.test.ts
 * (convexTest + identities), convex/__tests__/inboxByAgentId.test.ts (Clerk member identity shape).
 * Every test asserts the CORRECT behaviour; it fails today only if the audited defect is real.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const C = "client-c";
const NOW = 1_700_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string });
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `user-${org}`,
		organizationSlug: org,
		org_role: "org:member",
	} as Parameters<T["withIdentity"]>[0]);

async function seed(roster: string[]) {
	const t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: C,
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: C,
			isActive: true,
			createdAt: NOW,
		});
		// The FLEET's pi (no tenant column on profiles).
		await ctx.db.insert("profiles", {
			orchestratorId: "pi",
			instanceId: "pi-vps",
			name: "pi",
			static: { role: "coordinator", workspace: "/fleet/pi-workspace", capabilities: [] },
			dynamic: { currentTask: "fleet-secret-task", lastSeen: NOW, sessionCount: 1 },
		});
	});
	return t;
}

async function outcome(p: Promise<unknown>): Promise<string> {
	try {
		const r = await p;
		return r === null ? "null" : "served";
	} catch (e) {
		return `refused:${(e as { data?: unknown }).data ?? (e as Error).message}`.slice(0, 80);
	}
}

describe("profiles:getProfile", () => {
	test("profiles:getProfile — a roster 'Pi' admits the request 'pi' (roster compare is normalised like every other roster check) (identity: Clerk member of client-c)", async () => {
		const t = await seed(["Pi"]);
		const profile = await asMember(t, C).query(api.profiles.getProfile, {
			orchestratorId: "pi",
		});
		expect(profile).not.toBeNull();
	});

	test("profiles:getProfile — a roster 'pi' does not serve the FLEET pi's workspace/currentTask to a client org (identity: Clerk member of client-c)", async () => {
		const t = await seed(["pi"]);
		const profile = await asMember(t, C).query(api.profiles.getProfile, {
			orchestratorId: "pi",
		});
		expect(profile?.static.workspace ?? null).not.toBe("/fleet/pi-workspace");
	});

	test("profiles:getProfile — instanceId probe: a foreign existing instance and an absent instance give the SAME answer (no existence oracle) (identity: Clerk member of client-c, roster ['sigma'])", async () => {
		const t = await seed(["sigma"]);
		const m = asMember(t, C);
		const foreign = await outcome(m.query(api.profiles.getProfile, { instanceId: "pi-vps" }));
		const absent = await outcome(m.query(api.profiles.getProfile, { instanceId: "no-such-instance" }));
		expect(foreign).toBe(absent);
	});
});

describe("profiles writes", () => {
	test("profiles:upsertProfile — the claimless service account cannot rewrite the fleet pi's profile (typed 'pi', no claim) (identity: service account WITHOUT a claim)", async () => {
		const t = await seed(["sigma"]);
		let denied = false;
		try {
			await asService(t).mutation(api.profiles.upsertProfile, {
				orchestratorId: "pi",
				static: { role: "x", workspace: "/evil", capabilities: [] },
			});
		} catch (e) {
			denied = String((e as { data?: unknown }).data ?? e).includes("RBAC_DENIED");
		}
		expect(denied, "upsertProfile must refuse a claimless caller naming 'pi'").toBe(true);
		const row = await t.run((ctx) =>
			ctx.db.query("profiles").withIndex("by_orchestrator", (q) => q.eq("orchestratorId", "pi")).first(),
		);
		expect(row?.static.workspace).toBe("/fleet/pi-workspace");
	});

	test("profiles:updateDynamic — the claimless service account cannot auto-create a profile for an unknown orchestrator name (identity: service account WITHOUT a claim)", async () => {
		const t = await seed(["sigma"]);
		let denied = false;
		try {
			await asService(t).mutation(api.profiles.updateDynamic, {
				orchestratorId: "brand-new-name",
				currentTask: "x",
			});
		} catch (e) {
			denied = String((e as { data?: unknown }).data ?? e).includes("RBAC_DENIED");
		}
		const created = await t.run((ctx) =>
			ctx.db.query("profiles").withIndex("by_orchestrator", (q) => q.eq("orchestratorId", "brand-new-name")).first(),
		);
		expect(created, "no profile row may be auto-created for an unverified name").toBeNull();
		expect(denied).toBe(true);
	});
});

describe("profiles:getProfileWithMemories", () => {
	test("profiles:getProfileWithMemories — a member whose roster lacks 'pi' gets profile:null for pi, as getProfile refuses it (identity: Clerk member of client-c, roster ['sigma'])", async () => {
		const t = await seed(["sigma"]);
		const r = await asMember(t, C).query(api.profiles.getProfileWithMemories, {
			orchestratorId: "pi",
			namespace: `team/${C}`,
		});
		expect(r.profile).toBeNull();
	});
});
