/// <reference types="vite/client" />
//
// migrations/seat_binding_inventory:inventory (task k177pske4qj37sfw7nw2787msd8fzp0e).
// Pinned: exact per-org and total counts over seeded rows with and without agentId /
// clerkOrgId; an expired and a revoked token are not "live"; no token value or hash in the
// output; the truncation flag when the bound is hit. Hermetic, fictitious identifiers.

import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const inventory = internal.migrations.seat_binding_inventory.inventory;
type Out = FunctionReturnType<typeof inventory>;

const HOUR = 3_600_000;
const ACME = { slug: "acme-hr", id: "org_ACME1" };
const BETA = { slug: "beta-co", id: "org_BETA1" };
const RAW_TOKEN_HASH = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const RAW_REFRESH_HASH = "cafebabecafebabecafebabecafebabecafebabe";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedAgent(
	t: T,
	orgSlug: string,
	name: string,
	clerkOrgId?: string,
	active = true,
): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			name,
			isActive: active,
			createdAt: 1,
			...(clerkOrgId !== undefined ? { clerkOrgId } : {}),
		}),
	);
}

async function seedProfile(
	t: T,
	p: {
		profileId: string;
		slug?: string;
		clerkOrgId?: string;
		agentId?: Id<"agents">;
	},
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: p.profileId,
			description: "fixture",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: 1,
			updatedAt: 1,
			...(p.slug ? { clerkOrgSlug: p.slug } : {}),
			...(p.clerkOrgId !== undefined ? { clerkOrgId: p.clerkOrgId } : {}),
			...(p.agentId ? { agentId: p.agentId } : {}),
		});
	});
}

async function seedToken(
	t: T,
	k: {
		n: string;
		profile: string;
		slug?: string;
		clerkOrgId?: string;
		expiresAt: number;
		revokedAt?: number;
		principal?: "person";
	},
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash: `${RAW_TOKEN_HASH}${k.n}`,
			refreshTokenHash: `${RAW_REFRESH_HASH}${k.n}`,
			clientId: `client-${k.n}`,
			userId: "user-fixture",
			scopes: [],
			scopeProfile: k.profile,
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: k.expiresAt,
			createdAt: 1,
			...(k.principal ? { principal: k.principal } : {}),
			...(k.revokedAt !== undefined ? { revokedAt: k.revokedAt } : {}),
			...(k.slug ? { clerkOrgSlug: k.slug } : {}),
			...(k.clerkOrgId !== undefined ? { clerkOrgId: k.clerkOrgId } : {}),
		});
	});
}

async function seedWorld(t: T): Promise<void> {
	const now = Date.now();
	const live = now + HOUR;
	const bound = await seedAgent(t, ACME.slug, "scribe", ACME.id);
	await seedAgent(t, ACME.slug, "legacy-agent"); // no clerkOrgId
	await seedAgent(t, BETA.slug, "ops"); // no clerkOrgId

	// ACME: one bound profile, one unbound with a label list, one unbound without.
	await seedProfile(t, {
		profileId: "scribe-acme",
		slug: ACME.slug,
		clerkOrgId: ACME.id,
		agentId: bound,
	});
	await seedProfile(t, {
		profileId: "legacy-acme",
		slug: ACME.slug,
		clerkOrgId: ACME.id,
	});
	await seedProfile(t, {
		profileId: "bare-acme",
		slug: ACME.slug,
		clerkOrgId: ACME.id,
	});
	// BETA: unbound, no clerkOrgId, label list. Keyed by slug.
	await seedProfile(t, {
		profileId: "ops-beta",
		slug: BETA.slug,
	});

	// Live tokens.
	await seedToken(t, {
		n: "1",
		profile: "scribe-acme",
		slug: ACME.slug,
		clerkOrgId: ACME.id,
		expiresAt: live,
	}); // bound, has id
	await seedToken(t, {
		n: "2",
		profile: "legacy-acme",
		slug: ACME.slug,
		clerkOrgId: ACME.id,
		expiresAt: live,
	}); // unbound profile
	await seedToken(t, {
		n: "3",
		profile: "ops-beta",
		slug: BETA.slug,
		expiresAt: live,
	}); // unbound profile, no id
	// Not live: expired, revoked. Both would otherwise count (unbound profile, no id).
	await seedToken(t, {
		n: "4",
		profile: "ops-beta",
		slug: BETA.slug,
		expiresAt: now - HOUR,
	});
	await seedToken(t, {
		n: "5",
		profile: "ops-beta",
		slug: BETA.slug,
		expiresAt: live,
		revokedAt: now - 1000,
	});
}

