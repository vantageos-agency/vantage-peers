/// <reference types="vite/client" />
//
// restamp_clerk_ids — the Clerk DEV -> PRODUCTION ID switch (task
// k17233azpt695d23sez93nk65d8g34dm, step P2). RED on the head before this change: the
// migration module does not exist, so this file cannot even import it, and a dev ID
// survives every table. Poles pinned, each in both directions:
//   - a mapped org / user ID is rewritten; an unmapped one is left alone and LISTED;
//   - a map with a duplicate, chained, malformed, empty or conflicting entry is refused
//     and nothing is written;
//   - the fleet service authSubject is corrected only when it equals the map's `from`;
//   - dryRun (the default) writes nothing; a second run writes nothing;
//   - readBack finds 0 rows on a `from` value after the write (and >0 before it);
//   - credentials bound to a dev user are reported by revokeList and never rewritten.
// Hermetic: no deployment is touched. Fictitious identifiers only.

import type { FunctionReturnType } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { TABLE_ORDER } from "../migrations/backfill_org_clerk_id";
import {
	RESTAMP_COLUMNS,
	RESTAMP_TABLE_ORDER,
	type RestampTable,
} from "../migrations/restamp_clerk_ids";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const mig = internal.migrations.restamp_clerk_ids;
const NOW = 1_700_000_000_000;
const SEAT = "seat-x";

const DEV_FLEET = "org_DEVFLEET1";
const PROD_FLEET = "org_PRODFLEET1";
const DEV_ACME = "org_DEVACME1";
const PROD_ACME = "org_PRODACME1";
const UNKNOWN_ORG = "org_UNKNOWN9";
const DEV_SVC = "user_DEVSVC1";
const PROD_SVC = "user_PRODSVC1";
const DEV_ADMIN = "user_DEVADMIN1";
const PROD_ADMIN = "user_PRODADMIN1";
const UNKNOWN_USER = "user_UNKNOWN9";

const MAP = {
	orgs: [
		{ from: DEV_FLEET, to: PROD_FLEET },
		{ from: DEV_ACME, to: PROD_ACME },
	],
	users: [
		{ from: DEV_SVC, to: PROD_SVC },
		{ from: DEV_ADMIN, to: PROD_ADMIN },
	],
};

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type RunResult = FunctionReturnType<typeof mig.run>;
type IdMap = typeof MAP;

async function seedMappings(t: T, opts: { svc?: Id<"agents"> } = {}) {
	return await t.run(async (ctx) => {
		const fleet = await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "fleet-org",
			clerkOrgId: DEV_FLEET,
			allowedOrchestrators: [SEAT],
			scopes: [],
			displayName: "fleet",
			isActive: true,
			createdAt: NOW,
			orgKind: "operator",
			...(opts.svc !== undefined ? { serviceAccountAgentId: opts.svc } : {}),
		});
		const acme = await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "acme-hr",
			clerkOrgId: DEV_ACME,
			allowedOrchestrators: [SEAT],
			scopes: [],
			displayName: "acme",
			isActive: true,
			createdAt: NOW,
		});
		return { fleet, acme };
	});
}

async function seedServiceAgent(
	t: T,
	authSubject: string | null = DEV_SVC,
) {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug: "fleet-org",
			clerkOrgId: DEV_FLEET,
			name: "fleet-service-account",
			normalizedName: "fleet-service-account",
			kind: "service",
			...(authSubject !== null ? { authSubject } : {}),
			isActive: true,
			createdAt: NOW,
		}),
	);
}

const mission = (name: string, clerkOrgId: string | undefined) => ({
	name,
	project: "p",
	status: "execute" as const,
	priority: "medium" as const,
	pilot: "x",
	agents: [],
	createdBy: SEAT,
	orgId: "some-slug",
	...(clerkOrgId === undefined ? {} : { clerkOrgId }),
	createdAt: NOW,
	updatedAt: NOW,
});

async function seedMissions(t: T) {
	return await t.run(async (ctx) => ({
		acme: await ctx.db.insert("missions", mission("acme", DEV_ACME)),
		fleet: await ctx.db.insert("missions", mission("fleet", DEV_FLEET)),
		ghost: await ctx.db.insert("missions", mission("ghost", UNKNOWN_ORG)),
		bare: await ctx.db.insert("missions", mission("bare", undefined)),
		done: await ctx.db.insert("missions", mission("done", PROD_ACME)),
	}));
}

const membership = (org: string, user: string) => ({
	clerkOrgSlug: "slug-of-org",
	clerkOrgId: org,
	clerkUserId: user,
	role: "admin" as const,
	createdAt: NOW,
	updatedAt: NOW,
});

