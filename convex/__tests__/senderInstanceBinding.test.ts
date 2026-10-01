/// <reference types="vite/client" />
//
// Task k17bppsrq4eajey55a6w9v3xks8feyza part 2. VantagePeers Cloud.
//
// DEFECT (Eta, on #1400): `from` is bound to the caller's roster, but
// `fromInstanceId` was a free label — a member of org B sending as its own
// orchestrator could label the message "eta-vps". The instance must belong to
// the verified sender (`<from>` or `<from>-<suffix>`, segment boundary).
//
// Poles: REFUSED (foreign instance, prefix without boundary, bare "bob-"),
// SERVED (own instance, case variant, omitted), MASTER unchanged.
//
// DELETION PROBE (not committed): remove the requireSenderInstanceOfSender
// call in messages:sendMessage and the REFUSED poles go RED.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const DOOR = "messages:sendMessage";

async function seedOrg(t: T, slug: string, roster: string[]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedProfile(t: T, orchestratorId: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			name: orchestratorId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

const memberOf = (t: T, org: string) =>
	t.withIdentity({ subject: `member-of-${org}`, organizationId: org } as Parameters<
		typeof t.withIdentity
	>[0]);

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Parameters<
		typeof t.withIdentity
	>[0]);

async function refusalOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data : String(e);
	}
	throw new Error("expected a refusal, got a success");
}

async function fixture() {
	const t = createT();
	await seedOrg(t, "org-b", ["bob", "bea"]);
	for (const p of ["bob", "bea", "eta"]) await seedProfile(t, p);
	return t;
}

describe("sendMessage — the instance label belongs to the verified sender", () => {
	test("REFUSED: org B member from='bob' labelled 'eta-vps' is RBAC_DENIED instance-not-of-sender, naming the door", async () => {
		const t = await fixture();
		const refusal = await refusalOf(
			memberOf(t, "org-b").mutation(api.messages.sendMessage, {
				from: "bob",
				fromInstanceId: "eta-vps",
				channel: "bea",
				content: "impersonation",
			}),
		);
		expect(refusal).toContain("RBAC_DENIED");
		expect(refusal).toContain(DOOR);
		expect(refusal).toMatch(/reason\\*":\\*"instance-not-of-sender/);
		expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
	});

	test("REFUSED: the prefix needs a segment boundary ('bobby-vps', 'bob-', 'xbob-vps')", async () => {
		const t = await fixture();
		for (const fromInstanceId of ["bobby-vps", "bob-", "xbob-vps", "bea-vps"]) {
			const refusal = await refusalOf(
				memberOf(t, "org-b").mutation(api.messages.sendMessage, {
					from: "bob",
					fromInstanceId,
					channel: "bea",
					content: "x",
				}),
			);
			expect(refusal).toMatch(/reason\\*":\\*"instance-not-of-sender/);
		}
	});

	test("SERVED: own instances (exact role, <role>-vps, <role>-vps-1, case variant) are stamped as given", async () => {
		const t = await fixture();
		for (const fromInstanceId of ["bob", "bob-vps", "bob-vps-1", "BOB-VPS"]) {
			const id = await memberOf(t, "org-b").mutation(api.messages.sendMessage, {
				from: "bob",
				fromInstanceId,
				channel: "bea",
				content: "legit",
			});
			const row = await t.run((ctx) => ctx.db.get(id));
			expect(row?.fromInstanceId).toBe(fromInstanceId);
			expect(row?.tenantId).toBe("org-b");
		}
	});

	test("SERVED: fromInstanceId omitted", async () => {
		const t = await fixture();
		const id = await memberOf(t, "org-b").mutation(api.messages.sendMessage, {
			from: "bob",
			channel: "bea",
			content: "no instance",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.fromInstanceId).toBeUndefined();
	});

	test("MASTER unchanged: the service account may label any instance", async () => {
		const t = await fixture();
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "bob",
			fromInstanceId: "eta-vps",
			channel: "bea",
			content: "fleet traffic",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.fromInstanceId).toBe("eta-vps");
	});
});
