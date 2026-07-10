/// <reference types="vite/client" />
//
// Issue #1064 extension (slice 3) — missions:get, mirroring briefingNotes:get
// (PR #1075) and messages:getById (PR #1076).
//
// `missions:get` takes `v.id("missions")`. A well-formed ID from another
// table passes the MCP boundary regex (#1065) and dies one layer down, where
// Convex redacts the validator's message in prod. The caller sees
// `[Request ID: …] Server Error` with `error.data` undefined — nothing to
// act on.
//
// Same contract as PR #1069 / #1072 / #1075 / #1076: the `v.id()` validator
// runs BEFORE the handler, so there is no seam to intercept while it is in
// place. Relax to `v.string()`, then `ctx.db.normalizeId` per argument,
// throwing a structured `ConvexError` naming the offending argument.

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
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

type WrongTablePayload = {
	path?: string;
	expectedTable?: string;
	receivedId?: string;
	message?: string;
};

// `ConvexError.data` is a JSON string under convex-test and the thrown object
// in prod — both measured. Accept both.
const decodePayload = (caught: unknown): WrongTablePayload => {
	const raw = (caught as ConvexError<string | WrongTablePayload>).data;
	return typeof raw === "string" ? (JSON.parse(raw) as WrongTablePayload) : raw;
};

const newMission = (t: ReturnType<typeof createT>) =>
	t.mutation(api.missions.create, {
		name: "Probe mission",
		project: "vantage-peers",
		status: "plan",
		priority: "medium",
		pilot: "sigma",
		agents: ["sigma"],
		createdBy: "sigma",
	});

const newTask = (t: ReturnType<typeof createT>) =>
	t.mutation(api.tasks.create, {
		title: "Probe task",
		assignedTo: "sigma",
		priority: "low",
		status: "todo",
		createdBy: "sigma",
	});

describe("missions:get — wrong-table ID (issue #1064, reads)", () => {
	test("a messages-table ID yields an actionable ConvexError naming missionId", async () => {
		const t = createT();
		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "sigma",
			content: "probe",
		});

		let caught: unknown;
		try {
			await t.query(api.missions.get, {
				missionId: messageId as unknown as Id<"missions">,
			});
			throw new Error("get did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.path).toBe("missionId");
		expect(payload?.expectedTable).toBe("missions");
		expect(payload?.receivedId).toBe(messageId);
		expect(payload?.message).toContain("missionId");
		expect(payload?.message).toContain("missions");
		// Literal hint string (not the imported constant) — a mutant that empties
		// the hint at the call-site must redden this.
		expect(payload?.message).toBe(
			"missionId is not a valid missions ID. Use the full 32-char missionId returned by list_missions or create_mission.",
		);
		expect(payload?.message).not.toBe(
			"missionId is not a valid missions ID.",
		);
	});

	test("negative control: an ID from a THIRD table is also named, with its own value", async () => {
		const t = createT();
		const taskId = await newTask(t);

		let caught: unknown;
		try {
			await t.query(api.missions.get, {
				missionId: taskId as unknown as Id<"missions">,
			});
			throw new Error("get did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.expectedTable).toBe("missions");
		expect(payload?.receivedId).toBe(taskId);
	});

	test("positive control: a real missionId still returns the document", async () => {
		const t = createT();
		const missionId = await newMission(t);
		const doc = await t.query(api.missions.get, { missionId });
		expect(doc?._id).toBe(missionId);
		expect(doc?.name).toBe("Probe mission");
	});

	test("contract preserved: a valid missions ID that no longer exists returns null, does NOT throw", async () => {
		const t = createT();
		const missionId = await newMission(t);
		await t.run(async (ctx) => {
			await ctx.db.delete(missionId);
		});

		// A well-formed ID of the RIGHT table pointing at a deleted doc must stay
		// a `null` return, not an error. Widening the validator must not turn a
		// benign miss into a throw.
		await expect(
			t.query(api.missions.get, { missionId }),
		).resolves.toBeNull();
	});
});
