/// <reference types="vite/client" />
/**
 * Task k171ysvpwb4wzjkkjr2kqpwsx98hedaw (Iris RH, client agent victor): a client
 * seat that wrote `orchestrator/victor`, `project/marie` or `audit/friction` was
 * refused with a text that said what was refused and not what it MAY write.
 *
 * The rule is data (convex/lib/seatNamespace.ts `memoryWritableRootsOf`): a seat
 * acting for its org may write
 *   team/<org ID> (and its legacy slug alias), project/<org slug>,
 *   orchestrator/<its own verified agent ID>.
 * Everything else is refused, and the refusal NAMES those roots, built from the
 * same function that decides, so the text cannot drift from the rule.
 *
 * OPEN (no ruling, so no grant): project/<another slug> (e.g. project/marie) and
 * audit/friction (a fleet-wide namespace the weekly friction digest reads as the
 * fleet master). Both stay refused and are pinned as refused here.
 *
 * Every pole runs under a SCOPED org-agent identity (service transport acting for
 * the org, a verified agent proof), never as master.
 */

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
		([path]) => !path.includes("search") && !path.includes("backfill"),
	),
);
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

const IRIS = "iris-rh";
const OTHER = "other-co";
const IRIS_ID = testClerkOrgId(IRIS);
const OTHER_ID = testClerkOrgId(OTHER);
const VICTOR = "victor";

const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seed(t: T): Promise<Record<string, Id<"agents">>> {
	await t.run(async (ctx) => {
		for (const [org, names] of [
			[IRIS, [VICTOR, "marie"]],
			[OTHER, [VICTOR]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: [...names],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: 1,
			});
		}
	});
	return await seedRosterAgents(t);
}

async function thrown(p: Promise<unknown>): Promise<string | null> {
	try {
		await p;
		return null;
	} catch (e) {
		return e instanceof ConvexError ? String(e.data) : String(e);
	}
}

const seat = (agentId: Id<"agents">, org = IRIS, orgId = IRIS_ID) => ({
	__actingOrg: orgId,
	verifiedActor: { agentId, orgSlug: org },
});
const store = (t: T, namespace: string, extra: Record<string, unknown>) =>
	service(t).mutation(api.memories.storeMemory, {
		namespace,
		type: "feedback",
		content: `row in ${namespace}`,
		createdBy: VICTOR,
		...extra,
	} as never);
const episode = (t: T, namespace: string, extra: Record<string, unknown>) =>
	service(t).mutation(api.episodes.storeEpisode, {
		namespace,
		createdBy: VICTOR,
		context: "c",
		goal: "g",
		action: "a",
		outcome: "o",
		insight: "i",
		severity: "minor",
		...extra,
	} as never);

describe("an org agent's writable namespaces, and a refusal that names them", () => {
	test("ALLOW: victor writes orchestrator/<his agent ID>, project/iris-rh and team/<org ID>", async () => {
		const t = createT();
		const ag = await seed(t);
		const victor = ag[`${IRIS}/${VICTOR}`];
		for (const ns of [`orchestrator/${victor}`, `project/${IRIS}`, `team/${IRIS_ID}`]) {
			expect(await thrown(store(t, ns, seat(victor)))).toBeNull();
		}
		await drain(t);
	});

	test("REFUSED, and the text names the namespaces victor MAY write (store_memory)", async () => {
		const t = createT();
		const ag = await seed(t);
		const victor = ag[`${IRIS}/${VICTOR}`];
		for (const ns of [`orchestrator/${VICTOR}`, "project/marie", "audit/friction"]) {
			const value = await thrown(store(t, ns, seat(victor)));
			console.log(`THROWN[${ns}] = ${value}`);
			expect(value).toContain("RBAC_DENIED");
			expect(value).toContain(ns);
			expect(value).toContain(`orchestrator/${victor}`);
			expect(value).toContain(`project/${IRIS}`);
			expect(value).toContain(`team/${IRIS_ID}`);
		}
		await drain(t);
	});

	test("REFUSED, and the text names them (store_episode)", async () => {
		const t = createT();
		const ag = await seed(t);
		const victor = ag[`${IRIS}/${VICTOR}`];
		const value = await thrown(episode(t, "audit/friction", seat(victor)));
		expect(value).toContain("RBAC_DENIED");
		expect(value).toContain(`orchestrator/${victor}`);
		expect(value).toContain(`project/${IRIS}`);
		await drain(t);
	});

	test("CONSISTENCY: every root the refusal lists is itself served", async () => {
		const t = createT();
		const ag = await seed(t);
		const victor = ag[`${IRIS}/${VICTOR}`];
		const value = (await thrown(store(t, "audit/friction", seat(victor)))) ?? "";
		const listed = value.match(/(?:orchestrator|project|team)\/[A-Za-z0-9_;-]+/g) ?? [];
		const roots = [...new Set(listed)].filter((r) => r !== "audit/friction");
		expect(roots.length).toBeGreaterThanOrEqual(3);
		for (const root of roots) {
			expect(await thrown(store(t, root, seat(victor)))).toBeNull();
		}
		await drain(t);
	});

	test("CROSS-ORG: another org's agent named victor cannot write iris-rh's roots, and its refusal lists ITS roots only", async () => {
		const t = createT();
		const ag = await seed(t);
		const irisVictor = ag[`${IRIS}/${VICTOR}`];
		const otherVictor = ag[`${OTHER}/${VICTOR}`];
		const asOther = seat(otherVictor, OTHER, OTHER_ID);
		for (const ns of [`orchestrator/${irisVictor}`, `project/${IRIS}`, `team/${IRIS_ID}`]) {
			const value = await thrown(store(t, ns, asOther));
			expect(value).toContain("RBAC_DENIED");
			expect(value).toContain(`orchestrator/${otherVictor}`);
			expect(value).toContain(`project/${OTHER}`);
			const offered = (value ?? "").split("may write:")[1] ?? "";
			expect(offered).not.toContain(`project/${IRIS}`);
			expect(offered).not.toContain(IRIS_ID);
			expect(offered).not.toContain(irisVictor);
		}
		// the proof of one org does not open a root when acting for another
		expect(
			await thrown(store(t, `orchestrator/${irisVictor}`, seat(irisVictor, IRIS, OTHER_ID))),
		).not.toBeNull();
		await drain(t);
	});

	test("NO PROOF: a seat without a verified agent is told it needs one and is offered only the org roots", async () => {
		const t = createT();
		await seed(t);
		const value = await thrown(store(t, `orchestrator/${VICTOR}`, { __actingOrg: IRIS_ID }));
		expect(value).toContain("RBAC_DENIED");
		expect(value).toContain(`project/${IRIS}`);
		expect(value).toContain("orchestrator/<your agent ID>");
		await drain(t);
	});
});
