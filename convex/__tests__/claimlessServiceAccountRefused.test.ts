/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, backend standard R-54: a claimless service-account call is
// REFUSED everywhere.
//
// Every MCP caller reaches Convex as ONE service account, which resolves to
// master. A door that resolves its caller through `withOrgScope` therefore cannot
// tell the fleet's own call from a tenant bearer's unless the transport carries
// the organisation it VERIFIED for the bearer (`verifiedOrg`). Operator ruling:
// the service account's claimless call is REFUSED at every door it reaches, and
// the fleet's own orchestrators send the OPERATOR organisation as theirs. A
// `fleet-wide:` marker is legitimate only on a door that is service-account-only
// by purpose.
//
// Poles, per converted door (the 34 tenant-reachable doors and the 29 fleet-
// internal doors that used to carry a `fleet-wide:` marker):
//   REFUSED  a service-account call that names no organisation raises RBAC_DENIED
//            `verified-claim-required`, naming the door;
//   PRESENT  the same call with the OPERATOR organisation as `verifiedOrg` is
//            served (the fleet keeps its reach, byte for byte).
// Beside them, per class:
//   - a CLIENT organisation's claim never gets the fleet's reach on a fleet-internal
//     door (it is that organisation's member there);
//   - a claim from anyone but the service account is refused (`verified-org-not-
//     trusted`), never ignored;
//   - the transport's operator-organisation accessor is service-account-only.

import { ConvexError } from "convex/values";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTestStrict as convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { FLEET_STATION_CLAIM_DOORS } from "../../tests/fixtures/fleetStationDoors";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
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
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

// biome-ignore lint/suspicious/noExplicitAny: doors are addressed by name in the table below
const apiAny = api as any;

const SERVICE_ACCOUNT = "test-service-account-user-id";
const NOW = 1_780_000_000_000;
const OP = "fleet-op";
const A = "acme-a";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

const asService = (t: T) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT } as Identity);
const asMember = (t: T, slug: string) =>
	t.withIdentity({
		subject: `member-of-${slug}`,
		organizationSlug: slug,
		org_id: testClerkOrgId(slug),
		org_role: "org:admin",
	} as Identity);
const operatorClaim = { verifiedOrg: { orgSlug: OP } };
const clientClaim = { verifiedOrg: { orgSlug: A } };

async function refusal(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (e) {
		return e instanceof ConvexError
			? String((e as ConvexError<string>).data)
			: String((e as Error).message);
	}
	throw new Error("expected a refusal, got a success");
}

type World = {
	t: T;
	ids: Record<string, string>;
};

const fields = (orchestratorId: string, name: string) => ({
	name,
	description: "d",
	purpose: "p",
	orchestratorId,
	status: "idea" as const,
	businessModel: "m",
	targetCustomers: "c",
	services: [],
	pricing: "x",
	revenueProjections: { y1: 1, y2: 2, y3: 3 },
	coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
	coreProcesses: [],
	dependencies: [],
	kpis: [],
});