async function seedMemberships(t: T) {
	return await t.run(async (ctx) => ({
		admin: await ctx.db.insert(
			"orgMembership",
			membership(DEV_ACME, DEV_ADMIN),
		),
		svc: await ctx.db.insert("orgMembership", membership(DEV_FLEET, DEV_SVC)),
		stranger: await ctx.db.insert(
			"orgMembership",
			membership(DEV_ACME, UNKNOWN_USER),
		),
	}));
}

async function seedCredentials(t: T) {
	return await t.run(async (ctx) => ({
		access: await ctx.db.insert("oauth_access_tokens", {
			tokenHash: "h1",
			clientId: "c1",
			userId: DEV_ADMIN,
			scopes: [],
			scopeProfile: "p",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: NOW + 1,
			createdAt: NOW,
		}),
		accessOther: await ctx.db.insert("oauth_access_tokens", {
			tokenHash: "h2",
			clientId: "c1",
			userId: "not-a-clerk-id",
			scopes: [],
			scopeProfile: "p",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: NOW + 1,
			createdAt: NOW,
		}),
		refresh: await ctx.db.insert("oauth_refresh_tokens", {
			tokenHash: "r1",
			clientId: "c1",
			userId: DEV_SVC,
			scopeProfile: "p",
			expiresAt: NOW + 1,
			createdAt: NOW,
		}),
		bearer: await ctx.db.insert("userBearerTokens", {
			tokenHash: "b1",
			clerkUserId: DEV_ADMIN,
			workspaceId: "w",
			extId: "e",
			expiresAt: NOW + 1,
			revoked: false,
			createdAt: NOW,
		}),
	}));
}

async function walk(
	t: T,
	table: RestampTable,
	map: IdMap,
	opts: { dryRun?: boolean; pageSize?: number } = {},
) {
	const total = {
		examined: 0,
		toRewrite: 0,
		alreadyRestamped: 0,
		rewritten: 0,
		unmapped: [] as RunResult["unmappedRows"],
		pages: 0,
	};
	let cursor: string | null = null;
	for (let guard = 0; guard < 100; guard++) {
		const r: RunResult = await t.mutation(mig.run, {
			map,
			table,
			...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
			...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
			cursor,
		});
		total.pages++;
		total.examined += r.examined;
		total.toRewrite += r.toRewrite;
		total.alreadyRestamped += r.alreadyRestamped;
		total.rewritten += r.rewritten;
		total.unmapped.push(...r.unmappedRows);
		if (r.isDone) return total;
		cursor = r.nextCursor;
	}
	throw new Error("walk did not terminate");
}

async function walkAll(t: T, map: IdMap, opts: { dryRun?: boolean } = {}) {
	for (const table of RESTAMP_TABLE_ORDER) await walk(t, table, map, opts);
}

async function remainingOnFrom(t: T, map: IdMap): Promise<number> {
	let remaining = 0;
	for (const table of RESTAMP_TABLE_ORDER) {
		let cursor: string | null = null;
		for (let guard = 0; guard < 100; guard++) {
			const r: FunctionReturnType<typeof mig.readBack> = await t.query(
				mig.readBack,
				{ map, table, cursor },
			);
			remaining += r.remaining;
			if (r.isDone) break;
			cursor = r.nextCursor;
		}
	}
	return remaining;
}

const snapshot = (t: T) =>
	t.run(async (ctx) => ({
		missions: await ctx.db.query("missions").collect(),
		mappings: await ctx.db.query("client_org_mapping").collect(),
		memberships: await ctx.db.query("orgMembership").collect(),
		agents: await ctx.db.query("agents").collect(),
	}));

describe("restamp_clerk_ids: coverage", () => {
	test("the covered tables are client_org_mapping plus every table backfill_org_clerk_id stamps", () => {
		expect(RESTAMP_TABLE_ORDER).toEqual(["client_org_mapping", ...TABLE_ORDER]);
		expect(Object.keys(RESTAMP_COLUMNS).sort()).toEqual(
			[...RESTAMP_TABLE_ORDER].sort(),
		);
		expect(RESTAMP_COLUMNS.orgMembership.userField).toBe("clerkUserId");
		expect(RESTAMP_COLUMNS.messages.orgField).toBe("tenantOrgId");
	});
});