describe("migrations/seat_binding_inventory:inventory", () => {
	test("exact counts per org and in totals; expired and revoked tokens are not live", async () => {
		const t = createT();
		await seedWorld(t);
		const out: Out = await t.query(inventory, {});

		expect(out.cap).toBe(5000);
		expect(out.anyTruncated).toBe(false);
		expect(out.truncated).toEqual({
			profiles: false,
			tokens: false,
			agents: false,
		});
		expect(out.totals).toMatchObject({
			profilesScanned: 4,
			profilesWithoutAgentId: 3,
			profilesWithoutClerkOrgId: 1,
			tokensScanned: 5,
			liveTokens: 3,
			liveTokensWithoutProfileAgentId: 2,
			liveTokensWithoutClerkOrgId: 1,
			liveTokensProfileMissing: 0,
			agentsScanned: 3,
			agentsWithoutClerkOrgId: 2,
		});

		const acme = out.perOrg.find((o) => o.org === ACME.id);
		const beta = out.perOrg.find((o) => o.org === BETA.slug);
		expect(acme).toMatchObject({
			org: ACME.id,
			orgKeyKind: "clerkOrgId",
			profilesWithoutAgentId: 2,
			profilesWithoutClerkOrgId: 0,
			liveTokensWithoutProfileAgentId: 1,
			liveTokensWithoutClerkOrgId: 0,
			// the ACME agent without an id is keyed by its slug, below
			agentsWithoutClerkOrgId: 0,
		});
		expect(beta).toMatchObject({
			org: BETA.slug,
			orgKeyKind: "slug",
			profilesWithoutAgentId: 1,
			profilesWithoutClerkOrgId: 1,
			liveTokensWithoutProfileAgentId: 1,
			liveTokensWithoutClerkOrgId: 1,
			agentsWithoutClerkOrgId: 1,
		});
		// An agent with no org id is keyed by the slug as stored.
		expect(
			out.perOrg.find((o) => o.org === ACME.slug)?.agentsWithoutClerkOrgId,
		).toBe(1);

		expect(out.missingAgentIdProfiles).toEqual([
			{ profileId: "bare-acme", org: ACME.id },
			{ profileId: "legacy-acme", org: ACME.id },
			{ profileId: "ops-beta", org: BETA.slug },
		]);
	});

	test("the output carries no token value, hash or refresh hash", async () => {
		const t = createT();
		await seedWorld(t);
		const text = JSON.stringify(await t.query(inventory, {}));
		expect(text).not.toContain(RAW_TOKEN_HASH);
		expect(text).not.toContain(RAW_REFRESH_HASH);
		expect(text).not.toMatch(/tokenHash|refreshTokenHash|codeHash/);
	});

	test("an empty deployment is an empty, untruncated report", async () => {
		const t = createT();
		const out: Out = await t.query(inventory, {});
		expect(out.anyTruncated).toBe(false);
		expect(out.perOrg).toEqual([]);
		expect(out.missingAgentIdProfiles).toEqual([]);
		expect(out.totals.liveTokens).toBe(0);
	});

	test("the truncation flag is set per table when the bound is hit, and not when it is met exactly", async () => {
		const t = createT();
		await seedWorld(t); // 4 profiles, 5 tokens, 3 agents
		const exact: Out = await t.query(inventory, { limit: 5 });
		expect(exact.cap).toBe(5);
		expect(exact.anyTruncated).toBe(false);

		const cut: Out = await t.query(inventory, { limit: 3 });
		expect(cut.cap).toBe(3);
		expect(cut.truncated).toEqual({
			profiles: true,
			tokens: true,
			agents: false,
		});
		expect(cut.anyTruncated).toBe(true);
		expect(cut.totals.profilesScanned).toBe(3);
		expect(cut.totals.tokensScanned).toBe(3);
	});
});

