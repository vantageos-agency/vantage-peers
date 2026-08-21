/// <reference types="vite/client" />
//
// Issue #1064 extension — businessUnits:get, mirroring tasks:getById (PR #1072).
//
// `businessUnits:get` takes `v.id("businessUnits")`. A well-formed ID from
// another table passes the MCP boundary regex (#1065) and dies one layer
// down, where Convex redacts the validator's message in prod. The caller
// sees `[Request ID: …] Server Error` with `error.data` undefined — nothing
// to act on.
//
// Same contract as PR #1069 (`markAsRead`) and #1072 (`tasks.getById`): the
// `v.id()` validator runs BEFORE the handler, so there is no seam to
// intercept while it is in place. Relax to `v.string()`, then
// `ctx.db.normalizeId` per argument, throwing a structured `ConvexError`
// naming the offending argument.

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

function createT(): ReturnType<typeof convexTest> {
	return convexTest(schema, modules).withIdentity({
		subject: "test-service-account-user-id",
	}) as unknown as ReturnType<typeof convexTest>;
}

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

const newBu = (t: ReturnType<typeof createT>) =>
	t.mutation(api.businessUnits.create, {
		name: "Probe BU",
		description: "probe",
		purpose: "probe",
		orchestratorId: "sigma",
		status: "idea",
		businessModel: "probe",
		targetCustomers: "probe",
		services: ["probe"],
		pricing: "probe",
		revenueProjections: { y1: 0, y2: 0, y3: 0 },
		coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
		coreProcesses: ["probe"],
		dependencies: [],
		kpis: [],
	});

const newTask = (t: ReturnType<typeof createT>) =>
	t.mutation(api.tasks.create, {
		title: "Probe task",
		assignedTo: "sigma",
		priority: "low",
		status: "todo",
		createdBy: "sigma",
	});

describe("businessUnits:get — wrong-table ID (issue #1064, reads)", () => {
	test("a messages-table ID yields an actionable ConvexError naming buId", async () => {
		const t = createT();
		await t.run((ctx) =>
			ctx.db.insert("profiles", {
				orchestratorId: "sigma",
				name: "sigma",
				static: { role: "sigma", workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			}),
		);
		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "sigma",
			content: "probe",
		});

		let caught: unknown;
		try {
			await t.query(api.businessUnits.get, {
				buId: messageId as unknown as Id<"businessUnits">,
			});
			throw new Error("get did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.path).toBe("buId");
		expect(payload?.expectedTable).toBe("businessUnits");
		expect(payload?.receivedId).toBe(messageId);
		expect(payload?.message).toContain("buId");
		expect(payload?.message).toContain("businessUnits");
		// Literal hint string (not the imported constant) — a mutant that empties
		// the hint at the call-site must redden this.
		expect(payload?.message).toBe(
			"buId is not a valid businessUnits ID. Use the full 32-char buId returned by businessUnits.list or businessUnits.create.",
		);
		expect(payload?.message).not.toBe(
			"buId is not a valid businessUnits ID.",
		);
	});

	test("negative control: an ID from a THIRD table is also named, with its own value", async () => {
		const t = createT();
		const taskId = await newTask(t);

		let caught: unknown;
		try {
			await t.query(api.businessUnits.get, {
				buId: taskId as unknown as Id<"businessUnits">,
			});
			throw new Error("get did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.expectedTable).toBe("businessUnits");
		expect(payload?.receivedId).toBe(taskId);
	});

	test("positive control: a real buId still returns the document", async () => {
		const t = createT();
		const buId = await newBu(t);
		const doc = await t.query(api.businessUnits.get, { buId });
		expect(doc?._id).toBe(buId);
		expect(doc?.name).toBe("Probe BU");
	});

	test("contract preserved: a valid businessUnits ID that no longer exists returns null, does NOT throw", async () => {
		const t = createT();
		const buId = await newBu(t);
		await t.run(async (ctx) => {
			await ctx.db.delete(buId);
		});

		// A well-formed ID of the RIGHT table pointing at a deleted doc must stay
		// a `null` return, not an error. Widening the validator must not turn a
		// benign miss into a throw.
		await expect(t.query(api.businessUnits.get, { buId })).resolves.toBeNull();
	});
});
