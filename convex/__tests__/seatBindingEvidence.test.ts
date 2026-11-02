/// <reference types="vite/client" />
//
// migrations/seat_binding_inventory:bindingEvidence (task k177pske4qj37sfw7nw2787msd8fzp0e).
// One seeded profile per verdict, decided only on the agentId stamped on the profile's own
// seat tokens. Hermetic, fictitious identifiers.

import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const evidence = internal.migrations.seat_binding_inventory.bindingEvidence;
type Out = FunctionReturnType<typeof evidence>;

const HOUR = 3_600_000;
const ACME = { slug: "acme-hr", id: "org_ACME1" };
const BETA = { slug: "beta-co", id: "org_BETA1" };
const HASH = "feedfacefeedfacefeedfacefeedfacefeedface";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function agent(
	t: T,
	o: { name: string; org?: string; active?: boolean },
): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug: ACME.slug,
			name: o.name,
			isActive: o.active ?? true,
			createdAt: 1,
			...(o.org !== undefined ? { clerkOrgId: o.org } : {}),
		}),
	);
}

async function profile(
	t: T,
	profileId: string,
	o: { org?: string; agentId?: Id<"agents"> } = {},
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: "fixture",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: 1,
			updatedAt: 1,
			clerkOrgSlug: ACME.slug,
			...(o.org !== undefined
				? { clerkOrgId: o.org }
				: { clerkOrgId: ACME.id }),
			...(o.agentId ? { agentId: o.agentId } : {}),
		});
	});
}

let n = 0;
async function token(
	t: T,
	profileId: string,
	o: {
		agentId?: Id<"agents">;
		expired?: boolean;
		revoked?: boolean;
		person?: boolean;
		client?: string;
	} = {},
): Promise<void> {
	n++;
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash: `${HASH}${n}`,
			refreshTokenHash: `${HASH}r${n}`,
			clientId: o.client ?? `client-${n}`,
			userId: "user-fixture",
			scopes: [],
			scopeProfile: profileId,
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + (o.expired ? -HOUR : HOUR),
			createdAt: 1,
			...(o.revoked ? { revokedAt: 1 } : {}),
			...(o.person ? { principal: "person" as const } : {}),
			...(o.agentId ? { agentId: o.agentId } : {}),
		});
	});
}

