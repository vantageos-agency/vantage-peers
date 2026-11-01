/// <reference types="vite/client" />
/**
 * M17 (task k174ct4gmhcw4zj173ddesj6j98g26vg) — the caller's tenant is applied
 * INSIDE the read, never as a filter after an unscoped one (backend standard
 * R-11).
 *
 * Two families of door are pinned, each under an ORDINARY (non-master) org
 * member or a service-account bearer carrying that member's verified org:
 *
 *   A. Doors the MCP layer reaches as the fleet service account. They used to
 *      read every tenant (master) and leave the MCP process to drop foreign
 *      rows after the fact. They now take the bearer's `verifiedOrg` claim and
 *      run under that org's MEMBER scope, so the existing tenant index ranges
 *      are the read. Poles: the own-org row is served and a foreign one is not;
 *      a page the foreign rows would have eaten is still full; the claim is
 *      believed from the service account only (a member presenting it, or a
 *      claim naming no active org, is refused with RBAC_DENIED); with no claim
 *      the service account reads unchanged.
 *
 *   B. Doors a member reaches directly that read the whole table and filtered
 *      afterwards: episodes:getCriticalInsights, stats:openTaskCountsByOrchestrator,
 *      stats:fleetStats, tasks:listUnlinkedBlocked, businessUnits:list. Their
 *      admission set is unchanged (the own-org row is still served, the foreign
 *      one is not); the read itself is now bounded to the caller's tenant.
 *      stats:fleetStats is the one admission change: its figures are fleet-wide
 *      totals, so an org member is REFUSED BY RAISING (a zeroed or narrowed
 *      aggregate would be a fabricated figure), while the fleet master is
 *      served the real figures.
 *
 * Identities are ORDINARY by construction: the service account id is the one
 * `vitest.config.ts` configures, and no org-member subject equals it.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { withFleetClaim } from "../../tests/lib/withFleetClaim";
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

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const SERVICE_ACCOUNT = "test-service-account-user-id";
const OWN = "org-a";
const FOREIGN = "org-b";
const OWN_ROSTER = "alice";
const FOREIGN_ROSTER = "mallory";

const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT });
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		organizationId: org,
		org_id: testClerkOrgId(org),
		organizationSlug: org,
	} as Parameters<T["withIdentity"]>[0]);

async function seedMappings(t: T): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const [slug, roster, active] of [
			[OWN, OWN_ROSTER, true],
			[FOREIGN, FOREIGN_ROSTER, true],
			["org-off", "nobody", false],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [roster],
				scopes: [
					"view-own-tasks",
					"view-own-missions",
					"view-stats-aggregated",
				],
				displayName: slug,
				isActive: active,
				createdAt: now,
			});
		}
	});
}

const orgOf = (org: string) => ({
	orgId: org,
	clerkOrgId: testClerkOrgId(org),
});
const rosterOf = (org: string) => (org === OWN ? OWN_ROSTER : FOREIGN_ROSTER);

/** Refusal data, as the ConvexError payload string. */
async function refusal(read: () => Promise<unknown>): Promise<string> {
	try {
		await read();
	} catch (e) {
		expect(e).toBeInstanceOf(ConvexError);
		return String((e as ConvexError<string>).data);
	}
	throw new Error("expected a refusal, got a success");
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeds
// ─────────────────────────────────────────────────────────────────────────────

async function seedMessages(t: T): Promise<void> {
	await t.run(async (ctx) => {
		const base = 1_780_000_000_000;
		// Oldest first, so the FOREIGN rows are the NEWEST (insertion order is
		// `_creationTime`, `createdAt` agrees): an unscoped window of 2 is all
		// foreign.
		const rows: Array<[string, string]> = [
			[OWN, "own-deploy-3"],
			[OWN, "own-deploy-2"],
			[OWN, "own-deploy-1"],
			[FOREIGN, "foreign-deploy-2"],
			[FOREIGN, "foreign-deploy-1"],
		];
		let i = 0;
		for (const [org, content] of rows) {
			await ctx.db.insert("messages", {
				from: rosterOf(org),
				channel: "broadcast",
				// The search index tokenises on whitespace: "deploy" must be a token.
				content: `deploy ${content}`,
				createdAt: base + i++ * 1000,
				tenantId: org,
				tenantOrgId: testClerkOrgId(org),
			});
		}
	});
}

async function seedTasks(t: T): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		// Oldest first: the FOREIGN rows are the newest.
		const rows: Array<[string, string]> = [
			[OWN, "own-hook-3"],
			[OWN, "own-hook-2"],
			[OWN, "own-hook-1"],
			[FOREIGN, "foreign-hook-2"],
			[FOREIGN, "foreign-hook-1"],
		];
		for (const [org, title] of rows) {
			await ctx.db.insert("tasks", {
				// The search index tokenises on whitespace: "hook" must be a token.
				title: `hook ${title}`,
				assignedTo: rosterOf(org),
				priority: "medium",
				status: "todo",
				createdBy: rosterOf(org),
				createdAt: now,
				updatedAt: now,
				...orgOf(org),
			});
		}
	});
}