describe("restamp_clerk_ids: mapped rows are rewritten, unmapped rows untouched and listed", () => {
	test("missions: mapped org IDs move, an unknown ID and an absent one stay, the unknown one is listed", async () => {
		const t = createT();
		const ids = await seedMissions(t);
		const total = await walk(t, "missions", MAP, { dryRun: false });
		expect(total.rewritten).toBe(2);
		expect(total.alreadyRestamped).toBe(1);
		const rows = await t.run(async (ctx) => ({
			acme: await ctx.db.get(ids.acme),
			fleet: await ctx.db.get(ids.fleet),
			ghost: await ctx.db.get(ids.ghost),
			bare: await ctx.db.get(ids.bare),
			done: await ctx.db.get(ids.done),
		}));
		expect(rows.acme?.clerkOrgId).toBe(PROD_ACME);
		expect(rows.fleet?.clerkOrgId).toBe(PROD_FLEET);
		expect(rows.ghost?.clerkOrgId).toBe(UNKNOWN_ORG);
		expect(rows.bare?.clerkOrgId).toBeUndefined();
		expect(rows.done?.clerkOrgId).toBe(PROD_ACME);
		expect(total.unmapped).toEqual([
			{ id: ids.ghost, field: "clerkOrgId", value: UNKNOWN_ORG },
		]);
	});

	test("client_org_mapping: the org keys move and the service pointer is preserved", async () => {
		const t = createT();
		const svc = await seedServiceAgent(t);
		const { fleet, acme } = await seedMappings(t, { svc });
		await walk(t, "client_org_mapping", MAP, { dryRun: false });
		const rows = await t.run(async (ctx) => ({
			fleet: await ctx.db.get(fleet),
			acme: await ctx.db.get(acme),
		}));
		expect(rows.fleet?.clerkOrgId).toBe(PROD_FLEET);
		expect(rows.fleet?.serviceAccountAgentId).toBe(svc);
		expect(rows.acme?.clerkOrgId).toBe(PROD_ACME);
	});

	test("orgMembership: org and user move together; an unmapped user stays and is listed", async () => {
		const t = createT();
		const ids = await seedMemberships(t);
		const total = await walk(t, "orgMembership", MAP, { dryRun: false });
		const rows = await t.run(async (ctx) => ({
			admin: await ctx.db.get(ids.admin),
			svc: await ctx.db.get(ids.svc),
			stranger: await ctx.db.get(ids.stranger),
		}));
		expect(rows.admin).toMatchObject({
			clerkOrgId: PROD_ACME,
			clerkUserId: PROD_ADMIN,
		});
		expect(rows.svc).toMatchObject({
			clerkOrgId: PROD_FLEET,
			clerkUserId: PROD_SVC,
		});
		expect(rows.stranger).toMatchObject({
			clerkOrgId: PROD_ACME,
			clerkUserId: UNKNOWN_USER,
		});
		expect(total.unmapped).toEqual([
			{ id: ids.stranger, field: "clerkUserId", value: UNKNOWN_USER },
		]);
	});

	test("walking page by page (pageSize 1) gives the same result as one page", async () => {
		const t = createT();
		await seedMissions(t);
		const total = await walk(t, "missions", MAP, {
			dryRun: false,
			pageSize: 1,
		});
		expect(total.pages).toBeGreaterThan(1);
		expect(total.rewritten).toBe(2);
		expect(total.examined).toBe(5);
	});
});

describe("restamp_clerk_ids: dry run and idempotence", () => {
	test("the default is a dry run: it counts, it writes nothing", async () => {
		const t = createT();
		await seedMissions(t);
		await seedMemberships(t);
		await seedMappings(t);
		const before = await snapshot(t);
		const missions = await walk(t, "missions", MAP);
		await walk(t, "orgMembership", MAP);
		await walk(t, "client_org_mapping", MAP, { dryRun: true });
		expect(missions.toRewrite).toBe(2);
		expect(missions.rewritten).toBe(0);
		expect(await snapshot(t)).toEqual(before);
	});

	test("a second run writes nothing and counts the rows alreadyRestamped", async () => {
		const t = createT();
		await seedMissions(t);
		await seedMemberships(t);
		await seedMappings(t);
		await walkAll(t, MAP, { dryRun: false });
		const after = await snapshot(t);
		const missions = await walk(t, "missions", MAP, { dryRun: false });
		await walkAll(t, MAP, { dryRun: false });
		expect(missions.rewritten).toBe(0);
		expect(missions.toRewrite).toBe(0);
		expect(missions.alreadyRestamped).toBe(3);
		expect(await snapshot(t)).toEqual(after);
	});
});