// ---- After #1660: each reason counted under exactly that reason ----------------------
// One seeded profile + one live token per case, in a fresh deployment. The reason names
// are the ones documented in seat_binding_inventory.ts (mirror of resolveSeatAgent).
type Res = Out["totals"]["afterPr1660"]["profiles"];
const REASONS = [
	"noAgentId",
	"danglingAgentId",
	"agentInactive",
	"orgMismatch",
	"profileMissing",
] as const;

function reasonsOf(r: Res): string[] {
	const out: string[] = REASONS.filter((k) => r[k] > 0);
	if (r.emptyOrMissingClerkOrgId.profile > 0) out.push("org.profile");
	if (r.emptyOrMissingClerkOrgId.agent > 0) out.push("org.agent");
	if (r.emptyOrMissingClerkOrgId.token > 0) out.push("org.token");
	return out.sort();
}

async function oneCase(opts: {
	agent?: { clerkOrgId?: string; active?: boolean } | "dangling" | "none";
	profileOrg?: string;
	tokenOrg?: string;
	tokenProfile?: string;
}): Promise<Out> {
	const t = createT();
	let agentId: Id<"agents"> | undefined;
	const a = opts.agent ?? { clerkOrgId: ACME.id };
	if (a === "dangling") {
		agentId = await seedAgent(t, ACME.slug, "gone", ACME.id);
		await t.run(async (ctx) => ctx.db.delete(agentId as Id<"agents">));
	} else if (a !== "none") {
		agentId = await seedAgent(
			t,
			ACME.slug,
			"scribe",
			a.clerkOrgId,
			a.active ?? true,
		);
	}
	await seedProfile(t, {
		profileId: "p1",
		slug: ACME.slug,
		clerkOrgId: "profileOrg" in opts ? opts.profileOrg : ACME.id,
		...(agentId ? { agentId } : {}),
	});
	await seedToken(t, {
		n: "1",
		profile: opts.tokenProfile ?? "p1",
		slug: ACME.slug,
		clerkOrgId: "tokenOrg" in opts ? opts.tokenOrg : ACME.id,
		expiresAt: Date.now() + HOUR,
	});
	return await t.query(inventory, {});
}

