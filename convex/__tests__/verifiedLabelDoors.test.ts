/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * Identity-zero slice 2a-bis (task k1728vgv6qhpy1ak3x171f2hh58gjcyx): once a
 * call's identity is proven BY ID (verifiedActor), a claimed name carries no
 * authority. Every door that uses the caller's name for an authority decision
 * or a written attribution uses the label of the VERIFIED ROW, never the
 * asserted string. The asserted name is still compared (a mismatch is refused
 * AGENT_IDENTITY_MISMATCH, nothing written) - it is never overwritten silently.
 *
 * Door families: reassign review task, cancel automation task, attach review
 * artifact, fleet-system check (the word "system"), sendMessage `from`.
 *
 * Poles per family: REFUSE (another orchestrator's name), ALLOW (own name),
 * ATTRIBUTION (the written field equals the row's name, not the padded or
 * re-cased claim), AUTHORITY (the decision reads the row label).
 */

import { ConvexError } from "convex/values";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { insertTaskRow, seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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
	// "Quill": a coordinator / canceller whose stored label has a capital Q.
	quill: Id<"agents">;
	// "System": a verified agent whose stored label normalises to the fleet word.
	systemRow: Id<"agents">;
	// "Quill" again, in a client org with a roster, for the messaging family.
	quillInClientOrg: Id<"agents">;
};

const CLIENT_ORG = "org-a";

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
		const quill = await put("Quill");
		const systemRow = await put("System");
		await ctx.db.insert("taskClosureConfig", {
			key: "reviewCoordinators",
			value: ["quill"],
			updatedAt: 0,
		});
		await ctx.db.insert("taskClosureConfig", {
			key: "automationTaskCancellers",
			value: ["quill"],
			updatedAt: 0,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: CLIENT_ORG,
			clerkOrgId: testClerkOrgId(CLIENT_ORG),
			allowedOrchestrators: ["quill", "peer"],
			scopes: ["view-own-tasks"],
			displayName: CLIENT_ORG,
			isActive: true,
			createdAt: 1,
		});
		const inClient = (name: string) =>
			ctx.db.insert("agents", {
				orgSlug: CLIENT_ORG,
				clerkOrgId: testClerkOrgId(CLIENT_ORG),
				name,
				normalizedName: name.toLowerCase(),
				isActive: true,
				createdAt: 1,
			});
		const quillInClientOrg = await inClient("Quill");
		await inClient("peer");
		await ctx.db.insert("profiles", {
			orchestratorId: "peer",
			name: "peer",
			static: { role: "peer", workspace: "w", capabilities: [] },
			dynamic: { lastSeen: 1, sessionCount: 1 },
		});
		return { orgSlug: op.clerkOrgSlug, quill, systemRow, quillInClientOrg };
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

const rowOf = (t: T, id: Id<"tasks">) =>
	t.run(async (ctx) => (await ctx.db.get(id)) as Record<string, unknown>);

const reviewTask = (t: T) =>
	t.run(async (ctx) =>
		insertTaskRow(ctx, {
			title: "[REVIEW] automation review",
			assignedTo: "eta",
			createdBy: "system",
			priority: "medium",
			status: "todo",
			origin: "automation",
			isReviewTask: true,
			createdAt: 1,
			updatedAt: 1,
		}),
	);

const chainTask = (t: T) =>
	t.run(async (ctx) =>
		insertTaskRow(ctx, {
			title: "chain step",
			assignedTo: "sigma",
			createdBy: "system",
			priority: "high",
			status: "todo",
			origin: "automation",
			createdAt: 1,
			updatedAt: 1,
		}),
	);

const plainTask = (t: T, createdBy: string) =>
	t.run(async (ctx) =>
		insertTaskRow(ctx, {
			title: "plain chore",
			assignedTo: "sigma",
			createdBy,
			priority: "low",
			status: "todo",
			createdAt: 1,
			updatedAt: 1,
		}),
	);

describe("family 1: reassign review task", () => {
	test("ALLOW: the verified coordinator under its own label (padded, re-cased) reassigns", async () => {
		const w = await world();
		const id = await reviewTask(w.t);
		const got = await code(
			svc(w.t).mutation(api.tasks.update, {
				taskId: id,
				callerOrchestrator: " QUILL ",
				assignedTo: "pi",
				...proofOf(w.quill, w.orgSlug),
			} as never),
		);
		expect(got).toBe("NO_ERROR");
		expect((await rowOf(w.t, id)).assignedTo).toBe("pi");
	});
	test("REFUSE: the verified coordinator asserting another orchestrator's name -> AGENT_IDENTITY_MISMATCH, nothing changed", async () => {
		const w = await world();
		const id = await reviewTask(w.t);
		const got = await code(
			svc(w.t).mutation(api.tasks.update, {
				taskId: id,
				callerOrchestrator: "pi",
				assignedTo: "pi",
				...proofOf(w.quill, w.orgSlug),
			} as never),
		);
		expect(got).toBe("AGENT_IDENTITY_MISMATCH");
		expect((await rowOf(w.t, id)).assignedTo).toBe("eta");
	});
});

describe("family 2: cancel automation task", () => {
	test("ALLOW + ATTRIBUTION: the verified canceller cancels; cancelledBy is the ROW's label", async () => {
		const w = await world();
		const id = await chainTask(w.t);
		const got = await code(
			svc(w.t).mutation(api.tasks.update, {
				taskId: id,
				callerOrchestrator: " QUILL ",
				status: "cancelled",
				cancelReason: "operator order",
				...proofOf(w.quill, w.orgSlug),
			} as never),
		);
		expect(got).toBe("NO_ERROR");
		const r = await rowOf(w.t, id);
		expect(r.status).toBe("cancelled");
		expect(r.cancelledBy).toBe("Quill");
	});
	test("REFUSE: another orchestrator's name -> AGENT_IDENTITY_MISMATCH, task untouched", async () => {
		const w = await world();
		const id = await chainTask(w.t);
		const got = await code(
			svc(w.t).mutation(api.tasks.update, {
				taskId: id,
				callerOrchestrator: "pi",
				status: "cancelled",
				cancelReason: "operator order",
				...proofOf(w.quill, w.orgSlug),
			} as never),
		);
		expect(got).toBe("AGENT_IDENTITY_MISMATCH");
		const r = await rowOf(w.t, id);
		expect(r.status).toBe("todo");
		expect(r.cancelledBy).toBeUndefined();
	});
});

describe("family 3: attach review artifact", () => {
	const attach = (w: World, id: Id<"tasks">, asserted: string) =>
		code(
			svc(w.t).mutation(api.tasks.attachReviewArtifact, {
				taskId: id,
				callerOrchestrator: asserted,
				artifactRef: "https://example.test/pull/1",
				...proofOf(w.quill, w.orgSlug),
			} as never),
		);

	test("ALLOW + ATTRIBUTION: reviewArtifactAttachedBy is the ROW's label, not the padded claim", async () => {
		const w = await world();
		const id = await reviewTask(w.t);
		expect(await attach(w, id, " quill ")).toBe("NO_ERROR");
		expect((await rowOf(w.t, id)).reviewArtifactAttachedBy).toBe("Quill");
	});
	test("REFUSE: another orchestrator's name -> AGENT_IDENTITY_MISMATCH, nothing written", async () => {
		const w = await world();
		const id = await reviewTask(w.t);
		expect(await attach(w, id, "pi")).toBe("AGENT_IDENTITY_MISMATCH");
		const r = await rowOf(w.t, id);
		expect(r.reviewArtifactRef).toBeUndefined();
		expect(r.reviewArtifactAttachedBy).toBeUndefined();
	});
});

describe("family 4: the fleet-system word is earned by the row, not the claim", () => {
	const del = (w: World, id: Id<"tasks">, asserted: string, proven: boolean) =>
		code(
			svc(w.t).mutation(api.tasks.deleteTask, {
				taskId: id,
				callerOrchestrator: asserted,
				...(proven ? proofOf(w.systemRow, w.orgSlug) : {}),
			} as never),
		);
	const exists = (w: World, id: Id<"tasks">) =>
		w.t.run(async (ctx) => (await ctx.db.get(id)) !== null);

	test("AUTHORITY: a verified non-fleet agent whose row label is 'System' (asserting 'system') is NOT fleet system", async () => {
		const w = await world();
		const id = await plainTask(w.t, "pi");
		expect(await del(w, id, "system", true)).toBe("RBAC_DENIED");
		expect(await exists(w, id)).toBe(true);
	});
	test("REFUSE: the verified 'System' row asserting another name -> AGENT_IDENTITY_MISMATCH", async () => {
		const w = await world();
		const id = await plainTask(w.t, "pi");
		expect(await del(w, id, "pi", true)).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await exists(w, id)).toBe(true);
	});
	test("UNPROVEN unchanged: the service account with no proof and the word 'system' still deletes", async () => {
		const w = await world();
		const id = await plainTask(w.t, "pi");
		expect(await del(w, id, "system", false)).toBe("NO_ERROR");
		expect(await exists(w, id)).toBe(false);
	});
});

