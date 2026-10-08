/// <reference types="vite/client" />
//
// Org identity by Clerk org ID (Pi ruling (d), task k174d95s5qqy8t2r5rdrz3pr3d8fqv82),
// EXPAND phase: THE CLASS-CLOSING TEST.
//
// backfill_org_clerk_id fills the id column of every table in ORG_COLUMNS ONCE. Every
// row written after it is only correct if the write path stamps the id beside the
// slug. A test that pins the sites someone remembered cannot catch the site nobody
// did (Argus REVISE on PR #1482: five tables wrote the slug and no id). So this test
// does not list sites. It walks ORG_COLUMNS itself:
//
//   1. DRIVERS must have exactly one entry per table in ORG_COLUMNS. A table added to
//      ORG_COLUMNS without a driver fails the coverage test below, and fails `tsc`
//      (`satisfies Record<OrgIdTable, Driver>`): the author cannot add a table and
//      forget the write.
//   2. Each driver performs a REAL write through the table's public or internal write
//      path, as a member of an organisation whose mapping carries an id.
//   3. The assertion reads the rows the table now holds and requires at least one to
//      carry the slug AND the id, and every row that carries a slug to carry the id
//      of THAT slug's mapping.
//
// Hermetic: no deployment is touched. Fictitious identifiers only.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
	type OrgIdTable,
	ORG_COLUMNS,
	TABLE_ORDER,
} from "../migrations/backfill_org_clerk_id";
import { upsertAdminMembership } from "../orgMembership";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const NOW = 1_700_000_000_000;
const SEAT = "seat-x";
const MASTER = "test-master-token-org-clerk-id-write-sites";

const ACME = { slug: "acme-hr", id: "org_ACME1" };
const ID_BY_SLUG: Record<string, string> = { [ACME.slug]: ACME.id };

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const asOrg = (t: T, slug: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
	} as Identity);
const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_role: "org:admin",
	} as Identity);
const serviceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

async function seedWorld(t: T, mappingClerkOrgId: string | undefined) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ACME.slug,
			allowedOrchestrators: [SEAT],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: ACME.slug,
			isActive: true,
			createdAt: NOW,
			...(mappingClerkOrgId === undefined
				? {}
				: { clerkOrgId: mappingClerkOrgId }),
		});
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: 0,
		});
		await ctx.db.insert("profiles", {
			orchestratorId: "recipient-role",
			name: "recipient-role",
			static: { role: "recipient-role", workspace: "w", capabilities: [] },
			dynamic: { lastSeen: NOW, sessionCount: 1 },
		});
	});
}

type Driver = (t: T) => Promise<unknown>;

// One REAL write path per table of ORG_COLUMNS, acting as a member of ACME.
const DRIVERS = {
	missions: (t) =>
		asOrg(t, ACME.slug).mutation(api.missions.create, {
			name: "m",
			project: "p",
			status: "execute",
			priority: "medium",
			pilot: SEAT,
			agents: [SEAT],
			createdBy: SEAT,
		}),
	messages: (t) =>
		t.mutation(internal.messages.sendMessageInternal, {
			from: "pi",
			channel: "recipient-role",
			content: "hello",
			tenantId: ACME.slug,
		}),
	tasks: (t) =>
		asOrg(t, ACME.slug).mutation(api.tasks.create, {
			title: "t",
			assignedTo: SEAT,
			priority: "high",
			status: "todo",
			createdBy: SEAT,
		}),
	messageReceipts: (t) =>
		t.mutation(internal.messages.sendMessageInternal, {
			from: "pi",
			channel: "recipient-role",
			content: "hello",
			tenantId: ACME.slug,
		}),
	briefingNotes: (t) =>
		asOrg(t, ACME.slug).mutation(api.briefingNotes.create, {
			title: "b",
			topic: "t",
			participants: [SEAT],
			content: "c",
			createdBy: SEAT,
		}),
	recurringTasks: (t) =>
		asOrg(t, ACME.slug).mutation(api.recurringTasks.create, {
			title: "r",
			assignedTo: SEAT,
			priority: "low",
			cronExpression: "0 9 * * *",
			createdBy: SEAT,
		}),
	diary: (t) =>
		asOrg(t, ACME.slug).mutation(api.diary.write, {
			date: "2026-10-01",
			orchestrator: SEAT,
			content: "d",
		}),
	businessUnits: (t) =>
		asOrg(t, ACME.slug).mutation(api.businessUnits.create, {
			name: "bu",
			description: "d",
			purpose: "p",
			orchestratorId: SEAT,
			status: "idea",
			businessModel: "m",
			targetCustomers: "c",
			services: [],
			pricing: "p",
			revenueProjections: { y1: 0, y2: 0, y3: 0 },
			coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
			coreProcesses: [],
			dependencies: [],
			kpis: [],
		}),
	bulk_complete_runs: (t) =>
		asOrg(t, ACME.slug).mutation(api.tasks.bulkComplete, {
			filter: { assignedTo: SEAT },
			dryRun: false,
			callerOrchestrator: SEAT,
		}),
	agents: (t) =>
		adminOf(t, ACME.slug).mutation(api.agents.registerAgent, {
			orgSlug: ACME.slug,
			name: "neo",
		}),
	agent_relations: (t) =>
		adminOf(t, ACME.slug).mutation(api.agentRelations.linkChild, {
			orgSlug: ACME.slug,
			parentName: "neo",
			childName: "trinity",
		}),
	agent_credentials: async (t) => {
		await adminOf(t, ACME.slug).mutation(api.agents.registerAgent, {
			orgSlug: ACME.slug,
			name: "neo",
		});
		return await adminOf(t, ACME.slug).mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: ACME.slug, agentName: "neo" },
		);
	},
	orgMembership: (t) =>
		t.run((ctx) => upsertAdminMembership(ctx, ACME.slug, "user_admin_1")),
	memberWriterRoles: (t) =>
		t.mutation(internal.memberWriterRoles.setMemberWriterRoles, {
			orgSlug: ACME.slug,
			roles: ["org:admin"],
		}),
	oauth_access_tokens: (t) =>
		serviceAccount(t).mutation(api.oauth.createAccessToken, {
			tokenHash: "hash-1",
			clientId: "client-1",
			userId: SEAT,
			scopes: ["mcp:full"],
			scopeProfile: "p",
			fromAllowList: [SEAT],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: NOW + 1000,
			clerkOrgSlug: ACME.slug,
		}),
	oauth_scope_profiles: (t) =>
		t.mutation(internal.oauth.upsertScopeProfile, {
			profile: {
				profileId: "seat-profile",
				description: "d",
				fromAllowList: [SEAT],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				clerkOrgSlug: ACME.slug,
			},
		}),
	iframeEmbedSessions: (t) =>
		asOrg(t, ACME.slug).mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "s-1",
			origin: "https://example.test",
			expiresAt: NOW + 1000,
		}),
} satisfies Record<OrgIdTable, Driver>;

