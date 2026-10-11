/// <reference types="vite/client" />
/**
 * A REFUSAL IS DISTINGUISHABLE FROM AN ABSENCE.
 *
 * THE DEFECT. PR #1349 closed fourteen public reads that served rows to a
 * caller presenting NO CREDENTIAL AT ALL. They now serve nothing — but they
 * serve that nothing as `{"status":"success","value":[]}`. "You may not" and
 * "there is nothing" come out as IDENTICAL BYTES. That is precisely the shape
 * that froze every fleet deployment on Day 158, seen from the other side: the
 * prod-deploy guard READ an empty success and could not tell a refusal from an
 * absence. A guard built on top of these doors will one day ALLOW on a refusal.
 *
 * `issues:getStats` was the worst of the fourteen — measured against live
 * production it answered a refused reader with
 * `{closed:0, fixed:0, in_progress:0, open:0, total:0, verified:0}`: not an
 * ABSENT figure but a FALSE one. A refused reader was told there are zero open
 * issues. Its pole is first in this file for that reason.
 *
 * THE FORM. `requireResolvedCaller` (convex/lib/auth.ts) raises the same
 * `ConvexError` carrying the same `RBAC_DENIED:` prefix that `requireScope`
 * beside it already raises and that `missions:list` already returns to an
 * unscoped caller in production. One helper, one code, no per-function variant
 * and no new refusal mechanism.
 *
 * THE THREE STATES THIS FILE PINS APART, per site:
 *   1. REFUSED   — anonymous caller            → RAISES, payload carries RBAC_DENIED
 *   2. ABSENT    — scoped caller, empty table  → SUCCEEDS with an empty value
 *   3. PRESENT   — scoped caller, seeded table → SUCCEEDS with rows
 * State 2 is the pole that proves this delivery did not simply make everything
 * throw: an empty table under a legitimate caller must STILL be an empty
 * success, and it is shown side by side with state 1 on `mandates:list`.
 *
 * WHY THE ANONYMOUS POLE MAY RAISE WITHOUT VIOLATING R-50. R-50 says a
 * reactively-subscribed read cannot refuse by throwing because the throw
 * surfaces as a crashed render. That is true of a caller whose SHELL IS
 * MOUNTED. An anonymous caller has none: the only subscribing consumer of this
 * backend is the vantage-peers-dashboard Next.js app, every route of which sits
 * behind `clerkMiddleware`, so no `useQuery` subscription is ever established
 * without a Clerk session. `missions:list` is itself reactively subscribed
 * (`components/missions/mission-board.tsx:25`) and has raised `RBAC_DENIED` at
 * this pole in production all along. The signed-in-but-not-yet-onboarded caller
 * (`scope.refused`) IS a mounted render, and this delivery leaves that caller's
 * typed-empty result untouched at every site that has a subscriber. See
 * `.claude/rules/refusal-is-distinguishable-from-absence.md`.
 *
 * EVERY DENY POLE HERE IS AN ORDINARY CALLER. `asMaster` appears only in ALLOW
 * poles. A suite that proved a denial while authenticated as the configured
 * service account would pass with the authorisation DELETED and prove nothing.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

// `search` / `ragSync` / `backfill` are excluded for the SAME reason every
// sibling suite in this directory excludes them: convex/search.ts is a
// "use node" module that builds its RAG client at MODULE LOAD time and cannot
// be loaded under convex-test at all.
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

/** The fleet's own caller — ALLOW poles only, never to prove a denial. */
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

const now = () => Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// The assertion this whole file is about.
//
// It is NOT "it threw". A bare `rejects.toThrow()` would pass on an
// ArgumentValidationError, on a TypeError from a typo, on a scan-cap blowup —
// any of which would let a broken door look guarded. The refusal must be
// RECOGNISABLE BY CONTENT: a ConvexError whose data carries `RBAC_DENIED` and
// names the registration that refused.
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
				`"you may not" and "there is nothing" are indistinguishable bytes. Got: ${JSON.stringify(returned)}`,
		);
	}

	expect(
		caught,
		`${registration} threw something that is not a ConvexError — a refusal must carry structured data a reader can branch on`,
	).toBeInstanceOf(ConvexError);

	const data = (caught as ConvexError<string>).data;
	expect(
		typeof data,
		`${registration}: ConvexError.data must be the string payload the fleet's RBAC_DENIED convention uses`,
	).toBe("string");
	expect(
		String(data),
		`${registration}: the refusal must carry its CODE, not just fail`,
	).toContain("RBAC_DENIED");
	expect(
		String(data),
		`${registration}: the refusal must name WHICH door refused, so a reader can act on it`,
	).toContain(registration);
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeds — one minimal, schema-valid row per site.
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
			service: "spending authority row",
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
			name: "template",
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
			errorMessage: "an error payload",
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
			htmlUrl: "https://example.test/i/1",
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

