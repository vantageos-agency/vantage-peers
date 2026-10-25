/// <reference types="vite/client" />
/**
 * tasks:listBlockedOnMe -- the dedicated opt-in read of "who is waiting on me"
 * (task k177s4k501682y61m4jvqe69f58cdw20, point 4). check_messages returns
 * messages only; this is NOT part of its envelope.
 *
 * Poles: PRESENT / ABSENT / NOT-MINE / TERMINAL / CROSS-TENANT / ANONYMOUS.
 * The reader is resolved from the verified identity (verifiedActor carried by the
 * service account, or a Clerk org member), never from a "who am I" argument.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
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

const IRIS = "iris-rh";
const ACME = "acme";
const MIN = 60_000;

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: "ordinary-member-of-iris",
		organizationSlug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:editor",
	} as Parameters<T["withIdentity"]>[0]);
const asNoOrg = (t: T) =>
	t.withIdentity({ subject: "signed-in-no-org" } as Parameters<
		T["withIdentity"]
	>[0]);

type Agent = { id: Id<"agents">; org: string; name: string };

async function seedWorld() {
	const t = createT();
	const now = Date.now();
	const agents = await t.run(async (ctx) => {
		const mapping = (slug: string, names: string[]) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: names,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		await mapping(IRIS, ["alpha", "beta", "gamma"]);
		await mapping(ACME, ["alpha", "beta"]);
		const agent = async (org: string, name: string): Promise<Agent> => ({
			org,
			name,
			id: await ctx.db.insert("agents", {
				orgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: now,
			}),
		});
		return {
			irisAlpha: await agent(IRIS, "alpha"),
			irisBeta: await agent(IRIS, "beta"),
			irisGamma: await agent(IRIS, "gamma"),
			acmeAlpha: await agent(ACME, "alpha"),
			acmeBeta: await agent(ACME, "beta"),
		};
	});
	return { t, now, ...agents };
}

type World = Awaited<ReturnType<typeof seedWorld>>;

async function putTask(
	w: World,
	owner: Agent,
	title: string,
	opts: {
		status?: "todo" | "in_progress" | "review" | "blocked" | "done";
		blockedOn?: Id<"tasks">;
		ageMs?: number;
	} = {},
): Promise<Id<"tasks">> {
	const at = w.now - (opts.ageMs ?? 0);
	return await w.t.run(async (ctx) =>
		ctx.db.insert("tasks", {
			title,
			assignedTo: owner.name,
			assignedToId: owner.id,
			priority: "high" as const,
			status: opts.status ?? "todo",
			createdBy: owner.name,
			createdById: owner.id,
			orgId: owner.org,
			clerkOrgId: testClerkOrgId(owner.org),
			createdAt: at,
			updatedAt: at,
			...(opts.blockedOn !== undefined
				? { blockedOnTaskId: opts.blockedOn }
				: {}),
		}),
	);
}

const readAs = (w: World, who: Agent) =>
	asServiceAccount(w.t).query(api.tasks.listBlockedOnMe, {
		verifiedActor: { agentId: who.id, orgSlug: who.org },
	});

describe("tasks:listBlockedOnMe", () => {
	test("PRESENT: A owns live T, B blocks U on T -> A sees U", async () => {
		const w = await seedWorld();
		const T = await putTask(w, w.irisAlpha, "T: review my thing", {
			status: "in_progress",
		});
		const U = await putTask(w, w.irisBeta, "U: waiting for alpha", {
			status: "blocked",
			blockedOn: T,
			ageMs: 5 * MIN,
		});
		const r = await readAs(w, w.irisAlpha);
		expect(r.total).toBe(1);
		expect(r.truncated).toBe(false);
		expect(r.entries).toHaveLength(1);
		expect(r.entries[0]).toMatchObject({
			blockedTaskId: U,
			blockedTitle: "U: waiting for alpha",
			blockedAssignee: "beta",
			onTaskId: T,
			onTaskTitle: "T: review my thing",
		});
		expect(r.entries[0].age).toBeGreaterThanOrEqual(5 * MIN);
		expect(r.oldestAge).toBeGreaterThanOrEqual(5 * MIN);
		expect(r.oldestAge).toBeGreaterThan(0);
	});

	test("PRESENT: several waiters, oldest first, oldestAge is the maximum", async () => {
		const w = await seedWorld();
		const T = await putTask(w, w.irisAlpha, "T");
		await putTask(w, w.irisBeta, "young", {
			status: "blocked",
			blockedOn: T,
			ageMs: 1 * MIN,
		});
		await putTask(w, w.irisGamma, "old", {
			status: "blocked",
			blockedOn: T,
			ageMs: 90 * MIN,
		});
		const r = await readAs(w, w.irisAlpha);
		expect(r.total).toBe(2);
		expect(r.entries.map((e) => e.blockedTitle)).toEqual(["old", "young"]);
		expect(r.oldestAge).toBe(r.entries[0].age);
	});

	test("PRESENT: an org member naming its own agent is served the same rows", async () => {
		const w = await seedWorld();
		const T = await putTask(w, w.irisAlpha, "T");
		await putTask(w, w.irisBeta, "U", {
			status: "blocked",
			blockedOn: T,
			ageMs: MIN,
		});
		const r = await asMember(w.t, IRIS).query(api.tasks.listBlockedOnMe, {
			recipient: "alpha",
		});
		expect(r.total).toBe(1);
	});

	test("ABSENT: nobody is blocked on A's task -> an empty SUCCESS, not a throw", async () => {
		const w = await seedWorld();
		await putTask(w, w.irisAlpha, "T");
		const r = await readAs(w, w.irisAlpha);
		expect(r).toEqual({ entries: [], total: 0, truncated: false, oldestAge: 0 });
	});

	test("NOT-MINE: B is blocked on a task assigned to C -> A does not see it, C does", async () => {
		const w = await seedWorld();
		const onC = await putTask(w, w.irisGamma, "C's task");
		await putTask(w, w.irisBeta, "U", {
			status: "blocked",
			blockedOn: onC,
			ageMs: MIN,
		});
		expect((await readAs(w, w.irisAlpha)).total).toBe(0);
		expect((await readAs(w, w.irisGamma)).total).toBe(1);
	});

	test("TERMINAL: T done -> not listed; U no longer blocked -> not listed", async () => {
		const w = await seedWorld();
		const done = await putTask(w, w.irisAlpha, "T done", { status: "done" });
		await putTask(w, w.irisBeta, "U on done", {
			status: "blocked",
			blockedOn: done,
			ageMs: MIN,
		});
		const live = await putTask(w, w.irisAlpha, "T live");
		await putTask(w, w.irisBeta, "U resumed", {
			status: "in_progress",
			blockedOn: live,
			ageMs: MIN,
		});
		expect((await readAs(w, w.irisAlpha)).total).toBe(0);
	});

	test("CROSS-TENANT: another org's blocked task citing A's task never leaks", async () => {
		const w = await seedWorld();
		const T = await putTask(w, w.irisAlpha, "iris T");
		// blockTask refuses a cross-org cite; the row is seeded directly to prove
		// the read does not depend on that write-side guard alone.
		await putTask(w, w.acmeBeta, "acme U citing iris T", {
			status: "blocked",
			blockedOn: T,
			ageMs: MIN,
		});
		expect((await readAs(w, w.irisAlpha)).total).toBe(0);
	});

	test("CROSS-TENANT: a same-named agent in another org shares the name index but not the rows", async () => {
		const w = await seedWorld();
		const acmeT = await putTask(w, w.acmeAlpha, "acme alpha T");
		await putTask(w, w.acmeBeta, "acme U", {
			status: "blocked",
			blockedOn: acmeT,
			ageMs: MIN,
		});
		expect((await readAs(w, w.irisAlpha)).total).toBe(0);
		expect((await readAs(w, w.acmeAlpha)).total).toBe(1);
	});

	test("CROSS-TENANT: an in-tenant blocked task citing a namesake's task in another org is not listed (the target is judged too)", async () => {
		const w = await seedWorld();
		const acmeT = await putTask(w, w.acmeAlpha, "acme alpha T");
		// iris-stamped waiter, cite crosses into acme (impossible via blockTask,
		// seeded directly): only the target-side visibility check stops it.
		await putTask(w, w.irisBeta, "iris U citing acme T", {
			status: "blocked",
			blockedOn: acmeT,
			ageMs: MIN,
		});
		expect((await readAs(w, w.irisAlpha)).total).toBe(0);
	});

	test("ANONYMOUS: raises RBAC_DENIED naming the door", async () => {
		const w = await seedWorld();
		let caught: unknown;
		try {
			await w.t.query(api.tasks.listBlockedOnMe, { recipient: "alpha" });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ConvexError);
		const data = String((caught as ConvexError<string>).data);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("tasks:listBlockedOnMe");
	});

	test("SIGNED IN, NO ORGANISATION: raises RBAC_DENIED, never an empty success", async () => {
		const w = await seedWorld();
		let caught: unknown;
		try {
			await asNoOrg(w.t).query(api.tasks.listBlockedOnMe, {
				recipient: "alpha",
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ConvexError);
		expect(String((caught as ConvexError<string>).data)).toContain(
			"RBAC_DENIED",
		);
	});
});
