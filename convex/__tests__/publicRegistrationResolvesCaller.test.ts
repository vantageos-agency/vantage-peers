/// <reference types="vite/client" />
/**
 * Every public Convex registration in this suite RESOLVES ITS CALLER before it
 * serves data — and the ones that legitimately still serve a caller keep doing
 * so.
 *
 * THE MEASUREMENT THIS SUITE PINS. Every public registration in `convex/` was
 * enumerated and POSTed anonymously to the LIVE production deployment at commit
 * bd8c60e9 — no Authorization header, no bearer, no JWT. A positive control was
 * taken first and it distinguishes (a nonexistent path returns
 * `status=error`). FOURTEEN returned real rows to a caller with no credential:
 *
 *   tasks:listUnlinkedBlocked            159 rows
 *   profiles:listProfiles                 50
 *   errorMonitor:listErrors               50   (error payloads: the shape of
 *                                               everything else)
 *   fixPatterns:listAll                   50
 *   missionTemplates:listNames            33
 *   issueStatsQueries:getLatest           30
 *   errorMonitorFilters:listFilterRules   15
 *   mandates:list                          9   <-- SPENDING AUTHORITY
 *   recurringTasks:list                    4
 *   businessUnits:list                     1
 *   githubRepoMapping:list                 1
 *   issues:getStats                        1
 *   issues:listExternalOpen                1
 *   messages:listByChannel                 1
 *
 * A FIFTEENTH site of the same class, not reachable by an anonymous POST because
 * it is an action rather than a query, is `convex/search.ts::searchFixPatterns`:
 * it hardcoded namespace `"fixpatterns"` and resolved no identity, and a
 * CONSTANT NAMESPACE IS NOT AN AUTHORISATION. Its poles live in
 * convex/__tests__/searchNamespaceAuthorityEndToEnd.test.ts, beside the three
 * sibling search actions and the RAG seam that suite already owns.
 *
 * WHY NO EXISTING INSTRUMENT SAW THEM, restated so this suite is not mistaken
 * for a duplicate of its siblings: NOT ONE of the fourteen takes a
 * tenant-shaped ARGUMENT, and most take NO ARGUMENTS AT ALL. The two shipped
 * scanners drew their populations from argument/return SHAPES
 * (`check-public-fn-org-arg-identity.py`, `check-resource-id-read-org-scope.py`)
 * so all fourteen were invisible to them BY CONSTRUCTION. backend-doctor's
 * R-50/R-51 judge the SHAPE OF A REFUSAL (typed value vs throw), and a
 * registration with NO GUARD has nothing to throw, so it cannot fail a rule
 * about throwing. The control that does see this class must ask a different
 * question — "does this public registration resolve its caller before serving or
 * writing data" — over a population that is the EXPOSED SURFACE ITSELF, derived
 * from convex/_generated/api.d.ts so it cannot drift from what is actually
 * reachable. That rule belongs in backend-doctor, the instrument the fleet
 * already gates on, not in a fourth private script beside the three above; this
 * suite is the per-site evidence, not the instrument.
 *
 * WHY EVERY CALLER CONSTRUCTED HERE IS ORDINARY. A suite that authenticates as
 * master (`allowNoIdentityMaster`) or as the configured service account
 * (`CLERK_SERVICE_ACCOUNT_USER_ID`, "test-service-account-user-id" in
 * vitest.config.ts) would pass with the authorization DELETED and prove
 * nothing. Every DENY pole below is an anonymous caller, a signed-in caller
 * with no organisation, or an ORDINARY member of an active organisation.
 * `asMaster` appears ONLY in ALLOW poles, and only for the fleet-internal
 * tables where master is BY DEFINITION the only legitimate reader — those
 * tables carry no `orgId` column at all (see `requireFleetMaster` in
 * mandates.ts/profiles.ts/fixPatterns.ts and `requireMasterScope` in
 * issues.ts/errorMonitor.ts), so there is no ordinary caller who may read them
 * and an "ordinary allow pole" would be a fiction. For the tables that ARE
 * org-scoped (businessUnits, recurringTasks, tasks, messages) the ALLOW pole IS
 * an ordinary org member, because the failure mode of adding a guard is a
 * WITHHELD GRANT — a legitimate caller silently losing access — and that is
 * exactly as much a defect as the leak.
 *
 * REFUSAL SHAPE. Every site here is a reactively-subscribed public READ, so it
 * refuses with a TYPED EMPTY value, never a throw: a query that throws crashes
 * the subscribing client's render (R-50/R-51, and `withOrgScope`'s
 * `refuseWithoutThrow` exists for precisely this). No new identity layer is
 * introduced anywhere — every guard is `withOrgScope` plus, where the data is
 * org-scoped rather than fleet-internal, the pre-existing
 * `filterByOrgScope` / `isOrchestratorAllowedForScope` roster helpers.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

// `search` / `ragSync` / `backfill` are excluded for the SAME reason every
// pre-existing suite in this directory excludes them (see
// anonymousCallerServedTenantRows.test.ts): convex/search.ts is a "use node"
// module that builds its RAG client at MODULE LOAD time and cannot be loaded
// under convex-test at all.
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

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const ORDINARY_A = "ordinary-member-of-org-a";
const ORDINARY_NO_ORG = "ordinary-signed-in-user-with-no-org";

// Guard the guard: if either ordinary subject ever equalled the configured
// service account, withOrgScope's by-id master carve-out would fire and every
// DENY assertion below would pass vacuously.
for (const subject of [ORDINARY_A, ORDINARY_NO_ORG]) {
	if (subject === SERVICE_ACCOUNT_USER_ID) {
		throw new Error(
			`test-integrity: ${subject} must not be the service-account id — ` +
				"every DENY pole here must be an ORDINARY caller, never master",
		);
	}
}

/** An ordinary, non-master member of `orgSlug`. */
const asOrgMember = (t: T, orgSlug: string, subject = ORDINARY_A) =>
	t.withIdentity({
		subject,
		organizationId: orgSlug,
		org_id: testClerkOrgId(orgSlug),
		organizationSlug: orgSlug,
	} as Parameters<typeof t.withIdentity>[0]);