async function seedNotes(t: T): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		// Oldest first: the FOREIGN rows are the newest.
		const rows: Array<[string, string]> = [
			[OWN, "own-decision-3"],
			[OWN, "own-decision-2"],
			[OWN, "own-decision-1"],
			[FOREIGN, "foreign-decision-2"],
			[FOREIGN, "foreign-decision-1"],
		];
		for (const [org, title] of rows) {
			await ctx.db.insert("briefingNotes", {
				title,
				topic: "decision",
				participants: [rosterOf(org)],
				content: `decision content ${title}`,
				createdBy: rosterOf(org),
				createdAt: now,
				...orgOf(org),
			});
		}
	});
}

// A unit as the doors write it since M10f: stamped with its org (slug and ID)
// and owned by the lead agent BY ID.
const buRow = (
	orchestratorId: string,
	name: string,
	status = "live",
	owner?: { org: string; ownerId: string },
) => ({
	...(owner !== undefined
		? { ownerId: owner.ownerId, ...orgOf(owner.org) }
		: {}),
	name,
	description: "d",
	purpose: "p",
	orchestratorId,
	status: status as "live",
	businessModel: "m",
	targetCustomers: "c",
	services: [] as string[],
	pricing: "p",
	revenueProjections: { y1: 1, y2: 2, y3: 3 },
	coreTeam: {
		agents: [] as string[],
		skills: [] as string[],
		hooks: [] as string[],
		plugins: [] as string[],
	},
	coreProcesses: [] as string[],
	dependencies: [] as string[],
	kpis: [] as string[],
	managementFee: 10,
	createdAt: Date.now(),
	updatedAt: Date.now(),
});

async function seedBusinessUnits(t: T): Promise<void> {
	// Each roster name is an agent of its org, on the org's roster by ID.
	const agents = await seedRosterAgents(t);
	await t.run(async (ctx) => {
		// The three own units are the OLDEST; twenty-five foreign ones are newer.
		for (let i = 0; i < 3; i++) {
			await ctx.db.insert(
				"businessUnits",
				buRow(OWN_ROSTER, `own-bu-${i}`, i === 0 ? "idea" : "live", {
					org: OWN,
					ownerId: agents[`${OWN}/${OWN_ROSTER}`],
				}),
			);
		}
		for (let i = 0; i < 25; i++) {
			await ctx.db.insert(
				"businessUnits",
				buRow(FOREIGN_ROSTER, `foreign-bu-${i}`, "live", {
					org: FOREIGN,
					ownerId: agents[`${FOREIGN}/${FOREIGN_ROSTER}`],
				}),
			);
		}
	});
}

async function seedRepoMappings(t: T): Promise<void> {
	await t.run(async (ctx) => {
		// Oldest first: the FOREIGN and fleet rows are the newest.
		const rows: Array<[string | undefined, string]> = [
			[OWN, "own/repo-3"],
			[OWN, "own/repo-2"],
			[OWN, "own/repo-1"],
			[undefined, "fleet/repo-1"],
			[FOREIGN, "foreign/repo-1"],
		];
		for (const [org, repo] of rows) {
			await ctx.db.insert("githubRepoMapping", {
				repo,
				orchestrator: org === undefined ? "sigma" : rosterOf(org),
				project: "p",
				active: true,
				...(org !== undefined ? orgOf(org) : {}),
			});
		}
	});
}

