/// <reference types="vite/client" />
/**
 * IFRAME EMBED SESSIONS BELONG TO AN ORGANISATION BY ITS PERMANENT ORG ID (module M10i).
 *
 * A session stores the tenant's org ID beside its slug label (`tenantOrgId`).
 * `getSession` compares that ID with the caller's verified org ID (the package's
 * `sameOrg`); a slug never admits. The fleet is the package's `fleet` standing.
 * The three write doors (createSession / touchSession / revokeSession) were
 * removed (task k17cbr6y6da096t5e1k869kgb18hd0ht: no caller in any repo of the
 * organisation), so rows are seeded straight into the table. Every pole runs
 * under an ORDINARY org member, the service account, or no credential.
 *
 * POLES
 *   PERMISSION  - a member reads its own session, also after its org's slug was
 *                 renamed; the fleet reads any.
 *   DENIED      - another org that now HOLDS the old slug reads nothing; an
 *                 unstamped session is the fleet's alone; an anonymous read is
 *                 the typed null.
 *   ABSENT      - a revoked or unknown session reads null.
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const A = "org-a";
const B = "org-b";
const NOW = 1_700_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, slug: string, orgId = testClerkOrgId(slug)) =>
	t.withIdentity({
		subject: `user-of-${orgId}`,
		organizationSlug: slug,
		org_id: orgId,
	} as Identity);

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		for (const slug of [A, B]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
			});
		}
	});
}

const future = () => Date.now() + 3_600_000;

async function seedSession(
	t: T,
	sessionId: string,
	org: string | null,
	revoked = false,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("iframeEmbedSessions", {
			sessionId,
			...(org !== null
				? { tenantId: org, tenantOrgId: testClerkOrgId(org) }
				: {}),
			origin: "https://x.example",
			createdAt: NOW,
			lastSeenAt: NOW,
			expiresAt: future(),
			revoked,
		});
	});
}

describe("PERMISSION", () => {
	test("the member reads its own session", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedSession(t, "S1", A);
		const got = await asMember(t, A).query(
			api.iframeEmbedSessions.getSession,
			{ sessionId: "S1" },
		);
		expect(got?.tenantId).toBe(A);
	});

	test("RENAME: after the org's slug changed the member (new slug, same org ID) still reaches its own session", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedSession(t, "S1", A);
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", A))
				.unique();
			if (m !== null)
				await ctx.db.patch(m._id, { clerkOrgSlug: "org-a-renamed" });
		});
		const renamed = asMember(t, "org-a-renamed", testClerkOrgId(A));
		expect(
			await renamed.query(api.iframeEmbedSessions.getSession, {
				sessionId: "S1",
			}),
		).not.toBeNull();
	});

	test("the fleet reads any session, stamped or not", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedSession(t, "S1", B);
		await seedSession(t, "F1", null);
		const f = asService(t);
		expect(
			(await f.query(api.iframeEmbedSessions.getSession, { sessionId: "S1" }))
				?.tenantId,
		).toBe(B);
		expect(
			await f.query(api.iframeEmbedSessions.getSession, { sessionId: "F1" }),
		).not.toBeNull();
	});
});

describe("DENIED", () => {
	test("REUSED slug: another org that now holds the old slug reads nothing of the first org's session", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedSession(t, "S1", A);
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", A))
				.unique();
			if (m !== null)
				await ctx.db.patch(m._id, { clerkOrgSlug: "org-a-renamed" });
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: A,
				clerkOrgId: "org_NEWCOMER1",
				allowedOrchestrators: [],
				scopes: [],
				displayName: A,
				isActive: true,
				createdAt: NOW,
			});
		});
		const newcomer = asMember(t, A, "org_NEWCOMER1");
		expect(
			await newcomer.query(api.iframeEmbedSessions.getSession, {
				sessionId: "S1",
			}),
		).toBeNull();
	});

	test("an unstamped session is the fleet's alone", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedSession(t, "F1", null);
		expect(
			await asMember(t, A).query(api.iframeEmbedSessions.getSession, {
				sessionId: "F1",
			}),
		).toBeNull();
	});

	test("an anonymous read is the typed null", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedSession(t, "S1", A);
		expect(
			await t.query(api.iframeEmbedSessions.getSession, { sessionId: "S1" }),
		).toBeNull();
	});
});

describe("ABSENT", () => {
	test("a revoked or unknown session reads null", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedSession(t, "S1", A, true);
		const a = asMember(t, A);
		expect(
			await a.query(api.iframeEmbedSessions.getSession, { sessionId: "S1" }),
		).toBeNull();
		expect(
			await a.query(api.iframeEmbedSessions.getSession, { sessionId: "nope" }),
		).toBeNull();
	});
});