/** Signed in, but has not joined/created an organisation yet. */
const asNoOrg = (t: T) =>
	t.withIdentity({ subject: ORDINARY_NO_ORG } as Parameters<
		typeof t.withIdentity
	>[0]);

/**
 * The fleet's own caller: the by-id service-account carve-out inside
 * withOrgScope. Used ONLY in ALLOW poles — never to prove a denial.
 */
const asMaster = (t: T) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Parameters<
		typeof t.withIdentity
	>[0]);

async function seedOrgMapping(t: T, clerkOrgSlug: string, roster = ["sigma"]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}


// ─────────────────────────────────────────────────────────────────────────────
// REFUSAL SHAPE, CORRECTED (task k177hpz3cx9bb842tc9201wf118f94sa).
//
// The header above, and the DENY poles below, originally asserted the TYPED
// EMPTY VALUE as the contract for a caller with no credential. That closed the
// leak and left a second defect standing: "you may not" and "there is nothing"
// came out as IDENTICAL BYTES. A guard built on top of these doors — exactly
// like the prod-deploy guard that read an empty success on Day 158 and could
// not tell a refusal from an absence — will one day ALLOW on a refusal.
//
// The assertions are INVERTED here, not deleted. Each keeps its real security
// property (the unscoped caller is served NO ROWS) and gains the one it was
// missing (the refusal is RECOGNISABLE BY CONTENT: a ConvexError whose data
// carries RBAC_DENIED and names the registration). The ALLOW poles are
// untouched, because no admission set changed.
//
// R-50 is NOT violated: an anonymous caller has no mounted render for the
// throw to crash (the dashboard sits behind clerkMiddleware), and the
// signed-in-but-not-yet-onboarded caller keeps its typed-empty result at every
// site a dashboard `useQuery` actually subscribes to — the `preOrgAlsoRaises`
// flag on each site below, enumerated by command, is that distinction.
// See `.claude/rules/refusal-is-distinguishable-from-absence.md`.
// ─────────────────────────────────────────────────────────────────────────────

