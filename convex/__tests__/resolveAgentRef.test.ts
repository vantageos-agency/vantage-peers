/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * resolveAgentRef (migration step E1, task k170gke23yavvqsm5wkcg3epnn8hd59z):
 * the one helper a door will use to turn an agent reference into an `agents`
 * row. No door calls it yet; these poles pin the helper alone.
 *
 *   ID              loaded by ID; must be active and stamped with the caller's
 *                   verified org (permanent clerkOrgId, never the slug).
 *   ID + label      the label must be the row's CURRENT label under
 *                   normalizeOrchestratorId, else AGENT_IDENTITY_MISMATCH with
 *                   reason "id-label-mismatch" and the door name.
 *   label only      exactly findAgentByName, plus ONE LABEL_ONLY_DOOR log line.
 *   neither         null.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import type { Id } from "../_generated/dataModel";
import { findAgentByName, resolveAgentRef } from "../lib/agentIdentity";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const DOOR = "tasks:create";
const SLUG_A = "org-a";
const SLUG_B = "org-b";
const ORG_A_ID = testClerkOrgId("org-a-permanent");
const ORG_B_ID = testClerkOrgId("org-b-permanent");

type World = {
	t: T;
	nadiaA: Id<"agents">;
	brunoA: Id<"agents">;
	nadiaB: Id<"agents">;
	retiredA: Id<"agents">;
};

async function world(): Promise<World> {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		for (const [slug, id] of [
			[SLUG_A, ORG_A_ID],
			[SLUG_B, ORG_B_ID],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
		}
		const agent = (slug: string, org: string, name: string, isActive = true) =>
			ctx.db.insert("agents", {
				orgSlug: slug,
				clerkOrgId: org,
				name,
				normalizedName: name.toLowerCase(),
				isActive,
				createdAt: 1,
			});
		return {
			nadiaA: await agent(SLUG_A, ORG_A_ID, "Nadia"),
			brunoA: await agent(SLUG_A, ORG_A_ID, "bruno"),
			nadiaB: await agent(SLUG_B, ORG_B_ID, "Nadia"),
			retiredA: await agent(SLUG_A, ORG_A_ID, "old-timer", false),
		};
	});
	return { t, ...ids };
}

type Ref = { agentId?: string; label?: string };
const resolve = (w: World, ref: Ref, org: string = ORG_A_ID) =>
	w.t.run(async (ctx) => {
		const row = await resolveAgentRef(ctx, {
			...ref,
			orgClerkId: org,
			door: DOOR,
			arg: "assignedTo",
		});
		return row?._id ?? null;
	});

const refusal = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (e) {
		const err = e as { data?: unknown; message?: string };
		return typeof err.data === "string" ? err.data : String(err.message);
	}
	return "NO-REFUSAL";
};

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	logSpy.mockRestore();
});
const labelOnlyLines = () =>
	logSpy.mock.calls
		.map((c) => String(c[0]))
		.filter((line) => line.includes("LABEL_ONLY_DOOR"));

describe("resolveAgentRef: an agent ID is proved against the caller's org", () => {
	test("ALLOW: the ID of an active agent of the caller's org resolves that row", async () => {
		const w = await world();
		expect(await resolve(w, { agentId: w.nadiaA })).toBe(w.nadiaA);
		expect(labelOnlyLines()).toHaveLength(0);
	});

	test("REFUSE: the ID of an agent of ANOTHER org is refused, never returned, never null", async () => {
		const w = await world();
		const got = await refusal(resolve(w, { agentId: w.nadiaB }));
		expect(got).toMatch(/^ORG_MISMATCH/);
	});

	test("REFUSE: the ID of an inactive (retired) agent is refused", async () => {
		const w = await world();
		const got = await refusal(resolve(w, { agentId: w.retiredA }));
		expect(got).toMatch(/^VERIFIED_ACTOR_INACTIVE/);
	});

	test("REFUSE: a string that is not an agents ID is a typed refusal, not a lookup", async () => {
		const w = await world();
		const got = await refusal(resolve(w, { agentId: "nadia" }));
		expect(got).toContain("is not a valid agents ID");
	});

	test("REFUSE: the org is the verified ID; the slug an agent row stores does not stand in", async () => {
		const w = await world();
		// org B's verified ID against org A's agent: refused.
		const got = await refusal(resolve(w, { agentId: w.nadiaA }, ORG_B_ID));
		expect(got).toMatch(/^ORG_MISMATCH/);
	});
});

describe("resolveAgentRef: ID and label together", () => {
	test("ALLOW: the label equal to the row's label (case-insensitive) is admitted", async () => {
		const w = await world();
		expect(await resolve(w, { agentId: w.nadiaA, label: "NADIA" })).toBe(w.nadiaA);
		expect(labelOnlyLines()).toHaveLength(0);
	});

	test("REFUSE: a label naming another in-org agent -> AGENT_IDENTITY_MISMATCH, reason id-label-mismatch, door named", async () => {
		const w = await world();
		const got = await refusal(resolve(w, { agentId: w.nadiaA, label: "bruno" }));
		expect(got).toMatch(/^AGENT_IDENTITY_MISMATCH/);
		const payload = JSON.parse(got.slice(got.lastIndexOf("— ") + 2));
		expect(payload).toMatchObject({
			reason: "id-label-mismatch",
			door: DOOR,
			agentId: w.nadiaA,
		});
	});
});

describe("resolveAgentRef: label only is the legacy path, measured", () => {
	test("ALLOW: resolves exactly the row findAgentByName resolves", async () => {
		const w = await world();
		const direct = await w.t.run(
			async (ctx) =>
				(await findAgentByName(ctx, SLUG_A, "bruno", ORG_A_ID))?._id ?? null,
		);
		expect(direct).toBe(w.brunoA);
		expect(await resolve(w, { label: "bruno" })).toBe(direct);
	});

	test("ALLOW: the same label in another org resolves to that org's own agent", async () => {
		const w = await world();
		expect(await resolve(w, { label: "Nadia" })).toBe(w.nadiaA);
		expect(await resolve(w, { label: "Nadia" }, ORG_B_ID)).toBe(w.nadiaB);
	});

	test("ABSENT: an unknown label resolves null (unchanged legacy behaviour)", async () => {
		const w = await world();
		expect(await resolve(w, { label: "nobody" })).toBeNull();
	});

	test("emits exactly one LABEL_ONLY_DOOR line per call, with door and arg and no label value", async () => {
		const w = await world();
		await resolve(w, { label: "bruno" });
		const lines = labelOnlyLines();
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed).toMatchObject({
			event: "LABEL_ONLY_DOOR",
			door: DOOR,
			arg: "assignedTo",
		});
		expect(lines[0]).not.toContain("bruno");
		expect(Object.keys(parsed).sort()).toEqual(["arg", "door", "event"]);
	});

	test("an unknown label is still measured (the door took the label path)", async () => {
		const w = await world();
		await resolve(w, { label: "nobody" });
		expect(labelOnlyLines()).toHaveLength(1);
	});
});

describe("resolveAgentRef: neither", () => {
	test("returns null and logs nothing", async () => {
		const w = await world();
		expect(await resolve(w, {})).toBeNull();
		expect(labelOnlyLines()).toHaveLength(0);
	});
});