async function world(): Promise<World> {
	const t = createT();
	const ids: Record<string, string> = {};
	await t.run(async (ctx) => {
		const mapping = (slug: string, orgKind?: "operator") =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: [
					"view-own-tasks",
					"view-own-missions",
					"view-stats-aggregated",
					"view-orchestrator-summary",
				],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(orgKind ? { orgKind, fleetWide: true } : {}),
			});
		await mapping(OP, "operator");
		await mapping(A);
		const sigma = await seedRosterAgent(ctx, OP, "sigma");
		ids.sigma = sigma;
		await seedRosterAgent(ctx, A, "pi");
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: NOW,
		});
		ids.unitUpdate = await ctx.db.insert("businessUnits", {
			...fields("sigma", "unit-update"),
			ownerId: sigma,
			managementFee: 10,
			createdAt: NOW,
			updatedAt: NOW,
		});
		ids.unitRemove = await ctx.db.insert("businessUnits", {
			...fields("sigma", "unit-remove"),
			ownerId: sigma,
			managementFee: 10,
			createdAt: NOW,
			updatedAt: NOW,
		});
		ids.mission = await ctx.db.insert("missions", {
			name: "m",
			project: "p",
			status: "plan",
			priority: "medium",
			pilot: "sigma",
			pilotId: sigma,
			agents: ["sigma"],
			createdBy: "sigma",
			createdById: sigma,
			createdAt: NOW,
			updatedAt: NOW,
		});
		ids.template = await ctx.db.insert("missionTemplates", {
			name: "tpl",
			steps: [{ title: "s1", description: "d", assignedTo: "sigma" }],
			isDefault: false,
			createdBy: "sigma",
			createdAt: NOW,
			updatedAt: NOW,
		});
		ids.message = await ctx.db.insert("messages", {
			from: "sigma",
			channel: "broadcast",
			content: "hello fleet",
			createdAt: NOW,
		});
		ids.memory = await ctx.db.insert("memories", {
			namespace: `team/${OP}`,
			type: "project",
			content: "fleet memory",
			createdBy: "sigma",
			createdById: sigma,
			relations: [],
			isLatest: true,
			clerkOrgId: testClerkOrgId(OP),
			createdAt: 1,
			updatedAt: 1,
		});
		ids.repoMapping = await ctx.db.insert("githubRepoMapping", {
			repo: "owner/existing",
			orchestrator: "sigma",
			project: "proj",
			active: true,
		});
		ids.mandate = await ctx.db.insert("mandates", {
			requestedBy: "sigma",
			fulfilledBy: "sigma",
			service: "svc",
			budget: 10,
			status: "requested",
			createdAt: NOW,
			updatedAt: NOW,
		});
		ids.pattern = await ctx.db.insert("fixPatterns", {
			symptom: "s",
			rootCause: "r",
			tags: [],
			stack: ["convex"],
			sourceProject: "proj",
			createdBy: "sigma",
			severity: "minor",
			createdAt: NOW,
			updatedAt: NOW,
		});
		ids.errorLog = await ctx.db.insert("errorLogs", {
			hash: "h",
			deployment: "d",
			functionName: "f",
			errorMessage: "boom",
			firstSeen: NOW,
			lastSeen: NOW,
			count: 1,
		});
		ids.note = await ctx.db.insert("briefingNotes", {
			title: "t",
			topic: "topic",
			participants: ["sigma"],
			content: "briefing body",
			createdBy: "sigma",
			createdAt: NOW,
		});
		ids.session = "sess-existing";
		await ctx.db.insert("iframeEmbedSessions", {
			sessionId: ids.session,
			origin: "https://example.test",
			createdAt: Date.now(),
			lastSeenAt: Date.now(),
			expiresAt: Date.now() + 3_600_000,
			revoked: false,
		});
		await ctx.db.insert("profiles", {
			orchestratorId: "sigma",
			name: "sigma",
			agentId: sigma,
			static: { role: "r", workspace: "w", capabilities: [] },
			dynamic: { lastSeen: NOW, sessionCount: 1 },
		});
	});
	return { t, ids };
}

type Door = {
	door: string;
	kind: "query" | "mutation";
	args: (w: World) => Record<string, unknown>;
};

/**
 * The 34 tenant-reachable doors and the 29 fleet-internal doors converted for
 * R-54. Each carries valid arguments, so the REFUSED pole proves the claim check
 * and not an argument error, and the PRESENT pole proves the operator
 * organisation's call is served.
 */