async function expectRefusalCarryingItsCode(
	read: () => Promise<unknown>,
	registration: string,
): Promise<void> {
	let caught: unknown;
	let returned: unknown;
	let didThrow = false;
	try {
		returned = await read();
	} catch (e) {
		didThrow = true;
		caught = e;
	}
	if (!didThrow) {
		throw new Error(
			`${registration} returned a SUCCESSFUL value to an unscoped caller instead of raising — ` +
				`a refusal and an absence must not be the same bytes. Got: ${JSON.stringify(returned)}`,
		);
	}
	expect(caught).toBeInstanceOf(ConvexError);
	const data = String((caught as ConvexError<string>).data);
	expect(data).toContain("RBAC_DENIED");
	expect(data).toContain(registration);
}

const now = () => Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Seeds — one minimal, schema-valid row per leaking table.
// ─────────────────────────────────────────────────────────────────────────────

const seedProfile = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId: "sigma",
			name: "Sigma",
			static: { role: "infra", workspace: "/x", capabilities: [] },
			dynamic: { lastSeen: now(), sessionCount: 1 },
		});
	});

const seedMandate = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("mandates", {
			requestedBy: "pi",
			fulfilledBy: "sigma",
			service: "spending authority row that leaked in production",
			budget: 100000,
			status: "requested",
			createdAt: now(),
			updatedAt: now(),
		});
	});

const seedFixPattern = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("fixPatterns", {
			symptom: "s",
			rootCause: "r",
			tags: [],
			stack: [],
			sourceProject: "vantage-peers",
			createdBy: "sigma",
			severity: "major",
			createdAt: now(),
			updatedAt: now(),
		});
	});

const seedMissionTemplate = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("missionTemplates", {
			name: "template-that-leaked",
			steps: [],
			isDefault: false,
			createdBy: "sigma",
			createdAt: now(),
			updatedAt: now(),
		});
	});

const seedErrorLog = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("errorLogs", {
			hash: "h1",
			deployment: "prod",
			functionName: "tasks:complete",
			errorMessage: "an error payload that leaks the shape of everything else",
			firstSeen: now(),
			lastSeen: now(),
			count: 1,
		});
	});

const seedFilterRule = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("errorMonitorFilterRules", {
			functionName: "tasks:complete",
			errorMessageRegex: "x",
			reason: "noise",
			severity: "skip",
			active: true,
			createdAt: now(),
		});
	});

const seedIssueStats = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("issueStats", {
			repo: "org/repo",
			date: "2026-09-27",
			totalIssues: 3,
			resolvedIssues: 1,
			calculatedAt: now(),
		});
	});

const seedRepoMapping = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("githubRepoMapping", {
			repo: "org/repo",
			orchestrator: "sigma",
			project: "vantage-peers",
			active: true,
		});
	});

const seedIssue = (t: T, extra: Record<string, unknown> = {}) =>
	t.run(async (ctx) => {
		await ctx.db.insert("issues", {
			repo: "org/repo",
			issueNumber: 1,
			title: "issue",
			body: "b",
			htmlUrl: "https://example.test/1",
			labels: [],
			status: "open",
			priority: "medium",
			assignedOrchestrator: "sigma",
			project: "vantage-peers",
			githubCreatedAt: now(),
			githubUpdatedAt: now(),
			...extra,
		});
	});

/**
 * `orgId` is the row's TENANT. Left undefined the row is untenanted and is
 * served to NO org-scoped caller — so an ALLOW pole must always state it, or it
 * would be measuring the tenant gate rather than the roster it names.
 */
const seedRecurringTask = (t: T, assignedTo = "sigma", orgId?: string) =>
	t.run(async (ctx) => {
		await ctx.db.insert("recurringTasks", {
			title: "daily scan",
			assignedTo,
			orgId,
			clerkOrgId: testClerkOrgId(orgId),
			priority: "medium",
			cronExpression: "0 9 * * *",
			nextRunAt: now(),
			active: true,
			createdBy: "sigma",
			createdAt: now(),
			updatedAt: now(),
		});
	});

const seedBusinessUnit = (t: T, orchestratorId = "sigma") =>
	t.run(async (ctx) => {
		await ctx.db.insert("businessUnits", {
			name: `bu-${orchestratorId}`,
			description: "d",
			purpose: "p",
			orchestratorId,
			status: "building",
			businessModel: "m",
			targetCustomers: "c",
			services: [],
			pricing: "x",
			revenueProjections: { y1: 0, y2: 0, y3: 0 },
			coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
			coreProcesses: [],
			dependencies: [],
			kpis: [],
			managementFee: 10,
			createdAt: now(),
			updatedAt: now(),
		});
	});