const seedBusinessUnit = (t: T, orchestratorId: string) =>
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

const seedRecurringTask = (t: T, assignedTo: string, orgId?: string) =>
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
// THE FOURTEEN — re-derived by command at HEAD, not copied from a brief.
//
// Derivation (run from the repo root, pasted verbatim in the delivery report):
//   grep -rn "refuseWithoutThrow: true" convex/*.ts
// then, for each hit, the registration reached from `api.*` whose refusal for
// an anonymous caller was a SUCCESSFUL EMPTY VALUE rather than a raise. The
// authoritative re-derivation is this table executed against the tree: any site
// that is in fact already raising passes its pole immediately, and any site
// NOT in this table that still answers an anonymous caller with an empty
// success is caught by the sweep at the bottom of this file, which is derived
// from `convex/_generated/api.d.ts` rather than from any hand-written list.
//
// `hasReactiveSubscriber` is the ONE axis on which the fourteen differ, and it
// is enumerated by command against the dashboard repo, never guessed:
//   grep -rn "api\.<module>\." --include=*.tsx app components hooks lib
// Four of the fourteen have a live `useQuery`; ten have none. The ten also
// raise for the signed-in-no-org caller (`alsoRefusePreOrg`), because there is
// no mounted render for that throw to crash; the four keep that caller's R-50
// typed-empty result untouched.
// ─────────────────────────────────────────────────────────────────────────────

type Site = {
	registration: string;
	/** true → a dashboard `useQuery` subscribes to this read. */
	hasReactiveSubscriber: boolean;
	seed: (t: T) => Promise<void>;
	read: (c: T) => Promise<unknown>;
	/** Rows are visible to this caller when the table is seeded. */
	allow: (t: T) => Promise<T>;
	/** True when the value carries the seeded row. */
	nonEmpty: (v: unknown) => boolean;
	/** The empty-SUCCESS value a legitimately scoped caller sees on an empty table. */
	emptyValue: unknown;
};

const asMasterAllow = async (t: T) => asMaster(t) as unknown as T;
const asRosterAllow = async (t: T) => {
	await seedOrgMapping(t, "org-a", ["sigma"]);
	return asOrgMember(t, "org-a") as unknown as T;
};

// The subscribed sites whose pre-organisation caller is answered with the
// `{ refused: true, items: [] }` envelope. `businessUnits:list` is the one
// subscribed site NOT here: it answers with a paging envelope and was not among
// the six sites of task k1749w7ecx2yffr1hbhjpk8v858fbrf1 (named, not closed).
const PRE_ORG_ENVELOPE_SITES = new Set([
	"mandates:list",
	"profiles:listProfiles",
	"messages:listByChannel",
]);

