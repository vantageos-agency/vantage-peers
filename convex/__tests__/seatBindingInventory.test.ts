/// <reference types="vite/client" />
//
// migrations/seat_binding_inventory:inventory (task k177pske4qj37sfw7nw2787msd8fzp0e).
// Pinned: exact per-org and total counts over seeded rows with and without agentId /
// clerkOrgId; an expired and a revoked token are not "live"; no token value or hash in the
// output; the truncation flag when the bound is hit. Hermetic, fictitious identifiers.

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
const inventory = internal.migrations.seat_binding_inventory.inventory;
type Out = FunctionReturnType<typeof inventory>;

const HOUR = 3_600_000;
const ACME = { slug: "acme-hr", id: "org_ACME1" };
const BETA = { slug: "beta-co", id: "org_BETA1" };
const RAW_TOKEN_HASH = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const RAW_REFRESH_HASH = "cafebabecafebabecafebabecafebabecafebabe";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedAgent(
	t: T,
	orgSlug: string,
	name: string,
	clerkOrgId?: string,
): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			name,
			isActive: true,
			createdAt: 1,
			...(clerkOrgId ? { clerkOrgId } : {}),
		}),
	);
}

async function seedProfile(
	t: T,
	p: {
		profileId: string;
		slug?: string;
		clerkOrgId?: string;
		agentId?: Id<"agents">;
	},
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: p.profileId,
			description: "fixture",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: 1,
			updatedAt: 1,
			...(p.slug ? { clerkOrgSlug: p.slug } : {}),
			...(p.clerkOrgId ? { clerkOrgId: p.clerkOrgId } : {}),
			...(p.agentId ? { agentId: p.agentId } : {}),
		});
	});
}

async function seedToken(
	t: T,
	k: {
		n: string;
		profile: string;
		slug?: string;
		clerkOrgId?: string;
		expiresAt: number;
		revokedAt?: number;
	},
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash: `${RAW_TOKEN_HASH}${k.n}`,
			refreshTokenHash: `${RAW_REFRESH_HASH}${k.n}`,
			clientId: `client-${k.n}`,
			userId: "user-fixture",
			scopes: [],
			scopeProfile: k.profile,
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: k.expiresAt,
			createdAt: 1,
			...(k.revokedAt !== undefined ? { revokedAt: k.revokedAt } : {}),
			...(k.slug ? { clerkOrgSlug: k.slug } : {}),
			...(k.clerkOrgId ? { clerkOrgId: k.clerkOrgId } : {}),
		});
	});
}

async function seedWorld(t: T): Promise<void> {
	const now = Date.now();
	const live = now + HOUR;
	const bound = await seedAgent(t, ACME.slug, "scribe", ACME.id);
	await seedAgent(t, ACME.slug, "legacy-agent"); // no clerkOrgId
	await seedAgent(t, BETA.slug, "ops"); // no clerkOrgId

	// ACME: one bound profile, one unbound with a label list, one unbound without.
	await seedProfile(t, {
		profileId: "scribe-acme",
		slug: ACME.slug,
		clerkOrgId: ACME.id,
		agentId: bound,
	});
	await seedProfile(t, {
		profileId: "legacy-acme",
		slug: ACME.slug,
		clerkOrgId: ACME.id,
	});
	await seedProfile(t, {
		profileId: "bare-acme",
		slug: ACME.slug,
		clerkOrgId: ACME.id,
	});
	// BETA: unbound, no clerkOrgId, label list. Keyed by slug.
	await seedProfile(t, {
		profileId: "ops-beta",
		slug: BETA.slug,
	});

	// Live tokens.
	await seedToken(t, {
		n: "1",
		profile: "scribe-acme",
		slug: ACME.slug,
		clerkOrgId: ACME.id,
		expiresAt: live,
	}); // bound, has id
	await seedToken(t, {
		n: "2",
		profile: "legacy-acme",
		slug: ACME.slug,
		clerkOrgId: ACME.id,
		expiresAt: live,
	}); // unbound profile
	await seedToken(t, {
		n: "3",
		profile: "ops-beta",
		slug: BETA.slug,
		expiresAt: live,
	}); // unbound profile, no id
	// Not live: expired, revoked. Both would otherwise count (unbound profile, no id).
	await seedToken(t, {
		n: "4",
		profile: "ops-beta",
		slug: BETA.slug,
		expiresAt: now - HOUR,
	});
	await seedToken(t, {
		n: "5",
		profile: "ops-beta",
		slug: BETA.slug,
		expiresAt: live,
		revokedAt: now - 1000,
	});
}