const DOORS: Door[] = [
	// ── tenant-reachable doors (the 34) ────────────────────────────────────────
	{ door: "businessUnits:create", kind: "mutation", args: () => fields("sigma", "created") },
	{
		door: "businessUnits:update",
		kind: "mutation",
		args: (w) => ({ buId: w.ids.unitUpdate, callerOrchestrator: "sigma", name: "renamed" }),
	},
	{ door: "businessUnits:remove", kind: "mutation", args: (w) => ({ buId: w.ids.unitRemove }) },
	{ door: "businessUnits:get", kind: "query", args: (w) => ({ buId: w.ids.unitUpdate }) },
	{ door: "businessUnits:list", kind: "query", args: () => ({}) },
	{ door: "githubOwnerBinding:listBindings", kind: "query", args: () => ({}) },
	{ door: "githubRepoMapping:getByRepo", kind: "query", args: () => ({ repo: "owner/existing" }) },
	{ door: "githubRepoMapping:list", kind: "query", args: () => ({}) },
	{
		door: "githubRepoMapping:add",
		kind: "mutation",
		args: () => ({ repo: "owner/added", orchestrator: "sigma", project: "proj" }),
	},
	{ door: "githubRepoMapping:remove", kind: "mutation", args: () => ({ repo: "owner/existing" }) },
	{
		door: "iframeEmbedSessions:createSession",
		kind: "mutation",
		args: () => ({ sessionId: "sess-new", origin: "https://example.test", expiresAt: Date.now() + 3_600_000 }),
	},
	{ door: "iframeEmbedSessions:getSession", kind: "query", args: (w) => ({ sessionId: w.ids.session }) },
	{ door: "iframeEmbedSessions:touchSession", kind: "mutation", args: (w) => ({ sessionId: w.ids.session }) },
	{ door: "iframeEmbedSessions:revokeSession", kind: "mutation", args: (w) => ({ sessionId: w.ids.session }) },
	{ door: "messages:listMessages", kind: "query", args: () => ({}) },
	{ door: "messages:listBroadcastStatus", kind: "query", args: (w) => ({ messageId: w.ids.message }) },
	{ door: "messages:listByChannel", kind: "query", args: () => ({}) },
	{
		door: "messages:listByChannelPaginated",
		kind: "query",
		args: () => ({ paginationOpts: { numItems: 5, cursor: null } }),
	},
	{ door: "messages:getById", kind: "query", args: (w) => ({ messageId: w.ids.message }) },
	{ door: "messages:searchMessagesByKeyword", kind: "query", args: () => ({ query: "hello" }) },
	{ door: "memories:softDeleteMemory", kind: "mutation", args: (w) => ({ memoryId: w.ids.memory }) },
	{
		door: "missionTemplates:instantiateTemplateIntoMission",
		kind: "mutation",
		args: (w) => ({ templateName: "tpl", missionId: w.ids.mission }),
	},
	{
		door: "missions:create",
		kind: "mutation",
		args: () => ({
			name: "created",
			project: "p",
			status: "plan",
			priority: "medium",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "sigma",
		}),
	},
	{ door: "missions:get", kind: "query", args: (w) => ({ missionId: w.ids.mission }) },
	{ door: "missions:list", kind: "query", args: () => ({}) },
	{
		door: "missions:update",
		kind: "mutation",
		args: (w) => ({ missionId: w.ids.mission, name: "renamed", callerOrchestrator: "sigma" }),
	},
	{
		door: "missions:updateStatus",
		kind: "mutation",
		args: (w) => ({ missionId: w.ids.mission, status: "execute" }),
	},
	{
		door: "missions:updateProgress",
		kind: "mutation",
		args: (w) => ({ missionId: w.ids.mission, progress: 50 }),
	},
	{ door: "profiles:getProfile", kind: "query", args: () => ({ orchestratorId: "sigma" }) },
	{
		door: "profiles:upsertProfile",
		kind: "mutation",
		args: () => ({ orchestratorId: "sigma", name: "sigma" }),
	},
	{
		door: "profiles:updateDynamic",
		kind: "mutation",
		args: () => ({ orchestratorId: "sigma", currentTask: "working" }),
	},
	{
		door: "profiles:getProfileWithMemories",
		kind: "query",
		args: () => ({ orchestratorId: "sigma", namespace: `team/${OP}` }),
	},
	{ door: "profiles:listProfiles", kind: "query", args: () => ({}) },
	{ door: "orgRoster:getMyOrgRoster", kind: "query", args: () => ({}) },
	{ door: "orgRoster:getMyAgentDirectory", kind: "query", args: () => ({}) },
	{ door: "briefingNotes:get", kind: "query", args: (w) => ({ noteId: w.ids.note }) },
	{ door: "briefingNotes:list", kind: "query", args: () => ({}) },
	{
		door: "briefingNotes:searchBriefingNotesByKeyword",
		kind: "query",
		args: () => ({ query: "briefing" }),
	},
	// ── fleet-internal doors that carried a `fleet-wide:` marker (the 29) ───────
	{ door: "errorMonitor:listDeployments", kind: "query", args: () => ({}) },
	{ door: "errorMonitor:listErrors", kind: "query", args: () => ({}) },
	{ door: "errorMonitor:getError", kind: "query", args: (w) => ({ errorId: w.ids.errorLog }) },
	{ door: "errorMonitorFilters:listFilterRules", kind: "query", args: () => ({}) },
	{ door: "errorMonitorFilters:getPendingAliasReleases", kind: "query", args: () => ({}) },
	{ door: "fixPatterns:get", kind: "query", args: (w) => ({ patternId: w.ids.pattern }) },
	{ door: "fixPatterns:listByProject", kind: "query", args: () => ({ sourceProject: "proj" }) },
	{ door: "fixPatterns:listAll", kind: "query", args: () => ({}) },
	{ door: "fixPatterns:listByStack", kind: "query", args: () => ({ stack: "convex" }) },
	{ door: "githubOwnerBinding:listUnprovenMappings", kind: "query", args: () => ({}) },
	{ door: "improvisationDigest:scanWindow", kind: "query", args: () => ({ windowDays: 1 }) },
	{ door: "issueStatsQueries:getLatest", kind: "query", args: () => ({}) },
	{ door: "issues:getByRepoNumber", kind: "query", args: () => ({ repo: "owner/existing", issueNumber: 1 }) },
	{ door: "issues:listByProject", kind: "query", args: () => ({ project: "proj" }) },
	{ door: "issues:listByOrchestrator", kind: "query", args: () => ({ assignedOrchestrator: "sigma" }) },
	{ door: "issues:listByStatus", kind: "query", args: () => ({ status: "open" }) },
	{ door: "issues:getStats", kind: "query", args: () => ({}) },
	{ door: "issues:listExternalOpen", kind: "query", args: () => ({}) },
	{ door: "mandates:list", kind: "query", args: () => ({}) },
	{ door: "mandates:get", kind: "query", args: (w) => ({ mandateId: w.ids.mandate }) },
	{
		door: "mandates:validateSpending",
		kind: "query",
		args: (w) => ({ mandateId: w.ids.mandate, proposedAmount: 1 }),
	},
	{ door: "missionTemplates:getByName", kind: "query", args: () => ({ name: "tpl" }) },
	{ door: "missionTemplates:listNames", kind: "query", args: () => ({}) },
	{ door: "orgMembership:getMembership", kind: "query", args: () => ({}) },
	{ door: "dashboard:getDashboardSummary", kind: "query", args: () => ({}) },
	{ door: "dashboard:getProjectSummary", kind: "query", args: () => ({}) },
	{ door: "stats:orchestratorStats", kind: "query", args: () => ({ window: "24h" }) },
	{ door: "stats:openTaskCountsByOrchestrator", kind: "query", args: () => ({}) },
	{ door: "stats:fleetStats", kind: "query", args: () => ({}) },
];