/** A blocked task with neither blockedOnTaskId nor blockedOnNobodyReason. */
const seedUnlinkedBlockedTask = (t: T, assignedTo = "sigma", orgId?: string) =>
	t.run(async (ctx) => {
		await ctx.db.insert("tasks", {
			title: "blocked with no link",
			assignedTo,
			orgId,
			clerkOrgId: testClerkOrgId(orgId),
			priority: "medium",
			status: "blocked",
			createdBy: "sigma",
			createdAt: now(),
			updatedAt: now(),
		});
	});

const seedMessage = (t: T, channel: string, tenantId?: string) =>
	t.run(async (ctx) => {
		await ctx.db.insert("messages", {
			from: "sigma",
			channel,
			content: `content on ${channel}`,
			createdAt: now(),
			...(tenantId !== undefined ? { tenantId, tenantOrgId: testClerkOrgId(tenantId) } : {}),
		});
	});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1 — FLEET-INTERNAL, MASTER-ONLY reads.
//
// These tables carry NO orgId/tenant column, and their WRITES are already
// master-only (`requireFleetMaster` / `requireMasterScope`, landed earlier).
// The reads were left open. Closing them means the read admits exactly what the
// write admits: master, and nobody else. The THIRD deny pole in each block — an
// ORDINARY MEMBER OF AN ACTIVE ORG — is the one that matters most: it proves the
// guard is not merely "is anyone signed in".
// ─────────────────────────────────────────────────────────────────────────────

const masterOnlyReads: Array<{
	label: string;
	/** `module:function`, the string the refusal must name. */
	registration: string;
	/**
	 * True when NO dashboard `useQuery` subscribes to this read, so the
	 * signed-in-but-not-yet-onboarded caller may be raised at too. Enumerated by
	 * command against vantage-peers-dashboard, never guessed.
	 */
	preOrgAlsoRaises: boolean;
	seed: (t: T) => Promise<void>;
	read: (c: T | ReturnType<typeof asMaster>) => Promise<unknown>;
	empty: unknown;
	nonEmpty: (v: unknown) => boolean;
}> = [
	{
		label: "profiles:listProfiles (50 rows leaked)",
		registration: "profiles:listProfiles",
		preOrgAlsoRaises: false,
		seed: seedProfile,
		read: (c) => c.query(api.profiles.listProfiles, {}),
		empty: [],
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
	},
	{
		label: "mandates:list (9 rows of SPENDING AUTHORITY leaked)",
		registration: "mandates:list",
		preOrgAlsoRaises: false,
		seed: seedMandate,
		read: (c) => c.query(api.mandates.list, {}),
		empty: [],
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
	},
	{
		label: "fixPatterns:listAll (50 rows leaked)",
		registration: "fixPatterns:listAll",
		preOrgAlsoRaises: true,
		seed: seedFixPattern,
		read: (c) => c.query(api.fixPatterns.listAll, {}),
		empty: [],
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
	},
	{
		label: "missionTemplates:listNames (33 rows leaked)",
		registration: "missionTemplates:listNames",
		preOrgAlsoRaises: true,
		seed: seedMissionTemplate,
		read: (c) => c.query(api.missionTemplates.listNames, {}),
		empty: [],
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
	},
	{
		label: "errorMonitor:listErrors (50 error payloads leaked)",
		registration: "errorMonitor:listErrors",
		preOrgAlsoRaises: true,
		seed: seedErrorLog,
		read: (c) => c.query(api.errorMonitor.listErrors, {}),
		empty: [],
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
	},
	{
		label: "errorMonitorFilters:listFilterRules (15 rows leaked)",
		registration: "errorMonitorFilters:listFilterRules",
		preOrgAlsoRaises: true,
		seed: seedFilterRule,
		read: (c) => c.query(api.errorMonitorFilters.listFilterRules, {}),
		empty: [],
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
	},
	{
		label: "issueStatsQueries:getLatest (30 rows leaked)",
		registration: "issueStatsQueries:getLatest",
		preOrgAlsoRaises: true,
		seed: seedIssueStats,
		read: (c) => c.query(api.issueStatsQueries.getLatest, {}),
		empty: [],
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
	},
	{
		label: "githubRepoMapping:list (1 row leaked)",
		registration: "githubRepoMapping:list",
		preOrgAlsoRaises: true,
		seed: seedRepoMapping,
		read: (c) => c.query(api.githubRepoMapping.list, {}),
		empty: { items: [], nextCursor: null },
		nonEmpty: (v) =>
			typeof v === "object" &&
			v !== null &&
			(v as { items: unknown[] }).items.length === 1,
	},
	{
		label: "issues:getStats (aggregate counts leaked)",
		registration: "issues:getStats",
		preOrgAlsoRaises: true,
		seed: (t) => seedIssue(t),
		read: (c) => c.query(api.issues.getStats, {}),
		empty: {
			open: 0,
			in_progress: 0,
			fixed: 0,
			verified: 0,
			closed: 0,
			total: 0,
		},
		nonEmpty: (v) => (v as { total: number }).total === 1,
	},
	{
		label: "issues:listExternalOpen (1 row leaked)",
		registration: "issues:listExternalOpen",
		preOrgAlsoRaises: true,
		seed: (t) =>
			seedIssue(t, {
				externalRepo: "third/party",
				prStatus: "open",
				prUrl: "https://example.test/pr/1",
			}),
		read: (c) => c.query(api.issues.listExternalOpen, { prStatus: "open" }),
		empty: { issues: [], nextPageToken: null },
		nonEmpty: (v) => (v as { issues: unknown[] }).issues.length === 1,
	},
];

