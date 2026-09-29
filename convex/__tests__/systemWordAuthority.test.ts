/// <reference types="vite/client" />
/**
 * The word "system" carries authority only where the VERIFIED scope justifies
 * it (task k17df9ahgk021pw7z9b0dtjyzh8fap59).
 *
 * `callerOrchestrator` is an ARGUMENT on the public mutations: a
 * caller-supplied string. Nine sites authorised any caller who typed the seven
 * letters "system" past the OWNERSHIP check (`createdBy === caller`). Every one
 * of them already refused a caller with no organisation, so the defect is
 * INTRA-organisation: member A of org-X skipping the ownership check to
 * delete/update the row of member B of the SAME org. The shared predicate
 * `isFleetSystemCaller` (convex/lib/systemCaller.ts) now requires the VERIFIED
 * master scope as well.
 *
 * Every pole runs under an ORDINARY organisation member (org-a, seats
 * seat-a + seat-b). The master identity appears only in the master-regression
 * tests, never as the subject of a leak or withheld pole.
 *
 *   LEAK      member seat-a types "system" on seat-b's row (same org) -> REFUSED
 *   WITHHELD  member seat-a acts on its OWN row                       -> SUCCEEDS
 *   MASTER    the fleet's verified master, typing "system"            -> SUCCEEDS
 *
 * mandates.* sit behind requireFleetMaster, so an ordinary member is refused
 * before the word is reached; those poles pin that ordering (they pass on the
 * pre-fix tree too — there is nothing to turn RED at the member level).
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
type T = ReturnType<typeof createT>;

async function seedOrgA(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a", "seat-b"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asMemberOfOrgA(t: T) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: T) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

// ── seeds ───────────────────────────────────────────────────────────────────
async function seedNote(t: T, createdBy: string) {
	return await t.run((ctx) =>
		ctx.db.insert("briefingNotes", {
			title: "seed note",
			topic: "handoff",
			participants: [createdBy],
			content: "seed content",
			createdBy,
			createdAt: Date.now(),
			orgId: "org-a",
		}),
	);
}

async function seedMission(t: T, createdBy: string) {
	return await t.run((ctx) =>
		ctx.db.insert("missions", {
			name: "seed mission",
			project: "p",
			status: "plan",
			priority: "medium",
			pilot: createdBy,
			agents: [createdBy],
			createdBy,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId: "org-a",
		}),
	);
}

async function seedBU(t: T, orchestratorId: string) {
	return await t.run((ctx) =>
		ctx.db.insert("businessUnits", {
			name: `bu-${orchestratorId}`,
			description: "d",
			purpose: "p",
			orchestratorId,
			status: "idea",
			businessModel: "m",
			targetCustomers: "c",
			services: [],
			pricing: "0",
			revenueProjections: { y1: 0, y2: 0, y3: 0 },
			coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
			coreProcesses: [],
			dependencies: [],
			kpis: [],
			managementFee: 10,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
}

async function seedDiary(t: T, orchestrator: string) {
	return await t.run((ctx) =>
		ctx.db.insert("diary", {
			date: "2026-09-29",
			orchestrator,
			content: "seed diary",
			createdAt: Date.now(),
		}),
	);
}

async function seedMessage(t: T, from: string) {
	return await t.run((ctx) =>
		ctx.db.insert("messages", {
			from,
			channel: "seat-x",
			content: "seed message",
			createdAt: Date.now(),
		}),
	);
}

async function seedMandate(t: T) {
	return await t.run((ctx) =>
		ctx.db.insert("mandates", {
			requestedBy: "seat-b",
			fulfilledBy: "seat-b",
			service: "svc",
			budget: 100,
			status: "requested",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
}

// ── briefingNotes.deleteBriefingNote ────────────────────────────────────────
describe("briefingNotes.deleteBriefingNote — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' on seat-b's note (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const noteId = await seedNote(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/Unauthorized: only seat-b \(creator\)/);
		expect(await t.run((ctx) => ctx.db.get(noteId))).not.toBeNull();
	});

	test("WITHHELD: member seat-a deleting its own note succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const noteId = await seedNote(t, "seat-a");
		const result = await asMemberOfOrgA(t).mutation(
			api.briefingNotes.deleteBriefingNote,
			{ noteId, callerOrchestrator: "seat-a" },
		);
		expect(result.deleted).toBe(true);
		expect(await t.run((ctx) => ctx.db.get(noteId))).toBeNull();
	});

	test("MASTER: the verified master typing 'system' still deletes", async () => {
		const t = createT();
		const noteId = await seedNote(t, "seat-b");
		const result = await asMaster(t).mutation(
			api.briefingNotes.deleteBriefingNote,
			{ noteId, callerOrchestrator: "system" },
		);
		expect(result.deleted).toBe(true);
	});
});

// ── briefingNotes.update ────────────────────────────────────────────────────
describe("briefingNotes.update — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' on seat-b's note (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const noteId = await seedNote(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "system",
				title: "hijacked",
			}),
		).rejects.toThrow(/Unauthorized: system is not creator/);
		const row = await t.run((ctx) => ctx.db.get(noteId));
		expect(row?.title).toBe("seed note");
	});

	test("WITHHELD: member seat-a updating its own note succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const noteId = await seedNote(t, "seat-a");
		await asMemberOfOrgA(t).mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "seat-a",
			title: "mine",
		});
		const row = await t.run((ctx) => ctx.db.get(noteId));
		expect(row?.title).toBe("mine");
	});

	test("MASTER: the verified master typing 'system' still updates", async () => {
		const t = createT();
		const noteId = await seedNote(t, "seat-b");
		await asMaster(t).mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "system",
			title: "by fleet",
		});
		const row = await t.run((ctx) => ctx.db.get(noteId));
		expect(row?.title).toBe("by fleet");
	});
});

// ── businessUnits.update ────────────────────────────────────────────────────
describe("businessUnits.update — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' on seat-b's BU (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const buId = await seedBU(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.businessUnits.update, {
				buId,
				callerOrchestrator: "system",
				description: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED: system is not the owning orchestrator \(seat-b\)/);
		const row = await t.run((ctx) => ctx.db.get(buId));
		expect(row?.description).toBe("d");
	});

	test("WITHHELD: member seat-a updating its own BU succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const buId = await seedBU(t, "seat-a");
		await asMemberOfOrgA(t).mutation(api.businessUnits.update, {
			buId,
			callerOrchestrator: "seat-a",
			description: "mine",
		});
		const row = await t.run((ctx) => ctx.db.get(buId));
		expect(row?.description).toBe("mine");
	});

	test("MASTER: the verified master typing 'system' still updates", async () => {
		const t = createT();
		const buId = await seedBU(t, "seat-b");
		await asMaster(t).mutation(api.businessUnits.update, {
			buId,
			callerOrchestrator: "system",
			description: "by fleet",
		});
		const row = await t.run((ctx) => ctx.db.get(buId));
		expect(row?.description).toBe("by fleet");
	});
});

// ── diary.deleteDiary ───────────────────────────────────────────────────────
describe("diary.deleteDiary — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' on seat-b's entry (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const diaryId = await seedDiary(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.diary.deleteDiary, {
				diaryId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/Unauthorized: only seat-b \(owner\)/);
		expect(await t.run((ctx) => ctx.db.get(diaryId))).not.toBeNull();
	});

	test("WITHHELD: member seat-a deleting its own entry succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const diaryId = await seedDiary(t, "seat-a");
		const result = await asMemberOfOrgA(t).mutation(api.diary.deleteDiary, {
			diaryId,
			callerOrchestrator: "seat-a",
		});
		expect(result.deleted).toBe(true);
		expect(await t.run((ctx) => ctx.db.get(diaryId))).toBeNull();
	});

	test("MASTER: the verified master typing 'system' still deletes", async () => {
		const t = createT();
		const diaryId = await seedDiary(t, "seat-b");
		const result = await asMaster(t).mutation(api.diary.deleteDiary, {
			diaryId,
			callerOrchestrator: "system",
		});
		expect(result.deleted).toBe(true);
	});
});

// ── messages.deleteMessage ──────────────────────────────────────────────────
describe("messages.deleteMessage — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' on seat-b's message (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const messageId = await seedMessage(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.messages.deleteMessage, {
				messageId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/Unauthorized: only seat-b \(sender\)/);
		expect(await t.run((ctx) => ctx.db.get(messageId))).not.toBeNull();
	});

	test("WITHHELD: member seat-a deleting its own message succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const messageId = await seedMessage(t, "seat-a");
		const result = await asMemberOfOrgA(t).mutation(api.messages.deleteMessage, {
			messageId,
			callerOrchestrator: "seat-a",
		});
		expect(result.deleted).toBe(true);
		expect(await t.run((ctx) => ctx.db.get(messageId))).toBeNull();
	});

	test("MASTER: the verified master typing 'system' still deletes", async () => {
		const t = createT();
		const messageId = await seedMessage(t, "seat-b");
		const result = await asMaster(t).mutation(api.messages.deleteMessage, {
			messageId,
			callerOrchestrator: "system",
		});
		expect(result.deleted).toBe(true);
	});
});

// ── missions.update (cancel branch — the only place the word is read) ──────
describe("missions.update — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' to cancel seat-b's mission (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const missionId = await seedMission(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.missions.update, {
				missionId,
				callerOrchestrator: "system",
				status: "cancelled",
				cancelReason: "hijack attempt",
			}),
		).rejects.toThrow(/RBAC_DENIED: Only seat-b \(creator\)/);
		const row = await t.run((ctx) => ctx.db.get(missionId));
		expect(row?.status).toBe("plan");
	});

	test("WITHHELD: member seat-a cancelling its own mission succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const missionId = await seedMission(t, "seat-a");
		await asMemberOfOrgA(t).mutation(api.missions.update, {
			missionId,
			callerOrchestrator: "seat-a",
			status: "cancelled",
			cancelReason: "mine to cancel",
		});
		const row = await t.run((ctx) => ctx.db.get(missionId));
		expect(row?.status).toBe("cancelled");
		expect(row?.cancelledBy).toBe("seat-a");
	});

	test("MASTER: the verified master typing 'system' still cancels", async () => {
		const t = createT();
		const missionId = await seedMission(t, "seat-b");
		await asMaster(t).mutation(api.missions.update, {
			missionId,
			callerOrchestrator: "system",
			status: "cancelled",
			cancelReason: "fleet cleanup",
		});
		const row = await t.run((ctx) => ctx.db.get(missionId));
		expect(row?.status).toBe("cancelled");
	});
});

// ── mandates.accept / update / settle ───────────────────────────────────────
// requireFleetMaster runs BEFORE the word: a member never reaches it. These
// poles pin that ordering AND the master-side ownership compare.
describe("mandates.{accept,update,settle} — the word 'system' is not authority", () => {
	test("LEAK: member typing 'system' on accept is refused before the word is read", async () => {
		const t = createT();
		await seedOrgA(t);
		const mandateId = await seedMandate(t);
		await expect(
			asMemberOfOrgA(t).mutation(api.mandates.accept, {
				mandateId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/RBAC_DENIED: caller may not accept mandate/);
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("requested");
	});

	test("LEAK: member typing 'system' on update is refused before the word is read", async () => {
		const t = createT();
		await seedOrgA(t);
		const mandateId = await seedMandate(t);
		await expect(
			asMemberOfOrgA(t).mutation(api.mandates.update, {
				mandateId,
				callerOrchestrator: "system",
				status: "delivered",
			}),
		).rejects.toThrow(/RBAC_DENIED: caller may not update mandate/);
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("requested");
	});

	test("LEAK: member typing 'system' on settle is refused before the word is read", async () => {
		const t = createT();
		await seedOrgA(t);
		const mandateId = await seedMandate(t);
		await expect(
			asMemberOfOrgA(t).mutation(api.mandates.settle, {
				mandateId,
				callerOrchestrator: "system",
				finalCost: 1,
			}),
		).rejects.toThrow(/RBAC_DENIED: caller may not settle mandate/);
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("requested");
	});

	test("MASTER: 'system' still accepts, updates and settles", async () => {
		const t = createT();
		const mandateId = await seedMandate(t);
		const tM = asMaster(t);
		await tM.mutation(api.mandates.accept, { mandateId, callerOrchestrator: "system" });
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("accepted");
		await tM.mutation(api.mandates.update, {
			mandateId,
			callerOrchestrator: "system",
			status: "delivered",
		});
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("delivered");
		await tM.mutation(api.mandates.settle, {
			mandateId,
			callerOrchestrator: "system",
			finalCost: 5,
		});
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("settled");
	});

	test("WITHHELD: master naming the row's own party still succeeds; a stranger name is refused", async () => {
		const t = createT();
		const mandateId = await seedMandate(t);
		const tM = asMaster(t);
		await expect(
			tM.mutation(api.mandates.accept, { mandateId, callerOrchestrator: "seat-a" }),
		).rejects.toThrow(/Unauthorized: only seat-b \(fulfilledBy\)/);
		await tM.mutation(api.mandates.accept, { mandateId, callerOrchestrator: "seat-b" });
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("accepted");
		await expect(
			tM.mutation(api.mandates.settle, {
				mandateId,
				callerOrchestrator: "seat-a",
				finalCost: 1,
			}),
		).rejects.toThrow(/Unauthorized: only seat-b \(requestedBy\)/);
	});
});

// ── the CLASS, structurally ─────────────────────────────────────────────────
// The mandates.* sites are reachable only by the verified master, for whom the
// typed-word compare and `isFleetSystemCaller` are observationally identical —
// no behavioural pole can tell them apart. This scan pins the CLASS instead:
// outside the shared predicate, no convex module may compare a caller name to
// the literal "system". A per-file variant is how a boundary drifts.
describe("the word 'system' is compared in exactly one place", () => {
	test("no convex source compares a caller to the literal outside lib/systemCaller.ts", () => {
		const sources = import.meta.glob(["../*.ts", "../lib/*.ts"], {
			query: "?raw",
			import: "default",
			eager: true,
		}) as Record<string, string>;
		const typedWord =
			/(callerOrchestrator|caller)[A-Za-z.]*\s*(===|!==)\s*["']system["']/;
		const offenders = Object.entries(sources)
			.filter(([path]) => !path.endsWith("lib/systemCaller.ts"))
			.filter(([path]) => !/\.test\.ts$/.test(path))
			.filter(([, src]) => typedWord.test(src))
			.map(([path]) => path);
		expect(Object.keys(sources).length).toBeGreaterThan(20);
		expect(offenders).toEqual([]);
	});
});
