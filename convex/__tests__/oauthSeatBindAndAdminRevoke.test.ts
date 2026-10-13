/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, operator doors on the oauth surface.
//
// 1. oauth:bindScopeProfileAgent: no door bound an agentId onto an
//    oauth_scope_profiles row, so a seat whose label carries an accent
//    ("hélios") but whose profileId does not ("helios-iris-rh") never resolved
//    its agent through the label fallback. The door binds it BY ID.
//    (internalMutation: no client or token reaches it, run with the admin key)
//    REFUSED  unknown profile; unknown agent; an
//             inactive agent; an agent of another org (judged by stored org IDs);
//             a profile or agent with no stored org ID (ORG_ID_MISSING).
//    PRESENT  the bind succeeds, resolveSeatAgent returns that agent.
//    ABSENT   (before the bind) the same profile resolves no agent.
//
// 2. Admin token revoke.
//    - revokeAccessTokensOnly on a client with no oauth_clients row (an
//      admin-minted token's `admin-mint:*` clientId) raises a CODED ConvexError
//      (CLIENT_NOT_FOUND) whose payload survives Convex's redaction, never a plain
//      Error.
//    - oauth:revokeAccessTokensOnly({ tokenId }) revokes ONE access token by its row _id.
//    - the client token walks paginate ONE table per transaction (Convex rejects
//      a second `.paginate` in one function; convex-test does not, so the guard
//      reads the source).

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { resolveSeatAgent } from "../lib/seatAgent";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T) =>
	t.withIdentity({
		subject: "ordinary-member",
		organizationId: "iris-rh",
		organizationSlug: "iris-rh",
		org_id: "org_IRIS1",
	} as Identity);

const NOW = 1_700_000_000_000;
const IRIS_ID = "org_IRIS1";
const OTHER_ID = "org_OTHER1";
const REASON = "operator audit trail reason, over twenty characters";

async function seed(t: T) {
	return await t.run(async (ctx) => {
		const agent = (
			orgSlug: string,
			clerkOrgId: string,
			name: string,
			isActive = true,
		) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId,
				name,
				normalizedName: name.toLowerCase(),
				isActive,
				createdAt: NOW,
			});
		const helios = await agent("iris-rh", IRIS_ID, "hélios");
		const retired = await agent("iris-rh", IRIS_ID, "retired", false);
		const foreign = await agent("other", OTHER_ID, "hélios");
		const profile = (profileId: string, fromAllowList: string[]) =>
			ctx.db.insert("oauth_scope_profiles", {
				profileId,
				description: "seat",
				fromAllowList,
				namespaceReadPrefixes: ["team/iris-rh"],
				namespaceWritePrefixes: ["team/iris-rh"],
				createdAt: NOW,
				updatedAt: NOW,
				clerkOrgSlug: "iris-rh",
				clerkOrgId: IRIS_ID,
			});
		await profile("helios-iris-rh", ["hélios"]);
		await profile("duo-iris-rh", ["hélios", "retired"]);
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "iris-rh",
			clerkOrgId: IRIS_ID,
			allowedOrchestrators: ["hélios", "retired"],
			scopes: ["view-own-tasks"],
			displayName: "iris-rh",
			isActive: true,
			createdAt: NOW,
		});
		return { helios, retired, foreign };
	});
}

const heliosToken = {
	scopeProfile: "helios-iris-rh",
	fromAllowList: ["hélios"],
	clerkOrgSlug: "iris-rh",
	clerkOrgId: IRIS_ID,
};