/**
 * The content doors (diary, episodes, memories, knowledge base, OKF bundle) that
 * already refuse the claimless call; their poles live in
 * contentDoorsVerifiedClaim.test.ts.
 */
const CONTENT_DOORS_COVERED_ELSEWHERE = new Set([
	"diary:deleteDiary",
	"diary:get",
	"diary:list",
	"diary:listByDateRange",
	"diary:write",
	"episodes:getCriticalInsights",
	"episodes:listEpisodes",
	"episodes:storeEpisode",
	"kb:softDeleteDocument",
	"kb:storeDocumentChunked",
	"kbMutations:claimUpload",
	"kbMutations:generateUploadUrl",
	"kbMutations:generateUploadUrlWithTicket",
	"memories:getMemory",
	"memories:listMemories",
	"memories:storeMemory",
	"okfBundleNode:exportOkfBundle",
	"okfBundleNode:importOkfBundle",
	"okfBundleNode:validateOkfBundle",
	"okfBundleDurable:cancelOkfBundleExportDurable",
	"okfBundleDurable:getOkfBundleExportDurableStatus",
	"okfBundleDurable:startOkfBundleExportDurable",
]);

async function call(
	w: World,
	d: Door,
	claim: Record<string, unknown> | null,
	runner: (t: T) => ReturnType<typeof asService> = asService,
): Promise<unknown> {
	const [mod, fn] = d.door.split(":");
	const ref = apiAny[mod][fn];
	const args = { ...d.args(w), ...(claim ?? {}) };
	const client = runner(w.t);
	return d.kind === "query"
		? await client.query(ref, args)
		: await client.mutation(ref, args);
}