describe("family 5: sendMessage `from` is the verified row's label", () => {
	const send = (w: World, from: string) =>
		code(
			svc(w.t).mutation(api.messages.sendMessage, {
				from,
				channel: "peer",
				content: "hello",
				seatOrgSlug: CLIENT_ORG,
				...proofOf(w.quillInClientOrg, CLIENT_ORG),
			} as never),
		);
	const stored = (w: World) =>
		w.t.run(async (ctx) =>
			(await ctx.db.query("messages").collect()).map((m) => m.from),
		);

	test("ALLOW + ATTRIBUTION: the written `from` equals the row's name", async () => {
		const w = await world();
		expect(await send(w, " QUILL")).toBe("NO_ERROR");
		expect(await stored(w)).toEqual(["Quill"]);
	});
	test("REFUSE: another orchestrator's name -> AGENT_IDENTITY_MISMATCH, no message written", async () => {
		const w = await world();
		expect(await send(w, "pi")).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await stored(w)).toEqual([]);
	});
});

describe("source scan: no door reads the asserted name for authority or attribution on a proven call", () => {
	const tasks = readFileSync(new URL("../tasks.ts", import.meta.url), "utf8");
	const messages = readFileSync(new URL("../messages.ts", import.meta.url), "utf8");
	const asserted = String.raw`(?:args\.)?callerOrchestrator`;

	test("tasks.ts: authority predicates and attribution writes take the derived label", () => {
		const bad = [
			new RegExp(String.raw`isFleetSystemCaller\(\s*callerScope,\s*${asserted}\s*\)`, "g"),
			new RegExp(String.raw`mayReassignReviewTask\(\s*ctx,\s*${asserted}\b`, "g"),
			new RegExp(String.raw`mayCancelAutomationTask\(\s*ctx,\s*${asserted}\s*\)`, "g"),
			new RegExp(String.raw`reviewArtifactAttachedBy:\s*${asserted}\b`, "g"),
			new RegExp(String.raw`cancelledBy\s*=\s*memberActor\s*\?\?\s*${asserted}\b`, "g"),
		];
		const hits = bad.flatMap((re) => tasks.match(re) ?? []);
		expect(hits).toEqual([]);
	});
	test("messages.ts: the sender written by sendMessage is the derived label", () => {
		const call = /return await sendMessageCore\(\s*ctx,\s*\{ \.\.\.sendArgs, from, fromInstanceId \}/;
		expect(call.test(messages)).toBe(true);
		expect(/const from = provenLabel \?\? assertedFrom;/.test(messages)).toBe(true);
	});
});