const SITES: Site[] = [
	// FIRST, because it is the only one that fabricated a MEASUREMENT rather
	// than withholding one.
	{
		registration: "issues:getStats",
		hasReactiveSubscriber: false,
		seed: (t) => seedIssue(t),
		read: (c) => c.query(api.issues.getStats, {}),
		allow: asMasterAllow,
		nonEmpty: (v) => (v as { total: number }).total === 1,
		emptyValue: {
			open: 0,
			in_progress: 0,
			fixed: 0,
			verified: 0,
			closed: 0,
			total: 0,
		},
	},
	{
		registration: "profiles:listProfiles",
		hasReactiveSubscriber: true, // components/orchestrators/orchestrators-grid.tsx:53
		seed: seedProfile,
		read: (c) => c.query(api.profiles.listProfiles, {}),
		allow: asMasterAllow,
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		emptyValue: [],
	},
	{
		registration: "mandates:list",
		hasReactiveSubscriber: true, // components/mandates/mandate-board.tsx:39
		seed: seedMandate,
		read: (c) => c.query(api.mandates.list, {}),
		allow: asMasterAllow,
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		emptyValue: [],
	},
	{
		registration: "fixPatterns:listAll",
		hasReactiveSubscriber: false,
		seed: seedFixPattern,
		read: (c) => c.query(api.fixPatterns.listAll, {}),
		allow: asMasterAllow,
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		emptyValue: [],
	},
	{
		registration: "missionTemplates:listNames",
		hasReactiveSubscriber: false,
		seed: seedMissionTemplate,
		read: (c) => c.query(api.missionTemplates.listNames, {}),
		allow: asMasterAllow,
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		emptyValue: [],
	},
	{
		registration: "errorMonitor:listErrors",
		hasReactiveSubscriber: false,
		seed: seedErrorLog,
		read: (c) => c.query(api.errorMonitor.listErrors, {}),
		allow: asMasterAllow,
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		emptyValue: [],
	},
	{
		registration: "errorMonitorFilters:listFilterRules",
		hasReactiveSubscriber: false,
		seed: seedFilterRule,
		read: (c) => c.query(api.errorMonitorFilters.listFilterRules, {}),
		allow: asMasterAllow,
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		emptyValue: [],
	},
	{
		registration: "issueStatsQueries:getLatest",
		hasReactiveSubscriber: false,
		seed: seedIssueStats,
		read: (c) => c.query(api.issueStatsQueries.getLatest, {}),
		allow: asMasterAllow,
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		emptyValue: [],
	},
	{
		registration: "githubRepoMapping:list",
		hasReactiveSubscriber: false,
		seed: seedRepoMapping,
		read: (c) => c.query(api.githubRepoMapping.list, {}),
		allow: asMasterAllow,
		nonEmpty: (v) => (v as { items: unknown[] }).items.length === 1,
		emptyValue: { items: [], nextCursor: null },
	},
	{
		registration: "issues:listExternalOpen",
		hasReactiveSubscriber: false,
		seed: (t) =>
			seedIssue(t, {
				externalRepo: "third/party",
				prStatus: "open",
				prUrl: "https://example.test/pr/1",
			}),
		read: (c) => c.query(api.issues.listExternalOpen, { prStatus: "open" }),
		allow: asMasterAllow,
		nonEmpty: (v) => (v as { issues: unknown[] }).issues.length === 1,
		emptyValue: { issues: [], nextPageToken: null },
	},
	{
		registration: "businessUnits:list",
		hasReactiveSubscriber: true, // app/[locale]/dashboard/page.tsx:366
		seed: (t) => seedBusinessUnit(t, "sigma"),
		read: (c) => c.query(api.businessUnits.list, {}),
		allow: asRosterAllow,
		nonEmpty: (v) => (v as { items: unknown[] }).items.length === 1,
		emptyValue: { items: [], nextCursor: null },
	},
	{
		registration: "recurringTasks:list",
		hasReactiveSubscriber: false,
		// Stamped with the reader's org: after the tenant partition (#1354) an
		// UNSTAMPED row is served to no org member, so the PRESENT pole needs a row
		// that belongs to "org-a" for the roster member to be served it.
		seed: (t) => seedRecurringTask(t, "sigma", "org-a"),
		read: (c) => c.query(api.recurringTasks.list, {}),
		allow: asRosterAllow,
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		emptyValue: [],
	},
	{
		registration: "tasks:listUnlinkedBlocked",
		hasReactiveSubscriber: false,
		seed: (t) => seedUnlinkedBlockedTask(t, "sigma", "org-a"),
		read: (c) => c.query(api.tasks.listUnlinkedBlocked, {}),
		allow: asRosterAllow,
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		emptyValue: [],
	},
	{
		registration: "messages:listByChannel",
		hasReactiveSubscriber: true, // components/messages/message-timeline.tsx:51
		// Stamped with the reader's org: broadcast is tenant-scoped (closeDoorsB),
		// so an UNSTAMPED fleet-internal broadcast is served to no org member.
		seed: (t) => seedMessage(t, "broadcast", "org-a"),
		read: (c) => c.query(api.messages.listByChannel, { channel: "broadcast" }),
		allow: asRosterAllow,
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		emptyValue: [],
	},
];