describe("R-54: a claimless service-account call is REFUSED at every converted door", () => {
	for (const d of DOORS) {
		test(`${d.door}: REFUSED without a claim, naming the door`, async () => {
			const w = await world();
			const text = await refusal(() => call(w, d, null));
			expect(text).toContain("RBAC_DENIED");
			expect(text).toContain("verified-claim-required");
			expect(text).toContain(d.door);
		});
	}
});

describe("R-54: the OPERATOR organisation's claim is served", () => {
	for (const d of DOORS) {
		test(`${d.door}: PRESENT with the operator organisation as verifiedOrg`, async () => {
			const w = await world();
			await call(w, d, operatorClaim);
			await drain(w.t);
		});
	}
});

describe("R-54: the fleet keeps its reach under the operator organisation's claim", () => {
	test("messages:listMessages still reads every tenant (the fleet's reach is unchanged)", async () => {
		const w = await world();
		await w.t.run((ctx) =>
			ctx.db.insert("messages", {
				from: "pi",
				channel: "broadcast",
				content: "tenant a",
				tenantId: A,
				tenantOrgId: testClerkOrgId(A),
				createdAt: NOW,
			}),
		);
		const rows = (await asService(w.t).query(api.messages.listMessages, {
			...operatorClaim,
		})) as Array<{ content: string }>;
		expect(rows.map((r) => r.content).sort()).toEqual(["hello fleet", "tenant a"]);
	});

	test("businessUnits:list under the operator claim lists the fleet's units", async () => {
		const w = await world();
		const page = (await asService(w.t).query(api.businessUnits.list, {
			...operatorClaim,
		})) as { items: Array<{ name: string }> };
		expect(page.items.map((u) => u.name).sort()).toEqual(["unit-remove", "unit-update"]);
	});
});

describe("R-54: a CLIENT organisation's claim never gets the fleet's reach", () => {
	test("businessUnits:list under a client claim reads that organisation's range (none of the fleet's units)", async () => {
		const w = await world();
		const page = (await asService(w.t).query(api.businessUnits.list, {
			...clientClaim,
		})) as { items: unknown[] };
		expect(page.items).toEqual([]);
	});

	test("missions:list under a client claim does not list the fleet's mission", async () => {
		const w = await world();
		const rows = (await asService(w.t).query(api.missions.list, {
			...clientClaim,
		})) as unknown[];
		expect(rows).toEqual([]);
	});

	for (const d of DOORS.filter((x) =>
		[
			"issues:listByStatus",
			"issues:getStats",
			"fixPatterns:get",
			"missionTemplates:getByName",
			"stats:fleetStats",
			"errorMonitor:getError",
			"githubOwnerBinding:listUnprovenMappings",
		].includes(x.door),
	)) {
		test(`${d.door}: a fleet-internal door refuses a client organisation's claim`, async () => {
			const w = await world();
			const text = await refusal(() => call(w, d, clientClaim));
			expect(text).toContain("RBAC_DENIED");
			expect(text).toContain("not-fleet-master");
		});
	}

	test("fixPatterns:listAll answers a client organisation's claim what it answers an ordinary member (nothing of the fleet's table)", async () => {
		const w = await world();
		const out = await asService(w.t).query(api.fixPatterns.listAll, {
			...clientClaim,
		});
		expect(out).toEqual([]);
	});

	test("mandates:list answers a client organisation's claim the typed refusal envelope", async () => {
		const w = await world();
		const out = (await asService(w.t).query(api.mandates.list, {
			...clientClaim,
		})) as { refused?: boolean; items?: unknown[] } | unknown[];
		expect(Array.isArray(out)).toBe(false);
		expect((out as { refused: boolean }).refused).toBe(true);
	});

	test("orgRoster:getMyOrgRoster answers a client organisation's claim its own roster, not the fleet's [*]", async () => {
		const w = await world();
		const roster = (await asService(w.t).query(api.orgRoster.getMyOrgRoster, {
			...clientClaim,
		})) as string[];
		expect(roster).not.toContain("*");
	});
});

describe("R-54: a claim is believed from the service account only", () => {
	test("a member naming an organisation is REFUSED, not ignored", async () => {
		const w = await world();
		const text = await refusal(() =>
			asMember(w.t, A).query(api.businessUnits.list, { ...operatorClaim }),
		);
		expect(text).toContain("RBAC_DENIED");
		expect(text).toContain("verified-org-not-trusted");
	});

	test("a claim naming no active organisation is refused", async () => {
		const w = await world();
		const text = await refusal(() =>
			asService(w.t).query(api.businessUnits.list, {
				verifiedOrg: { orgSlug: "no-such-org" },
			}),
		);
		expect(text).toContain("org-not-active");
	});

	test("a dashboard member with no claim is unchanged (the member path)", async () => {
		const w = await world();
		const page = (await asMember(w.t, A).query(api.businessUnits.list, {})) as {
			items: unknown[];
		};
		expect(page.items).toEqual([]);
	});
});

