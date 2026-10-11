/// <reference types="vite/client" />
/**
 * IFRAME EMBED SESSIONS BELONG TO AN ORGANISATION BY ITS PERMANENT ORG ID (module M10i).
 *
 * A session stores the tenant's org ID beside its slug label (`tenantOrgId`).
 * The doors compare that ID with the caller's verified org ID (the package's
 * `sameOrg`); a slug never admits. A session id is never re-used, a member's
 * session carries the verified subject, and the fleet is the package's `fleet`
 * standing. Every pole runs under an ORDINARY org member or the service account.
 *
 * POLES
 *   PERMISSION  - a member creates, reads, touches and revokes its own session,
 *                 also after its org's slug was renamed; the fleet uses any.
 *   DENIED      - another org that now HOLDS the old slug reaches nothing; a
 *                 claimed foreign tenant or foreign user is refused; a duplicate
 *                 id is refused; an unstamped session is the fleet's alone;
 *                 an anonymous write is refused by raising.
 *   ABSENT      - a revoked or unknown session reads null; touching an unknown
 *                 session answers false.
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
const create = (c: ReturnType<typeof asMember>, sessionId: string, extra = {}) =>
	c.mutation(api.iframeEmbedSessions.createSession, {
		sessionId,
		origin: "https://x.example",
		expiresAt: future(),
		...extra,
	});

const refusal = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (e) {
		const x = e as { data?: unknown; message?: string };
		return typeof x.data === "string" ? x.data : String(x.message);
	}
	return "SERVED";
};

describe("PERMISSION", () => {
	test("a member's session is stamped with the verified org's slug AND ID and the verified subject", async () => {
		const t = createT();
		await seedOrgs(t);
		await create(asMember(t, A), "S1");
		const [row] = await t.run((ctx) => ctx.db.query("iframeEmbedSessions").collect());
		expect(row.tenantId).toBe(A);
		expect(row.tenantOrgId).toBe(testClerkOrgId(A));
		expect(row.userId).toBe(`user-of-${testClerkOrgId(A)}`);
	});

	test("the member reads, touches and revokes its own session; a claim equal to its own org and subject is accepted", async () => {
		const t = createT();
		await seedOrgs(t);
		const a = asMember(t, A);
		await create(a, "S1", { tenantId: A, userId: `user-of-${testClerkOrgId(A)}` });
		expect((await a.query(api.iframeEmbedSessions.getSession, { sessionId: "S1" }))?.tenantId).toBe(A);
		expect(await a.mutation(api.iframeEmbedSessions.touchSession, { sessionId: "S1" })).toBe(true);
		expect(await a.mutation(api.iframeEmbedSessions.revokeSession, { sessionId: "S1" })).toBe(true);
	});

	test("RENAME: after the org's slug changed the member (new slug, same org ID) still reaches its own session", async () => {
		const t = createT();
		await seedOrgs(t);
		await create(asMember(t, A), "S1");
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", A))
				.unique();
			if (m !== null) await ctx.db.patch(m._id, { clerkOrgSlug: "org-a-renamed" });
		});
		const renamed = asMember(t, "org-a-renamed", testClerkOrgId(A));
		expect(await renamed.query(api.iframeEmbedSessions.getSession, { sessionId: "S1" })).not.toBeNull();
		expect(await renamed.mutation(api.iframeEmbedSessions.touchSession, { sessionId: "S1" })).toBe(true);
	});

	test("the fleet creates for any tenant, keeps a claimed user, and reads, touches and revokes any session", async () => {
		const t = createT();
		await seedOrgs(t);
		const f = asService(t);
		await f.mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "F1",
			tenantId: B,
			userId: "claimed-user",
			origin: "https://f.example",
			expiresAt: future(),
		});
		const [row] = await t.run((ctx) => ctx.db.query("iframeEmbedSessions").collect());
		expect(row.tenantOrgId).toBe(testClerkOrgId(B));
		expect(row.userId).toBe("claimed-user");
		expect((await f.query(api.iframeEmbedSessions.getSession, { sessionId: "F1" }))?.tenantId).toBe(B);
		expect(await f.mutation(api.iframeEmbedSessions.touchSession, { sessionId: "F1" })).toBe(true);
		expect(await f.mutation(api.iframeEmbedSessions.revokeSession, { sessionId: "F1" })).toBe(true);
	});
});

describe("DENIED", () => {
	test("REUSED slug: another org that now holds the old slug reaches nothing of the first org's session", async () => {
		const t = createT();
		await seedOrgs(t);
		await create(asMember(t, A), "S1");
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", A))
				.unique();
			if (m !== null) await ctx.db.patch(m._id, { clerkOrgSlug: "org-a-renamed" });
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
		expect(await newcomer.query(api.iframeEmbedSessions.getSession, { sessionId: "S1" })).toBeNull();
		expect(
			await refusal(newcomer.mutation(api.iframeEmbedSessions.touchSession, { sessionId: "S1" })),
		).toContain("session-not-in-caller-org");
		expect(
			await refusal(newcomer.mutation(api.iframeEmbedSessions.revokeSession, { sessionId: "S1" })),
		).toContain("session-not-in-caller-org");
	});

	test("a claimed foreign tenant and a claimed foreign user are refused, not corrected", async () => {
		const t = createT();
		await seedOrgs(t);
		expect(await refusal(create(asMember(t, A), "S1", { tenantId: B }))).toContain("tenant-not-callers-org");
		expect(await refusal(create(asMember(t, A), "S2", { userId: "someone-else" }))).toContain(
			"user-not-verified-caller",
		);
		expect(await t.run((ctx) => ctx.db.query("iframeEmbedSessions").collect())).toHaveLength(0);
	});

	test("a session id is never re-used: the second insert is refused, the first stays usable", async () => {
		const t = createT();
		await seedOrgs(t);
		await create(asMember(t, A), "S1");
		expect(await refusal(create(asMember(t, A), "S1"))).toContain("SESSION_ID_TAKEN");
		expect(await refusal(create(asMember(t, B), "S1"))).toContain("SESSION_ID_TAKEN");
		expect(await asMember(t, A).query(api.iframeEmbedSessions.getSession, { sessionId: "S1" })).not.toBeNull();
	});

	test("an unstamped session is the fleet's alone", async () => {
		const t = createT();
		await seedOrgs(t);
		await asService(t).mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "F1",
			origin: "https://f.example",
			expiresAt: future(),
		});
		expect(await asMember(t, A).query(api.iframeEmbedSessions.getSession, { sessionId: "F1" })).toBeNull();
		expect(
			await refusal(asMember(t, A).mutation(api.iframeEmbedSessions.touchSession, { sessionId: "F1" })),
		).toContain("RBAC_DENIED");
	});

	test("an anonymous write is refused by raising; an anonymous read is the typed null", async () => {
		const t = createT();
		await seedOrgs(t);
		await create(asMember(t, A), "S1");
		expect(
			await refusal(
				t.mutation(api.iframeEmbedSessions.createSession, {
					sessionId: "S2",
					origin: "https://x.example",
					expiresAt: future(),
				}),
			),
		).toContain("RBAC_DENIED");
		expect(await refusal(t.mutation(api.iframeEmbedSessions.touchSession, { sessionId: "S1" }))).toContain(
			"RBAC_DENIED",
		);
		expect(await t.query(api.iframeEmbedSessions.getSession, { sessionId: "S1" })).toBeNull();
	});
});

describe("ABSENT", () => {
	test("a revoked or unknown session reads null; touching an unknown session answers false", async () => {
		const t = createT();
		await seedOrgs(t);
		const a = asMember(t, A);
		await create(a, "S1");
		await a.mutation(api.iframeEmbedSessions.revokeSession, { sessionId: "S1" });
		expect(await a.query(api.iframeEmbedSessions.getSession, { sessionId: "S1" })).toBeNull();
		expect(await a.query(api.iframeEmbedSessions.getSession, { sessionId: "nope" })).toBeNull();
		expect(await a.mutation(api.iframeEmbedSessions.touchSession, { sessionId: "nope" })).toBe(false);
	});
});
