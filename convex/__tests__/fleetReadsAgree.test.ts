/// <reference types="vite/client" />
/**
 * Task k17a388w6d0cxmyw8gfk5tryp18hvw2k: two reads that disagreed with their own list.
 *
 *  (a) memories:listMemories required `namespace`, while list_episodes documents
 *      "the fleet master may omit it to read every namespace". The omission reached
 *      Convex as an argument-validation failure, which production redacts to
 *      "[Request ID: ...] Server Error".
 *  (b) fixPatterns:get narrowed to the verified actor's own patterns and answered a
 *      miss with null ("not found"), while fixPatterns:listAll serves the fleet every
 *      pattern. A refusal must be distinguishable from an absence.
 *
 * POLES per read: REFUSED / ABSENT / PRESENT.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

const ORG_ID = testClerkOrgId("org-a");
const asMember = (t: T) =>
	t.withIdentity({
		subject: "user_member",
		org_slug: "org-a",
		org_id: ORG_ID,
		org_role: "org:member",
	} as Parameters<typeof t.withIdentity>[0]);

async function seedOrg(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			clerkOrgId: ORG_ID,
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
	try {
		await fn();
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data : JSON.stringify(data);
	}
	throw new Error("expected a refusal, got a success");
};

const EPISODE = {
	context: "c",
	goal: "g",
	action: "a",
	outcome: "o",
	insight: "i",
	severity: "minor" as const,
};

async function seedEpisode(t: T, namespace: string, content: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("memories", {
			namespace,
			type: "episode",
			content,
			createdBy: "eta",
			relations: [],
			isLatest: true,
			episode: EPISODE,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe("memories:listMemories without a namespace (list_episodes, fleet master)", () => {
	test("PRESENT: the fleet master reads episodes across namespaces, newest first, not a server error", async () => {
		const t = createT();
		await seedEpisode(t, "orchestrator/eta", "older-eta");
		await seedEpisode(t, "orchestrator/sigma", "newer-sigma");
		const page = await asService(t).query(api.memories.listMemories, {
			type: "episode",
			limit: 5,
		});
		expect(page.value.map((m) => m.content)).toEqual([
			"newer-sigma",
			"older-eta",
		]);
	});

	test("ABSENT: the fleet master with no episodes gets an empty success", async () => {
		const t = createT();
		const page = await asService(t).query(api.memories.listMemories, {
			type: "episode",
		});
		expect(page.value).toEqual([]);
		expect(page.isDone).toBe(true);
	});

	test("REFUSED: an org member omitting the namespace is refused with RBAC_DENIED, never served another tenant's rows", async () => {
		const t = createT();
		await seedOrg(t);
		await seedEpisode(t, "orchestrator/eta", "fleet-private");
		const data = await refusal(() =>
			asMember(t).query(api.memories.listMemories, { type: "episode" }),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("memories:listMemories");
	});
});

describe("fixPatterns:get agrees with fixPatterns:listAll", () => {
	async function seed(t: T) {
		await seedFleetAgents(t, ["eta", "sigma"]);
		const agents = await t.run(async (ctx) => {
			const all = await ctx.db.query("agents").collect();
			const idOf = (name: string): Id<"agents"> => {
				const a = all.find((x) => x.name === name);
				if (a === undefined) throw new Error(`no agent ${name}`);
				return a._id;
			};
			const operator = (
				await ctx.db.query("client_org_mapping").collect()
			).find((m) => m.orgKind === "operator");
			return {
				eta: idOf("eta"),
				sigma: idOf("sigma"),
				slug: operator?.clerkOrgSlug ?? "",
			};
		});
		// A row shaped like production's: no org stamp, created by another station.
		const patternId = await t.run(async (ctx) =>
			ctx.db.insert("fixPatterns", {
				symptom: "eta-symptom",
				rootCause: "rc",
				tags: [],
				stack: [],
				sourceProject: "p",
				createdBy: "eta",
				severity: "minor",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		return { ...agents, patternId };
	}

	test("the list serves the row (the premise of the disagreement)", async () => {
		const t = createT();
		const s = await seed(t);
		const rows = await asService(t).query(api.fixPatterns.listAll, {});
		expect(rows.map((r) => r._id)).toContain(s.patternId);
	});

	test("REFUSED: a non-master caller outside the creator roster gets RBAC_DENIED, not a null that reads as 'not found'", async () => {
		const t = createT();
		const s = await seed(t);
		const data = await refusal(() =>
			asService(t).query(api.fixPatterns.get, {
				patternId: s.patternId,
				callerIdentities: ["sigma"],
				verifiedActor: { agentId: s.sigma, orgSlug: s.slug },
			}),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("fixPatterns:get");
	});

	test("PRESENT: the creator reads its own pattern; the master (no claim) reads any", async () => {
		const t = createT();
		const s = await seed(t);
		const own = await asService(t).query(api.fixPatterns.get, {
			patternId: s.patternId,
			callerIdentities: ["eta"],
			verifiedActor: { agentId: s.eta, orgSlug: s.slug },
		});
		expect(own?._id).toBe(s.patternId);
		const master = await asService(t).query(api.fixPatterns.get, {
			patternId: s.patternId,
		});
		expect(master?._id).toBe(s.patternId);
	});

	test("ABSENT: an id that does not exist is still null, for a narrowed caller too", async () => {
		const t = createT();
		const s = await seed(t);
		const gone = await t.run(async (ctx) => {
			await ctx.db.delete(s.patternId);
			return s.patternId;
		});
		const got = await asService(t).query(api.fixPatterns.get, {
			patternId: gone,
			callerIdentities: ["sigma"],
			verifiedActor: { agentId: s.sigma, orgSlug: s.slug },
		});
		expect(got).toBeNull();
	});
});