describe("restamp_clerk_ids: readBack", () => {
	test("rows remain on a from value before the write, none after", async () => {
		const t = createT();
		await seedMissions(t);
		await seedMemberships(t);
		await seedMappings(t);
		expect(await remainingOnFrom(t, MAP)).toBeGreaterThan(0);
		await walkAll(t, MAP, { dryRun: false });
		expect(await remainingOnFrom(t, MAP)).toBe(0);
	});

	test("inventory counts each from value and lists what the map does not know, writing nothing", async () => {
		const t = createT();
		const ids = await seedMissions(t);
		const before = await snapshot(t);
		const inv = await t.query(mig.inventory, { map: MAP, table: "missions" });
		expect(inv.orgsOnFrom).toEqual([
			{ from: DEV_FLEET, to: PROD_FLEET, rows: 1 },
			{ from: DEV_ACME, to: PROD_ACME, rows: 1 },
		]);
		expect(inv.alreadyRestamped).toBe(1);
		expect(inv.unmappedRows).toEqual([
			{ id: ids.ghost, field: "clerkOrgId", value: UNKNOWN_ORG },
		]);
		expect(inv.conflicts).toEqual([]);
		expect(await snapshot(t)).toEqual(before);
	});
});

describe("restamp_clerk_ids: a map that is wrong is refused and nothing is written", () => {
	const refused = async (map: IdMap, pattern: RegExp) => {
		const t = createT();
		await seedMissions(t);
		const before = await snapshot(t);
		await expect(
			t.mutation(mig.run, { map, table: "missions", dryRun: false }),
		).rejects.toThrow(pattern);
		expect(await snapshot(t)).toEqual(before);
	};

	test("duplicate from", async () => {
		await refused(
			{
				orgs: [
					{ from: DEV_ACME, to: PROD_ACME },
					{ from: DEV_ACME, to: "org_PRODOTHER1" },
				],
				users: [],
			},
			/duplicate org "from"/,
		);
	});

	test("duplicate to", async () => {
		await refused(
			{
				orgs: [
					{ from: DEV_ACME, to: PROD_ACME },
					{ from: DEV_FLEET, to: PROD_ACME },
				],
				users: [],
			},
			/duplicate org "to"/,
		);
	});

	test("a to that is also a from (chain or swap)", async () => {
		await refused(
			{
				orgs: [
					{ from: DEV_ACME, to: DEV_FLEET },
					{ from: DEV_FLEET, to: PROD_FLEET },
				],
				users: [],
			},
			/both a "to" and a "from"/,
		);
	});

	test("malformed IDs and an empty map", async () => {
		await refused(
			{ orgs: [{ from: "acme-hr", to: PROD_ACME }], users: [] },
			/not a valid Clerk org ID/,
		);
		await refused(
			{ orgs: [], users: [{ from: DEV_SVC, to: "svc-prod" }] },
			/not a valid Clerk user ID/,
		);
		await refused({ orgs: [], users: [] }, /the map is empty/);
	});

	test("a to already live on another mapping row while its from is still held", async () => {
		const t = createT();
		await seedMappings(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "intruder",
				clerkOrgId: PROD_ACME,
				allowedOrchestrators: [],
				scopes: [],
				displayName: "intruder",
				isActive: true,
				createdAt: NOW,
			});
		});
		const before = await snapshot(t);
		await expect(
			t.mutation(mig.run, {
				map: MAP,
				table: "client_org_mapping",
				dryRun: false,
			}),
		).rejects.toThrow(/already the live value of another mapping row/);
		expect(await snapshot(t)).toEqual(before);
		const inv = await t.query(mig.inventory, {
			map: MAP,
			table: "client_org_mapping",
		});
		expect(inv.conflicts.length).toBeGreaterThan(0);
	});

	test("a user to that already has a membership in the org where its from is a member", async () => {
		const t = createT();
		await seedMemberships(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("orgMembership", membership(DEV_ACME, PROD_ADMIN));
		});
		const before = await snapshot(t);
		await expect(
			t.mutation(mig.run, {
				map: MAP,
				table: "orgMembership",
				dryRun: false,
			}),
		).rejects.toThrow(/already has a membership/);
		expect(await snapshot(t)).toEqual(before);
	});
});

