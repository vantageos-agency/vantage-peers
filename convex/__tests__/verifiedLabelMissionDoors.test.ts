/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * Identity-zero slice 2a-ter (task k1778c2hvae8e8vz9f5bbbbbb98g62hw): the rule of
 * slice 2a-bis extended to the mission, recurring-task and briefing-note doors.
 * Once a call's identity is proven BY ID (verifiedActor), a claimed name carries
 * no authority and is never written: the door decides on, and writes, the label
 * of the VERIFIED ROW. A mismatching asserted name is refused
 * AGENT_IDENTITY_MISMATCH with nothing written.
 *
 * Door families: missions (create, update/cancel), recurring tasks (create,
 * pause), briefing notes (create, update, deleteBriefingNote).
 *
 * Poles per family: REFUSE (another orchestrator's name), ALLOW (own name),
 * ATTRIBUTION (the written name equals the row's name, not the padded claim),
 * AUTHORITY (the word "system" asserted by a non-fleet verified row).
 */

import { ConvexError } from "convex/values";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
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

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;
const svc = (t: T) => t.withIdentity({ subject: "test-service-account-user-id" });

type World = {
	t: T;
	orgSlug: string;
	// "Quill": the verified author / creator, stored label with a capital Q.
	quill: Id<"agents">;
	// "System": a verified agent whose stored label normalises to the fleet word.
	systemRow: Id<"agents">;
};

async function world(): Promise<World> {
	const t = createT();
	await seedFleetAgents(t, ["eta", "pi", "sigma"]);
	const seeded = await t.run(async (ctx) => {
		const op = (await ctx.db.query("client_org_mapping").collect()).find(
			(m) => m.orgKind === "operator",
		);
		if (op === undefined) throw new Error("fixture: no operator org");
		const put = (name: string) =>
			ctx.db.insert("agents", {
				orgSlug: op.clerkOrgSlug,
				name,
				normalizedName: name.toLowerCase(),
				isActive: true,
				createdAt: 1,
			});
		return {
			orgSlug: op.clerkOrgSlug,
			quill: await put("Quill"),
			systemRow: await put("System"),
		};
	});
	return { t, ...seeded };
}

const proofOf = (agentId: Id<"agents">, orgSlug: string) => ({
	verifiedActor: { agentId, orgSlug },
});

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "NO_ERROR";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		return text.replace(/^"/, "").split(":")[0] ?? text;
	}
}

// ─── missions ────────────────────────────────────────────────────────────────

const missionArgs = (createdBy: string) => ({
	name: "m",
	project: "p",
	status: "plan" as const,
	priority: "medium" as const,
	pilot: "eta",
	agents: [] as string[],
	createdBy,
});

const createMission = (w: World, createdBy: string, as: Id<"agents">) =>
	svc(w.t).mutation(api.missions.create, {
		...missionArgs(createdBy),
		...proofOf(as, w.orgSlug),
	} as never);

const missionRows = (w: World) =>
	w.t.run(async (ctx) => await ctx.db.query("missions").collect());

describe("family 1: missions", () => {
	test("ALLOW + ATTRIBUTION: create under a padded claim writes the ROW's label as createdBy", async () => {
		const w = await world();
		const got = await code(createMission(w, " QUILL ", w.quill));
		expect(got).toBe("NO_ERROR");
		const rows = await missionRows(w);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.createdBy).toBe("Quill");
		expect(rows[0]?.createdById).toBe(w.quill);
	});
	test("REFUSE: create asserting another orchestrator's name -> AGENT_IDENTITY_MISMATCH, zero rows", async () => {
		const w = await world();
		expect(await code(createMission(w, "pi", w.quill))).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await missionRows(w)).toHaveLength(0);
	});

	const cancel = (w: World, asserted: string, as: Id<"agents">, missionId: Id<"missions">) =>
		code(
			svc(w.t).mutation(api.missions.update, {
				missionId,
				callerOrchestrator: asserted,
				status: "cancelled",
				cancelReason: "operator order",
				...proofOf(as, w.orgSlug),
			} as never),
		);
	const seeded = async (w: World): Promise<Id<"missions">> => {
		await createMission(w, "Quill", w.quill);
		const rows = await missionRows(w);
		return rows[0]?._id as Id<"missions">;
	};

	test("ALLOW + ATTRIBUTION: the verified creator cancels; cancelledBy is the ROW's label", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await cancel(w, " QUILL ", w.quill, id)).toBe("NO_ERROR");
		const m = await w.t.run((ctx) => ctx.db.get(id));
		expect(m?.status).toBe("cancelled");
		expect(m?.cancelledBy).toBe("Quill");
	});
	test("REFUSE: cancel asserting another orchestrator's name -> AGENT_IDENTITY_MISMATCH, mission untouched", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await cancel(w, "pi", w.quill, id)).toBe("AGENT_IDENTITY_MISMATCH");
		const m = await w.t.run((ctx) => ctx.db.get(id));
		expect(m?.status).toBe("plan");
		expect(m?.cancelledBy).toBeUndefined();
	});
	test("AUTHORITY: a verified non-fleet row labelled 'System' asserting 'system' is NOT fleet system", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await cancel(w, "system", w.systemRow, id)).toBe("RBAC_DENIED");
		const m = await w.t.run((ctx) => ctx.db.get(id));
		expect(m?.status).toBe("plan");
	});
	test("UNPROVEN unchanged: the service account with no proof and the word 'system' still cancels", async () => {
		const w = await world();
		const id = await seeded(w);
		const got = await code(
			svc(w.t).mutation(api.missions.update, {
				missionId: id,
				callerOrchestrator: "system",
				status: "cancelled",
				cancelReason: "operator order",
			} as never),
		);
		expect(got).toBe("NO_ERROR");
		expect((await w.t.run((ctx) => ctx.db.get(id)))?.cancelledBy).toBe("system");
	});
});