describe("R-54: the transport's operator-organisation accessor", () => {
	test("clientOrgMapping:getOperatorOrg answers the service account the stored operator slug", async () => {
		const w = await world();
		const out = await asService(w.t).query(api.clientOrgMapping.getOperatorOrg, {});
		expect(out).toEqual({ orgSlug: OP });
	});

	test("clientOrgMapping:getOperatorOrg refuses an organisation member", async () => {
		const w = await world();
		const text = await refusal(() =>
			asMember(w.t, A).query(api.clientOrgMapping.getOperatorOrg, {}),
		);
		expect(text).toContain("RBAC_DENIED");
	});

	test("clientOrgMapping:getOperatorOrg refuses an anonymous caller", async () => {
		const w = await world();
		const text = await refusal(() =>
			w.t.query(api.clientOrgMapping.getOperatorOrg, {}),
		);
		expect(text).toContain("RBAC_DENIED");
	});

	test("two operator organisations answer null (no single operator, nothing is guessed)", async () => {
		const w = await world();
		await w.t.run((ctx) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "second-op",
				clerkOrgId: testClerkOrgId("second-op"),
				allowedOrchestrators: [],
				scopes: [],
				displayName: "second-op",
				isActive: true,
				createdAt: NOW,
				orgKind: "operator",
			}),
		);
		const out = await asService(w.t).query(api.clientOrgMapping.getOperatorOrg, {});
		expect(out).toBeNull();
	});
});

describe("R-54: every door that calls a claim helper has a pole", () => {
	test("the fixture that models a fleet station adds the claim to exactly the doors this table pins", () => {
		expect([...FLEET_STATION_CLAIM_DOORS].sort()).toEqual(DOORS.map((d) => d.door).sort());
	});

	test("the doors found in convex/*.ts are covered here or in the content-door suite", () => {
		const dir = join(__dirname, "..");
		const helpers = [
			"actingClaimOf(",
			"requireServiceAccountClaim(",
			"requireClaimedScope(",
			"scopeActingClaim(",
			"claim: { verifiedOrg",
			"writerOf(",
		];
		const found = new Set<string>();
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
			const mod = file.slice(0, -3);
			const src = readFileSync(join(dir, file), "utf8");
			const regs = [...src.matchAll(/^export const (\w+) = (query|mutation|action)\(\{/gm)];
			for (const m of regs) {
				const start = m.index ?? 0;
				const end = src.indexOf("\n});\n", start);
				const block = src.slice(start, end === -1 ? src.length : end);
				// An action reaches its scope through the internal bridge, so it is
				// recognised by the claim it declares.
				const declaresClaim =
					m[2] === "action" &&
					(block.includes("claimedOrgArgs") || block.includes("verifiedOrg"));
				if (declaresClaim || helpers.some((h) => block.includes(h))) {
					found.add(`${mod}:${m[1]}`);
				}
			}
		}
		const covered = new Set([...DOORS.map((d) => d.door), ...CONTENT_DOORS_COVERED_ELSEWHERE]);
		expect([...found].filter((d) => !covered.has(d)).sort()).toEqual([]);
		expect([...covered].filter((d) => !found.has(d)).sort()).toEqual([]);
	});

	test("no door but the three service-account-only ones still carries a fleet-wide marker", () => {
		const dir = join(__dirname, "..");
		const withMarker: string[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
			const src = readFileSync(join(dir, file), "utf8");
			for (const m of src.matchAll(/^\/\/ fleet-wide:[^\n]*\n(?:\/\/[^\n]*\n)*export const (\w+) = /gm)) {
				withMarker.push(`${file.slice(0, -3)}:${m[1]}`);
			}
		}
		expect(withMarker.sort()).toEqual([
			"clientOrgMapping:getByClerkSlug",
			"missionTemplates:softDelete",
			"missionTemplates:upsert",
		]);
	});
});
