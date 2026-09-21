/// <reference types="vite/client" />
/**
 * briefingNotes.create / briefingNotes.update / briefingNotes.deleteBriefingNote
 * — write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): all three mutations authorized (or did not
 * authorize at all) solely on the client-supplied `createdBy`/
 * `callerOrchestrator` STRING ARGUMENT — never a verified identity. `create`
 * took NO identity/scope check at all (any caller, including anonymous,
 * could write a note under any org). `update`/`deleteBriefingNote` compared
 * `callerOrchestrator` against the note's own STORED `createdBy` field (or
 * accepted the "system" narrowing bypass) — an anonymous caller, or a
 * caller authenticated as a DIFFERENT org, could pass any orchestrator name
 * (or the note's own creator name, once known) and mutate/delete another
 * org's note. This is the class of defect
 * .claude/rules/authority-attached-to-anonymous-object.md describes: a
 * write surface must derive authority from the verified caller
 * (withOrgScope), never trust the client-supplied argument alone.
 *
 * This suite proves all three mutations now enforce org scope via
 * withOrgScope + isOrgAllowedForScope (checked against the note's STORED
 * `orgId`), both poles, while keeping the pre-existing callerOrchestrator
 * narrowing check intact.
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

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedOrgBMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-b",
			allowedOrchestrators: ["seat-b"],
			scopes: ["view-own-tasks"],
			displayName: "org-b",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asOrgB(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-b",
		organizationId: "org-b",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedNote(
	t: ReturnType<typeof createT>,
	orgId: string | undefined,
	createdBy: string,
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("briefingNotes", {
			title: "seed note",
			topic: "handoff",
			participants: [createdBy],
			content: "seed content",
			createdBy,
			createdAt: Date.now(),
			orgId,
		});
	});
}

describe("briefingNotes.create — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();

		await expect(
			t.mutation(api.briefingNotes.create, {
				title: "anon note",
				topic: "handoff",
				participants: ["seat-x"],
				content: "content",
				createdBy: "seat-x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const all = await t.run((ctx) => ctx.db.query("briefingNotes").collect());
		expect(all).toHaveLength(0);
	});

	test("org-a creating a note gets orgId forced to its own org, regardless of the createdBy argument it passes", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		// Named attack M1 shape: org-a asserts a createdBy value that could be
		// mistaken for another org's own agent name. orgId must STILL derive
		// from the verified scope, never from anything caller-supplied.
		const noteId = await tA.mutation(api.briefingNotes.create, {
			title: "org-a note",
			topic: "handoff",
			participants: ["seat-b"],
			content: "content",
			createdBy: "seat-b",
		});

		const note = await t.run((ctx) => ctx.db.get(noteId));
		expect(note?.orgId).toBe("org-a");
	});

	test("the master/service-account identity creates a note with no orgId (legacy/internal)", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const noteId = await tMaster.mutation(api.briefingNotes.create, {
			title: "master note",
			topic: "handoff",
			participants: ["seat-x"],
			content: "content",
			createdBy: "seat-x",
		});

		const note = await t.run((ctx) => ctx.db.get(noteId));
		expect(note?.orgId).toBeUndefined();
	});
});

describe("briefingNotes.update — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const noteId = await seedNote(t, "org-b", "seat-b");

		await expect(
			t.mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "seat-b",
				content: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const note = await t.run((ctx) => ctx.db.get(noteId));
		expect(note?.content).toBe("seed content");
	});

	test("org-a trying to update org-b's note is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const noteId = await seedNote(t, "org-b", "seat-x");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "seat-a",
				content: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const note = await t.run((ctx) => ctx.db.get(noteId));
		expect(note?.content).toBe("seed content");
	});

	// Named attack M1: org-a asserts callerOrchestrator EQUAL to the foreign
	// note's own createdBy value — the exact shape that would pass the OLD
	// (pre-fix) `note.createdBy === callerOrchestrator` check alone. The new
	// org-scope check must independently refuse this regardless of what the
	// caller-supplied callerOrchestrator equals.
	test("org-a trying to update org-b's note is refused even when callerOrchestrator matches the note's own createdBy", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const noteId = await seedNote(t, "org-b", "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "seat-b",
				content: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const note = await t.run((ctx) => ctx.db.get(noteId));
		expect(note?.content).toBe("seed content");
	});

	// The "system" narrowing bypass (kept for master/internal callers) must
	// never let a cross-org caller through the NEW org-scope check either.
	test("org-a trying to update org-b's note via the 'system' narrowing bypass is still refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const noteId = await seedNote(t, "org-b", "seat-x");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "system",
				content: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const note = await t.run((ctx) => ctx.db.get(noteId));
		expect(note?.content).toBe("seed content");
	});

	test("org-a updating its own (org-a-owned) note succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const noteId = await seedNote(t, "org-a", "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "seat-a",
			content: "updated by owner",
		});

		const note = await t.run((ctx) => ctx.db.get(noteId));
		expect(note?.content).toBe("updated by owner");
	});

	test("the master/service-account identity updates any org's note", async () => {
		const t = createT();
		const noteId = await seedNote(t, "org-b", "seat-b");
		const tMaster = asMaster(t);

		await tMaster.mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "system",
			content: "updated by master",
		});

		const note = await t.run((ctx) => ctx.db.get(noteId));
		expect(note?.content).toBe("updated by master");
	});

	// update's args never include `orgId` — an org caller cannot move a note
	// into another org's scope via the patch, by construction. Proven here:
	// updating org-a's own note with every other mutable field set leaves
	// orgId unchanged.
	test("org-a updating its own note cannot move it into another org's scope — orgId is unaffected by the patch", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const noteId = await seedNote(t, "org-a", "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "seat-a",
			title: "retitled",
			topic: "retopic",
			participants: ["seat-a", "seat-c"],
			content: "rewritten",
			decisions: ["decided"],
		});

		const note = await t.run((ctx) => ctx.db.get(noteId));
		expect(note?.orgId).toBe("org-a");
	});

	// Anonymous-oracle proof (mirrors messages.ts deleteMessage, PR #1313
	// REVISE fix): the scope check must run BEFORE ctx.db.get, so an
	// anonymous caller gets RBAC_DENIED even for a non-existent noteId —
	// never "BriefingNote ... not found", which would let noteId existence
	// leak to an unauthenticated caller.
	test("an anonymous update on a non-existent noteId is refused with RBAC_DENIED, not 'not found'", async () => {
		const t = createT();
		const noteId = await seedNote(t, "org-b", "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(noteId);
		});

		await expect(
			t.mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "seat-b",
				content: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// Reviewer REVISE on #1315 (mutant B2): a mutant that widens
	// isOrgAllowedForScope to also let `orgId === undefined` through for a
	// non-master scope survived because no test pinned the claim in the PR
	// body — that every note stored without an orgId (every legacy/pre-Beta
	// production row) is NOT reachable by an org-scoped caller. Seeded via
	// t.run directly (never via create/update, which would themselves stamp
	// an orgId) to reproduce the exact shape of a legacy row.
	test("org-a updating a legacy note (no orgId at all) is refused with RBAC_DENIED, and the note is unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const noteId = await t.run(async (ctx) => {
			return await ctx.db.insert("briefingNotes", {
				title: "legacy note",
				topic: "handoff",
				participants: ["seat-legacy"],
				content: "legacy content",
				createdBy: "seat-legacy",
				createdAt: Date.now(),
				// no orgId field at all — the exact shape of a pre-Beta row.
			});
		});
		const before = await t.run((ctx) => ctx.db.get(noteId));
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "seat-legacy",
				content: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const after = await t.run((ctx) => ctx.db.get(noteId));
		expect(after).toEqual(before);
	});
});

describe("briefingNotes.deleteBriefingNote — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const noteId = await seedNote(t, "org-b", "seat-b");

		await expect(
			t.mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		expect(await t.run((ctx) => ctx.db.get(noteId))).not.toBeNull();
	});

	test("org-a trying to delete org-b's note is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const noteId = await seedNote(t, "org-b", "seat-x");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: "seat-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		expect(await t.run((ctx) => ctx.db.get(noteId))).not.toBeNull();
	});

	// Named attack M1: org-a asserts callerOrchestrator EQUAL to the foreign
	// note's own createdBy value.
	test("org-a trying to delete org-b's note is refused even when callerOrchestrator matches the note's own createdBy", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const noteId = await seedNote(t, "org-b", "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		expect(await t.run((ctx) => ctx.db.get(noteId))).not.toBeNull();
	});

	test("org-a trying to delete org-b's note via the 'system' narrowing bypass is still refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const noteId = await seedNote(t, "org-b", "seat-x");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		expect(await t.run((ctx) => ctx.db.get(noteId))).not.toBeNull();
	});

	test("org-a deleting its own (org-a-owned) note succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const noteId = await seedNote(t, "org-a", "seat-a");
		const tA = asOrgA(t);

		const result = await tA.mutation(api.briefingNotes.deleteBriefingNote, {
			noteId,
			callerOrchestrator: "seat-a",
		});
		expect(result.deleted).toBe(true);
		expect(await t.run((ctx) => ctx.db.get(noteId))).toBeNull();
	});

	test("the master/service-account identity deletes any org's note", async () => {
		const t = createT();
		const noteId = await seedNote(t, "org-b", "seat-b");
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(api.briefingNotes.deleteBriefingNote, {
			noteId,
			callerOrchestrator: "system",
		});
		expect(result.deleted).toBe(true);
	});

	// Reviewer's optional point (mirrors messages.ts deleteMessage, PR #1313):
	// withOrgScope must resolve, and the anonymous refusal must fire, BEFORE
	// ctx.db.get(args.noteId) — otherwise an anonymous caller can use
	// noteId existence ("Briefing note not found" vs. a later RBAC error) as
	// an oracle to enumerate valid ids without ever authenticating.
	test("an anonymous deleteBriefingNote on a non-existent note id is refused with RBAC_DENIED, not 'Briefing note not found'", async () => {
		const t = createT();
		const noteId = await seedNote(t, "org-b", "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(noteId);
		});

		await expect(
			t.mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// Reviewer REVISE on #1315 (mutant B2) — same claim as the update test
	// above, pinned for deleteBriefingNote: a legacy note (no orgId at all,
	// seeded via t.run directly) must stay out of an org-scoped caller's
	// reach.
	test("org-a deleting a legacy note (no orgId at all) is refused with RBAC_DENIED, and the note still exists", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const noteId = await t.run(async (ctx) => {
			return await ctx.db.insert("briefingNotes", {
				title: "legacy note",
				topic: "handoff",
				participants: ["seat-legacy"],
				content: "legacy content",
				createdBy: "seat-legacy",
				createdAt: Date.now(),
				// no orgId field at all — the exact shape of a pre-Beta row.
			});
		});
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: "seat-legacy",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		expect(await t.run((ctx) => ctx.db.get(noteId))).not.toBeNull();
	});
});