// ─── recurring tasks ─────────────────────────────────────────────────────────

const scheduleArgs = (createdBy: string) => ({
	title: "weekly chore",
	assignedTo: "eta",
	priority: "low" as const,
	cronExpression: "0 9 * * *",
	createdBy,
});

const createSchedule = (w: World, createdBy: string, as: Id<"agents">) =>
	svc(w.t).mutation(api.recurringTasks.create, {
		...scheduleArgs(createdBy),
		...proofOf(as, w.orgSlug),
	} as never);

const scheduleRows = (w: World) =>
	w.t.run(async (ctx) => await ctx.db.query("recurringTasks").collect());

describe("family 2: recurring tasks", () => {
	test("ALLOW + ATTRIBUTION: create under a padded claim writes the ROW's label as createdBy", async () => {
		const w = await world();
		expect(await code(createSchedule(w, " QUILL ", w.quill))).toBe("NO_ERROR");
		const rows = await scheduleRows(w);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.createdBy).toBe("Quill");
		expect(rows[0]?.createdById).toBe(w.quill);
	});
	test("REFUSE: create asserting another orchestrator's name -> AGENT_IDENTITY_MISMATCH, zero rows", async () => {
		const w = await world();
		expect(await code(createSchedule(w, "pi", w.quill))).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await scheduleRows(w)).toHaveLength(0);
	});
	test("AUTHORITY (by ID, pinned): a verified 'System' row asserting 'system' creates under its own label, not the fleet word", async () => {
		const w = await world();
		expect(await code(createSchedule(w, "system", w.systemRow))).toBe("NO_ERROR");
		const rows = await scheduleRows(w);
		expect(rows[0]?.createdBy).toBe("System");
		expect(rows[0]?.createdById).toBe(w.systemRow);
	});

	const pause = (w: World, asserted: string, as: Id<"agents">, taskId: Id<"recurringTasks">) =>
		code(
			svc(w.t).mutation(api.recurringTasks.pause, {
				taskId,
				callerOrchestrator: asserted,
				...proofOf(as, w.orgSlug),
			} as never),
		);
	const seeded = async (w: World): Promise<Id<"recurringTasks">> => {
		await createSchedule(w, "Quill", w.quill);
		return (await scheduleRows(w))[0]?._id as Id<"recurringTasks">;
	};
	const active = async (w: World, id: Id<"recurringTasks">) =>
		(await w.t.run((ctx) => ctx.db.get(id)))?.active;

	test("ALLOW (by ID, pinned): the verified creator pauses under a padded claim", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await pause(w, " quill ", w.quill, id)).toBe("NO_ERROR");
		expect(await active(w, id)).toBe(false);
	});
	test("REFUSE (pinned): another orchestrator's name -> AGENT_IDENTITY_MISMATCH, still active", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await pause(w, "pi", w.quill, id)).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await active(w, id)).toBe(true);
	});
	test("AUTHORITY (by ID, pinned): a verified 'System' row asserting 'system' cannot pause another's schedule", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await pause(w, "system", w.systemRow, id)).toBe("RBAC_DENIED");
		expect(await active(w, id)).toBe(true);
	});
});

// ─── briefing notes ──────────────────────────────────────────────────────────

const noteArgs = (createdBy: string) => ({
	title: "t",
	topic: "topic",
	participants: ["Quill"],
	content: "body",
	createdBy,
});

const createNote = (w: World, createdBy: string, as: Id<"agents">) =>
	svc(w.t).mutation(api.briefingNotes.create, {
		...noteArgs(createdBy),
		...proofOf(as, w.orgSlug),
	} as never);

const noteRows = (w: World) =>
	w.t.run(async (ctx) => await ctx.db.query("briefingNotes").collect());

