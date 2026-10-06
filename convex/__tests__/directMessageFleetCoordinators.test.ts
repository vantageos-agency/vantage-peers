/// <reference types="vite/client" />
//
// Pi ruling (b), task k17axar1dx4k6grekykm9tzz098frfm3: a client org's direct
// recipients are its own roster PLUS an explicit, data-held allow-list of
// fleet coordinators (client_org_mapping.addressableFleetCoordinators). Empty
// by default; never inferred; ["*"] is never a grant. An allowed coordinator
// is reachable by role and by its instances (resolved through the profile
// owner). The write path is the internal mutation
// clientOrgMapping:setAddressableFleetCoordinators, which accepts only names
// on the operator org's roster.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedProfile(t: T, orchestratorId: string, instanceId?: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			name: orchestratorId,
			instanceId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

async function seedOrg(
	t: T,
	clerkOrgSlug: string,
	allowedOrchestrators: string[],
	orgKind?: "operator" | "client",
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators,
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
			...(orgKind !== undefined ? { orgKind } : {}),
		});
	});
}

const asOrg = (t: T, org: string) =>
	t.withIdentity({
		subject: `user-${org}`,
		organizationId: org,
	} as Parameters<T["withIdentity"]>[0]);

async function seedWorld(t: T) {
	await seedOrg(t, "perello", ["pi", "sigma", "eta"], "operator");
	await seedOrg(t, "cgt", ["cgtbot", "neo"]);
	await seedOrg(t, "iris-rh", ["irisbot"]);
	await seedOrg(t, "other-client", ["themis"]);
	for (const o of ["cgtbot", "neo", "irisbot", "sigma", "eta", "themis"]) {
		await seedProfile(t, o);
	}
	await seedProfile(t, "pi", "pi-chromebook");
}

async function writes(t: T) {
	return await t.run(async (ctx) => ({
		messages: (await ctx.db.query("messages").collect()).length,
		receipts: (await ctx.db.query("messageReceipts").collect()).length,
	}));
}

async function recipientsOf(t: T, messageId: string) {
	const rs = await t.run((ctx) => ctx.db.query("messageReceipts").collect());
	return rs.filter((r) => r.messageId === messageId).map((r) => r.recipient);
}

const BOUNCE = /recipient error/;

describe("direct messages: addressableFleetCoordinators (empty by default)", () => {
	test("CGT (no list) -> sigma: refused, nothing written", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asOrg(t, "cgt").mutation(api.messages.sendMessage, {
				from: "cgtbot",
				channel: "sigma",
				content: "x",
			}),
		).rejects.toThrow(BOUNCE);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("CGT -> neo (own roster): delivered", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await asOrg(t, "cgt").mutation(api.messages.sendMessage, {
			from: "cgtbot",
			channel: "neo",
			content: "x",
		});
		expect(await recipientsOf(t, id)).toEqual(["neo"]);
	});

	test("iris-rh with [pi] -> pi and -> pi-chromebook: delivered", async () => {
		const t = createT();
		await seedWorld(t);
		await t.mutation(internal.clientOrgMapping.setAddressableFleetCoordinators, {
			clerkOrgSlug: "iris-rh",
			names: ["pi"],
		});
		const iris = asOrg(t, "iris-rh");
		const m1 = await iris.mutation(api.messages.sendMessage, {
			from: "irisbot",
			channel: "pi",
			content: "x",
		});
		expect(await recipientsOf(t, m1)).toEqual(["pi"]);
		const m2 = await iris.mutation(api.messages.sendMessage, {
			from: "irisbot",
			channel: "pi-chromebook",
			content: "x",
		});
		expect(await recipientsOf(t, m2)).toEqual(["pi"]);
	});

	test("iris-rh with [pi] -> eta and -> themis: refused", async () => {
		const t = createT();
		await seedWorld(t);
		await t.mutation(internal.clientOrgMapping.setAddressableFleetCoordinators, {
			clerkOrgSlug: "iris-rh",
			names: ["pi"],
		});
		for (const channel of ["eta", "themis", "pi,eta"]) {
			await expect(
				asOrg(t, "iris-rh").mutation(api.messages.sendMessage, {
					from: "irisbot",
					channel,
					content: "x",
				}),
			).rejects.toThrow(BOUNCE);
		}
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("setter: stores normalised names and reports previous/current", async () => {
		const t = createT();
		await seedWorld(t);
		const r = await t.mutation(
			internal.clientOrgMapping.setAddressableFleetCoordinators,
			{ clerkOrgSlug: "iris-rh", names: [" PI "] },
		);
		expect(r).toEqual({
			clerkOrgSlug: "iris-rh",
			previous: [],
			current: ["pi"],
		});
	});

	test("setter refuses a non-operator name, a wildcard and an unknown org", async () => {
		const t = createT();
		await seedWorld(t);
		const set = (clerkOrgSlug: string, names: string[]) =>
			t.mutation(internal.clientOrgMapping.setAddressableFleetCoordinators, {
				clerkOrgSlug,
				names,
			});
		await expect(set("iris-rh", ["themis"])).rejects.toThrow(/NOT_OPERATOR_ORCHESTRATOR/);
		await expect(set("iris-rh", ["neo"])).rejects.toThrow(/NOT_OPERATOR_ORCHESTRATOR/);
		await expect(set("iris-rh", ["*"])).rejects.toThrow(/NOT_OPERATOR_ORCHESTRATOR/);
		await expect(set("no-such-org", ["pi"])).rejects.toThrow(/ORG_MAPPING_NOT_FOUND/);
	});
});