describe("oauth:bindScopeProfileAgent", () => {
	test("ABSENT then PRESENT: the unbound accented seat resolves nothing; after the bind it resolves the agent", async () => {
		const t = createT();
		const { helios } = await seed(t);
		expect(
			await t.run((ctx) => resolveSeatAgent(ctx, heliosToken)),
		).toBeNull();
		const res = await asService(t).mutation(internal.oauth.bindScopeProfileAgent, {
			profileId: "helios-iris-rh",
			agentId: helios,
		});
		expect(res).toEqual({
			profileId: "helios-iris-rh",
			agentId: helios,
			previousAgentId: null,
		});
		const agent = await t.run((ctx) => resolveSeatAgent(ctx, heliosToken));
		expect(agent?._id).toBe(helios);
	});

	test("REFUSED: unknown profile", async () => {
		const t = createT();
		const { helios } = await seed(t);
		await expect(
			asService(t).mutation(internal.oauth.bindScopeProfileAgent, {
				profileId: "ghost",
				agentId: helios,
			}),
		).rejects.toThrow(/PROFILE_NOT_FOUND/);
	});

	test("REFUSED: an inactive agent", async () => {
		const t = createT();
		const { retired } = await seed(t);
		await expect(
			asService(t).mutation(internal.oauth.bindScopeProfileAgent, {
				profileId: "helios-iris-rh",
				agentId: retired,
			}),
		).rejects.toThrow(/AGENT_INACTIVE/);
	});

	test("REFUSED: an agent of another organisation, same label", async () => {
		const t = createT();
		const { foreign } = await seed(t);
		await expect(
			asService(t).mutation(internal.oauth.bindScopeProfileAgent, {
				profileId: "helios-iris-rh",
				agentId: foreign,
			}),
		).rejects.toThrow(/AGENT_ORG_MISMATCH/);
		const row = await t.run((ctx) =>
			ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", "helios-iris-rh"))
				.unique(),
		);
		expect(row?.agentId).toBeUndefined();
	});

	test("REFUSED: a profile with a slug but no stored org ID (no label fallback)", async () => {
		const t = createT();
		const { helios } = await seed(t);
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", "helios-iris-rh"))
				.unique();
			if (row) await ctx.db.patch(row._id, { clerkOrgId: undefined });
		});
		await expect(
			internal_bind(t, "helios-iris-rh", helios),
		).rejects.toThrow(/ORG_ID_MISSING.*profile/s);
	});

	test("REFUSED: an agent with no stored org ID (no label fallback)", async () => {
		const t = createT();
		const { helios } = await seed(t);
		await t.run((ctx) => ctx.db.patch(helios, { clerkOrgId: undefined }));
		await expect(
			internal_bind(t, "helios-iris-rh", helios),
		).rejects.toThrow(/ORG_ID_MISSING.*agent/s);
	});

	test("PRESENT: the bind is by ID, whatever the label list holds", async () => {
		const t = createT();
		const { helios } = await seed(t);
		const res = await internal_bind(t, "duo-iris-rh", helios);
		expect(res.agentId).toBe(helios);
	});

	test("REFUSED: an agent id that names no row", async () => {
		const t = createT();
		const { helios } = await seed(t);
		await t.run((ctx) => ctx.db.delete(helios));
		await expect(
			asService(t).mutation(internal.oauth.bindScopeProfileAgent, {
				profileId: "helios-iris-rh",
				agentId: helios,
			}),
		).rejects.toThrow(/AGENT_NOT_FOUND/);
	});
});

function tokenRow(tokenHash: string, clientId: string) {
	return {
		tokenHash,
		clientId,
		userId: "admin",
		scopes: ["vantage:read"],
		scopeProfile: "helios-iris-rh",
		fromAllowList: ["hélios"],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: NOW + 3_600_000,
		createdAt: NOW,
	};
}

describe("oauth:revokeAccessTokensOnly on a client with no row", () => {
	test("REFUSED with a coded ConvexError, not a plain Error", async () => {
		const t = createT();
		const err = await asService(t)
			.mutation(api.oauth.revokeAccessTokensOnly, {
				clientId: "admin-mint:abc123",
				reason: REASON,
			})
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(err).not.toBeNull();
		expect((err as { name?: string }).name).toBe("ConvexError");
		expect(JSON.stringify((err as { data?: unknown }).data)).toContain(
			"CLIENT_NOT_FOUND",
		);
	});
});