describe("migrations/seat_binding_inventory:inventory", () => {
	test("exact counts per org and in totals; expired and revoked tokens are not live", async () => {
		const t = createT();
		await seedWorld(t);
		const out: Out = await t.query(inventory, {});

		expect(out.cap).toBe(5000);
		expect(out.anyTruncated).toBe(false);
		expect(out.truncated).toEqual({
			profiles: false,
			tokens: false,
			agents: false,
		});
		expect(out.totals).toEqual({
			profilesScanned: 4,
			profilesWithoutAgentId: 3,
			profilesWithoutClerkOrgId: 1,
			tokensScanned: 5,
			liveTokens: 3,
			liveTokensWithoutProfileAgentId: 2,
			liveTokensWithoutClerkOrgId: 1,
			liveTokensProfileMissing: 0,
			agentsScanned: 3,
			agentsWithoutClerkOrgId: 2,
		});

		const acme = out.perOrg.find((o) => o.org === ACME.id);
		const beta = out.perOrg.find((o) => o.org === BETA.slug);
		expect(acme).toEqual({
			org: ACME.id,
			orgKeyKind: "clerkOrgId",
			profilesWithoutAgentId: 2,
			profilesWithoutClerkOrgId: 0,
			liveTokensWithoutProfileAgentId: 1,
			liveTokensWithoutClerkOrgId: 0,
			// the ACME agent without an id is keyed by its slug, below
			agentsWithoutClerkOrgId: 0,
		});
		expect(beta).toEqual({
			org: BETA.slug,
			orgKeyKind: "slug",
			profilesWithoutAgentId: 1,
			profilesWithoutClerkOrgId: 1,
			liveTokensWithoutProfileAgentId: 1,
			liveTokensWithoutClerkOrgId: 1,
			agentsWithoutClerkOrgId: 1,
		});
		// An agent with no org id is keyed by the slug as stored.
		expect(
			out.perOrg.find((o) => o.org === ACME.slug)?.agentsWithoutClerkOrgId,
		).toBe(1);

		expect(out.missingAgentIdProfiles).toEqual([
			{ profileId: "bare-acme", org: ACME.id },
			{ profileId: "legacy-acme", org: ACME.id },
			{ profileId: "ops-beta", org: BETA.slug },
		]);
	});

	test("the output carries no token value, hash or refresh hash", async () => {
		const t = createT();
		await seedWorld(t);
		const text = JSON.stringify(await t.query(inventory, {}));
		expect(text).not.toContain(RAW_TOKEN_HASH);
		expect(text).not.toContain(RAW_REFRESH_HASH);
		expect(text).not.toMatch(/tokenHash|refreshTokenHash|codeHash/);
	});

	test("an empty deployment is an empty, untruncated report", async () => {
		const t = createT();
		const out: Out = await t.query(inventory, {});
		expect(out.anyTruncated).toBe(false);
		expect(out.perOrg).toEqual([]);
		expect(out.missingAgentIdProfiles).toEqual([]);
		expect(out.totals.liveTokens).toBe(0);
	});

	test("the truncation flag is set per table when the bound is hit, and not when it is met exactly", async () => {
		const t = createT();
		await seedWorld(t); // 4 profiles, 5 tokens, 3 agents
		const exact: Out = await t.query(inventory, { limit: 5 });
		expect(exact.cap).toBe(5);
		expect(exact.anyTruncated).toBe(false);

		const cut: Out = await t.query(inventory, { limit: 3 });
		expect(cut.cap).toBe(3);
		expect(cut.truncated).toEqual({
			profiles: true,
			tokens: true,
			agents: false,
		});
		expect(cut.anyTruncated).toBe(true);
		expect(cut.totals.profilesScanned).toBe(3);
		expect(cut.totals.tokensScanned).toBe(3);
	});
});
