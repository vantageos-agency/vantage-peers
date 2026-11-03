/// <reference types="vite/client" />
//
// The author ID stored on every write path the erase rule reads (task
// k170t9bg650dyw6hxjj627p9fx8hhpeq). A row is erasable by its author only when the
// author's ID was stored AT WRITE TIME from the verified caller: an agent's agents-row
// ID from the transport's proof (never from a typed label), a person's "user:<subject>".
//
//   SEAT    memories:storeMemory / episodes:storeEpisode / diary:write with a verifiedActor
//           store createdById = that agent's ID
//   PERSON  a Clerk member's row stores createdById = "user:<subject>"
//   NO PROOF a seat without a verified agent stores NO createdById (a label is not an ID)
//   OTHER ORG'S PROOF is refused before anything is written

import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api } from "../_generated/api";
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
const A = "stamp-org-a";
const B = "stamp-org-b";
const ALICE = "alice";
const BOB = "bob";

let t: T;
let agents: Record<string, Id<"agents">>;

beforeEach(async () => {
	vi.useFakeTimers();
	t = createT();
	await t.run(async (ctx) => {
		for (const [slug, roster] of [
			[A, [ALICE]],
			[B, [BOB]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [...roster],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
		}
	});
	agents = await seedRosterAgents(t);
});
afterEach(() => {
	vi.useRealTimers();
});

const service = () => t.withIdentity({ subject: SERVICE });
const seat = (org: string, agent: string) => ({
	__actingOrg: testClerkOrgId(org),
	verifiedActor: { agentId: agents[`${org}/${agent}`], orgSlug: org },
});
const rowOf = <Tn extends "memories" | "diary">(table: Tn, id: string) =>
	t.run((ctx) => ctx.db.get(id as Id<Tn>));

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

describe("the author ID is stored from the verified caller", () => {
	test("memories:storeMemory — a seat stores its verified agent ID", async () => {
		const id = await service().mutation(api.memories.storeMemory, {
			namespace: `team/${testClerkOrgId(A)}`,
			type: "project",
			content: "seat memory",
			createdBy: ALICE,
			...seat(A, ALICE),
		} as never);
		const row = await rowOf("memories", id);
		expect(row?.createdById).toBe(agents[`${A}/${ALICE}`]);
	});

	test("memories:storeMemory — a seat WITHOUT a proof stores a label and no ID", async () => {
		const id = await service().mutation(api.memories.storeMemory, {
			namespace: `team/${testClerkOrgId(A)}`,
			type: "project",
			content: "unproven seat memory",
			createdBy: ALICE,
			__actingOrg: testClerkOrgId(A),
		} as never);
		const row = await rowOf("memories", id);
		expect(row?.createdBy).toBe(ALICE);
		expect(row?.createdById).toBeUndefined();
	});

	test("memories:storeMemory — a Clerk member stores user:<subject> as its ID", async () => {
		const member = t.withIdentity({
			subject: "user_member_a",
			org_slug: A,
			org_id: testClerkOrgId(A),
			org_role: "org:member",
		} as Parameters<typeof t.withIdentity>[0]);
		const id = await member.mutation(api.memories.storeMemory, {
			namespace: `team/${testClerkOrgId(A)}`,
			type: "project",
			content: "member memory",
		} as never);
		const row = await rowOf("memories", id);
		expect(row?.createdById).toBe("user:user_member_a");
	});

	test("memories:storeMemory — another org's agent as the proof is refused and nothing is written", async () => {
		const before = (await t.run((ctx) => ctx.db.query("memories").collect())).length;
		expect(
			await code(
				service().mutation(api.memories.storeMemory, {
					namespace: `team/${testClerkOrgId(A)}`,
					type: "project",
					content: "forged",
					createdBy: ALICE,
					__actingOrg: testClerkOrgId(A),
					verifiedActor: { agentId: agents[`${B}/${BOB}`], orgSlug: B },
				} as never),
			),
		).not.toBe("SERVED");
		expect((await t.run((ctx) => ctx.db.query("memories").collect())).length).toBe(before);
	});

	test("episodes:storeEpisode — a seat stores its verified agent ID on the memories row", async () => {
		const id = await service().mutation(api.episodes.storeEpisode, {
			namespace: `team/${testClerkOrgId(A)}`,
			context: "c",
			goal: "g",
			action: "a",
			outcome: "o",
			insight: "i",
			severity: "minor",
			createdBy: ALICE,
			...seat(A, ALICE),
		} as never);
		const row = await rowOf("memories", id as string);
		expect(row?.createdById).toBe(agents[`${A}/${ALICE}`]);
	});

	test("diary:write — a seat stores its verified agent ID; no proof stores none", async () => {
		const proven = await service().mutation(api.diary.write, {
			orchestrator: ALICE,
			date: "2026-11-03",
			content: "proven",
			createdBy: ALICE,
			...seat(A, ALICE),
		} as never);
		expect((await rowOf("diary", proven))?.createdById).toBe(agents[`${A}/${ALICE}`]);
		const unproven = await service().mutation(api.diary.write, {
			orchestrator: ALICE,
			date: "2026-11-04",
			content: "unproven",
			createdBy: ALICE,
			__actingOrg: testClerkOrgId(A),
		} as never);
		expect((await rowOf("diary", unproven))?.createdById).toBeUndefined();
	});
});