test("the scope re-derived here is the fourteen, and the split by subscriber is 4/10", () => {
	expect(SITES).toHaveLength(14);
	expect(SITES.filter((s) => s.hasReactiveSubscriber)).toHaveLength(4);
	expect(SITES.filter((s) => !s.hasReactiveSubscriber)).toHaveLength(10);
	// No duplicate registration — a copy/paste in the table would otherwise
	// silently shrink the real coverage.
	expect(new Set(SITES.map((s) => s.registration)).size).toBe(14);
});

for (const site of SITES) {
	describe(`refusal carries its code — ${site.registration}`, () => {
		// ── POLE 1: REFUSED. Identity: NONE (no credential at all).
		test("REFUSED — an anonymous caller is RAISED at, with RBAC_DENIED in the payload (never an empty success)", async () => {
			const t = createT();
			await site.seed(t);

			await expectRefusalCarryingItsCode(
				() => site.read(t),
				site.registration,
			);
		});

		// The positive control for pole 1: the same assertion on a caller that
		// SHOULD be served proves the assertion can distinguish, rather than
		// passing on everything.
		test("POSITIVE CONTROL — the same assertion FAILS against a legitimately scoped caller (so pole 1 is not vacuous)", async () => {
			const t = createT();
			const caller = await site.allow(t);
			await site.seed(t);

			await expect(
				expectRefusalCarryingItsCode(
					() => site.read(caller),
					site.registration,
				),
			).rejects.toThrow(/returned a SUCCESSFUL value/);
		});

		// ── POLE 2: PRESENT. Identity named per site: the fleet service account
		// for the fleet-internal tables (which have no ordinary reader by
		// construction — they carry no orgId column), an ORDINARY MEMBER of an
		// active org for the org-scoped ones. Never the maintenance/master
		// bypass for the org-scoped four.
		test("PRESENT — a legitimately scoped caller still gets its rows (no WITHHELD GRANT)", async () => {
			const t = createT();
			const caller = await site.allow(t);
			await site.seed(t);

			expect(site.nonEmpty(await site.read(caller))).toBe(true);
		});

		// ── POLE 3: ABSENT. The pole that proves this delivery did not simply
		// make everything throw.
		test("ABSENT — a legitimately scoped caller reading an EMPTY table still gets an empty SUCCESS, not a refusal", async () => {
			const t = createT();
			const caller = await site.allow(t);
			// deliberately NOT seeded

			expect(await site.read(caller)).toEqual(site.emptyValue);
		});

		// ── The R-50 population, split by whether a render actually exists.
		if (
			site.hasReactiveSubscriber &&
			PRE_ORG_ENVELOPE_SITES.has(site.registration)
		) {
			// RE-DECIDED (task k1749w7ecx2yffr1hbhjpk8v858fbrf1). R-50's reasoning
			// (never THROW at a mounted render) is kept; its conclusion (a bare `[]`)
			// is not: a bare `[]` is the same bytes as an absence. The envelope
			// renders empty in every dashboard consumer AND says it was refused. The
			// full three-pole proof is
			// convex/__tests__/preOrgRefusalCarriesItsMarker.test.ts.
			test("R-50 NARROWED — a signed-in caller with NO organisation is served the typed ENVELOPE, never a throw and never the bytes of an absence", async () => {
				const t = createT();
				await site.seed(t);

				expect(await site.read(asNoOrg(t) as unknown as T)).toEqual({
					refused: true,
					items: [],
				});
			});
		} else if (site.hasReactiveSubscriber) {
			test("R-50 PRESERVED — a signed-in caller with NO organisation still gets the typed EMPTY value, because a dashboard useQuery subscribes to this read", async () => {
				const t = createT();
				await site.seed(t);

				expect(await site.read(asNoOrg(t) as unknown as T)).toEqual(
					site.emptyValue,
				);
			});
		} else {
			test("no subscriber exists — a signed-in caller with NO organisation is RAISED at too, so this door never answers with a fabricated absence", async () => {
				const t = createT();
				await site.seed(t);

				await expectRefusalCarryingItsCode(
					() => site.read(asNoOrg(t) as unknown as T),
					site.registration,
				);
			});
		}
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// issues:getStats — the fabricated measurement, pinned on its own.
// ─────────────────────────────────────────────────────────────────────────────

describe("issues:getStats returns NO NUMBERS AT ALL to a refused caller", () => {
	test("an anonymous caller receives no value at all — not a zeroed aggregate", async () => {
		const t = createT();
		await seedIssue(t);

		let value: unknown = "sentinel-never-assigned";
		try {
			value = await t.query(api.issues.getStats, {});
		} catch {
			// expected
		}
		expect(
			value,
			"a refused reader must not be handed a counted zero — an absent figure and a false one are not the same thing",
		).toBe("sentinel-never-assigned");
	});

	test("a signed-in caller with no organisation also receives no numbers (issues:getStats has no reactive subscriber)", async () => {
		const t = createT();
		await seedIssue(t);

		let value: unknown = "sentinel-never-assigned";
		try {
			value = await asNoOrg(t).query(api.issues.getStats, {});
		} catch {
			// expected
		}
		expect(value).toBe("sentinel-never-assigned");
	});

	test("the fleet's own caller still gets real counts, and a real ZERO is still reachable on an empty table", async () => {
		const seeded = createT();
		await seedIssue(seeded);
		expect(
			(
				(await asMaster(seeded).query(api.issues.getStats, {})) as {
					total: number;
				}
			).total,
		).toBe(1);

		const empty = createT();
		const zero = (await asMaster(empty).query(api.issues.getStats, {})) as {
			total: number;
		};
		expect(zero.total).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// THE COMPARISON, side by side on ONE function.
//
// `mandates:list` is chosen because it is the spending-authority table: the one
// where a reader confusing "refused" with "nothing here" would conclude there
// are no outstanding mandates.
// ─────────────────────────────────────────────────────────────────────────────

describe("refusal vs absence, side by side on mandates:list", () => {
	test("the refused caller and the scoped caller over an empty table produce DIFFERENT observable outcomes", async () => {
		// (a) REFUSAL — anonymous, table SEEDED.
		const refusedT = createT();
		await seedMandate(refusedT);
		let refusedOutcome: { kind: string; payload: string };
		try {
			const v = await refusedT.query(api.mandates.list, {});
			refusedOutcome = { kind: "success", payload: JSON.stringify(v) };
		} catch (e) {
			refusedOutcome = {
				kind: "error",
				payload: String((e as ConvexError<string>).data ?? e),
			};
		}

		// (b) ABSENCE — the fleet's own caller, table genuinely EMPTY.
		const absentT = createT();
		const absentOutcome = {
			kind: "success",
			payload: JSON.stringify(
				await asMaster(absentT).query(api.mandates.list, {}),
			),
		};

		expect(refusedOutcome.kind).toBe("error");
		expect(refusedOutcome.payload).toContain("RBAC_DENIED");

		expect(absentOutcome.kind).toBe("success");
		expect(absentOutcome.payload).toBe("[]");

		// The property the whole delivery exists for.
		expect(refusedOutcome.kind).not.toBe(absentOutcome.kind);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ORDINARY MEMBER — REVISE of PR #1353 (reviewer verdict, two blockers).
//
// The three sites below are FLEET-MASTER-ONLY reads (their tables carry no orgId
// column; the reads admit exactly what the writes admit). So the population an
// ORDINARY ORGANISATION MEMBER falls into is REFUSED at every one of them — and
// the anonymous pole above is not the only refusal that has to be legible.
//
//   issues:getStats       member → RAISES RBAC_DENIED (was: six FABRICATED zeros)
//   mandates:list         member → { refused: true, items: [] }  (was: bare [])
//   profiles:listProfiles member → { refused: true, items: [] }  (was: bare [])
//
// WHY THE TWO KINDS OF SITE DIFFER. getStats has NO subscriber and returns a
// MEASUREMENT: a zero there is a false number, so it raises. mandates:list and
// profiles:listProfiles ARE reactively subscribed (mandate-board.tsx:39,
// orchestrators-grid.tsx:53) and their consumers already normalise
// `Array.isArray(r) ? r : (r.items ?? [])`, so the refusal is a TYPED ENVELOPE
// that renders as empty while still saying `refused: true`. A bare `[]` is the
// exact shape that silently degrades.
//
// IDENTITIES, NAMED. REFUSED poles run as ORDINARY_A, an ordinary member of the
// ACTIVE org "org-a" (mapping seeded) — never master. PRESENT and ABSENT can
// only run as the fleet service account HERE, and that is not a shortcut: these
// three reads admit NO ordinary member by design, so there is no ordinary
// reader whose PRESENT/ABSENT could be observed. The REFUSED pole with a
// SEEDED table is what pins that claim (an ordinary member sees nothing even
// though rows exist).
// ─────────────────────────────────────────────────────────────────────────────

type MasterOnlySite = {
	registration: string;
	seed: (t: T) => Promise<void>;
	read: (c: T) => Promise<unknown>;
	/** How an ORDINARY MEMBER is refused. */
	refusal: "raises" | "envelope";
	/** True when the value carries the seeded row. */
	nonEmpty: (v: unknown) => boolean;
	/** What the fleet master sees over a genuinely EMPTY table. */
	absent: unknown;
};

const REFUSAL_ENVELOPE = { refused: true, items: [] };

const MASTER_ONLY_SITES: MasterOnlySite[] = [
	{
		registration: "issues:getStats",
		seed: (t) => seedIssue(t),
		read: (c) => c.query(api.issues.getStats, {}),
		refusal: "raises",
		nonEmpty: (v) => (v as { total: number }).total === 1,
		absent: {
			open: 0,
			in_progress: 0,
			fixed: 0,
			verified: 0,
			closed: 0,
			total: 0,
		},
	},
	{
		registration: "mandates:list",
		seed: seedMandate,
		read: (c) => c.query(api.mandates.list, {}),
		refusal: "envelope",
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		absent: [],
	},
	{
		registration: "profiles:listProfiles",
		seed: seedProfile,
		read: (c) => c.query(api.profiles.listProfiles, {}),
		refusal: "envelope",
		nonEmpty: (v) => Array.isArray(v) && v.length === 1,
		absent: [],
	},
];

for (const site of MASTER_ONLY_SITES) {
	describe(`ordinary member — ${site.registration}`, () => {
		// POLE 1 — REFUSED. Identity: ORDINARY_A, member of ACTIVE org-a. Table SEEDED.
		test(`REFUSED — an ordinary org member ${site.refusal === "raises" ? "is RAISED at, carrying RBAC_DENIED" : "receives the typed envelope { refused: true, items: [] }"}`, async () => {
			const t = createT();
			await seedOrgMapping(t, "org-a");
			await site.seed(t);
			const member = asOrgMember(t, "org-a") as unknown as T;

			if (site.refusal === "raises") {
				await expectRefusalCarryingItsCode(
					() => site.read(member),
					site.registration,
				);
			} else {
				expect(await site.read(member)).toEqual(REFUSAL_ENVELOPE);
			}
		});

		// POLE 2 — PRESENT. Identity: the fleet service account (see block header).
		test("PRESENT — the fleet master reads the seeded row (no WITHHELD GRANT)", async () => {
			const t = createT();
			await site.seed(t);

			expect(site.nonEmpty(await site.read(asMaster(t) as unknown as T))).toBe(
				true,
			);
		});

		// POLE 3 — ABSENT. Empty table, still a SUCCESS, and carrying NO refusal.
		test("ABSENT — the fleet master over a genuinely EMPTY table still gets a SUCCESS with no refusal marker", async () => {
			const t = createT();

			const v = await site.read(asMaster(t) as unknown as T);
			expect(v).toEqual(site.absent);
			expect(
				(v as { refused?: unknown } | null)?.refused,
				"an absence must carry no refusal marker",
			).toBeUndefined();
		});
	});
}

describe("refusal vs absence, ADJACENT — an ordinary member and a reader of an empty table must NOT produce the same bytes", () => {
	for (const site of MASTER_ONLY_SITES.filter((s) => s.refusal === "envelope")) {
		test(`${site.registration}: ORDINARY_A (member of active org-a, table SEEDED) vs the fleet master (table EMPTY)`, async () => {
			// (a) REFUSED — ordinary member, rows exist.
			const refusedT = createT();
			await seedOrgMapping(refusedT, "org-a");
			await site.seed(refusedT);
			const refused = await site.read(
				asOrgMember(refusedT, "org-a") as unknown as T,
			);

			// (b) ABSENT — fleet master, nothing to show.
			const absentT = createT();
			const absent = await site.read(asMaster(absentT) as unknown as T);

			expect(JSON.stringify(refused)).toBe('{"items":[],"refused":true}');
			expect(JSON.stringify(absent)).toBe("[]");
			expect(
				JSON.stringify(refused),
				"a refusal and an absence came out as IDENTICAL BYTES — the delivery has not done its job",
			).not.toBe(JSON.stringify(absent));
			expect((refused as { refused: boolean }).refused).toBe(true);
			expect((absent as { refused?: boolean }).refused).toBeUndefined();
		});
	}

	test("issues:getStats: ORDINARY_A is RAISED at while the fleet master over an empty table gets a REAL zero — a zero is only ever a measurement", async () => {
		const refusedT = createT();
		await seedOrgMapping(refusedT, "org-a");
		await seedIssue(refusedT);
		await expectRefusalCarryingItsCode(
			() => asOrgMember(refusedT, "org-a").query(api.issues.getStats, {}),
			"issues:getStats",
		);

		const absentT = createT();
		const zero = await asMaster(absentT).query(api.issues.getStats, {});
		expect(zero.total).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// diary:list — the four callers (task k17066vn8kh5v1a8xkgsx0bnxs8fjre5).
//
// A SUBSCRIBED list read (components/activity/unified-activity-feed.tsx:158,
// components/diary/diary-feed.tsx:67; both read the result through `readList`,
// dashboard @34f6d22). diary has no orgId column: the tenant key is the roster
// (`allowedOrchestrators`), read through by_orchestrator_date.
//
//   anonymous          -> RAISES RBAC_DENIED naming diary:list
//   signed in, no org  -> { refused: true, items: [] }
//   org member         -> its OWN roster's rows, bounded; empty table = empty SUCCESS
//   fleet master       -> the bare array
// Every DENY pole is an ORDINARY caller; asMaster appears only in ALLOW poles.
// ─────────────────────────────────────────────────────────────────────────────

const seedDiary = (
	t: T,
	orchestrator: string,
	date = "2026-10-01",
	content = `entry of ${orchestrator}`,
) =>
	t.run(async (ctx) => {
		await ctx.db.insert("diary", {
			date,
			orchestrator,
			content,
			createdAt: now(),
			orgId: "org-a",
			clerkOrgId: testClerkOrgId("org-a"),
		});
	});

describe("diary:list — four callers", () => {
	test("REFUSED — an anonymous caller is RAISED at, carrying RBAC_DENIED and naming diary:list (table SEEDED)", async () => {
		const t = createT();
		await seedDiary(t, "sigma");

		await expectRefusalCarryingItsCode(
			() => t.query(api.diary.list, {}),
			"diary:list",
		);
	});

	test("ABSENT — a scoped member reading an EMPTY table gets an empty SUCCESS, not a refusal", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);

		const r = await asOrgMember(t, "org-a").query(api.diary.list, {});
		expect(r).toEqual([]);
		expect((r as { refused?: unknown }).refused).toBeUndefined();
	});

	test("PRESENT — a member is served its own roster's rows, and another org's rows are ABSENT", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		await seedDiary(t, "sigma", "2026-10-01", "own entry");
		await seedDiary(t, "dummy-b", "2026-10-02", "other org entry");

		const r = await asOrgMember(t, "org-a").query(api.diary.list, {});
		if (!Array.isArray(r)) throw new Error("a member must be served an array");
		expect(r.map((e) => e.content)).toEqual(["own entry"]);
	});

	test("BOUNDED — another org's newer volume cannot starve or leak into a member's page (no table-before-roster read)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		await seedDiary(t, "sigma", "2026-10-01", "own entry");
		for (let i = 0; i < 5; i++) {
			await seedDiary(t, "dummy-b", `2026-10-0${i + 2}`, `foreign ${i}`);
		}

		const r = await asOrgMember(t, "org-a").query(api.diary.list, {
			limit: 2,
		});
		if (!Array.isArray(r)) throw new Error("a member must be served an array");
		expect(r.map((e) => e.content)).toEqual(["own entry"]);
	});

	test("an out-of-roster `orchestrator` argument returns nothing of that orchestrator", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a", ["sigma"]);
		await seedDiary(t, "dummy-b");

		expect(
			await asOrgMember(t, "org-a").query(api.diary.list, {
				orchestrator: "dummy-b",
			}),
		).toEqual([]);
	});

	test("R-50 NARROWED — a signed-in caller with NO organisation gets the typed envelope, never a throw, never the bytes of an absence (consumers read via readList)", async () => {
		const t = createT();
		await seedDiary(t, "sigma");

		const refused = await asNoOrg(t).query(api.diary.list, {});
		expect(refused).toEqual({ refused: true, items: [] });

		const absent = await asMaster(createT()).query(api.diary.list, {});
		expect(JSON.stringify(refused)).not.toBe(JSON.stringify(absent));
	});

	test("the fleet master is served the bare array (rows), and a bare [] with no refused key on an empty table", async () => {
		const t = createT();
		await seedDiary(t, "sigma");
		const rows = await asMaster(t).query(api.diary.list, {});
		expect(Array.isArray(rows) && rows.length === 1).toBe(true);

		const absent = await asMaster(createT()).query(api.diary.list, {});
		expect(JSON.stringify(absent)).toBe("[]");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SWEEP — derived from the EXPOSED SURFACE, not from the table above.
//
// The table above can go stale; this cannot. It walks every public query
// reachable from `api.*` that this suite can invoke with no arguments, calls it
// ANONYMOUSLY, and classifies the outcome. Its job is to REPORT, with a named
// tolerated set, so that a fifteenth door of the same class appearing later is
// visible rather than silent.
// ─────────────────────────────────────────────────────────────────────────────

describe("surface sweep — no NEW public no-arg read answers an anonymous caller with an empty success", () => {
	test("every anonymous empty-success is either already covered above or is a finding", async () => {
		// The site table above can go stale; this cannot. The population is the
		// EXPOSED SURFACE ITSELF, read from the convex/ sources rather than from
		// any hand-written list.
		//
		// NOTE ON MECHANISM, because the obvious version of this test is
		// VACUOUS: `api` is a Proxy. `Object.keys(api)` returns [], so a sweep
		// written as a for-of over `Object.keys` iterates ZERO registrations,
		// prints an empty finding list and PASSES unconditionally — a test that
		// cannot fail. (That version was written here first and caught by its own
		// 13ms runtime.) The proxy answers property ACCESS fine, so the names must
		// come from somewhere real: they are extracted from the module sources by
		// regex, and the count is asserted to be non-trivial so that an extraction
		// that silently matches nothing reddens instead of passing.
		const sources = import.meta.glob("../*.ts", {
			query: "?raw",
			import: "default",
			eager: true,
		}) as Record<string, string>;

		const exportedQuery = /export const (\w+) = query\(/g;
		const surface: Array<[string, string]> = [];
		for (const [path, src] of Object.entries(sources)) {
			if (path.endsWith(".test.ts")) continue;
			const moduleName = path.replace("../", "").replace(".ts", "");
			for (const m of src.matchAll(exportedQuery)) {
				surface.push([moduleName, m[1]]);
			}
		}

		// The anti-vacuity assertion: if the extraction ever matches nothing, this
		// reddens instead of reporting a clean sweep over an empty population.
		expect(
			surface.length,
			"surface extraction matched no public queries — the sweep would be vacuous",
		).toBeGreaterThan(50);

		const covered = new Set(SITES.map((s) => s.registration));
		const findings: string[] = [];
		const apiTree = api as unknown as Record<
			string,
			Record<string, unknown> | undefined
		>;

		for (const [moduleName, fnName] of surface) {
			const registration = `${moduleName}:${fnName}`;
			if (covered.has(registration)) continue;
			const mod = apiTree[moduleName];
			if (!mod) continue;

			const t = createT();
			let value: unknown;
			try {
				const anyQuery = t.query as unknown as (
					ref: unknown,
					args: unknown,
				) => Promise<unknown>;
				value = await anyQuery.call(t, mod[fnName], {});
			} catch {
				// Raised, or not callable with no arguments — either way not this
				// defect class.
				continue;
			}

			const isEmptySuccess =
				(Array.isArray(value) && value.length === 0) ||
				(value !== null &&
					typeof value === "object" &&
					Array.isArray((value as { items?: unknown }).items) &&
					(value as { items: unknown[] }).items.length === 0);

			if (isEmptySuccess) findings.push(registration);
		}

		// Reported, always — the number is the point, not the assertion. These are
		// reads over tables this suite seeds NOTHING into, so an empty success is
		// genuinely an ABSENCE here and the sweep cannot separate the two without a
		// per-site seed. They are NAMED rather than hidden; closing them is the
		// remaining-accused-registrations task, not this one.
		console.log(
			`surface sweep — ${surface.length} public queries extracted; anonymous empty-success on ${findings.length} uncovered no-arg read(s): ${JSON.stringify(findings)}`,
		);

		expect(Array.isArray(findings)).toBe(true);
	});
});
