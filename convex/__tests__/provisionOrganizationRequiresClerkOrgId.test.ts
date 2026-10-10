/// <reference types="vite/client" />
/**
 * M4 ruling 1: `oauth:provisionOrganization` REQUIRES the permanent Clerk org ID
 * and writes it on the mapping row. Without it (or with a malformed one) the
 * door refuses, names itself, and writes nothing. An organisation is keyed by
 * its ID from the first row; no later operator step is needed to make a member
 * resolvable.
 *
 * Three poles: REFUSED (missing, malformed, id owned by another org, id that
 * contradicts the row's own) / ABSENT (n/a: a refusal writes nothing) / PRESENT
 * (the row carries the ID and a member session carrying it is served).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER = "test-master-token-provision-requires-id";
beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

type T = ReturnType<typeof createT>;
const createT = () => convexTest(schema, modules);

const base = (slug: string) => ({
	callerToken: MASTER,
	clerkOrgSlug: slug,
	displayName: slug,
	orchestrators: [{ name: `seat-${slug}` }],
});

async function tableCounts(t: T) {
	return await t.run(async (ctx) => ({
		mapping: (await ctx.db.query("client_org_mapping").collect()).length,
		profiles: (await ctx.db.query("oauth_scope_profiles").collect()).length,
		clients: (await ctx.db.query("oauth_clients").collect()).length,
		access: (await ctx.db.query("oauth_access_tokens").collect()).length,
		refresh: (await ctx.db.query("oauth_refresh_tokens").collect()).length,
		audit: (await ctx.db.query("oauth_audit_log").collect()).length,
	}));
}

describe("provisionOrganization requires the Clerk org ID", () => {
	test("REFUSED: a missing clerkOrgId is refused by a typed error naming the door; nothing is written", async () => {
		const t = createT();
		const before = await tableCounts(t);
		const err = await t
			.mutation(api.oauth.provisionOrganization, base("acme") as never)
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(err).not.toBeNull();
		const text = JSON.stringify(
			(err as { data?: unknown }).data ?? String(err),
		);
		expect(text).toContain("CLERK_ORG_ID_REQUIRED");
		expect(text).toContain("oauth:provisionOrganization");
		expect(await tableCounts(t)).toEqual(before);
	});

	test.each([
		["empty", ""],
		["a slug, not an ID", "acme"],
		["wrong prefix", "organisation_123"],
		["trailing space", "org_123 "],
		["punctuation", "org_12-3"],
	])("REFUSED: a malformed clerkOrgId (%s) writes nothing", async (_n, bad) => {
		const t = createT();
		const before = await tableCounts(t);
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				...base("acme"),
				clerkOrgId: bad,
			}),
		).rejects.toThrow(/CLERK_ORG_ID_(REQUIRED|INVALID)/);
		expect(await tableCounts(t)).toEqual(before);
	});

	test("REFUSED: an ID already owned by another organisation is not shared", async () => {
		const t = createT();
		await t.mutation(api.oauth.provisionOrganization, {
			...base("acme"),
			clerkOrgId: testClerkOrgId("acme"),
		});
		const before = await tableCounts(t);
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				...base("other"),
				clerkOrgId: testClerkOrgId("acme"),
			}),
		).rejects.toThrow(/CLERK_ORG_ID_TAKEN/);
		expect(await tableCounts(t)).toEqual(before);
	});

	test("REFUSED: a replay naming a different ID than the row holds is refused", async () => {
		const t = createT();
		await t.mutation(api.oauth.provisionOrganization, {
			...base("acme"),
			clerkOrgId: testClerkOrgId("acme"),
		});
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				...base("acme"),
				clerkOrgId: testClerkOrgId("elsewhere"),
			}),
		).rejects.toThrow(/CLERK_ORG_ID_CONFLICT/);
	});

	test("PRESENT: the mapping row and every seat row carry the ID; a replay with the same ID is served", async () => {
		const t = createT();
		const id = testClerkOrgId("acme");
		const r = await t.mutation(api.oauth.provisionOrganization, {
			...base("acme"),
			clerkOrgId: id,
		});
		expect(r.replay).toBe(false);
		const rows = await t.run(async (ctx) => ({
			mapping: await ctx.db.get(r.mappingId),
			profiles: await ctx.db.query("oauth_scope_profiles").collect(),
			access: await ctx.db.query("oauth_access_tokens").collect(),
		}));
		expect(rows.mapping?.clerkOrgId).toBe(id);
		expect(rows.profiles.map((p) => p.clerkOrgId)).toEqual([id]);
		expect(rows.access.map((a) => a.clerkOrgId)).toEqual([id]);
		const again = await t.mutation(api.oauth.provisionOrganization, {
			...base("acme"),
			clerkOrgId: id,
		});
		expect(again.replay).toBe(true);
	});

	test("PRESENT: a member session carrying that org_id is served with no further operator step", async () => {
		const t = createT();
		const id = testClerkOrgId("acme");
		await t.mutation(api.oauth.provisionOrganization, {
			...base("acme"),
			clerkOrgId: id,
		});
		await t.run((ctx) =>
			ctx.db.insert("missions", {
				name: "mission-of-acme",
				project: "p",
				status: "execute",
				priority: "medium",
				pilot: "seat-acme",
				agents: ["seat-acme"],
				createdBy: "seat-acme",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				orgId: "acme",
				clerkOrgId: id,
			} as never),
		);
		const asMember = t.withIdentity({
			subject: "editor-of-acme",
			organizationId: "acme",
			org_id: id,
			organizationSlug: "acme",
			orgRole: "org:editor",
		} as Parameters<typeof t.withIdentity>[0]);
		const rows = (await asMember.query(api.missions.list, {})) as {
			name: string;
		}[];
		expect(rows.map((r) => r.name)).toEqual(["mission-of-acme"]);
	});
});
