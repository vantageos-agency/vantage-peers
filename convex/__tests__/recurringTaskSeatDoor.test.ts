/// <reference types="vite/client" />
/**
 * VantagePeers Cloud — task k170ahhzv5dsczsgsh20mr4fah8hfbk4.
 *
 * A client seat (CGT Alsachimie's Mimir) reaches Convex the way production
 * reaches it: the fleet service account ACTING FOR the seat's organisation
 * (`__actingOrg`, convex/lib/actingOrg.ts) and carrying the seat's
 * `verifiedActor`. The acting org makes the scope an ordinary MEMBER scope
 * (`isMaster: false`, `serviceTransport: true`), so a door that reads the
 * forwarded agent only off a MASTER scope never sees it.
 *
 * Poles for pause / resume / remove (and update, which shares the gate):
 *   CREATOR     the seat that created the schedule            -> served;
 *   ASSIGNEE    the seat assigned (not creator)                -> served for
 *               pause / resume / update, refused for remove (creator only);
 *   BYSTANDER   a same-org agent, neither creator nor assignee -> RBAC_DENIED;
 *   OTHER ORG   a seat of another org                          -> refused;
 *   MASTER      the fleet service account, no acting org       -> served.
 * Every refusal leaves the row unchanged. The identity under test is a scoped
 * seat, never the master (a-permission-fails-in-two-directions).
 */

import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test } from "vitest";
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

const A = "seat-org-a";
const B = "seat-org-b";

let t: T;
let svc: ReturnType<T["withIdentity"]>;
let mimir: Id<"agents">;
let vera: Id<"agents">;
let ivo: Id<"agents">;
let otherMimir: Id<"agents">;

beforeEach(async () => {
	t = createT();
	svc = t.withIdentity({ subject: "test-service-account-user-id" });
	await t.run(async (ctx) => {
		for (const [org, roster] of [
			[A, ["mimir", "vera", "ivo"]],
			[B, ["mimir"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: [...roster],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: 1,
			});
		}
	});
	const ids = await seedRosterAgents(t);
	mimir = ids[`${A}/mimir`];
	vera = ids[`${A}/vera`];
	ivo = ids[`${A}/ivo`];
	otherMimir = ids[`${B}/mimir`];
});

const seat = (org: string, agentId: Id<"agents">) => ({
	__actingOrg: testClerkOrgId(org),
	verifiedActor: { agentId, orgSlug: org },
});

/** A schedule created BY mimir (seat of org A), assigned to vera. */
const createdByMimir = () =>
	svc.mutation(api.recurringTasks.create, {
		title: "relance",
		assignedTo: "vera",
		priority: "medium",
		cronExpression: "0 9 * * *",
		createdBy: "mimir",
		...seat(A, mimir),
	} as never) as Promise<Id<"recurringTasks">>;

type Door = "pause" | "resume" | "remove" | "update";

const call = (door: Door, id: Id<"recurringTasks">, proof: object) =>
	door === "update"
		? svc.mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				title: "changed",
				...proof,
			} as never)
		: svc.mutation(api.recurringTasks[door], { taskId: id, ...proof } as never);

async function outcome(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		const m = /([A-Z][A-Z_]{3,}):/.exec(text);
		return m ? m[1] : `OTHER(${text.slice(0, 160)})`;
	}
}

const rowOf = (id: Id<"recurringTasks">) => t.run((ctx) => ctx.db.get(id));

describe("a seat acting for its own organisation reaches its own schedules", () => {
	for (const door of ["pause", "resume", "remove", "update"] as const) {
		test(`${door}: CREATOR seat is served`, async () => {
			const id = await createdByMimir();
			expect(await outcome(call(door, id, seat(A, mimir)))).toBe("SERVED");
			const row = await rowOf(id);
			if (door === "remove") expect(row).toBeNull();
			if (door === "pause") expect(row?.active).toBe(false);
			if (door === "update") expect(row?.title).toBe("changed");
		});

		test(`${door}: same-org BYSTANDER seat (neither creator nor assignee) is refused, row unchanged`, async () => {
			const id = await createdByMimir();
			expect(await outcome(call(door, id, seat(A, ivo)))).toBe("RBAC_DENIED");
			const row = await rowOf(id);
			expect(row?.title).toBe("relance");
			expect(row?.active).toBe(true);
		});

		test(`${door}: a seat of ANOTHER org is refused, row unchanged`, async () => {
			const id = await createdByMimir();
			expect(await outcome(call(door, id, seat(B, otherMimir)))).toMatch(
				/RBAC_DENIED|ORG_MISMATCH/,
			);
			const row = await rowOf(id);
			expect(row?.title).toBe("relance");
			expect(row?.active).toBe(true);
		});

		test(`${door}: the fleet master (no acting org, no proof) is unchanged`, async () => {
			const id = await createdByMimir();
			expect(await outcome(call(door, id, {}))).toBe("SERVED");
		});

		test(`${door}: a bearer acting for the org with NO agent proof is refused (never the fleet), row unchanged`, async () => {
			const id = await createdByMimir();
			expect(
				await outcome(call(door, id, { __actingOrg: testClerkOrgId(A) })),
			).toBe("RBAC_DENIED");
			const row = await rowOf(id);
			expect(row?.title).toBe("relance");
			expect(row?.active).toBe(true);
		});
	}

	test("pause / resume: the ASSIGNEE seat is served; remove: the assignee is refused (creator only)", async () => {
		const id = await createdByMimir();
		expect(await outcome(call("pause", id, seat(A, vera)))).toBe("SERVED");
		expect(await outcome(call("resume", id, seat(A, vera)))).toBe("SERVED");
		expect(await outcome(call("remove", id, seat(A, vera)))).toBe(
			"RBAC_DENIED",
		);
		expect(await rowOf(id)).not.toBeNull();
	});
});

// The pre-row refusal is requireResolvedCaller (task k170ahhzv5dsczsgsh20mr4fah8hfbk4),
// replacing an open-coded `!isMaster && orgSlug === null` throw. Edge case: that
// old predicate also caught a non-master scope with no org that is neither
// anonymous nor refused; withOrgScope builds no such scope on these doors, and
// authorizeScheduleActor would still refuse one (human path, no org). These poles
// pin what IS reachable: no existence oracle, same refusal for a live and an
// absent id, and the row untouched.
describe("a caller with no organisation, or no identity, learns nothing about a schedule id", () => {
	const absentId = async () => {
		const id = await createdByMimir();
		await t.run((ctx) => ctx.db.delete(id));
		return id;
	};
	for (const door of ["pause", "resume", "remove"] as const) {
		test(`${door}: signed in with no organisation -> the same refusal for a live and an absent id`, async () => {
			const noOrg = t.withIdentity({ subject: "user-without-org" });
			const live = await createdByMimir();
			const gone = await absentId();
			const run = (id: Id<"recurringTasks">) =>
				outcome(noOrg.mutation(api.recurringTasks[door], { taskId: id }));
			expect(await run(live)).toBe("RBAC_DENIED");
			expect(await run(gone)).toBe("RBAC_DENIED");
			const row = await rowOf(live);
			expect(row?.active).toBe(true);
		});

		test(`${door}: no identity -> the same refusal for a live and an absent id`, async () => {
			const live = await createdByMimir();
			const gone = await absentId();
			const run = (id: Id<"recurringTasks">) =>
				outcome(t.mutation(api.recurringTasks[door], { taskId: id }));
			expect(await run(live)).toBe(await run(gone));
			expect(await run(live)).not.toBe("SERVED");
			expect((await rowOf(live))?.active).toBe(true);
		});
	}
});