describe("restamp_clerk_ids: the fleet service authSubject", () => {
	test("corrected when it equals the map's from; dry run first writes nothing", async () => {
		const t = createT();
		const svc = await seedServiceAgent(t, DEV_SVC);
		await seedMappings(t, { svc });
		const dry = await t.mutation(mig.restampServiceAccount, { map: MAP });
		expect(dry).toMatchObject({
			dryRun: true,
			status: "would-restamp",
			currentAuthSubject: DEV_SVC,
			newAuthSubject: PROD_SVC,
		});
		expect((await t.run((c) => c.db.get(svc)))?.authSubject).toBe(DEV_SVC);

		const done = await t.mutation(mig.restampServiceAccount, {
			map: MAP,
			dryRun: false,
		});
		expect(done.status).toBe("restamped");
		expect((await t.run((c) => c.db.get(svc)))?.authSubject).toBe(PROD_SVC);

		const again = await t.mutation(mig.restampServiceAccount, {
			map: MAP,
			dryRun: false,
		});
		expect(again.status).toBe("already-restamped");
		expect((await t.run((c) => c.db.get(svc)))?.authSubject).toBe(PROD_SVC);
	});

	test("an authSubject that is not the map's from is never overwritten", async () => {
		const t = createT();
		const svc = await seedServiceAgent(t, "user_SOMEONEELSE1");
		await seedMappings(t, { svc });
		const r = await t.mutation(mig.restampServiceAccount, {
			map: MAP,
			dryRun: false,
		});
		expect(r).toMatchObject({
			status: "blocked",
			reason: "authSubject-is-not-a-from-value-of-the-map",
			currentAuthSubject: "user_SOMEONEELSE1",
		});
		expect((await t.run((c) => c.db.get(svc)))?.authSubject).toBe(
			"user_SOMEONEELSE1",
		);
	});

	test("no linked service row, or a row without authSubject, is blocked and written nowhere", async () => {
		const t = createT();
		await seedMappings(t);
		const none = await t.mutation(mig.restampServiceAccount, {
			map: MAP,
			dryRun: false,
		});
		expect(none).toMatchObject({
			status: "blocked",
			reason: "no-service-account-linked",
		});

		const t2 = createT();
		const bare = await seedServiceAgent(t2, null);
		await seedMappings(t2, { svc: bare });
		const absent = await t2.mutation(mig.restampServiceAccount, {
			map: MAP,
			dryRun: false,
		});
		expect(absent).toMatchObject({
			status: "blocked",
			reason: "authSubject-absent",
		});
	});

	test("a target subject already held by another service row blocks the correction", async () => {
		const t = createT();
		const svc = await seedServiceAgent(t, DEV_SVC);
		await seedMappings(t, { svc });
		await t.run(async (ctx) => {
			await ctx.db.insert("agents", {
				orgSlug: "acme-hr",
				clerkOrgId: DEV_ACME,
				name: "other-service",
				normalizedName: "other-service",
				kind: "service",
				authSubject: PROD_SVC,
				isActive: true,
				createdAt: NOW,
			});
		});
		const r = await t.mutation(mig.restampServiceAccount, {
			map: MAP,
			dryRun: false,
		});
		expect(r).toMatchObject({ status: "blocked" });
		expect((await t.run((c) => c.db.get(svc)))?.authSubject).toBe(DEV_SVC);
	});

	test("the table walk never touches agents.authSubject", async () => {
		const t = createT();
		const svc = await seedServiceAgent(t, DEV_SVC);
		await seedMappings(t, { svc });
		await walk(t, "agents", MAP, { dryRun: false });
		expect((await t.run((c) => c.db.get(svc)))?.authSubject).toBe(DEV_SVC);
	});
});

describe("restamp_clerk_ids: credentials bound to a dev user are reported, never rewritten", () => {
	test("revokeList counts and lists the rows on a from user; a full run leaves them as they were", async () => {
		const t = createT();
		const cred = await seedCredentials(t);
		await seedMemberships(t);
		await seedMappings(t);
		const access = await t.query(mig.revokeList, {
			map: MAP,
			table: "oauth_access_tokens",
		});
		expect(access.boundToFromUser).toBe(1);
		expect(access.ids).toEqual([cred.access]);
		expect(access.otherUser).toBe(1);
		const refresh = await t.query(mig.revokeList, {
			map: MAP,
			table: "oauth_refresh_tokens",
		});
		expect(refresh.ids).toEqual([cred.refresh]);
		const bearer = await t.query(mig.revokeList, {
			map: MAP,
			table: "userBearerTokens",
		});
		expect(bearer.ids).toEqual([cred.bearer]);

		await walkAll(t, MAP, { dryRun: false });
		const after = await t.run(async (ctx) => ({
			access: await ctx.db.get(cred.access),
			refresh: await ctx.db.get(cred.refresh),
			bearer: await ctx.db.get(cred.bearer),
		}));
		expect(after.access?.userId).toBe(DEV_ADMIN);
		expect(after.access?.revokedAt).toBeUndefined();
		expect(after.refresh?.userId).toBe(DEV_SVC);
		expect(after.bearer?.clerkUserId).toBe(DEV_ADMIN);
		expect(after.bearer?.revoked).toBe(false);
	});
});