for (const site of masterOnlyReads) {
	describe(`fleet-internal read resolves its caller — ${site.label}`, () => {
		test("DENY — an anonymous caller (no credential at all) is RAISED at, carrying RBAC_DENIED — never a typed empty value a reader would mistake for an absence", async () => {
			const t = createT();
			await site.seed(t);

			await expectRefusalCarryingItsCode(
				() => site.read(t),
				site.registration,
			);
		});

		test("DENY — a signed-in caller with NO verified organisation is refused in the shape its consumers can survive", async () => {
			const t = createT();
			await site.seed(t);

			if (site.preOrgAlsoRaises) {
				// No dashboard useQuery subscribes here, so there is no render for
				// the throw to crash and no reason to hand this caller a silence.
				await expectRefusalCarryingItsCode(
					() => site.read(asNoOrg(t)),
					site.registration,
				);
			} else {
				// A dashboard useQuery does subscribe to this read and this caller's
				// shell IS mounted (R-50), so it is not RAISED at. mandates:list and
				// profiles:listProfiles answer it with the envelope its consumers
				// already read (task k1749w7ecx2yffr1hbhjpk8v858fbrf1: a bare `[]`
				// is the bytes of an absence); businessUnits:list keeps its typed
				// empty (not one of the six sites).
				if (
					site.registration === "mandates:list" ||
					site.registration === "profiles:listProfiles"
				) {
					expect(await site.read(asNoOrg(t))).toEqual({
						refused: true,
						items: [],
					});
				} else {
					expect(await site.read(asNoOrg(t))).toEqual(site.empty);
				}
			}
		});

		test("DENY — an ORDINARY member of an ACTIVE organisation is refused in the shape this site declares (the guard is not merely 'is anyone signed in')", async () => {
			const t = createT();
			await seedOrgMapping(t, "org-a");
			await site.seed(t);

			const got = () => site.read(asOrgMember(t, "org-a"));
			if (site.registration === "issues:getStats") {
				// A zeroed aggregate is a FABRICATED MEASUREMENT, never a refusal.
				await expectRefusalCarryingItsCode(got, site.registration);
			} else if (
				site.registration === "mandates:list" ||
				site.registration === "profiles:listProfiles"
			) {
				// Reactively subscribed: a typed envelope its consumers already read.
				expect(await got()).toEqual({ refused: true, items: [] });
			} else {
				expect(await got()).toEqual(site.empty);
			}
		});

		test("ALLOW — the fleet's own master caller still reads the row (no WITHHELD GRANT)", async () => {
			const t = createT();
			await site.seed(t);

			const got = await site.read(asMaster(t));
			expect(site.nonEmpty(got)).toBe(true);
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2 — ORG-SCOPED reads. Here the ALLOW pole is an ORDINARY org member,
// because these rows DO carry an orchestrator the roster can judge, and the
// guard must narrow rather than close.
// ─────────────────────────────────────────────────────────────────────────────

describe("org-scoped read resolves its caller — businessUnits:list (1 row leaked)", () => {
	test("DENY — an anonymous caller is RAISED at, carrying RBAC_DENIED (an empty envelope and an empty table were the same bytes)", async () => {
		const t = createT();
		await seedBusinessUnit(t, "sigma");

		await expectRefusalCarryingItsCode(
			() => t.query(api.businessUnits.list, {}),
			"businessUnits:list",
		);
	});

	test("DENY — signed-in caller with NO verified organisation gets the typed empty envelope", async () => {
		const t = createT();
		await seedBusinessUnit(t, "sigma");

		expect(await asNoOrg(t).query(api.businessUnits.list, {})).toEqual({
			items: [],
			nextCursor: null,
		});
	});

	test("DENY — an ordinary org member is NOT served a BU led by an orchestrator outside its own roster", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		await seedBusinessUnit(t, "omega");

		const res = await asOrgMember(t, "org-a").query(api.businessUnits.list, {});
		expect(res.items).toEqual([]);
	});

	test("ALLOW — an ordinary org member IS served the BU led by an orchestrator ON its roster", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		await seedBusinessUnit(t, "sigma");

		const res = await asOrgMember(t, "org-a").query(api.businessUnits.list, {});
		expect(res.items).toHaveLength(1);
	});
});

describe("org-scoped read resolves its caller — recurringTasks:list (4 rows leaked)", () => {
	test("DENY — an anonymous caller is RAISED at, carrying RBAC_DENIED", async () => {
		const t = createT();
		await seedRecurringTask(t, "sigma");

		await expectRefusalCarryingItsCode(
			() => t.query(api.recurringTasks.list, {}),
			"recurringTasks:list",
		);
	});

	test("DENY — a signed-in caller with NO verified organisation is RAISED at too (no dashboard useQuery subscribes to this read)", async () => {
		const t = createT();
		await seedRecurringTask(t, "sigma");

		await expectRefusalCarryingItsCode(
			() => asNoOrg(t).query(api.recurringTasks.list, {}),
			"recurringTasks:list",
		);
	});

	test("DENY — an ordinary org member is NOT served a recurring task assigned outside its roster", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		await seedRecurringTask(t, "omega");

		expect(
			await asOrgMember(t, "org-a").query(api.recurringTasks.list, {}),
		).toEqual([]);
	});

	test("ALLOW — an ordinary org member IS served a recurring task assigned ON its roster", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		// Tenanted to org-a: the ALLOW pole has to clear the tenant gate AND the
		// roster, and it is the roster this test is about.
		await seedRecurringTask(t, "sigma", "org-a");

		expect(
			await asOrgMember(t, "org-a").query(api.recurringTasks.list, {}),
		).toHaveLength(1);
	});
});

describe("org-scoped read resolves its caller — tasks:listUnlinkedBlocked (159 rows leaked, the largest)", () => {
	test("DENY — an anonymous caller is RAISED at, carrying RBAC_DENIED", async () => {
		const t = createT();
		await seedUnlinkedBlockedTask(t, "sigma");

		await expectRefusalCarryingItsCode(
			() => t.query(api.tasks.listUnlinkedBlocked, {}),
			"tasks:listUnlinkedBlocked",
		);
	});

	test("DENY — a signed-in caller with NO verified organisation is RAISED at too (no dashboard useQuery subscribes to this read)", async () => {
		const t = createT();
		await seedUnlinkedBlockedTask(t, "sigma");

		await expectRefusalCarryingItsCode(
			() => asNoOrg(t).query(api.tasks.listUnlinkedBlocked, {}),
			"tasks:listUnlinkedBlocked",
		);
	});

	test("DENY — an ordinary org member is NOT served a blocked task assigned outside its roster", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		await seedUnlinkedBlockedTask(t, "omega");

		expect(
			await asOrgMember(t, "org-a").query(api.tasks.listUnlinkedBlocked, {}),
		).toEqual([]);
	});

	test("ALLOW — an ordinary org member IS served a blocked task assigned ON its roster", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		// Tenanted to org-a — see the recurringTasks ALLOW pole above.
		await seedUnlinkedBlockedTask(t, "sigma", "org-a");

		expect(
			await asOrgMember(t, "org-a").query(api.tasks.listUnlinkedBlocked, {}),
		).toHaveLength(1);
	});
});

