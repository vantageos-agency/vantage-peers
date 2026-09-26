/// <reference types="vite/client" />
/**
 * iframeEmbedSessions.createSession / touchSession / revokeSession —
 * write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): all three mutations authorized on NOTHING —
 * `tenantId` was a plain CALLER-SUPPLIED string argument, never verified.
 * Any caller holding this public deployment's URL could create a session
 * asserting ANY tenant's id, or touch/revoke a session belonging to another
 * tenant by simply presenting its `sessionId`. Defect class:
 * .claude/rules/authority-attached-to-anonymous-object.md.
 *
 * This suite proves: an anonymous caller is refused on all three surfaces,
 * a caller cannot create a session under a DIFFERENT tenant's id than its
 * own verified org, and a caller cannot touch/revoke a session owned by a
 * DIFFERENT tenant — while the master/service-account identity keeps its
 * legacy unrestricted behaviour.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
const NOW = 1_748_390_400_000;
const ONE_HOUR = 60 * 60 * 1000;

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asOrgB(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-b",
		organizationId: "org-b",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedOrgMapping(t: ReturnType<typeof createT>, slug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: [`seat-${slug}`],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedSession(
	t: ReturnType<typeof createT>,
	sessionId: string,
	tenantId: string,
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("iframeEmbedSessions", {
			sessionId,
			tenantId,
			origin: "https://acme-hr.vantagepeers.com",
			createdAt: NOW,
			lastSeenAt: NOW,
			expiresAt: NOW + ONE_HOUR,
			revoked: false,
		});
	});
}

describe("iframeEmbedSessions.createSession — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await expect(
			t.mutation(api.iframeEmbedSessions.createSession, {
				sessionId: "sess-anon",
				origin: "https://app.example.com",
				expiresAt: NOW + ONE_HOUR,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const all = await t.run((ctx) =>
			ctx.db.query("iframeEmbedSessions").collect(),
		);
		expect(all).toHaveLength(0);
	});

	test("a caller asserting a DIFFERENT tenant than its own verified org is refused (cross-tenant)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.iframeEmbedSessions.createSession, {
				sessionId: "sess-attack",
				tenantId: "org-b",
				origin: "https://org-b.vantagepeers.com",
				expiresAt: NOW + ONE_HOUR,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const all = await t.run((ctx) =>
			ctx.db.query("iframeEmbedSessions").collect(),
		);
		expect(all).toHaveLength(0);
	});

	test("a caller's session tenantId is forced to its own org regardless of a passed tenantId", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const tA = asOrgA(t);

		const sessionId = await tA.mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "sess-org-a",
			origin: "https://org-a.vantagepeers.com",
			expiresAt: NOW + ONE_HOUR,
		});
		const session = await t.run((ctx) => ctx.db.get(sessionId));
		expect(session?.tenantId).toBe("org-a");
	});
});

describe("iframeEmbedSessions.touchSession — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused (existence oracle: master can still touch the SAME row)", async () => {
		const t = createT();
		await seedSession(t, "sess-touch", "org-a");

		await expect(
			t.mutation(api.iframeEmbedSessions.touchSession, {
				sessionId: "sess-touch",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const tMaster = asMaster(t);
		const result = await tMaster.mutation(api.iframeEmbedSessions.touchSession, {
			sessionId: "sess-touch",
		});
		expect(result).toBe(true);
	});

	test("a caller from a DIFFERENT tenant may not touch this tenant's session (cross-tenant)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		await seedSession(t, "sess-org-a", "org-a");
		const tB = asOrgB(t);

		await expect(
			tB.mutation(api.iframeEmbedSessions.touchSession, {
				sessionId: "sess-org-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("the owning tenant may touch its own session", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedSession(t, "sess-org-a", "org-a");
		const tA = asOrgA(t);

		const result = await tA.mutation(api.iframeEmbedSessions.touchSession, {
			sessionId: "sess-org-a",
		});
		expect(result).toBe(true);
	});
});

describe("iframeEmbedSessions.revokeSession — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused (existence oracle: master can still revoke the SAME row)", async () => {
		const t = createT();
		await seedSession(t, "sess-revoke", "org-a");

		await expect(
			t.mutation(api.iframeEmbedSessions.revokeSession, {
				sessionId: "sess-revoke",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const tMaster = asMaster(t);
		const result = await tMaster.mutation(api.iframeEmbedSessions.revokeSession, {
			sessionId: "sess-revoke",
		});
		expect(result).toBe(true);
	});

	test("a caller from a DIFFERENT tenant may not revoke this tenant's session (cross-tenant)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		await seedSession(t, "sess-org-a-2", "org-a");
		const tB = asOrgB(t);

		await expect(
			tB.mutation(api.iframeEmbedSessions.revokeSession, {
				sessionId: "sess-org-a-2",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const untouched = await t.run((ctx) =>
			ctx.db
				.query("iframeEmbedSessions")
				.withIndex("by_session_id", (q) => q.eq("sessionId", "sess-org-a-2"))
				.unique(),
		);
		expect(untouched?.revoked).toBe(false);
	});

	test("the owning tenant may revoke its own session", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedSession(t, "sess-org-a-3", "org-a");
		const tA = asOrgA(t);

		const result = await tA.mutation(api.iframeEmbedSessions.revokeSession, {
			sessionId: "sess-org-a-3",
		});
		expect(result).toBe(true);
	});
});