describe("seat_binding_inventory:bindingEvidence", () => {
	test("one profile per verdict, each decided on the stamped agentId alone", async () => {
		const t = createT();
		const good = await agent(t, { name: "scribe", org: ACME.id });
		const other = await agent(t, { name: "ops", org: ACME.id });
		const foreign = await agent(t, { name: "scribe", org: BETA.id });
		const off = await agent(t, { name: "idle", org: ACME.id, active: false });
		const noOrg = await agent(t, { name: "nomad" });
		const gone = await agent(t, { name: "ghost", org: ACME.id });
		await t.run(async (ctx) => ctx.db.delete(gone));

		for (const id of [
			"p-bindable",
			"p-ambiguous",
			"p-none",
			"p-cross",
			"p-inactive",
			"p-dangling",
			"p-orgless-agent",
		]) {
			await profile(t, id);
		}
		await token(t, "p-bindable", { agentId: good });
		await token(t, "p-bindable", { agentId: good }); // same agent twice: still one
		await token(t, "p-ambiguous", { agentId: good });
		await token(t, "p-ambiguous", { agentId: other });
		await token(t, "p-none"); // live, nothing stamped
		await token(t, "p-cross", { agentId: foreign });
		await token(t, "p-inactive", { agentId: off });
		await token(t, "p-dangling", { agentId: gone });
		await token(t, "p-orgless-agent", { agentId: noOrg });

		const out: Out = await t.query(evidence, {
			profileIds: [
				"p-bindable",
				"p-ambiguous",
				"p-none",
				"p-cross",
				"p-inactive",
				"p-dangling",
				"p-orgless-agent",
				"p-missing",
			],
		});
		const verdicts = Object.fromEntries(
			out.profiles.map((p) => [p.profileId, p.verdict]),
		);
		expect(verdicts).toEqual({
			"p-bindable": "bindable",
			"p-ambiguous": "ambiguous",
			"p-none": "noEvidence",
			"p-cross": "crossOrg",
			"p-inactive": "inactive",
			"p-dangling": "dangling",
			"p-orgless-agent": "orgUnknown",
			"p-missing": "profileNotFound",
		});
		expect(out.truncated).toBe(false);
		const bindable = out.profiles.find((p) => p.profileId === "p-bindable");
		expect(bindable).toMatchObject({
			alreadyBound: false,
			clerkOrgId: ACME.id,
			liveSeatTokens: 2,
			liveSeatTokensWithStampedAgentId: 2,
			stampedAgents: [
				{
					agentId: good,
					onLiveTokens: 2,
					exists: true,
					clerkOrgId: ACME.id,
					isActive: true,
					sameOrgAsProfile: true,
				},
			],
		});
		expect(
			out.profiles.find((p) => p.profileId === "p-ambiguous")?.stampedAgents,
		).toHaveLength(2);
	});

	test("revoked, person and expired tokens: revoked and person never count; expired is lineage, not live", async () => {
		const t = createT();
		const a = await agent(t, { name: "a", org: ACME.id });
		const b = await agent(t, { name: "b", org: ACME.id });
		await profile(t, "p1");
		await token(t, "p1", { agentId: a });
		await token(t, "p1", { agentId: b, revoked: true });
		await token(t, "p1", { agentId: b, person: true });
		await token(t, "p1", { agentId: a, expired: true });
		const out: Out = await t.query(evidence, { profileIds: ["p1"] });
		expect(out.profiles[0]).toMatchObject({
			verdict: "bindable",
			liveSeatTokens: 1,
			lineageAccessTokens: 2,
			personTokensIgnored: 1,
		});
		expect(out.profiles[0].stampedAgents.map((s) => s.agentId)).toEqual([a]);
	});

	test("an expired-only stamped agent is lineage evidence; a second one makes it ambiguous", async () => {
		const t = createT();
		const a = await agent(t, { name: "a", org: ACME.id });
		const b = await agent(t, { name: "b", org: ACME.id });
		await profile(t, "p1");
		await token(t, "p1", { agentId: a });
		await token(t, "p1", { agentId: b, expired: true });
		const out: Out = await t.query(evidence, { profileIds: ["p1"] });
		expect(out.profiles[0].verdict).toBe("ambiguous");
		expect(
			out.profiles[0].stampedAgents.find((s) => s.agentId === b)?.onLiveTokens,
		).toBe(0);
	});

	test("an already bound profile is reported as such", async () => {
		const t = createT();
		const a = await agent(t, { name: "a", org: ACME.id });
		await profile(t, "p1", { agentId: a });
		await token(t, "p1", { agentId: a });
		const out: Out = await t.query(evidence, { profileIds: ["p1"] });
		expect(out.profiles[0]).toMatchObject({
			alreadyBound: true,
			verdict: "bindable",
		});
	});

	test("output carries no token value, hash or refresh hash", async () => {
		const t = createT();
		const a = await agent(t, { name: "a", org: ACME.id });
		await profile(t, "p1");
		await token(t, "p1", { agentId: a });
		const text = JSON.stringify(
			await t.query(evidence, { profileIds: ["p1"] }),
		);
		expect(text).not.toContain(HASH);
		expect(text).not.toMatch(/tokenHash|refreshTokenHash|codeHash/);
	});

	test("truncation is flagged per profile and overall; met exactly is not", async () => {
		const t = createT();
		const a = await agent(t, { name: "a", org: ACME.id });
		await profile(t, "p1");
		for (let i = 0; i < 3; i++) await token(t, "p1", { agentId: a });
		const exact: Out = await t.query(evidence, {
			profileIds: ["p1"],
			limit: 3,
		});
		expect(exact.truncated).toBe(false);
		const cut: Out = await t.query(evidence, { profileIds: ["p1"], limit: 2 });
		expect(cut.truncated).toBe(true);
		expect(cut.profiles[0].truncated).toBe(true);
		expect(cut.profiles[0].liveSeatTokens).toBe(2);
	});

	test("zero or more than 20 distinct profileIds is refused", async () => {
		const t = createT();
		await expect(t.query(evidence, { profileIds: [] })).rejects.toThrow(
			/BAD_ARGS/,
		);
		const many = Array.from({ length: 21 }, (_, i) => `p${i}`);
		await expect(t.query(evidence, { profileIds: many })).rejects.toThrow(
			/BAD_ARGS/,
		);
	});

	test("liveClientIds: both clients holding live tokens are listed with counts; revoked, expired and person clients are not", async () => {
		const t = createT();
		const a = await agent(t, { name: "a", org: ACME.id });
		await profile(t, "p1");
		await token(t, "p1", { agentId: a, client: "client-b" });
		await token(t, "p1", { agentId: a, client: "client-a" });
		await token(t, "p1", { agentId: a, client: "client-a" });
		await token(t, "p1", { client: "client-revoked", revoked: true });
		await token(t, "p1", { client: "client-expired", expired: true });
		await token(t, "p1", { client: "client-person", person: true });
		const out: Out = await t.query(evidence, { profileIds: ["p1"] });
		expect(out.profiles[0].liveClientIds).toEqual([
			{ clientId: "client-a", liveTokens: 2 },
			{ clientId: "client-b", liveTokens: 1 },
		]);
		expect(out.profiles[0].liveSeatTokens).toBe(3);
		const text = JSON.stringify(out);
		expect(text).not.toContain(HASH);
		expect(text).not.toMatch(/tokenHash|refreshTokenHash|codeHash/);
	});

	test("a profile with no live token lists no client", async () => {
		const t = createT();
		await profile(t, "p1");
		const out: Out = await t.query(evidence, { profileIds: ["p1", "nope"] });
		expect(out.profiles.map((p) => p.liveClientIds)).toEqual([[], []]);
	});
});