// missions:list (task k17apssqnw2xcf72r27c83338s8hc180): the ui://vp/v1
// mission-timeline primitive and list_missions reach it as the service account.
// A member's mission is served by its pilot's agents-row ID, so the roster
// agents are seeded and each row names its org's own roster agent.
async function seedMissions(t: T): Promise<void> {
	const agents = await seedRosterAgents(t);
	await t.run(async (ctx) => {
		// Oldest first: the FOREIGN rows are the newest.
		const rows: Array<[string, string]> = [
			[OWN, "own-launch-3"],
			[OWN, "own-launch-2"],
			[OWN, "own-launch-1"],
			[FOREIGN, "foreign-launch-2"],
			[FOREIGN, "foreign-launch-1"],
		];
		for (const [org, name] of rows) {
			const pilotId = agents[`${org}/${rosterOf(org)}`];
			await ctx.db.insert("missions", {
				name,
				description: "d",
				status: "execute",
				priority: "medium",
				pilot: rosterOf(org),
				pilotId,
				project: "p",
				agents: [],
				createdBy: rosterOf(org),
				createdById: pilotId,
				createdAt: 1,
				updatedAt: 1,
				...orgOf(org),
			} as never);
		}
	});
}

/** TEST FIXTURE: a `team/<label>` row carries its org's permanent ID (M10a). */
const stampOf = (namespace: string): { clerkOrgId?: string } => {
	const label = namespace.startsWith("team/") ? namespace.split("/")[1] : undefined;
	return label === undefined ? {} : { clerkOrgId: testClerkOrgId(label) };
};

