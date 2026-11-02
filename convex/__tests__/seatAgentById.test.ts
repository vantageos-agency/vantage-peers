/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, module M3: a seat token acts as the agent its PROFILE names
// BY ID (oauth_scope_profiles.agentId). A label never finds an agent.
//
//   REFUSED  an unbound profile (no agentId) whose allowlisted label and profileId
//            match an active agent of the same org: the label is not an identity,
//            so no agent resolves (an operator binds it by ID with
//            oauth:bindScopeProfileAgent); a profile bound to an agent of another org.
//   PRESENT  a bound profile resolves exactly the agent it names, whatever label
//            the token or the profile list carries, and a colliding same-org label
//            never takes its place.
//   ABSENT   a person token, an unknown profile and a token of another org resolve
//            no agent.

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { liveSeatAgent, resolveSeatAgent } from "../lib/seatAgent";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);

const NOW = 1_700_000_000_000;
const ORG_A = "org_AAAA1";
const ORG_B = "org_BBBB1";

async function seed(t: ReturnType<typeof createT>) {
	return await t.run(async (ctx) => {
		const agent = (orgSlug: string, clerkOrgId: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId,
				name,
				normalizedName: name.toLowerCase(),
				isActive: true,
				createdAt: NOW,
			});
		const clio = await agent("acme-a", ORG_A, "clio");
		const clioRenamed = await agent("acme-a", ORG_A, "clio-2");
		const foreignClio = await agent("acme-b", ORG_B, "clio");
		const profile = (
			profileId: string,
			label: string,
			slug: string,
			clerkOrgId: string,
			agentId?: typeof clio,
		) =>
			ctx.db.insert("oauth_scope_profiles", {
				profileId,
				description: "seat",
				fromAllowList: [label],
				...(agentId !== undefined ? { agentId } : {}),
				namespaceReadPrefixes: [`project/${slug}`],
				namespaceWritePrefixes: [`project/${slug}`],
				createdAt: NOW,
				updatedAt: NOW,
				clerkOrgSlug: slug,
				clerkOrgId,
			});
		await profile("clio-acme-a", "clio", "acme-a", ORG_A);
		await profile("bound-acme-a", "clio-2", "acme-a", ORG_A, clio);
		await profile("crossbound-acme-a", "clio", "acme-a", ORG_A, foreignClio);
		for (const [slug, id] of [
			["acme-a", ORG_A],
			["acme-b", ORG_B],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: ["clio"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
			});
		}
		return { clio, clioRenamed, foreignClio };
	});
}

const tokenOf = (scopeProfile: string, over: Record<string, unknown> = {}) => ({
	scopeProfile,
	fromAllowList: ["clio"],
	clerkOrgSlug: "acme-a",
	clerkOrgId: ORG_A,
	...over,
});

describe("resolveSeatAgent follows the profile's agent ID, never a label", () => {
	test("REFUSED: an unbound profile whose label and profileId match an active same-org agent resolves nothing", async () => {
		const t = createT();
		await seed(t);
		const agent = await t.run((ctx) =>
			resolveSeatAgent(ctx, tokenOf("clio-acme-a")),
		);
		expect(agent).toBeNull();
	});

	test("REFUSED: a profile bound to an agent of another org resolves nothing, the same-named agent of its own org is not put in its place", async () => {
		const t = createT();
		await seed(t);
		const agent = await t.run((ctx) =>
			resolveSeatAgent(ctx, tokenOf("crossbound-acme-a")),
		);
		expect(agent).toBeNull();
	});

	test("PRESENT: a bound profile resolves the agent it names, whatever label the token carries", async () => {
		const t = createT();
		const { clio } = await seed(t);
		const agent = await t.run((ctx) =>
			resolveSeatAgent(
				ctx,
				tokenOf("bound-acme-a", { fromAllowList: ["clio-2"] }),
			),
		);
		expect(agent?._id).toBe(clio);
	});

	test("PRESENT: a token carrying no label at all still resolves the bound agent", async () => {
		const t = createT();
		const { clio } = await seed(t);
		const agent = await t.run((ctx) =>
			resolveSeatAgent(ctx, tokenOf("bound-acme-a", { fromAllowList: [] })),
		);
		expect(agent?._id).toBe(clio);
	});

	test("REFUSED: a bound agent that carries no stored org ID names no organisation, its slug is not looked up to give it one", async () => {
		const t = createT();
		const { clio } = await seed(t);
		await t.run((ctx) => ctx.db.patch(clio, { clerkOrgId: undefined }));
		const agent = await t.run((ctx) =>
			resolveSeatAgent(ctx, tokenOf("bound-acme-a")),
		);
		expect(agent).toBeNull();
	});

	test("REFUSED: a token that carries no org ID is not matched to the profile's organisation by its slug", async () => {
		const t = createT();
		await seed(t);
		const agent = await t.run((ctx) =>
			resolveSeatAgent(ctx, tokenOf("bound-acme-a", { clerkOrgId: undefined })),
		);
		expect(agent).toBeNull();
	});

	test("ABSENT: a person token, an unknown profile and a token of another org resolve no agent", async () => {
		const t = createT();
		await seed(t);
		expect(
			await t.run((ctx) =>
				resolveSeatAgent(ctx, tokenOf("bound-acme-a", { principal: "person" })),
			),
		).toBeNull();
		expect(
			await t.run((ctx) => resolveSeatAgent(ctx, tokenOf("ghost"))),
		).toBeNull();
		expect(
			await t.run((ctx) =>
				resolveSeatAgent(
					ctx,
					tokenOf("bound-acme-a", {
						clerkOrgSlug: "acme-b",
						clerkOrgId: ORG_B,
					}),
				),
			),
		).toBeNull();
	});
});

describe("liveSeatAgent for an unstamped row", () => {
	test("REFUSED: an unstamped row on an unbound profile resolves nothing by label", async () => {
		const t = createT();
		await seed(t);
		const live = await t.run(async (ctx) => {
			const id = await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "h-unbound",
				clientId: "c",
				userId: "clio",
				scopes: ["mcp:full"],
				scopeProfile: "clio-acme-a",
				fromAllowList: ["clio"],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: NOW + 1000,
				createdAt: NOW,
				clerkOrgSlug: "acme-a",
				clerkOrgId: ORG_A,
			});
			const row = await ctx.db.get(id);
			return row ? await liveSeatAgent(ctx, row) : "no-row";
		});
		expect(live).toBeNull();
	});
});