const rowsOf = (t: T, table: OrgIdTable) =>
	t.run(
		async (ctx) =>
			(await ctx.db.query(table).collect()) as unknown as Record<
				string,
				unknown
			>[],
	);

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe("every table in ORG_COLUMNS has a real write path that stamps slug AND id", () => {
	test("COVERAGE: a driver exists for exactly the tables of ORG_COLUMNS", () => {
		expect(Object.keys(DRIVERS).sort()).toEqual([...TABLE_ORDER].sort());
	});

	for (const table of TABLE_ORDER) {
		test(`${table}: a real write stamps ${ORG_COLUMNS[table].slugField} and ${ORG_COLUMNS[table].idField}`, async () => {
			const { slugField, idField } = ORG_COLUMNS[table];
			const t = createT();
			await seedWorld(t, ACME.id);
			await (DRIVERS[table] as Driver)(t);

			const rows = await rowsOf(t, table);
			// The write happened.
			expect(rows.length).toBeGreaterThan(0);
			// It was an ORG-owned row: the slug is the caller's own org.
			const stamped = rows.filter((r) => r[slugField] === ACME.slug);
			expect(stamped.length).toBeGreaterThan(0);
			// Every row that carries a slug carries the id of THAT slug's mapping.
			for (const r of rows) {
				const slug = r[slugField];
				if (typeof slug === "string") {
					expect(r[idField]).toBe(ID_BY_SLUG[slug]);
				}
			}
		});
	}
});

describe("a mapping with no id yet: the slug is written, no id is invented", () => {
	for (const table of TABLE_ORDER) {
		test(`${table}: slug only while the mapping has no clerkOrgId`, async () => {
			const { slugField, idField } = ORG_COLUMNS[table];
			const t = createT();
			await seedWorld(t, undefined);
			await (DRIVERS[table] as Driver)(t);
			const rows = await rowsOf(t, table);
			const stamped = rows.filter((r) => r[slugField] === ACME.slug);
			expect(stamped.length).toBeGreaterThan(0);
			for (const r of stamped) expect(r[idField]).toBeUndefined();
		});
	}
});

describe("provisionOrganization: seat rows are written before the mapping has an id", () => {
	test("oauth_scope_profiles and oauth_access_tokens carry the slug only, and the backfill lists then fills them", async () => {
		const t = createT();
		const slug = "fresh-org";
		await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: slug,
			displayName: slug,
			orchestrators: [{ name: "neo" }],
		});
		for (const table of ["oauth_scope_profiles", "oauth_access_tokens"] as const) {
			const rows = (await rowsOf(t, table)).filter(
				(r) => r.clerkOrgSlug === slug,
			);
			expect(rows.length).toBeGreaterThan(0);
			for (const r of rows) expect(r.clerkOrgId).toBeUndefined();
		}

		// The mapping gets its id afterwards (operator step), then the backfill fills.
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
				.unique();
			await ctx.db.patch(m!._id, { clerkOrgId: "org_FRESH1" });
		});
		for (const table of ["oauth_scope_profiles", "oauth_access_tokens"] as const) {
			await t.mutation(internal.migrations.backfill_org_clerk_id.run, {
				table,
				dryRun: false,
				cursor: null,
			});
			const rows = (await rowsOf(t, table)).filter(
				(r) => r.clerkOrgSlug === slug,
			);
			for (const r of rows) expect(r.clerkOrgId).toBe("org_FRESH1");
		}
	});
});