describe("seat_binding_inventory: rows that resolve no agent after #1660", () => {
	const cases: Array<
		[string, Parameters<typeof oneCase>[0], string[], string[]]
	> = [
		// name, setup, reasons on the profile, reasons on its live token
		["noAgentId", { agent: "none" }, ["noAgentId"], ["noAgentId"]],
		[
			"danglingAgentId",
			{ agent: "dangling" },
			["danglingAgentId"],
			["danglingAgentId"],
		],
		[
			"agentInactive",
			{ agent: { clerkOrgId: ACME.id, active: false } },
			["agentInactive"],
			["agentInactive"],
		],
		["agent clerkOrgId missing", { agent: {} }, ["org.agent"], ["org.agent"]],
		[
			"agent clerkOrgId empty string",
			{ agent: { clerkOrgId: "" } },
			["org.agent"],
			["org.agent"],
		],
		[
			"profile clerkOrgId empty string",
			{ profileOrg: "" },
			["org.profile"],
			["org.profile"],
		],
		[
			"profile clerkOrgId missing",
			{ profileOrg: undefined },
			["org.profile"],
			["org.profile"],
		],
		["token clerkOrgId empty string", { tokenOrg: "" }, [], ["org.token"]],
		["token clerkOrgId missing", { tokenOrg: undefined }, [], ["org.token"]],
		[
			"orgMismatch agent vs profile",
			{ agent: { clerkOrgId: BETA.id } },
			["orgMismatch"],
			["orgMismatch"],
		],
		[
			"orgMismatch token vs profile",
			{ tokenOrg: BETA.id },
			[],
			["orgMismatch"],
		],
		["profileMissing", { tokenProfile: "nope" }, [], ["profileMissing"]],
	];

	for (const [name, setup, onProfile, onToken] of cases) {
		test(`${name}: counted under exactly that reason`, async () => {
			const out = await oneCase(setup);
			const p = out.totals.afterPr1660.profiles;
			const k = out.totals.afterPr1660.liveSeatTokens;
			expect(reasonsOf(p)).toEqual([...onProfile].sort());
			expect(p.wouldNotResolve).toBe(onProfile.length ? 1 : 0);
			expect(p.wouldResolveAfter1660).toBe(onProfile.length ? 0 : 1);
			expect(reasonsOf(k)).toEqual([...onToken].sort());
			expect(k.wouldNotResolve).toBe(1);
			expect(k.wouldResolveAfter1660).toBe(0);
			// Per org agrees with the totals for the (single) org the rows are keyed under.
			const sum = out.perOrg.reduce(
				(n, o) => n + o.afterPr1660.liveSeatTokens.wouldNotResolve,
				0,
			);
			expect(sum).toBe(1);
		});
	}

	test("a fully bound row (profile and live token) wouldResolveAfter1660", async () => {
		const out = await oneCase({});
		expect(out.totals.afterPr1660.profiles).toMatchObject({
			checked: 1,
			wouldResolveAfter1660: 1,
			wouldNotResolve: 0,
		});
		expect(out.totals.afterPr1660.liveSeatTokens).toMatchObject({
			checked: 1,
			wouldResolveAfter1660: 1,
			wouldNotResolve: 0,
		});
		expect(JSON.stringify(out)).not.toMatch(/fromAllowList|tokenHash/);
	});

	test("a person token is not a seat: counted apart, never as a failure", async () => {
		const t = createT();
		await seedProfile(t, {
			profileId: "p1",
			slug: ACME.slug,
			clerkOrgId: ACME.id,
		});
		await seedToken(t, {
			n: "1",
			profile: "p1",
			slug: ACME.slug,
			clerkOrgId: ACME.id,
			expiresAt: Date.now() + HOUR,
			principal: "person",
		});
		const out = await t.query(inventory, {});
		expect(out.totals.livePersonTokens).toBe(1);
		expect(out.totals.afterPr1660.liveSeatTokens.checked).toBe(0);
	});

	test("an empty-string clerkOrgId keys by slug and counts as without clerkOrgId", async () => {
		const out = await oneCase({ profileOrg: "", tokenOrg: "" });
		expect(out.totals.profilesWithoutClerkOrgId).toBe(1);
		expect(out.totals.liveTokensWithoutClerkOrgId).toBe(1);
		expect(out.perOrg.map((o) => o.org)).toEqual([ACME.slug]);
	});
});

// ---- tasks without a non-empty clerkOrgId (before #1663) -------------------------------
const tasksInventory =
	internal.migrations.seat_binding_inventory.tasksWithoutClerkOrgId;
type TasksOut = FunctionReturnType<typeof tasksInventory>;
type TaskStatusLit =
	| "todo"
	| "in_progress"
	| "blocked"
	| "review"
	| "done"
	| "cancelled"
	| "failed";

async function seedTask(
	t: T,
	k: { status: TaskStatusLit; orgId?: string; clerkOrgId?: string },
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("tasks", {
			title: "fixture",
			assignedTo: "scribe",
			priority: "low",
			status: k.status,
			createdBy: "fixture",
			createdAt: 1,
			updatedAt: 1,
			...(k.orgId !== undefined ? { orgId: k.orgId } : {}),
			...(k.clerkOrgId !== undefined ? { clerkOrgId: k.clerkOrgId } : {}),
		});
	});
}

