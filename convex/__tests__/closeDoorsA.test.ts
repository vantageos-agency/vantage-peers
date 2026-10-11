/// <reference types="vite/client" />
/**
 * closeDoorsA — public reads that served rows to a caller presenting NO
 * CREDENTIAL AT ALL now consult the verified caller.
 *
 * CLOSED-a (org/roster-scoped: an ordinary member is STILL SERVED its own data)
 *   diary:get, diary:listByDateRange, businessUnits:get
 * CLOSED-b (fleet-internal table, no org column: master only)
 *   fixPatterns:get / listByProject / listByStack
 *   errorMonitor:listDeployments / getError
 *   errorMonitorFilters:getPendingAliasReleases
 *   issues:getByRepoNumber / listByProject / listByOrchestrator
 *
 * Every DENY pole is an ORDINARY caller; `asMaster` appears only in ALLOW poles.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
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

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const MEMBER_A = "ordinary-member-of-org-a";
const MEMBER_B = "ordinary-member-of-org-b";
const NO_ORG = "ordinary-signed-in-user-with-no-org";

for (const subject of [MEMBER_A, MEMBER_B, NO_ORG]) {
	if (subject === SERVICE_ACCOUNT_USER_ID) {
		throw new Error(`test-integrity: ${subject} must not be the service account`);
	}
}

const asMember = (t: T, orgSlug: string, subject: string) =>
	t.withIdentity({
		subject,
		organizationId: orgSlug,
		org_id: testClerkOrgId(orgSlug),
		organizationSlug: orgSlug,
	} as Identity);
const asNoOrg = (t: T) => t.withIdentity({ subject: NO_ORG } as Identity);
const asMaster = (t: T) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Identity);

async function expectRefusal(
	read: () => Promise<unknown>,
	registration: string,
	reason: string,
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
			`${registration} returned a SUCCESS to a caller it must refuse (${reason}). Got: ${JSON.stringify(returned)}`,
		);
	}
	expect(caught, `${registration}: refusal must be a ConvexError`).toBeInstanceOf(
		ConvexError,
	);
	const data = String((caught as ConvexError<string>).data);
	expect(data, `${registration}: must carry its CODE`).toContain("RBAC_DENIED");
	expect(data, `${registration}: must name its DOOR`).toContain(registration);
	const text = data.startsWith('"') ? (JSON.parse(data) as string) : data;
	const payload = JSON.parse(text.slice(text.lastIndexOf(" — ") + 3)) as {
		registration: string;
		reason: string;
	};
	expect(payload.registration).toBe(registration);
	expect(payload.reason, `${registration}: wrong refusal reason`).toBe(reason);
}

async function seedOrg(t: T, slug: string, roster: string[]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const now = () => Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// CLOSED-a — an ordinary member is STILL SERVED its own data
// ─────────────────────────────────────────────────────────────────────────────

async function orgWorld() {
	const t = createT();
	await seedOrg(t, "org-a", ["sigma"]);
	await seedOrg(t, "org-b", ["tau"]);
	const ids = await t.run(async (ctx) => {
		const diaryA = await ctx.db.insert("diary", {
			date: "2026-09-30",
			orchestrator: "sigma",
			content: "org-a private diary",
			createdAt: now(),
			orgId: "org-a",
			clerkOrgId: testClerkOrgId("org-a"),
		});
		await ctx.db.insert("diary", {
			date: "2026-09-30",
			orchestrator: "tau",
			content: "org-b private diary",
			createdAt: now(),
			orgId: "org-b",
			clerkOrgId: testClerkOrgId("org-b"),
		});
		const buA = await ctx.db.insert("businessUnits", {
			name: "BU of org a",
			description: "d",
			purpose: "p",
			orchestratorId: "sigma",
			status: "live",
			businessModel: "m",
			targetCustomers: "c",
			services: [],
			pricing: "p",
			revenueProjections: { y1: 1, y2: 2, y3: 3 },
			coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
			coreProcesses: [],
			dependencies: [],
			kpis: [],
			managementFee: 10,
			createdAt: now(),
			updatedAt: now(),
		});
		return { diaryA, buA };
	});
	return { t, ...ids };
}

describe("diary:get (CLOSED-a, roster-scoped)", () => {
	const REG = "diary:get";
	const args = { date: "2026-09-30", orchestrator: "sigma" };

	test("anonymous + valid arguments is REFUSED with RBAC_DENIED naming its door", async () => {
		const { t } = await orgWorld();
		await expectRefusal(() => t.query(api.diary.get, args), REG, "no-credential");
	});
	test("signed in with no organisation is REFUSED", async () => {
		const { t } = await orgWorld();
		await expectRefusal(
			() => asNoOrg(t).query(api.diary.get, args),
			REG,
			"no-verified-organisation",
		);
	});
	test("ORDINARY member of org-a is STILL SERVED its own entry", async () => {
		const { t } = await orgWorld();
		const row = await asMember(t, "org-a", MEMBER_A).query(api.diary.get, args);
		expect(row?.content).toBe("org-a private diary");
	});
	test("member of a DIFFERENT org (org-b) does not get org-a's entry", async () => {
		const { t } = await orgWorld();
		const row = await asMember(t, "org-b", MEMBER_B).query(api.diary.get, args);
		expect(row).toBeNull();
	});
});

describe("diary:listByDateRange (CLOSED-a, roster-scoped)", () => {
	const REG = "diary:listByDateRange";
	const range = { from: "2026-09-01", to: "2026-09-30" };

	test("anonymous + valid arguments is REFUSED with RBAC_DENIED naming its door", async () => {
		const { t } = await orgWorld();
		await expectRefusal(
			() => t.query(api.diary.listByDateRange, range),
			REG,
			"no-credential",
		);
	});
	test("ORDINARY member of org-a is STILL SERVED its own entries, and only those", async () => {
		const { t } = await orgWorld();
		const rows = await asMember(t, "org-a", MEMBER_A).query(
			api.diary.listByDateRange,
			range,
		);
		expect(rows.map((r) => r.content)).toEqual(["org-a private diary"]);
	});
	test("member of org-b, asking for org-a's orchestrator, gets nothing of org-a", async () => {
		const { t } = await orgWorld();
		const asB = asMember(t, "org-b", MEMBER_B);
		const explicit = await asB.query(api.diary.listByDateRange, {
			...range,
			orchestrator: "sigma",
		});
		expect(explicit).toEqual([]);
		const all = await asB.query(api.diary.listByDateRange, range);
		expect(all.map((r) => r.content)).toEqual(["org-b private diary"]);
	});
	test("master still reads every entry", async () => {
		const { t } = await orgWorld();
		const rows = await asMaster(t).query(api.diary.listByDateRange, range);
		expect(rows).toHaveLength(2);
	});
});

describe("businessUnits:get (CLOSED-a, roster-scoped)", () => {
	const REG = "businessUnits:get";

	test("anonymous + valid arguments is REFUSED with RBAC_DENIED naming its door", async () => {
		const { t, buA } = await orgWorld();
		await expectRefusal(
			() => t.query(api.businessUnits.get, { buId: buA }),
			REG,
			"no-credential",
		);
	});
	test("ORDINARY member of org-a is STILL SERVED its own business unit", async () => {
		const { t, buA } = await orgWorld();
		const bu = await asMember(t, "org-a", MEMBER_A).query(api.businessUnits.get, {
			buId: buA,
		});
		expect(bu?.name).toBe("BU of org a");
	});
	test("member of a DIFFERENT org (org-b) does not get org-a's business unit", async () => {
		const { t, buA } = await orgWorld();
		const bu = await asMember(t, "org-b", MEMBER_B).query(api.businessUnits.get, {
			buId: buA,
		});
		expect(bu).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CLOSED-b — fleet-internal tables, master only
// ─────────────────────────────────────────────────────────────────────────────

async function fleetWorld() {
	const t = createT();
	await seedOrg(t, "org-a", ["sigma"]);
	const ids = await t.run(async (ctx) => {
		const fixId = await ctx.db.insert("fixPatterns", {
			symptom: "s",
			rootCause: "r",
			tags: [],
			stack: ["convex"],
			sourceProject: "proj-x",
			createdBy: "sigma",
			severity: "major",
			createdAt: now(),
			updatedAt: now(),
		});
		await ctx.db.insert("monitoredDeployments", {
			name: "dep",
			deploymentUrl: "https://example.invalid",
			deployKeyEnvVar: "K",
			githubRepo: "acme/r",
			orchestrator: "sigma",
			active: true,
			createdAt: now(),
		});
		const errId = await ctx.db.insert("errorLogs", {
			hash: "h",
			deployment: "dep",
			functionName: "f",
			errorMessage: "boom",
			firstSeen: now(),
			lastSeen: now(),
			count: 1,
		});
		await ctx.db.insert("errorMonitorConfig", {
			key: "pendingAliasReleases",
			value: ["alias-x"],
			updatedAt: now(),
		});
		await ctx.db.insert("issues", {
			repo: "acme/secret-repo",
			issueNumber: 7,
			title: "private title",
			body: "private body",
			htmlUrl: "https://example.invalid/7",
			labels: [],
			status: "open",
			priority: "high",
			assignedOrchestrator: "sigma",
			project: "secret-project",
			githubCreatedAt: now(),
			githubUpdatedAt: now(),
		});
		return { fixId, errId };
	});
	return { t, ...ids };
}

type Door = {
	reg: string;
	read: (t: ReturnType<T["withIdentity"]> | T, w: { fixId: string; errId: string }) => Promise<unknown>;
	present: (r: unknown) => boolean;
};

const nonEmpty = (r: unknown) =>
	r !== null && (Array.isArray(r) ? r.length > 0 : true);

const DOORS: Door[] = [
	{
		reg: "fixPatterns:get",
		read: (t, w) => t.query(api.fixPatterns.get, { patternId: w.fixId }),
		present: nonEmpty,
	},
	{
		reg: "fixPatterns:listByProject",
		read: (t) => t.query(api.fixPatterns.listByProject, { sourceProject: "proj-x" }),
		present: nonEmpty,
	},
	{
		reg: "fixPatterns:listByStack",
		read: (t) => t.query(api.fixPatterns.listByStack, { stack: "convex" }),
		present: nonEmpty,
	},
	{
		reg: "errorMonitor:listDeployments",
		read: (t) => t.query(api.errorMonitor.listDeployments, {}),
		present: nonEmpty,
	},
	{
		reg: "errorMonitor:getError",
		read: (t, w) => t.query(api.errorMonitor.getError, { errorId: w.errId }),
		present: nonEmpty,
	},
	{
		reg: "errorMonitorFilters:getPendingAliasReleases",
		read: (t) => t.query(api.errorMonitorFilters.getPendingAliasReleases, {}),
		present: nonEmpty,
	},
	{
		reg: "issues:getByRepoNumber",
		read: (t) =>
			t.query(api.issues.getByRepoNumber, {
				repo: "acme/secret-repo",
				issueNumber: 7,
			}),
		present: nonEmpty,
	},
	{
		reg: "issues:listByProject",
		read: (t) => t.query(api.issues.listByProject, { project: "secret-project" }),
		present: nonEmpty,
	},
	{
		reg: "issues:listByOrchestrator",
		read: (t) =>
			t.query(api.issues.listByOrchestrator, { assignedOrchestrator: "sigma" }),
		present: nonEmpty,
	},
];

for (const door of DOORS) {
	describe(`${door.reg} (CLOSED-b, master only)`, () => {
		test("anonymous + valid arguments is REFUSED with RBAC_DENIED naming its door", async () => {
			const w = await fleetWorld();
			await expectRefusal(() => door.read(w.t, w), door.reg, "no-credential");
		});
		test("signed in with no organisation is REFUSED", async () => {
			const w = await fleetWorld();
			await expectRefusal(
				() => door.read(asNoOrg(w.t), w),
				door.reg,
				"no-verified-organisation",
			);
		});
		test("ORDINARY org member is REFUSED not-fleet-master (no per-org slice exists)", async () => {
			const w = await fleetWorld();
			await expectRefusal(
				() => door.read(asMember(w.t, "org-a", MEMBER_A), w),
				door.reg,
				"not-fleet-master",
			);
		});
		test("fleet master is STILL SERVED the seeded row", async () => {
			const w = await fleetWorld();
			expect(door.present(await door.read(asMaster(w.t), w))).toBe(true);
		});
	});
}
