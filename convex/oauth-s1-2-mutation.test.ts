/// <reference types="vite/client" />
/**
 * S1.2-mutation — patchScopeProfileEmergency tests
 *
 * Day 90 Marie security leak remediation:
 *   - scope_profile `marie-iris-rh` had `global` in read/write prefixes
 *   - D4 enforcement: no `global` unless profile name is `master`
 *   - D9 workspace-level rename: `marie-iris-rh` → `iris-rh`
 *   - Cascade revoke all oauth_access_tokens + oauth_refresh_tokens
 *   - Append-only oauth_audit_log row
 *
 * Sprint S1.2 | Mission k57c7s478gw1a3e5gmhdeptg5n87z78n
 * Task k178bdsbkjazrap1eqw1pn90b987z2yj
 * Doctrine j579y6f31g7xzgtgdnpgetdmjx87ztyj base + j57bvz4c62mrfs024fay5vhqqs87zxph
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER_TOKEN = "test-master-token-s1-2-mutation-deadbeef";
const REASON_OK =
	"Day 90 security: remove global prefix from marie-iris-rh — D4 violation remediation";

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER_TOKEN);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

async function seedLeakedProfile(t: ReturnType<typeof createTestConvex>) {
	// Insert a profile that has `global` in prefixes — the Day 90 leak state
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "marie-iris-rh",
			description: "Marie — Day 88 seeded state with global leak",
			fromAllowList: ["marie"],
			namespaceReadPrefixes: [
				"orchestrator/marie",
				"orchestrator/victor",
				"project/marie",
				"global",
			],
			namespaceWritePrefixes: [
				"orchestrator/marie",
				"orchestrator/victor",
				"project/marie",
				"global",
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function seedMasterProfile(t: ReturnType<typeof createTestConvex>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "master",
			description: "Full admin access",
			fromAllowList: ["*"],
			namespaceReadPrefixes: ["*"],
			namespaceWritePrefixes: ["*"],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — master token guard
// ─────────────────────────────────────────────────────────────────────────────

describe("T1 — master token guard", () => {
	test("caller without master token throws UNAUTHORIZED", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);
		await expect(
			t.mutation(api.oauth.patchScopeProfileEmergency, {
				callerToken: "not-the-master",
				profileId: "marie-iris-rh",
				cascadeRevokeTokens: false,
				reason: REASON_OK,
			}),
		).rejects.toThrow(/Unauthorized/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — reason guard
// ─────────────────────────────────────────────────────────────────────────────

describe("T2 — reason length guard", () => {
	test("short reason (< 40 chars) throws", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);
		await expect(
			t.mutation(api.oauth.patchScopeProfileEmergency, {
				callerToken: MASTER_TOKEN,
				profileId: "marie-iris-rh",
				cascadeRevokeTokens: false,
				reason: "too short",
			}),
		).rejects.toThrow(/reason/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — D4 enforcement: "global" in readPrefixes for non-master throws
// ─────────────────────────────────────────────────────────────────────────────

describe("T3 — D4 enforcement: global in readPrefixes for non-master", () => {
	test("throws D4 violation when global is in namespaceReadPrefixes for non-master profile", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);
		await expect(
			t.mutation(api.oauth.patchScopeProfileEmergency, {
				callerToken: MASTER_TOKEN,
				profileId: "marie-iris-rh",
				namespaceReadPrefixes: ["orchestrator/marie", "global"],
				cascadeRevokeTokens: false,
				reason: REASON_OK,
			}),
		).rejects.toThrow(/D4 violation/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — D4 enforcement: "*" in prefixes throws
// ─────────────────────────────────────────────────────────────────────────────

describe("T4 — D4 enforcement: wildcard * in prefixes for non-master", () => {
	test("throws D4 violation when * is in namespaceWritePrefixes for non-master profile", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);
		await expect(
			t.mutation(api.oauth.patchScopeProfileEmergency, {
				callerToken: MASTER_TOKEN,
				profileId: "marie-iris-rh",
				namespaceWritePrefixes: ["*"],
				cascadeRevokeTokens: false,
				reason: REASON_OK,
			}),
		).rejects.toThrow(/D4 violation/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 — master profile CAN include "global"
// ─────────────────────────────────────────────────────────────────────────────

describe("T5 — master profile CAN include global (no D4 violation)", () => {
	test("no throw when global is in prefixes for master profile rename", async () => {
		const t = createTestConvex();
		await seedMasterProfile(t);
		// master profile can freely have "global" — D4 only blocks non-master profiles
		await expect(
			t.mutation(api.oauth.patchScopeProfileEmergency, {
				callerToken: MASTER_TOKEN,
				profileId: "master",
				namespaceReadPrefixes: ["*", "global"],
				namespaceWritePrefixes: ["*", "global"],
				cascadeRevokeTokens: false,
				reason:
					"Admin patching master profile to add explicit global prefix for audit completeness",
			}),
		).resolves.toBeDefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 — happy path: patch fields + return shape correct
// ─────────────────────────────────────────────────────────────────────────────

describe("T6 — happy path: patch fields + return shape", () => {
	test("returns { patchedProfileId, cascadeRevokedCount, auditLogId }", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);
		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "marie-iris-rh",
			fromAllowList: ["marie", "victor"],
			namespaceReadPrefixes: [
				"orchestrator/marie",
				"orchestrator/victor",
				"project/iris-rh",
			],
			namespaceWritePrefixes: ["orchestrator/marie", "project/iris-rh"],
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});
		expect(result).toHaveProperty("patchedProfileId");
		expect(result).toHaveProperty("cascadeRevokedCount");
		expect(result).toHaveProperty("auditLogId");
		expect(result.patchedProfileId).toBe("marie-iris-rh");
		expect(result.cascadeRevokedCount).toBe(0);
		expect(typeof result.auditLogId).toBe("string");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T7 — rename: old profileId → new profileId persisted
// ─────────────────────────────────────────────────────────────────────────────

describe("T7 — rename: old profileId → new profileId persisted", () => {
	test("query by new name succeeds, by old name fails after rename", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);
		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "marie-iris-rh",
			rename: "iris-rh",
			namespaceReadPrefixes: [
				"orchestrator/marie",
				"orchestrator/victor",
				"project/iris-rh",
			],
			namespaceWritePrefixes: ["orchestrator/marie", "project/iris-rh"],
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});
		expect(result.patchedProfileId).toBe("iris-rh");

		// Query by new name succeeds
		const newProfile = await t.query(api.oauth.getScopeProfile, {
			profileId: "iris-rh",
		});
		expect(newProfile).not.toBeNull();
		expect(newProfile?.profileId).toBe("iris-rh");

		// Query by old name fails (returns null)
		const oldProfile = await t.query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
		});
		expect(oldProfile).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T8 — cascade revoke access_tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("T8 — cascade revoke access_tokens citing profile", () => {
	test("access tokens citing the profile are deleted, count returned", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);

		// Insert 2 access tokens citing this profile
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "aa".repeat(32),
				clientId: "client-marie-1",
				userId: "marie",
				scopes: ["vantage:read"],
				scopeProfile: "marie-iris-rh",
				fromAllowList: ["marie"],
				namespaceReadPrefixes: ["orchestrator/marie", "global"],
				namespaceWritePrefixes: ["orchestrator/marie", "global"],
				expiresAt: Date.now() + 3600_000,
				createdAt: Date.now(),
			});
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "bb".repeat(32),
				clientId: "client-marie-2",
				userId: "marie",
				scopes: ["vantage:read"],
				scopeProfile: "marie-iris-rh",
				fromAllowList: ["marie"],
				namespaceReadPrefixes: ["orchestrator/marie", "global"],
				namespaceWritePrefixes: ["orchestrator/marie", "global"],
				expiresAt: Date.now() + 3600_000,
				createdAt: Date.now(),
			});
		});

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "marie-iris-rh",
			namespaceReadPrefixes: ["orchestrator/marie", "orchestrator/victor"],
			namespaceWritePrefixes: ["orchestrator/marie"],
			cascadeRevokeTokens: true,
			reason: REASON_OK,
		});
		expect(result.cascadeRevokedCount).toBe(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T9 — audit log row inserted
// ─────────────────────────────────────────────────────────────────────────────

describe("T9 — audit log row inserted with correct fields", () => {
	test("audit log has previousState, newState, actorTokenHash, reason", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);
		await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "marie-iris-rh",
			namespaceReadPrefixes: ["orchestrator/marie"],
			namespaceWritePrefixes: ["orchestrator/marie"],
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		// Read the audit log row directly via typed query
		const auditRow = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_audit_log")
				.withIndex("by_targetProfileId", (q) =>
					q.eq("targetProfileId", "marie-iris-rh"),
				)
				.unique();
		});
		expect(auditRow).not.toBeNull();
		expect(auditRow?.eventType).toBe("scope_profile_emergency_patch");
		expect(auditRow?.targetProfileId).toBe("marie-iris-rh");
		expect(auditRow?.reason).toBe(REASON_OK);
		// actorTokenHash must NOT be the raw token
		expect(auditRow?.actorTokenHash).not.toBe(MASTER_TOKEN);
		// must be a 64-char hex string (sha256)
		expect(auditRow?.actorTokenHash).toMatch(/^[0-9a-f]{64}$/);
		// previousState must include the leaked `global`
		expect(auditRow?.previousState.namespaceReadPrefixes).toContain("global");
		// newState must NOT include `global`
		expect(auditRow?.newState.namespaceReadPrefixes).not.toContain("global");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T10 — refresh tokens cascade revoke
// ─────────────────────────────────────────────────────────────────────────────

describe("T10 — refresh tokens cascade revoke counted", () => {
	test("refresh tokens citing profile are deleted and counted", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);

		// Insert 1 refresh token citing this profile
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_refresh_tokens", {
				tokenHash: "cc".repeat(32),
				clientId: "client-marie-refresh",
				userId: "marie",
				scopeProfile: "marie-iris-rh",
				expiresAt: Date.now() + 30 * 24 * 3600_000,
				createdAt: Date.now(),
			});
		});

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "marie-iris-rh",
			namespaceReadPrefixes: ["orchestrator/marie"],
			namespaceWritePrefixes: ["orchestrator/marie"],
			cascadeRevokeTokens: true,
			reason: REASON_OK,
		});
		// 0 access tokens + 1 refresh token = 1 total
		expect(result.cascadeRevokedCount).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T11 — missing profile
// ─────────────────────────────────────────────────────────────────────────────

describe("T11 — missing profile throws", () => {
	test("throws profile not found when profileId does not exist", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.patchScopeProfileEmergency, {
				callerToken: MASTER_TOKEN,
				profileId: "does-not-exist",
				cascadeRevokeTokens: false,
				reason: REASON_OK,
			}),
		).rejects.toThrow(/profile not found/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T12 — partial patch: only fromAllowList changes
// ─────────────────────────────────────────────────────────────────────────────

describe("T12 — partial patch: only fromAllowList changes", () => {
	test("other prefixes are preserved when only fromAllowList is provided", async () => {
		const t = createTestConvex();
		// Insert a clean profile (no global leak)
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "partial-test",
				description: "Profile for partial patch test",
				fromAllowList: ["marie"],
				namespaceReadPrefixes: ["orchestrator/marie", "project/marie"],
				namespaceWritePrefixes: ["orchestrator/marie"],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "partial-test",
			fromAllowList: ["marie", "victor"], // only this changes
			cascadeRevokeTokens: false,
			reason: "Partial patch test — adding victor to fromAllowList for audit",
		});

		const updated = await t.query(api.oauth.getScopeProfile, {
			profileId: "partial-test",
		});
		// fromAllowList was updated
		expect(updated?.fromAllowList).toEqual(["marie", "victor"]);
		// prefixes remain unchanged (no prefixes arg provided)
		expect(updated?.namespaceReadPrefixes).toEqual([
			"orchestrator/marie",
			"project/marie",
		]);
		expect(updated?.namespaceWritePrefixes).toEqual(["orchestrator/marie"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MT1 — access tokens for OTHER profiles unaffected by cascade
// ─────────────────────────────────────────────────────────────────────────────

describe("MT1 — access tokens for other profiles are unaffected", () => {
	test("cascade revoke only targets the patched profile, not other profiles", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);

		// Insert tokens for a different profile
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "dd".repeat(32),
				clientId: "client-other",
				userId: "other-user",
				scopes: ["vantage:read"],
				scopeProfile: "other-profile",
				fromAllowList: ["other"],
				namespaceReadPrefixes: ["orchestrator/other"],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3600_000,
				createdAt: Date.now(),
			});
		});

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "marie-iris-rh",
			namespaceReadPrefixes: ["orchestrator/marie"],
			namespaceWritePrefixes: ["orchestrator/marie"],
			cascadeRevokeTokens: true,
			reason: REASON_OK,
		});

		// No tokens for marie-iris-rh → 0 revoked
		expect(result.cascadeRevokedCount).toBe(0);

		// The other-profile token must still exist
		const otherToken = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_access_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", "dd".repeat(32)))
				.unique();
		});
		expect(otherToken).not.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MT2 — audit log filterable via by_targetProfileId index
// ─────────────────────────────────────────────────────────────────────────────

describe("MT2 — audit log filterable via by_targetProfileId index", () => {
	test("two patches on different profiles produce separate audit rows filterable by targetProfileId", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);
		// Create a second profile
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "another-profile",
				description: "Another profile for MT2",
				fromAllowList: ["other"],
				namespaceReadPrefixes: ["orchestrator/other"],
				namespaceWritePrefixes: ["orchestrator/other"],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "marie-iris-rh",
			namespaceReadPrefixes: ["orchestrator/marie"],
			namespaceWritePrefixes: ["orchestrator/marie"],
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});
		await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "another-profile",
			namespaceReadPrefixes: ["orchestrator/other"],
			namespaceWritePrefixes: ["orchestrator/other"],
			cascadeRevokeTokens: false,
			reason: "Another profile patch for MT2 audit log isolation test coverage",
		});

		const marieRows = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_audit_log")
				.withIndex("by_targetProfileId", (q) =>
					q.eq("targetProfileId", "marie-iris-rh"),
				)
				.collect();
		});
		expect(marieRows).toHaveLength(1);
		expect(marieRows[0].targetProfileId).toBe("marie-iris-rh");

		const otherRows = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_audit_log")
				.withIndex("by_targetProfileId", (q) =>
					q.eq("targetProfileId", "another-profile"),
				)
				.collect();
		});
		expect(otherRows).toHaveLength(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MT3 — multiple concurrent profiles tracked separately
// ─────────────────────────────────────────────────────────────────────────────

describe("MT3 — multiple concurrent profiles tracked separately", () => {
	test("patching three profiles produces three separate audit log rows", async () => {
		const t = createTestConvex();

		// Seed three profiles
		for (const pid of ["profile-a", "profile-b", "profile-c"]) {
			await t.run(async (ctx) => {
				await ctx.db.insert("oauth_scope_profiles", {
					profileId: pid,
					description: `Profile ${pid} for MT3`,
					fromAllowList: ["test"],
					namespaceReadPrefixes: ["orchestrator/test"],
					namespaceWritePrefixes: ["orchestrator/test"],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			});
		}

		for (const pid of ["profile-a", "profile-b", "profile-c"]) {
			await t.mutation(api.oauth.patchScopeProfileEmergency, {
				callerToken: MASTER_TOKEN,
				profileId: pid,
				fromAllowList: ["test-updated"],
				cascadeRevokeTokens: false,
				reason: `MT3 test patch for profile ${pid} — tracking separate audit entries per profile`,
			});
		}

		const totalRows = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_audit_log").collect();
		});
		expect(totalRows).toHaveLength(3);
		const profileIds = totalRows.map((r) => r.targetProfileId).sort();
		expect(profileIds).toEqual(["profile-a", "profile-b", "profile-c"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SL1 — after patch, no `global` in resulting prefixes (D4 post-condition)
// ─────────────────────────────────────────────────────────────────────────────

describe("SL1 — D4 post-condition: no global in resulting prefixes after patch", () => {
	test("patching leaked profile removes global from read and write prefixes", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);

		await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "marie-iris-rh",
			namespaceReadPrefixes: [
				"orchestrator/marie",
				"orchestrator/victor",
				"project/iris-rh",
			],
			namespaceWritePrefixes: ["orchestrator/marie", "project/iris-rh"],
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
		});
		expect(profile?.namespaceReadPrefixes).not.toContain("global");
		expect(profile?.namespaceWritePrefixes).not.toContain("global");
		expect(profile?.namespaceReadPrefixes).not.toContain("*");
		expect(profile?.namespaceWritePrefixes).not.toContain("*");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SL2 — master profile retains wildcard unaffected by non-master patches
// ─────────────────────────────────────────────────────────────────────────────

describe("SL2 — master profile retains wildcard after non-master patch", () => {
	test("patching marie-iris-rh does not affect master profile wildcards", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);
		await seedMasterProfile(t);

		// Patch the leaked non-master profile
		await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "marie-iris-rh",
			namespaceReadPrefixes: ["orchestrator/marie"],
			namespaceWritePrefixes: ["orchestrator/marie"],
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		// Master profile must still retain its wildcards
		const masterProfile = await t.query(api.oauth.getScopeProfile, {
			profileId: "master",
		});
		expect(masterProfile?.namespaceReadPrefixes).toContain("*");
		expect(masterProfile?.namespaceWritePrefixes).toContain("*");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SL3 — audit log captures previous state including leaked `global`
// ─────────────────────────────────────────────────────────────────────────────

describe("SL3 — audit log forensic: previousState captures leaked global", () => {
	test("audit log previousState includes global prefix as forensic evidence", async () => {
		const t = createTestConvex();
		await seedLeakedProfile(t);

		await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "marie-iris-rh",
			namespaceReadPrefixes: ["orchestrator/marie"],
			namespaceWritePrefixes: ["orchestrator/marie"],
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		const auditRow = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_audit_log")
				.withIndex("by_targetProfileId", (q) =>
					q.eq("targetProfileId", "marie-iris-rh"),
				)
				.unique();
		});
		// Forensic evidence: previous state must document the leaked `global`
		expect(auditRow?.previousState.namespaceReadPrefixes).toContain("global");
		expect(auditRow?.previousState.namespaceWritePrefixes).toContain("global");
		// New state must not contain `global`
		expect(auditRow?.newState.namespaceReadPrefixes).not.toContain("global");
		expect(auditRow?.newState.namespaceWritePrefixes).not.toContain("global");
	});
});