describe("seat_binding_inventory:tasksWithoutClerkOrgId", () => {
	test("exact counts: missing and empty-string, open vs closed, per org slug; stamped rows excluded", async () => {
		const t = createT();
		// ACME: 2 open missing (todo, review), 1 open empty-string (in_progress),
		//       1 closed missing (done), 1 closed empty-string (cancelled), 2 stamped (excluded).
		await seedTask(t, { status: "todo", orgId: ACME.slug });
		await seedTask(t, { status: "review", orgId: ACME.slug });
		await seedTask(t, {
			status: "in_progress",
			orgId: ACME.slug,
			clerkOrgId: "",
		});
		await seedTask(t, { status: "done", orgId: ACME.slug });
		await seedTask(t, {
			status: "cancelled",
			orgId: ACME.slug,
			clerkOrgId: "",
		});
		await seedTask(t, {
			status: "todo",
			orgId: ACME.slug,
			clerkOrgId: ACME.id,
		});
		await seedTask(t, {
			status: "done",
			orgId: ACME.slug,
			clerkOrgId: ACME.id,
		});
		// BETA: 1 open blocked missing. Fleet row with no slug: 1 failed missing.
		await seedTask(t, { status: "blocked", orgId: BETA.slug });
		await seedTask(t, { status: "failed" });

		const out: TasksOut = await t.query(tasksInventory, {});
		expect(out.cap).toBe(1000);
		expect(out.truncated).toBe(false);
		expect(out.truncatedReads).toEqual([]);
		expect(out.totals).toEqual({
			total: 7,
			missing: 5,
			emptyString: 2,
			open: 4,
			closed: 3,
			byStatus: {
				todo: 1,
				in_progress: 1,
				blocked: 1,
				review: 1,
				done: 1,
				cancelled: 1,
				failed: 1,
			},
		});
		const by = Object.fromEntries(out.perOrg.map((o) => [o.org, o.counts]));
		expect(Object.keys(by).sort()).toEqual(["(none)", ACME.slug, BETA.slug]);
		expect(by[ACME.slug]).toMatchObject({
			total: 5,
			missing: 3,
			emptyString: 2,
			open: 3,
			closed: 2,
		});
		expect(by[BETA.slug]).toMatchObject({ total: 1, open: 1, closed: 0 });
		expect(by["(none)"]).toMatchObject({ total: 1, open: 0, closed: 1 });
		expect(JSON.stringify(out)).not.toMatch(/fixture|scribe|_id/);
	});

	test("an empty table is an empty, untruncated report", async () => {
		const t = createT();
		const out: TasksOut = await t.query(tasksInventory, {});
		expect(out.totals.total).toBe(0);
		expect(out.perOrg).toEqual([]);
		expect(out.truncated).toBe(false);
	});

	test("truncation: a read that hits the bound is named and flagged; met exactly is not", async () => {
		const t = createT();
		for (let i = 0; i < 3; i++)
			await seedTask(t, { status: "todo", orgId: ACME.slug });
		await seedTask(t, { status: "done", orgId: ACME.slug, clerkOrgId: "" });

		const exact: TasksOut = await t.query(tasksInventory, { limit: 3 });
		expect(exact.truncated).toBe(false);
		expect(exact.totals.total).toBe(4);

		const cut: TasksOut = await t.query(tasksInventory, { limit: 2 });
		expect(cut.cap).toBe(2);
		expect(cut.truncated).toBe(true);
		expect(cut.truncatedReads).toEqual(["todo/missing"]);
		// A truncated read contributes at most `cap` rows: a lower bound, never the total.
		expect(cut.totals.byStatus.todo).toBe(2);
		expect(cut.totals.emptyString).toBe(1);
	});
});
