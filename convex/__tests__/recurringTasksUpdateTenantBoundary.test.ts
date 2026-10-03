/// <reference types="vite/client" />
/**
 * recurringTasks.update — the TENANT gate, not only the roster.
 *
 * DEFECT (measured at 0424d55): `update` authorised on
 * `isAssigneeAllowedForScope(scope, existing.assignedTo)`, a ROSTER MEMBERSHIP
 * test (a name), and never compared `existing.orgId` to the caller's org. Two
 * organisations whose `allowedOrchestrators` both carry the same orchestrator
 * name therefore reached each other's schedules — and `processDueTasks` then
 * generates tasks from that schedule stamped with the VICTIM's orgId, i.e.
 * injection into another organisation's task queue that looks native to every
 * reader.
 *
 * FIXTURE HONESTY: both organisations carry the SAME orchestrator name
 * ("seat-shared") in their roster, so only the tenant stamp separates them. A
 * fixture with differing rosters would pass with the guard deleted.
 *
 * Every pole runs under an ORDINARY org member — never master, never the
 * service account (a proof under the maintenance identity exercises the
 * bypass, not the control).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

const SHARED_SEAT = "seat-shared";

async function seedBothOrgsWithSameRoster(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", { roles: ["org:admin", "org:editor"], updatedAt: Date.now() });
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [SHARED_SEAT],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

function asMember(t: ReturnType<typeof createT>, org: "org-a" | "org-b") {
	return t.withIdentity({
		subject: `member-of-${org}`,
		organizationId: org,
		// the human path (no caller arg on update) needs a writer role (memberWriterRoles)
		org_role: "org:editor",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedSchedule(
	t: ReturnType<typeof createT>,
	opts: { orgId?: string; assignedTo?: string },
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("recurringTasks", {
			title: "original title",
			assignedTo: opts.assignedTo ?? SHARED_SEAT,
			priority: "medium",
			cronExpression: "0 9 * * *",
			nextRunAt: Date.now() + 60_000,
			active: true,
			createdBy: opts.assignedTo ?? SHARED_SEAT,
			orgId: opts.orgId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe("recurringTasks.update — tenant gate", () => {
	test("LEAK pole: an ordinary org-b member cannot update a schedule stamped org-a, even though both rosters carry the same seat", async () => {
		const t = createT();
		await seedBothOrgsWithSameRoster(t);
		const id = await seedSchedule(t, { orgId: "org-a" });

		await expect(
			asMember(t, "org-b").mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				title: "PWNED by org-b",
			}),
		).rejects.toThrow(/RBAC_DENIED.*organisation/);

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.title).toBe("original title");
		expect(row?.orgId).toBe("org-a");
	});

	test("WITHHELD pole: an ordinary org-a member still updates its OWN org-a schedule", async () => {
		const t = createT();
		await seedBothOrgsWithSameRoster(t);
		const id = await seedSchedule(t, { orgId: "org-a" });

		await asMember(t, "org-a").mutation(api.recurringTasks.update, {
			recurringTaskId: id,
			title: "renamed by its own org",
		});

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.title).toBe("renamed by its own org");
		expect(row?.orgId).toBe("org-a");
	});

	test("symmetry: org-b updates its own schedule and org-a's sibling row is untouched", async () => {
		const t = createT();
		await seedBothOrgsWithSameRoster(t);
		const idA = await seedSchedule(t, { orgId: "org-a" });
		const idB = await seedSchedule(t, { orgId: "org-b" });

		await asMember(t, "org-b").mutation(api.recurringTasks.update, {
			recurringTaskId: idB,
			title: "org-b rename",
		});

		expect((await t.run((ctx) => ctx.db.get(idB)))?.title).toBe("org-b rename");
		expect((await t.run((ctx) => ctx.db.get(idA)))?.title).toBe(
			"original title",
		);
	});

	test("roster leg still narrows: an org-a member cannot update an org-a schedule assigned to a seat outside org-a's roster", async () => {
		const t = createT();
		await seedBothOrgsWithSameRoster(t);
		const id = await seedSchedule(t, {
			orgId: "org-a",
			assignedTo: "seat-not-in-roster",
		});

		await expect(
			asMember(t, "org-a").mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				title: "should not land",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		expect((await t.run((ctx) => ctx.db.get(id)))?.title).toBe(
			"original title",
		);
	});

	test("reassignment guard unchanged: an org-a member cannot move its own schedule to a seat outside its roster", async () => {
		const t = createT();
		await seedBothOrgsWithSameRoster(t);
		const id = await seedSchedule(t, { orgId: "org-a" });

		await expect(
			asMember(t, "org-a").mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				assignedTo: "seat-elsewhere",
			}),
		).rejects.toThrow(/RBAC_DENIED.*assignee/);

		expect((await t.run((ctx) => ctx.db.get(id)))?.assignedTo).toBe(
			SHARED_SEAT,
		);
	});

	test("named cost: a legacy schedule with NO orgId stamp is withheld from an org member (until backfilled)", async () => {
		const t = createT();
		await seedBothOrgsWithSameRoster(t);
		const id = await seedSchedule(t, { orgId: undefined });

		await expect(
			asMember(t, "org-a").mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				title: "should not land",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("recurringTasks.getById — the by-id read is gated too", () => {
	test("LEAK pole: an ordinary org-b member is refused an org-a schedule, even though both rosters carry the same seat", async () => {
		const t = createT();
		await seedBothOrgsWithSameRoster(t);
		const id = await seedSchedule(t, { orgId: "org-a" });

		await expect(
			asMember(t, "org-b").query(api.recurringTasks.getById, {
				recurringTaskId: id,
			}),
		).rejects.toThrow(/RBAC_DENIED.*organisation/);
	});

	test("LEAK pole: an anonymous caller holding the id is refused with AUTH_REQUIRED, not served the row", async () => {
		const t = createT();
		await seedBothOrgsWithSameRoster(t);
		const id = await seedSchedule(t, { orgId: "org-a" });

		await expect(
			t.query(api.recurringTasks.getById, { recurringTaskId: id }),
		).rejects.toThrow(/AUTH_REQUIRED/);
	});

	test("WITHHELD pole: an ordinary org-a member is still served its OWN schedule", async () => {
		const t = createT();
		await seedBothOrgsWithSameRoster(t);
		const id = await seedSchedule(t, { orgId: "org-a" });

		const row = await asMember(t, "org-a").query(api.recurringTasks.getById, {
			recurringTaskId: id,
		});
		expect(row?._id).toBe(id);
		expect(row?.orgId).toBe("org-a");
	});

	test("the two zeros are distinguishable: a refusal raises, a genuinely absent row resolves null, and an anonymous caller learns nothing about which", async () => {
		const t = createT();
		await seedBothOrgsWithSameRoster(t);
		const foreignId = await seedSchedule(t, { orgId: "org-a" });
		const absentId = await seedSchedule(t, { orgId: "org-a" });
		await t.run(async (ctx) => {
			await ctx.db.delete(absentId);
		});
		const asB = asMember(t, "org-b");

		const settle = (p: Promise<unknown>) =>
			p.then(
				(v) => ({ settled: "resolved" as const, v }),
				(e: unknown) => ({ settled: "rejected" as const, e }),
			);
		const refused = await settle(
			asB.query(api.recurringTasks.getById, { recurringTaskId: foreignId }),
		);
		const absent = await settle(
			asB.query(api.recurringTasks.getById, { recurringTaskId: absentId }),
		);
		expect(refused.settled).toBe("rejected");
		expect(absent).toEqual({ settled: "resolved", v: null });

		// Identity is checked BEFORE the fetch: an anonymous caller gets the
		// same AUTH_REQUIRED for a real id and an absent one (no existence oracle).
		for (const id of [foreignId, absentId]) {
			await expect(
				t.query(api.recurringTasks.getById, { recurringTaskId: id }),
			).rejects.toThrow(/AUTH_REQUIRED/);
		}
	});
});