describe("family 3: briefing notes", () => {
	test("ALLOW + ATTRIBUTION: create under a padded claim writes the ROW's label as createdBy", async () => {
		const w = await world();
		expect(await code(createNote(w, " QUILL ", w.quill))).toBe("NO_ERROR");
		const rows = await noteRows(w);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.createdBy).toBe("Quill");
		expect(rows[0]?.createdById).toBe(w.quill);
	});
	test("REFUSE: create asserting another orchestrator's name -> AGENT_IDENTITY_MISMATCH, zero rows", async () => {
		const w = await world();
		expect(await code(createNote(w, "pi", w.quill))).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await noteRows(w)).toHaveLength(0);
	});

	const seeded = async (w: World): Promise<Id<"briefingNotes">> => {
		await createNote(w, "Quill", w.quill);
		return (await noteRows(w))[0]?._id as Id<"briefingNotes">;
	};
	const update = (w: World, asserted: string, as: Id<"agents">, noteId: Id<"briefingNotes">) =>
		code(
			svc(w.t).mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: asserted,
				title: "edited",
				...proofOf(as, w.orgSlug),
			} as never),
		);
	const del = (w: World, asserted: string, as: Id<"agents">, noteId: Id<"briefingNotes">) =>
		code(
			svc(w.t).mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: asserted,
				...proofOf(as, w.orgSlug),
			} as never),
		);
	const note = (w: World, id: Id<"briefingNotes">) => w.t.run((ctx) => ctx.db.get(id));

	test("ALLOW + ATTRIBUTION: update by the verified author; updatedBy is the ROW's label", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await update(w, " QUILL ", w.quill, id)).toBe("NO_ERROR");
		const n = await note(w, id);
		expect(n?.title).toBe("edited");
		expect(n?.updatedBy).toBe("Quill");
	});
	test("REFUSE: update asserting another orchestrator's name -> AGENT_IDENTITY_MISMATCH, note untouched", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await update(w, "pi", w.quill, id)).toBe("AGENT_IDENTITY_MISMATCH");
		const n = await note(w, id);
		expect(n?.title).toBe("t");
		expect(n?.updatedBy).toBeUndefined();
	});
	test("AUTHORITY: a verified 'System' row asserting 'system' cannot update another's note", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await update(w, "system", w.systemRow, id)).toBe("RBAC_DENIED");
		expect((await note(w, id))?.title).toBe("t");
	});
	test("ALLOW: delete by the verified author under a padded claim", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await del(w, " quill ", w.quill, id)).toBe("NO_ERROR");
		expect(await note(w, id)).toBeNull();
	});
	test("REFUSE: delete asserting another orchestrator's name -> AGENT_IDENTITY_MISMATCH, note kept", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await del(w, "pi", w.quill, id)).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await note(w, id)).not.toBeNull();
	});
	test("AUTHORITY: a verified 'System' row asserting 'system' cannot delete another's note", async () => {
		const w = await world();
		const id = await seeded(w);
		expect(await del(w, "system", w.systemRow, id)).toBe("RBAC_DENIED");
		expect(await note(w, id)).not.toBeNull();
	});
	test("UNPROVEN unchanged: the service account with no proof and the word 'system' still deletes", async () => {
		const w = await world();
		const id = await seeded(w);
		const got = await code(
			svc(w.t).mutation(api.briefingNotes.deleteBriefingNote, {
				noteId: id,
				callerOrchestrator: "system",
			} as never),
		);
		expect(got).toBe("NO_ERROR");
		expect(await note(w, id)).toBeNull();
	});
});

// ─── source scan ─────────────────────────────────────────────────────────────

describe("source scan: no door reads the asserted name for authority or attribution on a proven call", () => {
	const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
	const missions = read("../missions.ts");
	const recurring = read("../recurringTasks.ts");
	const briefing = read("../briefingNotes.ts");
	const actors = read("../lib/missionActors.ts");
	const hitsOf = (src: string, res: RegExp[]) => res.flatMap((re) => src.match(re) ?? []);

	test("missionActors.ts: the verified row's label returned by the lock is kept, not discarded", () => {
		// A bare statement `await requireAgentCredentialMatch(` throws the label away.
		expect(hitsOf(actors, [/^\s*await requireAgentCredentialMatch\(/gm])).toEqual([]);
	});
	test("missions.ts: the cancel authority, cancelledBy and createdBy take the derived label", () => {
		expect(
			hitsOf(missions, [
				/isFleetSystemCaller\(\s*scope,\s*callerOrchestrator\s*\)/g,
				/cancelledBy\s*=\s*callerOrchestrator\b/g,
				/createdBy:\s*\(claimedCreator\s*\?\?\s*actor\)/g,
			]),
		).toEqual([]);
	});
	test("recurringTasks.ts: the schedule's createdBy is the derived label", () => {
		expect(hitsOf(recurring, [/args\.createdBy\s*!==\s*undefined\s*\?\s*args\.createdBy\b/g])).toEqual([]);
	});
	test("briefingNotes.ts: authority predicates and attribution writes take the derived label", () => {
		expect(
			hitsOf(briefing, [
				/isFleetSystemCaller\(\s*scope,\s*(?:args\.)?callerOrchestrator\s*\)/g,
				/createdBy\s*=\s*claimedCreator\s*;/g,
				/actor\s*=\s*callerOrchestrator\s*;/g,
			]),
		).toEqual([]);
	});
});
