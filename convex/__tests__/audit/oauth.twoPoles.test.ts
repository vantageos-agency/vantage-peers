/// <reference types="vite/client" />
/**
 * Audit R3 reproductions (oauth). Each test asserts the CORRECT behaviour and is
 * expected to FAIL today if the audited defect is real.
 * Provenance: static audit of VantagePeers main @16f0907, rows in defects-R3.jsonl.
 */
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

const SERVICE_ACCOUNT_ID = "test-service-account-user-id";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const REASON = "audit reproduction reason that is comfortably over forty characters";

afterEach(() => vi.unstubAllEnvs());

describe("oauth:provisionOrganization", () => {
	test("oauth:provisionOrganization — the master secret passed as callerToken leaves no digest of itself in oauth_audit_log", async () => {
		// Identity: no Clerk identity, master secret as callerToken (the path under audit).
		const MASTER = "audit-r3-master-secret-value-0001";
		vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
		const t = convexTest(schema, modules);
		const res = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "audit-new-org",
			displayName: "Audit New Org",
			orchestrators: [{ name: "auditseat" }],
		});
		expect(res.replay).toBe(false);
		const rows = await t.run((ctx) =>
			ctx.db
				.query("oauth_audit_log")
				.filter((q) => q.eq(q.field("eventType"), "organization_provision"))
				.collect(),
		);
		// positive control: the audit row exists and carries a 64-hex digest
		expect(rows.length).toBe(1);
		expect(rows[0].actorTokenHash).toMatch(/^[0-9a-f]{64}$/);
		const leaksMasterDigest = rows.some((r) => r.actorTokenHash === sha(MASTER));
		expect(leaksMasterDigest, "actorTokenHash equals unsalted sha256 of the master secret").toBe(false);
	});
});

describe("oauth:createAuthorizationCode", () => {
	test("oauth:createAuthorizationCode — the single-use code is not stored in plaintext", async () => {
		// Identity: fleet service account (the only admitted caller).
		const t = convexTest(schema, modules);
		const tSvc = t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
		const CODE = "audit-r3-plain-code-0001";
		await tSvc.mutation(api.oauth.createAuthorizationCode, {
			code: CODE,
			clientId: "c1",
			redirectUri: "https://client.example/cb",
			codeChallenge: "challenge",
			scope: "mcp:full",
			userId: "u1",
			expiresAt: Date.now() - 1,
		});
		const rows = await t.run((ctx) => ctx.db.query("oauth_authorization_codes").collect());
		expect(rows.length).toBe(1); // positive control: the write landed
		expect(rows.some((r) => r.code === CODE), "row.code holds the plaintext code").toBe(false);
	});
});

describe("oauth:patchScopeProfileEmergency", () => {
	const seedProfile = (
		t: ReturnType<typeof convexTest>,
		profileId: string,
		prefixes: string[],
	) =>
		t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId,
				description: profileId,
				fromAllowList: ["a"],
				namespaceReadPrefixes: prefixes,
				namespaceWritePrefixes: prefixes,
				createdAt: now,
				updatedAt: now,
			});
		});

	test("oauth:patchScopeProfileEmergency — renaming master (wildcard prefixes) to a non-master id is refused by D4", async () => {
		// Identity: fleet service account (the only admitted caller).
		const t = convexTest(schema, modules);
		await seedProfile(t, "master", ["*"]);
		const tSvc = t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
		await expect(
			tSvc.mutation(api.oauth.patchScopeProfileEmergency, {
				profileId: "master",
				rename: "client-x",
				cascadeRevokeTokens: false,
				reason: REASON,
			}),
		).rejects.toThrow(/D4/);
	});

	test("oauth:patchScopeProfileEmergency — a rename onto an existing profileId is refused (no duplicate profileId)", async () => {
		// Identity: fleet service account.
		const t = convexTest(schema, modules);
		await seedProfile(t, "client-generic", ["ns/"]);
		await seedProfile(t, "public-readonly", ["ns/"]);
		const tSvc = t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
		await expect(
			tSvc.mutation(api.oauth.patchScopeProfileEmergency, {
				profileId: "client-generic",
				rename: "public-readonly",
				cascadeRevokeTokens: false,
				reason: REASON,
			}),
		).rejects.toThrow();
		const rows = await t.run((ctx) =>
			ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", "public-readonly"))
				.collect(),
		);
		expect(rows.length, "rows sharing profileId public-readonly").toBe(1);
	});
});