async function seedMemory(
	t: T,
	namespace: string,
	content: string,
	severity: "minor" | "critical" = "critical",
): Promise<string> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("memories", {
			namespace,
			...stampOf(namespace),
			type: "episode",
			content,
			createdBy: "sigma",
			relations: [],
			isLatest: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			episode: {
				context: `context ${content}`,
				goal: "g",
				action: "a",
				outcome: "o",
				insight: content,
				severity,
			},
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// A. verifiedOrg — the service account's read runs under the bearer's org
// ─────────────────────────────────────────────────────────────────────────────

interface ClaimDoor {
	name: string;
	seed: (t: T) => Promise<void>;
	call: (
		t: T,
		verifiedOrg: { orgSlug: string } | undefined,
	) => Promise<unknown>;
	/** Substrings of the rows the claim must serve / must not serve. */
	own: string[];
	foreign: string[];
	/** The page limit the call asks for (when the door pages). */
	pageOf?: number;
}

const CLAIM_DOORS: ClaimDoor[] = [
	{
		name: "messages:listMessages",
		seed: seedMessages,
		call: (t, verifiedOrg) =>
			asService(t).query(api.messages.listMessages, {
				limit: 2,
				verifiedOrg,
			}),
		own: ["own-deploy-1", "own-deploy-2"],
		foreign: ["foreign-deploy"],
		pageOf: 2,
	},
	{
		name: "messages:searchMessagesByKeyword",
		seed: seedMessages,
		call: (t, verifiedOrg) =>
			asService(t).query(api.messages.searchMessagesByKeyword, {
				query: "deploy",
				limit: 5,
				verifiedOrg,
			}),
		own: ["own-deploy"],
		foreign: ["foreign-deploy"],
	},
	{
		name: "tasks:list",
		seed: seedTasks,
		call: (t, verifiedOrg) =>
			asService(t).query(api.tasks.list, {
				limit: 2,
				fields: "full",
				verifiedOrg,
			}),
		own: ["own-hook"],
		foreign: ["foreign-hook"],
		pageOf: 2,
	},
	{
		name: "tasks:searchTasksByKeyword",
		seed: seedTasks,
		call: (t, verifiedOrg) =>
			asService(t).query(api.tasks.searchTasksByKeyword, {
				query: "hook",
				limit: 5,
				fields: "full",
				verifiedOrg,
			}),
		own: ["own-hook"],
		foreign: ["foreign-hook"],
	},
	{
		name: "briefingNotes:list",
		seed: seedNotes,
		call: (t, verifiedOrg) =>
			asService(t).query(api.briefingNotes.list, {
				limit: 2,
				fields: "full",
				verifiedOrg,
			}),
		own: ["own-decision"],
		foreign: ["foreign-decision"],
		pageOf: 2,
	},
	{
		name: "briefingNotes:searchBriefingNotesByKeyword",
		seed: seedNotes,
		call: (t, verifiedOrg) =>
			asService(t).query(api.briefingNotes.searchBriefingNotesByKeyword, {
				query: "decision",
				limit: 5,
				fields: "full",
				verifiedOrg,
			}),
		own: ["own-decision"],
		foreign: ["foreign-decision"],
	},
	{
		name: "missions:list",
		seed: seedMissions,
		call: (t, verifiedOrg) =>
			asService(t).query(api.missions.list, {
				limit: 2,
				fields: "lite",
				verifiedOrg,
			}),
		own: ["own-launch"],
		foreign: ["foreign-launch"],
		pageOf: 2,
	},
	{
		name: "businessUnits:list",
		seed: seedBusinessUnits,
		call: (t, verifiedOrg) =>
			asService(t).query(api.businessUnits.list, {
				limit: 2,
				fields: "lite",
				verifiedOrg,
			}),
		own: ["own-bu"],
		foreign: ["foreign-bu"],
		pageOf: 2,
	},
	{
		name: "githubRepoMapping:list",
		seed: seedRepoMappings,
		call: (t, verifiedOrg) =>
			asService(t).query(api.githubRepoMapping.list, {
				limit: 2,
				verifiedOrg,
			}),
		own: ["own/repo"],
		foreign: ["foreign/repo", "fleet/repo"],
		pageOf: 2,
	},
];

const itemsOf = (result: unknown): unknown[] => {
	if (Array.isArray(result)) return result;
	const items = (result as { items?: unknown[] } | null)?.items;
	return Array.isArray(items) ? items : [];
};

describe.each(
	CLAIM_DOORS,
)("$name — the service account's read runs under the verified org", (door) => {
	test("OWN: the claimed org's rows are served, no foreign row is", async () => {
		const t = createT();
		await seedMappings(t);
		await door.seed(t);
		const result = await door.call(t, { orgSlug: OWN });
		const body = JSON.stringify(result);
		for (const own of door.own) expect(body).toContain(own);
		for (const foreign of door.foreign) expect(body).not.toContain(foreign);
	});

	test("PAGE: foreign rows newer than every own row do not eat the page", async () => {
		if (door.pageOf === undefined) return;
		const t = createT();
		await seedMappings(t);
		await door.seed(t);
		const result = await door.call(t, { orgSlug: OWN });
		expect(itemsOf(result)).toHaveLength(door.pageOf);
	});

	test("NO CLAIM: the service account reads unchanged (master sees the foreign rows)", async () => {
		const t = createT();
		await seedMappings(t);
		await door.seed(t);
		const result = await door.call(t, undefined);
		expect(JSON.stringify(result)).toContain(door.foreign[0]);
	});

	test("TRUST: a member presenting the claim is refused, not ignored", async () => {
		const t = createT();
		await seedMappings(t);
		await door.seed(t);
		const data = await refusal(() => {
			const args = { verifiedOrg: { orgSlug: FOREIGN } };
			return callAsMember(t, door.name, args);
		});
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("verified-org-not-trusted");
	});

	test("ACTIVE: a claim naming an inactive or unknown org is refused", async () => {
		const t = createT();
		await seedMappings(t);
		await door.seed(t);
		for (const orgSlug of ["org-off", "org-does-not-exist"]) {
			const data = await refusal(() => door.call(t, { orgSlug }));
			expect(data).toContain("RBAC_DENIED");
			expect(data).toContain("org-not-active");
		}
	});
});

/** A member of org-a calling the named door WITH a claim (must be refused). */
function callAsMember(
	t: T,
	door: string,
	extra: { verifiedOrg: { orgSlug: string } },
): Promise<unknown> {
	const m = asMember(t, OWN);
	switch (door) {
		case "messages:listMessages":
			return m.query(api.messages.listMessages, { limit: 2, ...extra });
		case "messages:searchMessagesByKeyword":
			return m.query(api.messages.searchMessagesByKeyword, {
				query: "deploy",
				...extra,
			});
		case "tasks:list":
			return m.query(api.tasks.list, { limit: 2, ...extra });
		case "tasks:searchTasksByKeyword":
			return m.query(api.tasks.searchTasksByKeyword, {
				query: "hook",
				...extra,
			});
		case "briefingNotes:list":
			return m.query(api.briefingNotes.list, { limit: 2, ...extra });
		case "briefingNotes:searchBriefingNotesByKeyword":
			return m.query(api.briefingNotes.searchBriefingNotesByKeyword, {
				query: "decision",
				...extra,
			});
		case "missions:list":
			return m.query(api.missions.list, { limit: 2, ...extra });
		case "businessUnits:list":
			return m.query(api.businessUnits.list, { limit: 2, ...extra });
		case "githubRepoMapping:list":
			return m.query(api.githubRepoMapping.list, { limit: 2, ...extra });
		default:
			throw new Error(`no member call for ${door}`);
	}
}

describe("single-row doors — the claim gates the row before it is returned", () => {
	test("messages:getById: the claimed org's message is served, another org's is refused", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await t.run(async (ctx) => {
			const own = await ctx.db.insert("messages", {
				from: OWN_ROSTER,
				channel: "broadcast",
				content: "own-message",
				createdAt: Date.now(),
				tenantId: OWN,
				tenantOrgId: testClerkOrgId(OWN),
			});
			const foreign = await ctx.db.insert("messages", {
				from: FOREIGN_ROSTER,
				channel: "broadcast",
				content: "foreign-message",
				createdAt: Date.now(),
				tenantId: FOREIGN,
				tenantOrgId: testClerkOrgId(FOREIGN),
			});
			return { own, foreign };
		});
		const served = await asService(t).query(api.messages.getById, {
			messageId: ids.own,
			verifiedOrg: { orgSlug: OWN },
		});
		expect(JSON.stringify(served)).toContain("own-message");
		const data = await refusal(() =>
			asService(t).query(api.messages.getById, {
				messageId: ids.foreign,
				verifiedOrg: { orgSlug: OWN },
			}),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("messages:getById");
		expect(data).not.toContain("foreign-message");
		// No claim: the service account reads the foreign row, unchanged.
		const master = await asService(t).query(api.messages.getById, {
			messageId: ids.foreign,
		});
		expect(JSON.stringify(master)).toContain("foreign-message");
	});

	test("messages:listBroadcastStatus: another org's broadcast is refused before its receipts are read", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await t.run(async (ctx) => {
			const mk = async (org: string) => {
				const messageId = await ctx.db.insert("messages", {
					from: rosterOf(org),
					channel: "broadcast",
					content: `broadcast of ${org}`,
					createdAt: Date.now(),
					tenantId: org,
					tenantOrgId: testClerkOrgId(org),
				});
				await ctx.db.insert("messageReceipts", {
					messageId,
					recipient: rosterOf(org),
				});
				return messageId;
			};
			return { own: await mk(OWN), foreign: await mk(FOREIGN) };
		});
		const served = await asService(t).query(api.messages.listBroadcastStatus, {
			messageId: ids.own,
			verifiedOrg: { orgSlug: OWN },
		});
		expect(served.receipts.map((r) => r.recipient)).toEqual([OWN_ROSTER]);
		const data = await refusal(() =>
			asService(t).query(api.messages.listBroadcastStatus, {
				messageId: ids.foreign,
				verifiedOrg: { orgSlug: OWN },
			}),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("cross-tenant");
	});

	test("memories:getMemory: a memory outside the claimed org's namespaces is answered null", async () => {
		const t = createT();
		await seedMappings(t);
		const own = await seedMemory(t, "team/org-a/notes", "own-episode");
		const foreign = await seedMemory(t, "team/org-b", "foreign-episode");
		const served = await asService(t).query(api.memories.getMemory, {
			memoryId: own,
			verifiedOrg: { orgSlug: OWN },
		});
		expect(JSON.stringify(served)).toContain("own-episode");
		const hidden = await asService(t).query(api.memories.getMemory, {
			memoryId: foreign,
			verifiedOrg: { orgSlug: OWN },
		});
		expect(hidden).toBeNull();
		// No claim: the service account reads the foreign memory, unchanged.
		const master = await asService(t).query(api.memories.getMemory, {
			memoryId: foreign,
		});
		expect(JSON.stringify(master)).toContain("foreign-episode");
	});

	test("fixPatterns:get: a pattern outside the bearer's roster is answered null before its attempts are read", async () => {
		const t = createT();
		const ids = await t.run(async (ctx) => {
			const mk = async (createdBy: string) =>
				await ctx.db.insert("fixPatterns", {
					symptom: `symptom of ${createdBy}`,
					rootCause: "rc",
					tags: [],
					stack: [],
					sourceProject: "p",
					createdBy,
					severity: "minor",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			return { own: await mk(OWN_ROSTER), foreign: await mk(FOREIGN_ROSTER) };
		});
		const served = await asService(t).query(api.fixPatterns.get, {
			patternId: ids.own,
			callerIdentities: [OWN_ROSTER],
		});
		expect(JSON.stringify(served)).toContain("symptom of alice");
		const hidden = await asService(t).query(api.fixPatterns.get, {
			patternId: ids.foreign,
			callerIdentities: [OWN_ROSTER],
		});
		expect(hidden).toBeNull();
		// Master (no roster): reads the row unchanged.
		const master = await asService(t).query(api.fixPatterns.get, {
			patternId: ids.foreign,
		});
		expect(JSON.stringify(master)).toContain("symptom of mallory");
		// A member of an org is still refused by the master-only door.
		const data = await refusal(() =>
			asMember(t, OWN).query(api.fixPatterns.get, {
				patternId: ids.own,
				callerIdentities: [OWN_ROSTER, FOREIGN_ROSTER],
			}),
		);
		expect(data).toContain("RBAC_DENIED");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Doors a member reaches directly — the read itself is tenant-bounded
// ─────────────────────────────────────────────────────────────────────────────

describe("episodes:getCriticalInsights — a member reads its own namespaces only", () => {
	async function world(): Promise<T> {
		const t = createT();
		await seedMappings(t);
		await seedMemory(t, "team/org-b", "foreign-critical-newest");
		await seedMemory(t, "team/org-ab", "lookalike-ab-critical");
		await seedMemory(t, "team/org-a-b", "lookalike-a-b-critical");
		await seedMemory(t, "team/org-a", "own-critical-root");
		await seedMemory(t, "team/org-a/sub", "own-critical-sub");
		await seedMemory(t, "team/org-a/sub/deep", "own-critical-deep");
		await seedMemory(t, "team/org-a", "own-minor-root", "minor");
		return t;
	}

	test("OWN: the exact namespace and every sub-namespace are served, critical only", async () => {
		const t = await world();
		const rows = await asMember(t, OWN).query(
			api.episodes.getCriticalInsights,
			{},
		);
		expect(rows.map((r) => r.namespace).sort()).toEqual([
			"team/org-a",
			"team/org-a/sub",
			"team/org-a/sub/deep",
		]);
	});

	test("FOREIGN: another org's namespace, and the lookalike prefixes, are never served", async () => {
		const t = await world();
		const body = JSON.stringify(
			await asMember(t, OWN).query(api.episodes.getCriticalInsights, {}),
		);
		for (const foreign of [
			"foreign-critical-newest",
			"lookalike-ab-critical",
			"lookalike-a-b-critical",
		]) {
			expect(body).not.toContain(foreign);
		}
	});

	test("PAGE: a limit smaller than the own set is filled with own rows, not eaten by a newer foreign one", async () => {
		const t = await world();
		const rows = await asMember(t, OWN).query(
			api.episodes.getCriticalInsights,
			{ limit: 2 },
		);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.namespace.startsWith("team/org-a"))).toBe(true);
	});

	test("MASTER: the service account still reads every tenant", async () => {
		const t = await world();
		const rows = await asService(t).query(api.episodes.getCriticalInsights, {
			limit: 50,
		});
		expect(rows.map((r) => r.namespace)).toContain("team/org-b");
		expect(rows.length).toBe(6);
	});

	test("ABSENT: a member of an org with no episodes gets an empty SUCCESS", async () => {
		const t = createT();
		await seedMappings(t);
		await seedMemory(t, "team/org-b", "foreign-only");
		const rows = await asMember(t, OWN).query(
			api.episodes.getCriticalInsights,
			{},
		);
		expect(rows).toEqual([]);
	});
});

describe("stats:openTaskCountsByOrchestrator — a member counts its own org's open tasks", () => {
	async function world(): Promise<T> {
		const t = createT();
		await seedMappings(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			const mk = (org: string, assignedTo: string, status: string) =>
				ctx.db.insert("tasks", {
					title: `${org}-${assignedTo}-${status}`,
					assignedTo,
					priority: "medium",
					status: status as "todo",
					createdBy: assignedTo,
					createdAt: now,
					updatedAt: now,
					...orgOf(org),
				});
			await mk(OWN, OWN_ROSTER, "todo");
			await mk(OWN, OWN_ROSTER, "in_progress");
			await mk(OWN, OWN_ROSTER, "done");
			// Another org's task assigned to a NAME the own roster also carries.
			await mk(FOREIGN, OWN_ROSTER, "todo");
			await mk(FOREIGN, FOREIGN_ROSTER, "todo");
			await mk(FOREIGN, FOREIGN_ROSTER, "review");
		});
		return t;
	}

	test("OWN: only the member's own org counts, a foreign task under a shared name is not counted", async () => {
		const t = await world();
		const rows = await asMember(t, OWN).query(
			api.stats.openTaskCountsByOrchestrator,
			{},
		);
		expect(rows.map((r) => r.orchestrator)).toEqual([OWN_ROSTER]);
		expect(rows[0].todo).toBe(1);
		expect(rows[0].inProgress).toBe(1);
		expect(rows[0].totalOpen).toBe(2);
	});

	test("MASTER: the service account counts both orgs", async () => {
		const t = await world();
		const rows = await withFleetClaim(asService(t)).query(
			api.stats.openTaskCountsByOrchestrator,
			{},
		);
		const byName = Object.fromEntries(rows.map((r) => [r.orchestrator, r]));
		expect(byName[OWN_ROSTER].totalOpen).toBe(3);
		expect(byName[FOREIGN_ROSTER].totalOpen).toBe(2);
	});
});

describe("stats:fleetStats — fleet-wide totals are the fleet master's", () => {
	async function world(): Promise<T> {
		const t = createT();
		await seedMappings(t);
		await seedTasks(t);
		return t;
	}

	test("MASTER: the real fleet totals are served", async () => {
		const t = await world();
		const stats = await withFleetClaim(asService(t)).query(api.stats.fleetStats, {});
		expect(stats.tasks.total).toBe(5);
		expect(stats.tasks.byStatus.todo).toBe(5);
	});

	test("MEMBER holding view-stats-aggregated is REFUSED by raising, never served a zero or the fleet's counts", async () => {
		const t = await world();
		const data = await refusal(() =>
			asMember(t, OWN).query(api.stats.fleetStats, {}),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("stats:fleetStats");
		expect(data).toContain("not-fleet-master");
	});

	test("ANONYMOUS: refused by raising, as before", async () => {
		const t = await world();
		const data = await refusal(() => t.query(api.stats.fleetStats, {}));
		expect(data).toContain("RBAC_DENIED");
	});
});

describe("tasks:listUnlinkedBlocked — a member reads its own org's blocked tasks", () => {
	test("OWN served, FOREIGN not; master reads both", async () => {
		const t = createT();
		await seedMappings(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const [org, title] of [
				[OWN, "own-blocked"],
				[FOREIGN, "foreign-blocked"],
			] as const) {
				await ctx.db.insert("tasks", {
					title,
					assignedTo: rosterOf(org),
					priority: "medium",
					status: "blocked",
					createdBy: rosterOf(org),
					createdAt: now,
					updatedAt: now,
					...orgOf(org),
				});
			}
		});
		const own = await asMember(t, OWN).query(api.tasks.listUnlinkedBlocked, {});
		expect(own.map((r) => r.title)).toEqual(["own-blocked"]);
		const master = await withFleetClaim(asService(t)).query(api.tasks.listUnlinkedBlocked, {});
		expect(master.map((r) => r.title).sort()).toEqual([
			"foreign-blocked",
			"own-blocked",
		]);
	});
});

describe("businessUnits:list — a member's page is read from its roster's ranges", () => {
	test("PAGE: three own units behind twenty-five newer foreign ones are served, and the list is not exhausted", async () => {
		const t = createT();
		await seedMappings(t);
		await seedBusinessUnits(t);
		const page = await asMember(t, OWN).query(api.businessUnits.list, {
			limit: 2,
			fields: "lite",
		});
		expect(page.items).toHaveLength(2);
		expect(page.items.every((u) => u.name.startsWith("own-bu"))).toBe(true);
		expect(page.nextCursor).not.toBeNull();
	});

	test("orchestratorId + status: one index range, own units of that status only", async () => {
		const t = createT();
		await seedMappings(t);
		await seedBusinessUnits(t);
		const page = await asMember(t, OWN).query(api.businessUnits.list, {
			orchestratorId: OWN_ROSTER,
			status: "live",
			fields: "lite",
		});
		expect(page.items.map((u) => u.name).sort()).toEqual([
			"own-bu-1",
			"own-bu-2",
		]);
		// An orchestrator outside the member's roster is not readable at all.
		const foreign = await asMember(t, OWN).query(api.businessUnits.list, {
			orchestratorId: FOREIGN_ROSTER,
			status: "live",
			fields: "lite",
		});
		expect(foreign.items).toEqual([]);
	});

	test("MASTER: the fleet master still reads every unit, filtered by status and orchestrator", async () => {
		const t = createT();
		await seedMappings(t);
		await seedBusinessUnits(t);
		// The fleet's own unit: owned by the operator org's agent "sigma" by ID. An
		// orchestrator asked for by the fleet is a label in the OPERATOR org (the
		// same label in a client org is a different agent).
		await t.run(async (ctx) => {
			const operatorId = testClerkOrgId("scope-op");
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "scope-op",
				clerkOrgId: operatorId,
				allowedOrchestrators: [],
				scopes: [],
				displayName: "scope-op",
				isActive: true,
				createdAt: Date.now(),
				orgKind: "operator",
			});
			const sigma = await ctx.db.insert("agents", {
				orgSlug: "scope-op",
				clerkOrgId: operatorId,
				name: "sigma",
				normalizedName: "sigma",
				isActive: true,
				createdAt: Date.now(),
			});
			await ctx.db.insert("businessUnits", {
				...buRow("sigma", "fleet-bu", "idea"),
				ownerId: sigma,
			});
		});
		const all = await asService(t).query(api.businessUnits.list, {
			limit: 200,
			fields: "lite",
		});
		expect(all.items).toHaveLength(29);
		const idea = await asService(t).query(api.businessUnits.list, {
			orchestratorId: "sigma",
			status: "idea",
			fields: "lite",
		});
		expect(idea.items.map((u) => u.name)).toEqual(["fleet-bu"]);
		// A client org's agent label names nobody in the operator org.
		const clientLabel = await asService(t).query(api.businessUnits.list, {
			orchestratorId: OWN_ROSTER,
			fields: "lite",
		});
		expect(clientLabel.items).toEqual([]);
	});
});

describe("briefingNotes:list updatedSince — a member never scans the fleet's index", () => {
	test("a member's bounded read is not defeated by more foreign notes than the scan cap", async () => {
		const t = createT();
		await seedMappings(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			// More foreign notes (edited, so they sit in the global updatedAt
			// index) than BRIEFING_NOTES_LIST_SCAN_CAP.
			for (let i = 0; i < 2010; i++) {
				await ctx.db.insert("briefingNotes", {
					title: `foreign-${i}`,
					topic: "decision",
					participants: [],
					content: "c",
					createdBy: FOREIGN_ROSTER,
					createdAt: now,
					updatedAt: now + 1000 + i,
					...orgOf(FOREIGN),
				});
			}
			await ctx.db.insert("briefingNotes", {
				title: "own-edited",
				topic: "decision",
				participants: [],
				content: "c",
				createdBy: OWN_ROSTER,
				createdAt: now,
				updatedAt: now + 5,
				...orgOf(OWN),
			});
			await ctx.db.insert("briefingNotes", {
				title: "own-never-edited",
				topic: "decision",
				participants: [],
				content: "c",
				createdBy: OWN_ROSTER,
				createdAt: now + 3,
				...orgOf(OWN),
			});
		});
		const rows = await asMember(t, OWN).query(api.briefingNotes.list, {
			updatedSince: 1,
			fields: "full",
			limit: 10,
		});
		const titles = (Array.isArray(rows) ? rows : rows.items).map(
			(r) => r.title,
		);
		expect(titles.sort()).toEqual(["own-edited", "own-never-edited"]);
	});
});