// messages:listByChannel is the ONE site of the fourteen that is NOT
// "unguarded": it DOES resolve a scope and then hands `channel === "broadcast"`
// to anyone, credential or not — a hardcoded literal standing in for an
// authorisation. That is the FAIL-OPEN class, and it is why an instrument that
// only asks "does it resolve an identity" is insufficient.
describe("FAIL-OPEN closed — messages:listByChannel (1 row leaked via the hardcoded 'broadcast' literal)", () => {
	test("DENY — an anonymous caller is RAISED at on the broadcast channel, carrying RBAC_DENIED", async () => {
		const t = createT();
		await seedMessage(t, "broadcast");

		await expectRefusalCarryingItsCode(
			() => t.query(api.messages.listByChannel, { channel: "broadcast" }),
			"messages:listByChannel",
		);
	});

	test("DENY — an anonymous caller with NO channel argument is RAISED at too", async () => {
		const t = createT();
		await seedMessage(t, "broadcast");

		await expectRefusalCarryingItsCode(
			() => t.query(api.messages.listByChannel, {}),
			"messages:listByChannel",
		);
	});

	test("DENY — signed-in caller with NO verified organisation is served no broadcast rows, and is TOLD it was refused", async () => {
		const t = createT();
		await seedMessage(t, "broadcast");

		// Envelope, not a bare `[]` (task k1749w7ecx2yffr1hbhjpk8v858fbrf1): no
		// row is served, and the bytes are not those of an absence.
		expect(
			await asNoOrg(t).query(api.messages.listByChannel, {
				channel: "broadcast",
			}),
		).toEqual({ refused: true, items: [] });
	});

	test("ALLOW — an ordinary member of an ACTIVE org still reads broadcast (the shared channel is not withdrawn from legitimate callers)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		// Stamped with the reader's org: broadcast is tenant-scoped (closeDoorsB).
		await seedMessage(t, "broadcast", "org-a");

		expect(
			await asOrgMember(t, "org-a").query(api.messages.listByChannel, {
				channel: "broadcast",
			}),
		).toHaveLength(1);
	});

	test("ALLOW — an ordinary org member still reads a channel named for an orchestrator ON its roster", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		await seedMessage(t, "sigma", "org-a");

		expect(
			await asOrgMember(t, "org-a").query(api.messages.listByChannel, {
				channel: "sigma",
			}),
		).toHaveLength(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The internal split that keeps a REAL caller working.
//
// convex/prMonitor.ts's `pollOpenPRs` is an internalAction on a cron: it runs
// with NO Clerk identity by construction, so the master-only guard added to the
// PUBLIC `issues:listExternalOpen` would have silently emptied its result and
// killed PR monitoring fleet-wide. Splitting it the way `tasks.listForWebhook`
// is split keeps that caller working through a path that is structurally
// unreachable from `api.*` (registered only under the `internal` tree). This
// test pins the split itself: the internal reader still returns the row.
// ─────────────────────────────────────────────────────────────────────────────

describe("the fleet PR-monitor caller is rewired, not broken", () => {
	test("internal.issues.listExternalOpenForMonitor returns the row with no identity at all (the cron's real condition)", async () => {
		const t = createT();
		await seedIssue(t, {
			externalRepo: "third/party",
			prStatus: "open",
			prUrl: "https://example.test/pr/1",
		});

		const res = await t.run(async (ctx) => {
			const { internal } = await import("../_generated/api");
			return await ctx.runQuery(internal.issues.listExternalOpenForMonitor, {
				prStatus: "open" as const,
				limit: 50,
			});
		});

		expect(res.issues).toHaveLength(1);
	});
});
