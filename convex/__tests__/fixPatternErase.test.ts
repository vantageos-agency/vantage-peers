/// <reference types="vite/client" />
//
// fixPatterns:erase -- the erase path of a fix pattern, under the same rule as
// erase:eraseRow (convex/lib/eraseRow.ts): an admin of the owning organisation erases
// any pattern, the pattern's author the patterns it wrote, everyone else is refused
// RBAC_DENIED. A fix pattern has no organisation column: it is fleet-owned, so the
// owning organisation is the OPERATOR organisation, derived from the orgKind operator
// mapping. Task k176x68sj2jkwx46nshvtt40e18ht1xh.
//
//   AUTHOR       an operator-org agent proven by verifiedActor erases its own pattern;
//                the attempts that exist only for it go with it
//   NOT AUTHOR   another operator-org agent is refused, row unchanged
//   OTHER ORG    a client-org agent as the proof is refused, row unchanged
//   NO PROOF     the fleet master bearer without a verified agent is refused
//   FLEET DOOR   the internal door erases any pattern (operator reach)
//   ABSENT       an id that names no pattern is refused, never "not found" to a stranger

import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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

const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const OP = "pattern-operator-org";
const CLIENT = "pattern-client-org";

// The erase schedules the removal of the search entry; the timer is faked so the job
// never runs after the test (it would write outside the test transaction).
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function setup(): Promise<{
	t: T;
	agents: Record<string, Id<"agents">>;
	patternId: Id<"fixPatterns">;
}> {
	const t = createT();
	await t.run(async (ctx) => {
		for (const [slug, roster, kind] of [
			[OP, ["sigma", "pi"], "operator"],
			[CLIENT, ["alice"], undefined],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [...roster],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
				...(kind === undefined ? {} : { orgKind: kind }),
			});
		}
	});
	const agents = await seedRosterAgents(t);
	const patternId = await t.run(async (ctx) => {
		const id = await ctx.db.insert("fixPatterns", {
			symptom: "s",
			rootCause: "r",
			tags: [],
			stack: [],
			sourceProject: "p",
			createdBy: "sigma",
			severity: "minor",
			createdAt: 1,
			updatedAt: 1,
		});
		await ctx.db.insert("fixAttempts", {
			patternId: id,
			description: "d",
			worked: false,
			why: "w",
			createdBy: "sigma",
			createdAt: 1,
		});
		return id;
	});
	return { t, agents, patternId };
}

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		const m = /([A-Z][A-Z_]{3,}):/.exec(text);
		return m ? m[1] : `OTHER(${text.slice(0, 160)})`;
	}
}

const patternCount = (t: T) =>
	t.run(async (ctx) => (await ctx.db.query("fixPatterns").collect()).length);
const attemptCount = (t: T) =>
	t.run(async (ctx) => (await ctx.db.query("fixAttempts").collect()).length);

describe("fixPatterns:erase", () => {
	test("the author (an operator-org agent proven by ID) erases its pattern and the attempts", async () => {
		const { t, agents, patternId } = await setup();
		const r = await t.withIdentity({ subject: SERVICE }).mutation(api.fixPatterns.erase, {
			patternId,
			verifiedActor: { agentId: agents[`${OP}/sigma`], orgSlug: OP },
		} as never);
		expect(r).toMatchObject({ patternId, erased: true, cascaded: { fixAttempts: 1 } });
		expect(await patternCount(t)).toBe(0);
		expect(await attemptCount(t)).toBe(0);
	});

	test("another operator-org agent that did not write it is refused, row unchanged", async () => {
		const { t, agents, patternId } = await setup();
		const out = await code(
			t.withIdentity({ subject: SERVICE }).mutation(api.fixPatterns.erase, {
				patternId,
				verifiedActor: { agentId: agents[`${OP}/pi`], orgSlug: OP },
			} as never),
		);
		expect(out).toBe("RBAC_DENIED");
		expect(await patternCount(t)).toBe(1);
		expect(await attemptCount(t)).toBe(1);
	});

	test("a client-org agent as the proof is refused, row unchanged", async () => {
		const { t, agents, patternId } = await setup();
		const out = await code(
			t.withIdentity({ subject: SERVICE }).mutation(api.fixPatterns.erase, {
				patternId,
				verifiedActor: { agentId: agents[`${CLIENT}/alice`], orgSlug: CLIENT },
			} as never),
		);
		expect(out).toBe("RBAC_DENIED");
		expect(await patternCount(t)).toBe(1);
	});

	test("the master bearer without a verified agent is refused, row unchanged", async () => {
		const { t, patternId } = await setup();
		const out = await code(
			t.withIdentity({ subject: SERVICE }).mutation(api.fixPatterns.erase, {
				patternId,
			} as never),
		);
		expect(out).toBe("RBAC_DENIED");
		expect(await patternCount(t)).toBe(1);
	});

	test("an anonymous caller is refused, row unchanged", async () => {
		const { t, patternId } = await setup();
		const out = await code(t.mutation(api.fixPatterns.erase, { patternId } as never));
		expect(out).toBe("RBAC_DENIED");
		expect(await patternCount(t)).toBe(1);
	});

	test("an id that names no fix pattern is refused like a pattern the caller may not erase", async () => {
		const { t, agents } = await setup();
		const out = await code(
			t.withIdentity({ subject: SERVICE }).mutation(api.fixPatterns.erase, {
				patternId: "not-a-pattern-id",
				verifiedActor: { agentId: agents[`${OP}/sigma`], orgSlug: OP },
			} as never),
		);
		expect(out).toBe("RBAC_DENIED");
	});
});

describe("fixPatterns:eraseFleet (internal)", () => {
	test("erases any pattern with its attempts", async () => {
		const { t, patternId } = await setup();
		const r = await t.mutation(internal.fixPatterns.eraseFleet, { patternId });
		expect(r).toMatchObject({ patternId, erased: true, cascaded: { fixAttempts: 1 } });
		expect(await patternCount(t)).toBe(0);
		expect(await attemptCount(t)).toBe(0);
	});
});