describe("oauth:revokeAccessTokensOnly({ tokenId })", () => {
	test("PRESENT: revokes ONE token of an admin-minted client and leaves its sibling", async () => {
		const t = createT();
		const [one, other] = await t.run(async (ctx) => [
			await ctx.db.insert(
				"oauth_access_tokens",
				tokenRow("t".repeat(64), "admin-mint:abc123"),
			),
			await ctx.db.insert(
				"oauth_access_tokens",
				tokenRow("u".repeat(64), "admin-mint:abc123"),
			),
		]);
		const res = await asService(t).mutation(api.oauth.revokeAccessTokensOnly, {
			tokenId: one,
			reason: REASON,
		});
		expect(res.tokenId).toBe(one);
		expect(res.alreadyRevoked).toBe(false);
		const rows = await t.run(async (ctx) => [
			await ctx.db.get(one),
			await ctx.db.get(other),
		]);
		expect(rows[0]?.revokedAt).toBeTypeOf("number");
		expect(rows[1]?.revokedAt).toBeUndefined();
	});

	test("PRESENT: a second revoke is idempotent and keeps the first timestamp", async () => {
		const t = createT();
		const one = await t.run((ctx) =>
			ctx.db.insert(
				"oauth_access_tokens",
				tokenRow("t".repeat(64), "admin-mint:abc123"),
			),
		);
		const args = { tokenId: one, reason: REASON };
		await asService(t).mutation(api.oauth.revokeAccessTokensOnly, args);
		const first = await t.run((ctx) => ctx.db.get(one));
		const again = await asService(t).mutation(
			api.oauth.revokeAccessTokensOnly,
			args,
		);
		expect(again.alreadyRevoked).toBe(true);
		const second = await t.run((ctx) => ctx.db.get(one));
		expect(second?.revokedAt).toBe(first?.revokedAt);
	});

	test("REFUSED: not the service account", async () => {
		const t = createT();
		const one = await t.run((ctx) =>
			ctx.db.insert(
				"oauth_access_tokens",
				tokenRow("t".repeat(64), "admin-mint:abc123"),
			),
		);
		await expect(
			asMember(t).mutation(api.oauth.revokeAccessTokensOnly, {
				tokenId: one,
				reason: REASON,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await t.run((ctx) => ctx.db.get(one)))?.revokedAt).toBeUndefined();
	});

	test("REFUSED: neither or both targets", async () => {
		const t = createT();
		const one = await t.run((ctx) =>
			ctx.db.insert(
				"oauth_access_tokens",
				tokenRow("t".repeat(64), "admin-mint:abc123"),
			),
		);
		await expect(
			asService(t).mutation(api.oauth.revokeAccessTokensOnly, {
				reason: REASON,
			}),
		).rejects.toThrow(/INVALID_TARGET/);
		await expect(
			asService(t).mutation(api.oauth.revokeAccessTokensOnly, {
				clientId: "admin-mint:abc123",
				tokenId: one,
				reason: REASON,
			}),
		).rejects.toThrow(/INVALID_TARGET/);
		expect((await t.run((ctx) => ctx.db.get(one)))?.revokedAt).toBeUndefined();
	});

	test("REFUSED: a short reason, a malformed id, a missing row (all coded)", async () => {
		const t = createT();
		const one = await t.run((ctx) =>
			ctx.db.insert(
				"oauth_access_tokens",
				tokenRow("t".repeat(64), "admin-mint:abc123"),
			),
		);
		await expect(
			asService(t).mutation(api.oauth.revokeAccessTokensOnly, {
				tokenId: one,
				reason: "short",
			}),
		).rejects.toThrow(/REASON_TOO_SHORT/);
		await expect(
			asService(t).mutation(api.oauth.revokeAccessTokensOnly, {
				tokenId: "not-an-id",
				reason: REASON,
			}),
		).rejects.toThrow(/not a valid oauth_access_tokens ID/);
		await t.run((ctx) => ctx.db.delete(one));
		await expect(
			asService(t).mutation(api.oauth.revokeAccessTokensOnly, {
				tokenId: one,
				reason: REASON,
			}),
		).rejects.toThrow(/TOKEN_NOT_FOUND/);
	});
});

describe("oauth client token walks: one paginate per transaction", () => {
	test("walkClientTokensPage holds at most one .paginate call", () => {
		const src = readFileSync(new URL("../oauth.ts", import.meta.url), "utf8");
		const start = src.indexOf("async function walkClientTokensPage");
		const end = src.indexOf("export const continueClientTokenWalk");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const body = src.slice(start, end);
		// Convex raises "ran multiple paginated queries" at the second .paginate of
		// one function; the access AND refresh tables are walked in ONE call.
		expect(body.match(/\.paginate\(/g)?.length ?? 0).toBeLessThanOrEqual(1);
	});
});

function internal_bind(t: T, profileId: string, agentId: Id<"agents">) {
	return asService(t).mutation(internal.oauth.bindScopeProfileAgent, {
		profileId,
		agentId,
	});
}
