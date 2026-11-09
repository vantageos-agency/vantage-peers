/**
 * Task k175gqdsd7ntr10g0k4rc18r998hf2hq — VantagePeers Cloud: every MCP write
 * door is proven under a SCOPED ORG-AGENT SEAT, at both poles.
 *
 * WHY. Commit c5348d65 (2026-11-01) made the service account acting for an
 * organisation an ORDINARY MEMBER. Client seats lost writes and every suite
 * stayed green, because the existing door suites call Convex as the fleet
 * master (no `__actingOrg`) or as a hand-built identity, so nothing asserted the
 * ALLOW pole under the identity production actually presents.
 *
 * THE SEAT. The identity here is the production one end to end: a NON-master
 * OAuthContext carrying its verified `orgClerkId` and its verified agent proof
 * (`actor.agentId`), driving the REAL tool handler (`registerTools`), whose
 * Convex client is wrapped by `withActingOrg` exactly as
 * `selectConvexClientForRequest` wraps it. The fleet service account is the
 * transport; the call reaches Convex as an ordinary member of the acting org.
 * The master never appears on an ALLOW or REFUSED pole of a two-pole door.
 *
 * POLES per two-pole door (the seat is org A's):
 *   ALLOW    the seat acts on org A's own row / namespace / recipients -> the
 *            write lands;
 *   CROSS    the same seat aims at org B's row / namespace / recipients -> an
 *            error result, and org B's state is byte-identical afterwards.
 * A master-only door asserts the seat REFUSAL instead (and the row unchanged).
 *
 * The inventory is DERIVED, not typed: `.backend-doctor/vp-writer-tier.csv` and
 * `.backend-doctor/vp-by-tool.csv` list the write doors; the guard at the foot of
 * this file fails when a CSV write door has no entry in SEAT_COVERAGE, and an
 * exemption needs a reason.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api.js";
import schema from "../../../convex/schema.js";
import { convexTest } from "../../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../../tests/fixtures/testClerkOrgId";
import { agentIdOf } from "../../../tests/lib/agentIdOf.js";
import { insertTaskRow } from "../../../tests/lib/seedFleetAgents.js";
import { seedRosterAgents } from "../../../tests/lib/seedRosterAgents.js";
import type { OAuthContext } from "../auth.js";
import { withActingOrg } from "../authenticatedConvexClient.js";
import { registerTools } from "../tools.js";

const modules = Object.fromEntries(
	Object.entries(
		import.meta.glob<Record<string, unknown>>("../../../convex/**/*.ts"),
	).filter(([path]) => !path.includes("backfill")),
);

type T = ReturnType<typeof convexTest>;
type Result = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function resolveRef(dotted: string) {
	const [mod, fn] = dotted.split(":");
	return (anyApi as Record<string, Record<string, unknown>>)[mod][fn];
}

function bridge(t: T): ConvexHttpClient {
	return {
		query: (name: string, args: unknown) =>
			t.query(resolveRef(name) as never, args as never),
		mutation: (name: string, args: unknown) =>
			t.mutation(resolveRef(name) as never, args as never),
		action: (name: string, args: unknown) =>
			t.action(resolveRef(name) as never, args as never),
	} as unknown as ConvexHttpClient;
}

const A = "seat-org-a";
const B = "seat-org-b";
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);
const FUTURE = Date.now() + 3_600_000;

/** The seat of `org`'s agent `agentName`: non-master, verified org + agent proof. */
async function seatOf(
	t: T,
	org: string,
	agentName: string,
): Promise<OAuthContext> {
	const tokenHash = `hash-${org}-${agentName}`;
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash,
			clientId: `client-${org}`,
			userId: `user-${org}`,
			scopes: ["mcp:full"],
			scopeProfile: "tenant",
			fromAllowList: [agentName],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: FUTURE,
			createdAt: Date.now(),
			clerkOrgSlug: org,
			clerkOrgId: testClerkOrgId(org),
		});
	});
	return {
		clientId: `client-${org}`,
		accessTokenHash: tokenHash,
		userId: `user-${org}`,
		scopes: ["mcp:full"],
		scopeProfile: "tenant",
		fromAllowList: [agentName],
		actor: {
			orgSlug: org,
			agentName,
			agentId: String(await agentIdOf(t as never, org, agentName)),
		},
		namespaceReadPrefixes: [`team/${testClerkOrgId(org)}`],
		namespaceWritePrefixes: [`team/${testClerkOrgId(org)}`],
		expiresAt: FUTURE,
		isMaster: false,
		clerkOrgSlug: org,
		orgClerkId: testClerkOrgId(org),
	};
}

function handlersFor(t: T, ctx: OAuthContext): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	// The wrapper production applies to every non-master bearer's client.
	const client = withActingOrg(bridge(t), ctx.orgClerkId as string);
	registerTools({ tool: reg, registerTool: reg } as never, client, ctx);
	return handlers;
}

let raw: T;
let t: T;
let seatA: OAuthContext;
let seatB: OAuthContext;
let ivoA: OAuthContext;
let ivoB: OAuthContext;

afterEach(async () => {
	// Every write schedules follow-up work (RAG sync, notifications); run it to
	// the end inside the test so nothing writes after the test is over.
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	vi.useRealTimers();
});

beforeEach(async () => {
	vi.useFakeTimers();
	raw = convexTest(schema as never, modules as never) as unknown as T;
	t = raw.withIdentity({
		subject: "test-service-account-user-id",
	} as never) as unknown as T;
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: Date.now(),
		});
		for (const slug of [A, B]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["mimir", "ivo"],
				scopes: ["view-own-tasks", "manage-repo-mappings"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
	await seedRosterAgents(t as never);
	seatA = await seatOf(t, A, "mimir");
	seatB = await seatOf(t, B, "mimir");
	ivoA = await seatOf(t, A, "ivo");
	ivoB = await seatOf(t, B, "ivo");
});

const NOTE = "closing, evidence abc1234 and more words here";
const REASON =
	"# blocked-on-nobody: third-party outage typed by the colliding agent";

// ── helpers ─────────────────────────────────────────────────────────────────

const textOf = (r: Result | undefined) => r?.content[0]?.text ?? "";

/** Call a real tool handler as `seat`. */
async function as(
	seat: OAuthContext,
	tool: string,
	args: Record<string, unknown>,
): Promise<Result> {
	const h = handlersFor(t, seat).get(tool);
	if (!h) throw new Error(`${tool} is not registered by registerTools`);
	try {
		return await h(args);
	} catch (e) {
		// A few tools signal a refusal by throwing a protocol error instead of
		// returning an error result; both reach the client as an error.
		return {
			isError: true,
			content: [{ text: e instanceof Error ? e.message : String(e) }],
		};
	}
}

/** A seeding call: it must succeed, and its JSON body is returned. */
async function seed(
	seat: OAuthContext,
	tool: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await as(seat, tool, args);
	expect(res.isError, `seed ${tool}: ${textOf(res)}`).not.toBe(true);
	return JSON.parse(textOf(res)) as Record<string, unknown>;
}

const served = (res: Result) => expect(res.isError, textOf(res)).not.toBe(true);

/** A refusal: an error result carrying a refusal code or a not-found. */
const refused = (res: Result) => {
	expect(res.isError, textOf(res)).toBe(true);
	expect(textOf(res)).toMatch(
		/RBAC_DENIED|ORG_MISMATCH|AUTH_|Forbidden|not found|not accessible|does not exist|NOT_FOUND|MISMATCH/i,
	);
};

const rows = <R>(
	table: string,
	pick: (r: Record<string, unknown>) => boolean,
) =>
	t.run(
		async (ctx) =>
			(await ctx.db.query(table as never).collect()).filter((r) =>
				pick(r as Record<string, unknown>),
			) as unknown as R[],
	);

interface Door {
	/** Tool name, as in .backend-doctor/vp-by-tool.csv. */
	tool: string;
	/** ALLOW pole: the org-A seat acts on org A's own rows / namespace / recipients. */
	allow: () => Promise<void>;
	/** CROSS pole: the same seat aims at org B's; refused, org B unchanged. */
	cross: () => Promise<void>;
}
const DOORS: Door[] = [];

// ── single-task write doors (tasks.*) ───────────────────────────────────────
type TaskStatus = "todo" | "in_progress" | "paused";

async function seedTask(org: string, status: TaskStatus): Promise<string> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const id = await insertTaskRow(ctx, {
			title: `${org} task`,
			assignedTo: "mimir",
			createdBy: "mimir",
			priority: "low",
			status: status === "paused" ? "in_progress" : status,
			orgId: org,
			clerkOrgId: testClerkOrgId(org),
			...(status === "in_progress"
				? { startedAt: now - 60_000, workSegments: [{ start: now - 60_000 }] }
				: {}),
			...(status === "paused"
				? {
						startedAt: now - 60_000,
						pausedAt: now - 1000,
						workSegments: [{ start: now - 60_000, end: now - 1000 }],
					}
				: {}),
			createdAt: now,
			updatedAt: now,
		});
		return id as string;
	});
}

type TaskRow = {
	status: string;
	title: string;
	orgId?: string;
	clerkOrgId?: string;
	pausedAt?: number;
	workSegments?: Array<{ start: number; end?: number; correction?: unknown }>;
	dependsOn?: string[];
};
const readRow = (id: string) =>
	t.run(async (ctx) => (await ctx.db.get(id as never)) as TaskRow | null);

function taskDoor(
	tool: string,
	status: TaskStatus,
	args: (taskId: string) => Record<string, unknown>,
	landed: (r: TaskRow | null) => boolean,
) {
	DOORS.push({
		tool,
		allow: async () => {
			const id = await seedTask(A, status);
			served(await as(seatA, tool, args(id)));
			expect(landed(await readRow(id))).toBe(true);
		},
		cross: async () => {
			const id = await seedTask(B, status);
			const before = JSON.stringify(await readRow(id));
			refused(await as(seatA, tool, args(id)));
			expect(landed(await readRow(id))).toBe(false);
			expect(JSON.stringify(await readRow(id))).toBe(before);
		},
	});
}

taskDoor(
	"complete_task",
	"in_progress",
	(taskId) => ({ taskId, completionNote: NOTE, callerOrchestrator: "mimir" }),
	(r) => r?.status === "done",
);
taskDoor(
	"update_task",
	"todo",
	(taskId) => ({ taskId, title: "HIJACKED", callerOrchestrator: "mimir" }),
	(r) => r?.title === "HIJACKED",
);
taskDoor(
	"start_task",
	"todo",
	(taskId) => ({ taskId, callerOrchestrator: "mimir" }),
	(r) => r?.status === "in_progress",
);
taskDoor(
	"pause_task",
	"in_progress",
	(taskId) => ({ taskId, callerOrchestrator: "mimir" }),
	(r) => r?.pausedAt !== undefined,
);
taskDoor(
	"resume_task",
	"paused",
	(taskId) => ({ taskId, callerOrchestrator: "mimir" }),
	(r) => r !== null && r.pausedAt === undefined,
);
taskDoor(
	"block_task",
	"in_progress",
	(taskId) => ({ taskId, reason: REASON, callerOrchestrator: "mimir" }),
	(r) => r?.status === "blocked",
);
taskDoor(
	"fail_task",
	"in_progress",
	(taskId) => ({
		taskId,
		failureNote: "failing it, evidence abc1234 and more words here",
		callerOrchestrator: "mimir",
	}),
	(r) => r?.status === "failed",
);
taskDoor(
	"delete_task",
	"todo",
	(taskId) => ({ taskId, callerOrchestrator: "mimir" }),
	(r) => r === null,
);
taskDoor(
	"checkout_task",
	"todo",
	(taskId) => ({ taskId, callerOrchestrator: "mimir" }),
	(r) => r?.status === "in_progress",
);
taskDoor(
	"correct_task_segment",
	"in_progress",
	(taskId) => ({
		taskId,
		segmentIndex: 0,
		start: Date.now() - 50_000,
		end: Date.now() - 30_000,
		reason: REASON,
		callerOrchestrator: "mimir",
	}),
	(r) => r?.workSegments?.[0]?.correction !== undefined,
);

// add_task_dependency: the dependency id belongs to the SAME org as the target.
DOORS.push({
	tool: "add_task_dependency",
	allow: async () => {
		const target = await seedTask(A, "todo");
		const dep = await seedTask(A, "todo");
		served(
			await as(seatA, "add_task_dependency", {
				taskId: target,
				dependsOn: [dep],
				callerOrchestrator: "mimir",
			}),
		);
		expect((await readRow(target))?.dependsOn).toEqual([dep]);
	},
	cross: async () => {
		const target = await seedTask(B, "todo");
		const dep = await seedTask(A, "todo");
		const before = JSON.stringify(await readRow(target));
		refused(
			await as(seatA, "add_task_dependency", {
				taskId: target,
				dependsOn: [dep],
				callerOrchestrator: "mimir",
			}),
		);
		expect(JSON.stringify(await readRow(target))).toBe(before);
	},
});

// bulk_complete_tasks: a filter sweeps the seat's OWN org only.
DOORS.push({
	tool: "bulk_complete_tasks",
	allow: async () => {
		const own = await seedTask(A, "todo");
		served(
			await as(seatA, "bulk_complete_tasks", {
				filter: { status: "todo" },
				dryRun: false,
				callerOrchestrator: "mimir",
			}),
		);
		expect((await readRow(own))?.status).toBe("done");
	},
	cross: async () => {
		const foreign = await seedTask(B, "todo");
		const before = JSON.stringify(await readRow(foreign));
		// The sweep itself is served (the seat has no rows to close); org B's row
		// is neither closed nor touched: a filter door's cross pole is isolation.
		await as(seatA, "bulk_complete_tasks", {
			filter: { status: "todo" },
			dryRun: false,
			callerOrchestrator: "mimir",
		});
		expect(JSON.stringify(await readRow(foreign))).toBe(before);
		expect((await readRow(foreign))?.status).toBe("todo");
	},
});

// create_task: ALLOW lands in org A; CROSS assigns it to an org-B agent BY ID.
const missionArgs = (name: string) => ({
	name,
	status: "brainstorm",
	project: "p",
	priority: "low",
	pilot: "mimir",
	agents: ["mimir"],
	createdBy: "mimir",
});
DOORS.push({
	tool: "create_task",
	allow: async () => {
		served(
			await as(seatA, "create_task", { project: "test-project",
				title: "own create",
				status: "todo",
				assignedTo: "ivo",
				assignedToAgentId: String(await agentIdOf(t as never, A, "ivo")),
				priority: "low",
				createdBy: "mimir",
			}),
		);
		const made = await rows<TaskRow>("tasks", (r) => r.title === "own create");
		expect(made).toHaveLength(1);
		expect(made[0].clerkOrgId).toBe(A_ID);
	},
	cross: async () => {
		refused(
			await as(seatA, "create_task", { project: "test-project",
				title: "foreign create",
				status: "todo",
				assignedTo: "ivo",
				assignedToAgentId: String(await agentIdOf(t as never, B, "ivo")),
				priority: "low",
				createdBy: "mimir",
			}),
		);
		expect(await rows("tasks", (r) => r.title === "foreign create")).toEqual(
			[],
		);
	},
});

// ── missions ────────────────────────────────────────────────────────────────
DOORS.push({
	tool: "create_mission",
	allow: async () => {
		const made = await seed(
			seatA,
			"create_mission",
			missionArgs("own mission"),
		);
		const row = await readRow(made.missionId as string);
		expect((row as unknown as { clerkOrgId?: string }).clerkOrgId).toBe(A_ID);
	},
	cross: async () => {
		// A creator names no foreign row: the cross pole is that org B is not made
		// the owner and org B's seat sees only its own mission.
		const made = await seed(seatA, "create_mission", missionArgs("A only"));
		const row = (await readRow(made.missionId as string)) as unknown as {
			clerkOrgId?: string;
		};
		expect(row.clerkOrgId).not.toBe(B_ID);
		const bSees = await as(seatB, "get_mission", {
			missionId: made.missionId,
		});
		// get_mission answers a row it may not see with null, never the row.
		expect(textOf(bSees)).toBe("null");
	},
});
DOORS.push({
	tool: "update_mission",
	allow: async () => {
		const made = await seed(seatA, "create_mission", missionArgs("to update"));
		served(
			await as(seatA, "update_mission", {
				missionId: made.missionId,
				name: "renamed",
				callerOrchestrator: "mimir",
			}),
		);
		expect(
			((await readRow(made.missionId as string)) as { name?: string }).name,
		).toBe("renamed");
	},
	cross: async () => {
		const made = await seed(seatB, "create_mission", missionArgs("B only"));
		refused(
			await as(seatA, "update_mission", {
				missionId: made.missionId,
				name: "hijacked",
				callerOrchestrator: "mimir",
			}),
		);
		expect(
			((await readRow(made.missionId as string)) as { name?: string }).name,
		).toBe("B only");
	},
});

// ── messages ────────────────────────────────────────────────────────────────
const idOf = (org: string, name: string) => agentIdOf(t as never, org, name);

async function messageRows(content: string) {
	return await rows<{ _id: string; content: string }>(
		"messages",
		(r) => r.content === content,
	);
}

DOORS.push({
	tool: "send_message",
	allow: async () => {
		served(
			await as(seatA, "send_message", {
				from: "mimir",
				recipientAgentIds: [String(await idOf(A, "ivo"))],
				content: "own roster hello",
			}),
		);
		expect(await messageRows("own roster hello")).toHaveLength(1);
	},
	cross: async () => {
		refused(
			await as(seatA, "send_message", {
				from: "mimir",
				recipientAgentIds: [String(await idOf(B, "ivo"))],
				content: "foreign recipient hello",
			}),
		);
		expect(await messageRows("foreign recipient hello")).toEqual([]);
	},
});

DOORS.push({
	tool: "delete_message",
	allow: async () => {
		await seed(ivoA, "send_message", {
			from: "ivo",
			recipientAgentIds: [String(await idOf(A, "mimir"))],
			content: "to retract",
		});
		const [msg] = await messageRows("to retract");
		served(
			await as(ivoA, "delete_message", {
				messageId: msg._id,
				callerOrchestrator: "ivo",
			}),
		);
		expect(await messageRows("to retract")).toEqual([]);
	},
	cross: async () => {
		await seed(ivoB, "send_message", {
			from: "ivo",
			recipientAgentIds: [String(await idOf(B, "mimir"))],
			content: "org b message",
		});
		const [msg] = await messageRows("org b message");
		refused(
			await as(ivoA, "delete_message", {
				messageId: msg._id,
				callerOrchestrator: "ivo",
			}),
		);
		expect(await messageRows("org b message")).toHaveLength(1);
	},
});

type Receipt = { _id: string; readAt?: number; recipientId?: string };
const receiptsFor = (agentId: string) =>
	rows<Receipt>("messageReceipts", (r) => r.recipientId === agentId);

DOORS.push({
	tool: "mark_as_read",
	allow: async () => {
		await seed(ivoA, "send_message", {
			from: "ivo",
			recipientAgentIds: [String(await idOf(A, "mimir"))],
			content: "to read",
		});
		const [rc] = await receiptsFor(String(await idOf(A, "mimir")));
		served(
			await as(seatA, "mark_as_read", {
				receiptIds: [rc._id],
				callerOrchestrator: "mimir",
			}),
		);
		expect(
			(await receiptsFor(String(await idOf(A, "mimir"))))[0].readAt,
		).toBeTypeOf("number");
	},
	cross: async () => {
		await seed(ivoB, "send_message", {
			from: "ivo",
			recipientAgentIds: [String(await idOf(B, "mimir"))],
			content: "b to read",
		});
		const [rc] = await receiptsFor(String(await idOf(B, "mimir")));
		const res = await as(seatA, "mark_as_read", {
			receiptIds: [rc._id],
			callerOrchestrator: "mimir",
		});
		// Refused outright, or served as a no-op on a receipt that is not hers:
		// either way org B's receipt stays unread.
		void res;
		expect(
			(await receiptsFor(String(await idOf(B, "mimir"))))[0].readAt,
		).toBeUndefined();
	},
});

// ── briefing notes ──────────────────────────────────────────────────────────
const noteArgs = (title: string) => ({
	title,
	topic: "t",
	participants: ["mimir"],
	content: "body",
	createdBy: "mimir",
});
type Note = { title?: string; clerkOrgId?: string };
DOORS.push({
	tool: "create_briefing_note",
	allow: async () => {
		const made = await seed(
			seatA,
			"create_briefing_note",
			noteArgs("own note"),
		);
		const row = (await readRow(made.noteId as string)) as unknown as Note;
		expect(row.clerkOrgId).toBe(A_ID);
	},
	cross: async () => {
		const made = await seed(seatA, "create_briefing_note", noteArgs("A note"));
		refused(await as(seatB, "get_briefing_note", { noteId: made.noteId }));
	},
});
DOORS.push({
	tool: "update_briefing_note",
	allow: async () => {
		const made = await seed(seatA, "create_briefing_note", noteArgs("before"));
		served(
			await as(seatA, "update_briefing_note", {
				noteId: made.noteId,
				callerOrchestrator: "mimir",
				title: "after",
			}),
		);
		expect(
			((await readRow(made.noteId as string)) as unknown as Note).title,
		).toBe("after");
	},
	cross: async () => {
		const made = await seed(seatB, "create_briefing_note", noteArgs("b note"));
		refused(
			await as(seatA, "update_briefing_note", {
				noteId: made.noteId,
				callerOrchestrator: "mimir",
				title: "hijacked",
			}),
		);
		expect(
			((await readRow(made.noteId as string)) as unknown as Note).title,
		).toBe("b note");
	},
});

// ── recurring task create (pause/resume/remove/update: recurringTaskSeatDoor) ─
DOORS.push({
	tool: "create_recurring_task",
	allow: async () => {
		served(
			await as(seatA, "create_recurring_task", {
				title: "own schedule",
				assignedTo: "ivo",
				priority: "low",
				cronExpression: "0 9 * * *",
				createdBy: "mimir",
			}),
		);
		const made = await rows<{ clerkOrgId?: string }>(
			"recurringTasks",
			(r) => r.title === "own schedule",
		);
		expect(made).toHaveLength(1);
		expect(made[0].clerkOrgId).toBe(A_ID);
	},
	cross: async () => {
		// A schedule created by org A never lands in B and is not B's to see.
		await seed(seatA, "create_recurring_task", {
			title: "a only schedule",
			assignedTo: "ivo",
			priority: "low",
			cronExpression: "0 9 * * *",
			createdBy: "mimir",
		});
		const made = await rows<{ clerkOrgId?: string }>(
			"recurringTasks",
			(r) => r.title === "a only schedule",
		);
		expect(made[0].clerkOrgId).not.toBe(B_ID);
	},
});

// ── GitHub repo mapping ─────────────────────────────────────────────────────
type Mapping = {
	repo: string;
	orgId?: string;
	clerkOrgId?: string;
	orchestrator: string;
};
const mappingsOf = (repo: string) =>
	rows<Mapping>("githubRepoMapping", (r) => r.repo === repo);
async function bindOwner(owner: string, org: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("githubOwnerBindings", {
			owner,
			orgId: org,
			clerkOrgId: testClerkOrgId(org),
			installationId: 1,
			accountType: "Organization",
			githubUserLogin: owner,
			boundBy: "user-admin",
			boundAt: 1,
			active: true,
		});
	});
}
DOORS.push({
	tool: "add_repo_mapping",
	allow: async () => {
		await bindOwner("acme-a", A);
		served(
			await as(seatA, "add_repo_mapping", {
				repo: "acme-a/site",
				orchestrator: "mimir",
				project: "site",
				active: true,
			}),
		);
		const made = await mappingsOf("acme-a/site");
		expect(made).toHaveLength(1);
		expect(made[0].clerkOrgId).toBe(A_ID);
	},
	cross: async () => {
		await bindOwner("acme-b", B);
		await seed(seatB, "add_repo_mapping", {
			repo: "acme-b/site",
			orchestrator: "mimir",
			project: "site",
			active: true,
		});
		// The same repo name registered by A must not overwrite B's row.
		await as(seatA, "add_repo_mapping", {
			repo: "acme-b/site",
			orchestrator: "ivo",
			project: "hijacked",
		});
		const rowsB = (await mappingsOf("acme-b/site")).filter(
			(m) => m.clerkOrgId === B_ID,
		);
		expect(rowsB).toHaveLength(1);
		expect(rowsB[0].orchestrator).toBe("mimir");
	},
});
DOORS.push({
	tool: "remove_repo_mapping",
	allow: async () => {
		await bindOwner("acme-a", A);
		await seed(seatA, "add_repo_mapping", {
			repo: "acme-a/gone",
			orchestrator: "mimir",
			project: "site",
			active: true,
		});
		served(await as(seatA, "remove_repo_mapping", { repo: "acme-a/gone" }));
		expect(await mappingsOf("acme-a/gone")).toEqual([]);
	},
	cross: async () => {
		await bindOwner("acme-b", B);
		await seed(seatB, "add_repo_mapping", {
			repo: "acme-b/keep",
			orchestrator: "mimir",
			project: "site",
			active: true,
		});
		await as(seatA, "remove_repo_mapping", { repo: "acme-b/keep" });
		expect(await mappingsOf("acme-b/keep")).toHaveLength(1);
	},
});

// ── knowledge base: ticket -> upload -> claim -> store -> soft delete ────────
const KB_BODY = "# Title\n\nSome text for the seat.";
const KB_SHA = createHash("sha256").update(KB_BODY).digest("hex");

/** generate_upload_url as `seat`, then the blob POST (storage.store). */
async function ticketAndBlob(seat: OAuthContext) {
	const res = await as(seat, "generate_upload_url", { sha256: KB_SHA });
	served(res);
	const { ticket } = JSON.parse(res.content[1].text) as { ticket: string };
	const storageId = await t.run(async (ctx) =>
		ctx.storage.store(new Blob([KB_BODY], { type: "text/markdown" })),
	);
	return { ticket, storageId: String(storageId) };
}
const kbUploadsOf = (storageId: string) =>
	rows<{ clerkOrgId?: string; orgId?: string }>(
		"kbUploads",
		(r) => String(r.storageId) === storageId,
	);

DOORS.push({
	tool: "generate_upload_url",
	allow: async () => {
		const res = await as(seatA, "generate_upload_url", { sha256: KB_SHA });
		served(res);
		const tickets = await rows<{ orgId?: string; clerkOrgId?: string }>(
			"uploadTickets",
			() => true,
		);
		expect(tickets).toHaveLength(1);
		expect(tickets[0].clerkOrgId ?? tickets[0].orgId).toMatch(
			new RegExp(`${A_ID}|${A}`),
		);
	},
	cross: async () => {
		// A seat names no organisation: the ticket it is given binds org A and
		// nothing it can send makes it org B's (the claim pole below proves B's
		// ticket is not A's to use).
		await as(seatA, "generate_upload_url", { sha256: KB_SHA });
		const tickets = await rows<{ orgId?: string; clerkOrgId?: string }>(
			"uploadTickets",
			() => true,
		);
		expect(JSON.stringify(tickets)).not.toContain(B);
		expect(JSON.stringify(tickets)).not.toContain(B_ID);
	},
});
DOORS.push({
	tool: "claim_upload",
	allow: async () => {
		const { ticket, storageId } = await ticketAndBlob(seatA);
		served(await as(seatA, "claim_upload", { storageId, ticket }));
		expect(await kbUploadsOf(storageId)).toHaveLength(1);
	},
	cross: async () => {
		const { ticket, storageId } = await ticketAndBlob(seatB);
		refused(await as(seatA, "claim_upload", { storageId, ticket }));
		expect(await kbUploadsOf(storageId)).toEqual([]);
	},
});
async function storeDoc(seat: OAuthContext) {
	const { ticket, storageId } = await ticketAndBlob(seat);
	served(await as(seat, "claim_upload", { storageId, ticket }));
	const res = await as(seat, "store_document_chunked", {
		storageId,
		mimeType: "text/markdown",
		filename: "a.md",
	});
	return { storageId, res };
}
DOORS.push({
	tool: "store_document_chunked",
	allow: async () => {
		const { res } = await storeDoc(seatA);
		served(res);
		expect(JSON.parse(textOf(res)).chunkCount).toBeGreaterThan(0);
	},
	cross: async () => {
		const { ticket, storageId } = await ticketAndBlob(seatB);
		served(await as(seatB, "claim_upload", { storageId, ticket }));
		const before = JSON.stringify(await rows("memories", () => true));
		refused(
			await as(seatA, "store_document_chunked", {
				storageId,
				mimeType: "text/markdown",
				filename: "a.md",
			}),
		);
		expect(JSON.stringify(await rows("memories", () => true))).toBe(before);
	},
});
DOORS.push({
	tool: "soft_delete_document",
	allow: async () => {
		const { res } = await storeDoc(seatA);
		const { docId } = JSON.parse(textOf(res)) as { docId: string };
		served(await as(seatA, "soft_delete_document", { docId }));
		const live = await rows<{ isLatest?: boolean }>(
			"memories",
			(r) => r.isLatest === true,
		);
		expect(live).toEqual([]);
	},
	cross: async () => {
		const { res } = await storeDoc(seatB);
		const { docId } = JSON.parse(textOf(res)) as { docId: string };
		const before = JSON.stringify(await rows("memories", () => true));
		await as(seatA, "soft_delete_document", { docId });
		// Served as a no-op or refused: org B's chunks stay live either way.
		expect(JSON.stringify(await rows("memories", () => true))).toBe(before);
	},
});

// ── OKF bundles: the namespace is the seat's org's, or it is refused ─────────
const teamNs = (id: string) => `team/${id}`;
DOORS.push({
	tool: "export_okf_bundle",
	allow: async () => {
		served(
			await as(seatA, "export_okf_bundle", {
				namespace: teamNs(A_ID),
				format: "tarball",
			}),
		);
	},
	cross: async () => {
		refused(
			await as(seatA, "export_okf_bundle", {
				namespace: teamNs(B_ID),
				format: "tarball",
			}),
		);
	},
});
DOORS.push({
	tool: "import_okf_bundle",
	allow: async () => {
		const exported = await seed(seatA, "export_okf_bundle", {
			namespace: teamNs(A_ID),
			format: "tarball",
		});
		served(
			await as(seatA, "import_okf_bundle", {
				storageId: exported.storageId,
				targetNamespace: teamNs(A_ID),
				mode: "dry-run",
			}),
		);
	},
	cross: async () => {
		const exported = await seed(seatA, "export_okf_bundle", {
			namespace: teamNs(A_ID),
			format: "tarball",
		});
		const before = JSON.stringify(await rows("memories", () => true));
		refused(
			await as(seatA, "import_okf_bundle", {
				storageId: exported.storageId,
				targetNamespace: teamNs(B_ID),
				mode: "merge",
			}),
		);
		expect(JSON.stringify(await rows("memories", () => true))).toBe(before);
	},
});

// ── business units (roster-scoped; not advertised in tool-exposure.json) ─────
const buArgs = (name: string, orchestratorId: string) => ({
	name,
	description: "d",
	purpose: "p",
	orchestratorId,
	status: "building",
	businessModel: "m",
	targetCustomers: "c",
	services: ["s"],
	pricing: "p",
	revenueProjections: { y1: 1, y2: 2, y3: 3 },
	coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
	coreProcesses: ["x"],
	dependencies: [],
	kpis: ["k"],
	managementFee: 10,
});
type Bu = { name?: string; clerkOrgId?: string };
DOORS.push({
	tool: "create_bu",
	allow: async () => {
		const made = await seed(seatA, "create_bu", buArgs("own bu", "mimir"));
		const row = (await readRow(made.buId as string)) as unknown as Bu;
		expect(row.clerkOrgId).toBe(A_ID);
	},
	cross: async () => {
		// A unit led by an orchestrator that is not on the seat's own roster.
		refused(await as(seatA, "create_bu", buArgs("foreign lead", "sigma")));
		expect(
			await rows("businessUnits", (r) => r.name === "foreign lead"),
		).toEqual([]);
	},
});
DOORS.push({
	tool: "update_bu",
	allow: async () => {
		const made = await seed(seatA, "create_bu", buArgs("bu before", "mimir"));
		served(
			await as(seatA, "update_bu", {
				buId: made.buId,
				callerOrchestrator: "mimir",
				name: "bu after",
			}),
		);
		expect(((await readRow(made.buId as string)) as unknown as Bu).name).toBe(
			"bu after",
		);
	},
	cross: async () => {
		const made = await seed(seatB, "create_bu", buArgs("b bu", "mimir"));
		refused(
			await as(seatA, "update_bu", {
				buId: made.buId,
				callerOrchestrator: "mimir",
				name: "hijacked",
			}),
		);
		expect(((await readRow(made.buId as string)) as unknown as Bu).name).toBe(
			"b bu",
		);
	},
});

// ── mission template instantiation (the catalog is fleet-wide; the mission is not) ─
async function seedTemplate(name: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("missionTemplates", {
			name,
			steps: [{ title: "step one", description: "do it", assignedTo: "mimir" }],
			isDefault: false,
			createdBy: "sigma",
			createdAt: 1,
			updatedAt: 1,
		});
	});
}
DOORS.push({
	tool: "instantiate_template_into_mission",
	allow: async () => {
		await seedTemplate("tpl");
		const mission = await seed(
			seatA,
			"create_mission",
			missionArgs("A tpl mission"),
		);
		served(
			await as(seatA, "instantiate_template_into_mission", {
				templateName: "tpl",
				missionId: mission.missionId,
				callerOrchestrator: "mimir",
			}),
		);
		const made = await rows<TaskRow>("tasks", (r) => r.title === "step one");
		expect(made).toHaveLength(1);
		expect(made[0].clerkOrgId).toBe(A_ID);
	},
	cross: async () => {
		await seedTemplate("tpl");
		const mission = await seed(
			seatB,
			"create_mission",
			missionArgs("B tpl mission"),
		);
		refused(
			await as(seatA, "instantiate_template_into_mission", {
				templateName: "tpl",
				missionId: mission.missionId,
				callerOrchestrator: "mimir",
			}),
		);
		expect(await rows("tasks", (r) => r.title === "step one")).toEqual([]);
	},
});

// ── debate room turn ────────────────────────────────────────────────────────
const ADMIN_A = "user_admin_seat_a";
const asAdminOf = (org: string, subject: string) =>
	raw.withIdentity({
		subject,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	});
const DEBATE_SETTINGS = {
	maxRoundLimit: 5,
	maxParticipants: 6,
	maxRefusalRows: 2,
	maxTurnMessageChars: 4000,
	pollSeconds: 5,
	maxAnswerCharsCeiling: 500,
	maxLabelChars: 40,
	maxTurnInstructionChars: 400,
	maxActiveRooms: 10,
};
async function seedRoom(org: string, admin: string): Promise<string> {
	await raw.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:member"],
			updatedAt: 1,
		});
	});
	const as_ = asAdminOf(org, admin);
	await as_.mutation(api.debate.upsertSettings, DEBATE_SETTINGS);
	const templateId = await as_.mutation(api.debate.upsertTemplate, {
		template: {
			id: `review-${org}`,
			name: "Review",
			language: "en",
			turnInstruction: "Answer in one paragraph.",
			participants: [
				{
					id: "p1",
					label: "mimir",
					kind: "agent",
					agentId: await agentIdOf(t as never, org, "mimir"),
					transport: "waker",
				},
				{
					id: "p2",
					label: "ivo",
					kind: "agent",
					agentId: await agentIdOf(t as never, org, "ivo"),
					transport: "waker",
				},
			],
			roundLimit: 2,
			maxAnswerChars: 100,
			turnDeadlineSeconds: 3600,
			maxConsecutiveSkips: 2,
			voiceEnabled: false,
		},
	} as never);
	const roomId = await as_.mutation(api.debate.createRoom, {
		templateId,
		subject: "Should we ship?",
	} as never);
	return roomId as string;
}
type Room = { turns?: unknown[] };
const turnsOf = (roomId: string) =>
	rows<{ roomId: string }>("debateTurns", (r) => r.roomId === roomId);
DOORS.push({
	tool: "debate_post_turn",
	allow: async () => {
		const roomId = await seedRoom(A, ADMIN_A);
		const before = (await turnsOf(roomId)).length;
		served(
			await as(seatA, "debate_post_turn", {
				roomId,
				turnSeq: 1,
				text: "my answer",
			}),
		);
		expect((await turnsOf(roomId)).length).toBeGreaterThan(before);
	},
	cross: async () => {
		const roomId = await seedRoom(A, ADMIN_A);
		const before = (await turnsOf(roomId)).length;
		// org B's "mimir" shares the label of org A's first participant; it is not
		// that agent.
		const res = await as(seatB, "debate_post_turn", {
			roomId,
			turnSeq: 1,
			text: "intruder",
		});
		expect(res.isError, textOf(res)).toBe(true);
		expect((await turnsOf(roomId)).length).toBe(before);
	},
});
void (undefined as unknown as Room);

// ── erase doors (task k170t9bg650dyw6hxjj627p9fx8hhpeq) ─────────────────────
// A seat erases the rows its VERIFIED agent ID authored (stored createdById) and nothing
// else: another agent of the same org, and another org's seat, are refused and the row is
// byte-identical afterwards. The Convex-level poles per table are in
// convex/__tests__/eraseRow.test.ts; here the REAL tool handlers drive them.
const SECRET = "secret-seat-marker";
const memoryText = (id: string) =>
	t.run(async (ctx) => {
		const row = (await ctx.db.get(id as never)) as { content?: string } | null;
		return row === null ? null : (row.content ?? "");
	});
async function seedMemoryBy(
	seat: OAuthContext,
	org: string,
	createdBy: string,
): Promise<string> {
	const m = await seed(seat, "store_memory", {
		namespace: `team/${testClerkOrgId(org)}`,
		type: "project",
		content: `${SECRET} in ${org}`,
		createdBy,
	});
	return String(m.memoryId);
}
DOORS.push({
	tool: "erase_memory",
	allow: async () => {
		const id = await seedMemoryBy(seatA, A, "mimir");
		served(
			await as(seatA, "erase_memory", {
				memoryId: id,
				redactions: [{ find: SECRET, replaceWith: "[REDACTED]" }],
			}),
		);
		expect(await memoryText(id)).not.toContain(SECRET);
	},
	cross: async () => {
		const redactions = [{ find: SECRET, replaceWith: "[REDACTED]" }];
		const other = await seedMemoryBy(seatB, B, "mimir");
		refused(await as(seatA, "erase_memory", { memoryId: other, redactions }));
		expect(await memoryText(other)).toContain(SECRET);
		// a same-org agent that is not the author is refused too
		const own = await seedMemoryBy(seatA, A, "mimir");
		refused(await as(ivoA, "erase_memory", { memoryId: own, redactions }));
		expect(await memoryText(own)).toContain(SECRET);
	},
});
DOORS.push({
	tool: "erase_row",
	allow: async () => {
		const id = await seedMemoryBy(seatA, A, "mimir");
		const diary = await seed(seatA, "write_diary", {
			orchestrator: "mimir",
			date: "2026-11-03",
			content: "erase me",
		});
		served(await as(seatA, "erase_row", { table: "memories", rowId: id }));
		expect(await memoryText(id)).toBeNull();
		served(
			await as(seatA, "erase_row", {
				table: "diary",
				rowId: String(diary.diaryId),
			}),
		);
	},
	cross: async () => {
		const other = await seedMemoryBy(seatB, B, "mimir");
		refused(await as(seatA, "erase_row", { table: "memories", rowId: other }));
		expect(await memoryText(other)).toContain(SECRET);
		const own = await seedMemoryBy(seatA, A, "mimir");
		refused(await as(ivoA, "erase_row", { table: "memories", rowId: own }));
		expect(await memoryText(own)).toContain(SECRET);
	},
});

// ── doors a seat must NOT pass: master-only by design ────────────────────────
interface MasterOnly {
	tool: string;
	/** Why the door is master-only (doctrine pointer, not prose). */
	why: string;
	/** Arguments valid enough to reach the gate. */
	args: () => Promise<Record<string, unknown>>;
	/** Tables whose rows must be byte-identical after the refused call. */
	tables: string[];
}
const MASTER_ONLY: MasterOnly[] = [];

const fixPatternRow = () =>
	t.run(async (ctx) =>
		ctx.db.insert("fixPatterns", {
			symptom: "s",
			rootCause: "r",
			tags: [],
			stack: [],
			sourceProject: "p",
			createdBy: "sigma",
			severity: "minor",
			createdAt: 1,
			updatedAt: 1,
		}),
	);
const mandateRow = () =>
	t.run(async (ctx) =>
		ctx.db.insert("mandates", {
			requestedBy: "sigma",
			fulfilledBy: "eta",
			service: "svc",
			budget: 10,
			status: "requested",
			createdAt: 1,
			updatedAt: 1,
		}),
	);

MASTER_ONLY.push(
	{
		tool: "update_mission_status",
		why: "tools.ts kind master (C0.4: mission lifecycle is infrastructure-level)",
		args: async () => {
			const m = await seed(seatA, "create_mission", missionArgs("lifecycle"));
			return { missionId: m.missionId, status: "complete" };
		},
		tables: ["missions"],
	},
	{
		tool: "soft_delete_memory",
		why: "tools.ts kind master",
		args: async () => {
			const m = await seed(seatA, "store_memory", {
				namespace: `team/${A_ID}`,
				type: "project",
				content: "keep me",
				createdBy: "mimir",
			});
			return { memoryId: m.memoryId };
		},
		tables: ["memories"],
	},
	{
		tool: "create_fix_pattern",
		why: "convex/fixPatterns.ts requireFleetMaster: fix patterns are fleet-internal",
		args: async () => ({
			symptom: "s",
			rootCause: "r",
			tags: [],
			stack: [],
			sourceProject: "p",
			createdBy: "mimir",
			severity: "minor",
		}),
		tables: ["fixPatterns"],
	},
	{
		tool: "add_fix_attempt",
		why: "convex/fixPatterns.ts requireFleetMaster",
		args: async () => ({
			patternId: await fixPatternRow(),
			description: "d",
			worked: true,
			why: "w",
			createdBy: "mimir",
		}),
		tables: ["fixPatterns", "fixAttempts"],
	},
	{
		tool: "erase_fix_pattern",
		why: "convex/fixPatterns.ts erase: the owning organisation of a fix pattern is the operator org; only an admin of that org is served (assertMayErase), so a client org's agent is refused by ID",
		args: async () => ({ patternId: await fixPatternRow() }),
		tables: ["fixPatterns", "fixAttempts"],
	},
	{
		tool: "link_issue_to_pattern",
		why: "tools.ts kind master + fixPatterns requireFleetMaster",
		args: async () => ({ patternId: await fixPatternRow(), issueId: "i-1" }),
		tables: ["fixPatterns"],
	},
	{
		tool: "validate_fix",
		why: "tools.ts kind master + fixPatterns requireFleetMaster",
		args: async () => ({ patternId: await fixPatternRow(), validatedFix: "f" }),
		tables: ["fixPatterns"],
	},
	{
		tool: "update_mission_template",
		why: "convex/missionTemplates.ts upsert: the catalog is shared fleet-wide, never per-org",
		args: async () => ({
			name: "tpl-x",
			steps: [{ title: "a", description: "b" }],
			createdBy: "mimir",
		}),
		tables: ["missionTemplates"],
	},
	{
		tool: "soft_delete_mission_template",
		why: "tools.ts kind master (not advertised)",
		args: async () => {
			await seedTemplate("tpl-del");
			return { name: "tpl-del" };
		},
		tables: ["missionTemplates"],
	},
	{
		tool: "delete_bu",
		why: "tools.ts kind master + businessUnits:remove (not advertised)",
		args: async () => {
			const bu = await seed(seatA, "create_bu", buArgs("bu to keep", "mimir"));
			return { buId: bu.buId };
		},
		tables: ["businessUnits"],
	},
	{
		tool: "create_mandate",
		why: "convex/mandates.ts requireFleetMaster (not advertised)",
		args: async () => ({
			requestedBy: "mimir",
			fulfilledBy: "ivo",
			service: "svc",
			budget: 10,
		}),
		tables: ["mandates"],
	},
	{
		tool: "accept_mandate",
		why: "convex/mandates.ts requireFleetMaster (not advertised)",
		args: async () => ({
			mandateId: await mandateRow(),
			callerOrchestrator: "mimir",
		}),
		tables: ["mandates"],
	},
	{
		tool: "update_mandate",
		why: "convex/mandates.ts requireFleetMaster (not advertised)",
		args: async () => ({
			mandateId: await mandateRow(),
			callerOrchestrator: "mimir",
			tokensCost: 5,
		}),
		tables: ["mandates"],
	},
	{
		tool: "settle_mandate",
		why: "convex/mandates.ts requireFleetMaster (not advertised)",
		args: async () => ({
			mandateId: await mandateRow(),
			callerOrchestrator: "mimir",
			finalCost: 5,
		}),
		tables: ["mandates"],
	},
	{
		tool: "update_issue_status",
		why: "tools.ts kind master (not advertised)",
		args: async () => ({
			repo: "acme-a/site",
			issueNumber: 1,
			status: "closed",
		}),
		tables: ["issues"],
	},
	{
		tool: "link_commit_to_issue",
		why: "tools.ts kind master (not advertised)",
		args: async () => ({
			repo: "acme-a/site",
			issueNumber: 1,
			commitSha: "abc1234",
			fixedBy: "mimir",
		}),
		tables: ["issues"],
	},
	{
		tool: "verify_issue",
		why: "tools.ts kind master (not advertised)",
		args: async () => ({
			repo: "acme-a/site",
			issueNumber: 1,
			verifiedBy: "mimir",
		}),
		tables: ["issues"],
	},
	{
		tool: "add_deployment",
		why: "tools.ts kind master + errorMonitor requireMasterScope (not advertised)",
		args: async () => ({
			name: "dep-x",
			deploymentUrl: "https://dep-x.convex.cloud",
			deployKeyEnvVar: "DEPLOY_KEY_X",
			githubRepo: "acme-a/site",
			orchestrator: "mimir",
		}),
		tables: ["monitoredDeployments"],
	},
	{
		tool: "remove_deployment",
		why: "tools.ts kind master + errorMonitor requireMasterScope (not advertised)",
		args: async () => ({ name: "dep-x" }),
		tables: ["monitoredDeployments"],
	},
);

const snapshot = async (tables: string[]) =>
	JSON.stringify(
		await t.run(async (ctx) => {
			const out: Record<string, unknown[]> = {};
			for (const table of tables) {
				out[table] = await ctx.db.query(table as never).collect();
			}
			return out;
		}),
	);

describe("two-pole sweep: a scoped org-agent seat, both poles, per write door", () => {
	for (const door of DOORS) {
		describe(door.tool, () => {
			it("ALLOW: the org-A seat writes its own org-A rows", door.allow);
			it(
				"CROSS: the org-A seat aimed at org B is refused, org B unchanged",
				door.cross,
			);
		});
	}
});

describe("master-only doors: the org-A seat is refused and nothing changes", () => {
	for (const door of MASTER_ONLY) {
		it(`${door.tool} (${door.why})`, async () => {
			const args = await door.args();
			const before = await snapshot(door.tables);
			const res = await as(seatA, door.tool, args);
			expect(res.isError, textOf(res)).toBe(true);
			// An access refusal, not a validation error or a missing row.
			expect(textOf(res)).toMatch(/RBAC_DENIED|Forbidden/);
			expect(await snapshot(door.tables)).toBe(before);
		});
	}
});

// ── doors proven under a seat by an EARLIER suite (pole content checked here) ─
// Each entry names the Convex function the door reaches and the suite that
// drives it as the service account ACTING FOR an org (`__actingOrg`) with the
// seat's proof, asserting the allow pole on the seat's own rows AND the
// cross-org refusal. The guard below reads each file and fails when it no
// longer carries the function, the acting-org argument and a refusal.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

interface EarlierSuite {
	suite: string;
	/** `api.<module>.<function>` as the suite calls it. */
	ref: string;
}
const EARLIER: Record<string, EarlierSuite> = {
	store_memory: {
		suite: "convex/__tests__/actingOrgOwnRows.test.ts",
		ref: "api.memories.storeMemory",
	},
	store_episode: {
		suite: "convex/__tests__/actingOrgSeatNamespace.test.ts",
		ref: "api.episodes.storeEpisode",
	},
	update_profile: {
		suite: "convex/__tests__/actingOrgOwnRows.test.ts",
		ref: "api.profiles.upsertProfile",
	},
	set_summary: {
		suite: "convex/__tests__/actingOrgOwnRows.test.ts",
		ref: "api.profiles.updateDynamic",
	},
	write_diary: {
		suite: "convex/__tests__/actingOrgOwnRows.test.ts",
		ref: "api.diary.write",
	},
	update_recurring_task: {
		suite: "convex/__tests__/recurringTaskSeatDoor.test.ts",
		ref: "api.recurringTasks.update",
	},
	pause_recurring_task: {
		suite: "convex/__tests__/recurringTaskSeatDoor.test.ts",
		ref: "api.recurringTasks[door]",
	},
	resume_recurring_task: {
		suite: "convex/__tests__/recurringTaskSeatDoor.test.ts",
		ref: "api.recurringTasks[door]",
	},
	delete_recurring_task: {
		suite: "convex/__tests__/recurringTaskSeatDoor.test.ts",
		ref: "api.recurringTasks[door]",
	},
};

/** A write tool that is not a data-write door, with the reason it is exempt. */
const EXEMPT: Record<string, string> = {
	validate_task_payload:
		"pure payload validator, readOnlyHint true, issues no Convex call (csv crud=n/a)",
	whoami:
		"returns the caller's own verified identity and writes no row (csv crud=n/a, 'no Convex call reached')",
};

// ── the guard ───────────────────────────────────────────────────────────────
const csvRows = (rel: string) => {
	const [head, ...lines] = read(rel).trim().split("\n");
	void head;
	return lines;
};
/** Door names of vp-writer-tier.csv (first column). */
const writerTierDoors = () =>
	csvRows(".backend-doctor/vp-writer-tier.csv").map((l) => l.split(",")[0]);
/** Write doors of vp-by-tool.csv: every row whose `crud` is not a read/search. */
const byToolWriteDoors = () => {
	const lines = read(".backend-doctor/vp-by-tool.csv").trim().split("\n");
	const cols = lines[0].split(",");
	const crud = cols.indexOf("crud");
	const outil = cols.indexOf("outil");
	// Only the first six columns are comma-free; read them positionally.
	return lines
		.slice(1)
		.map((l) => l.split(","))
		.filter((f) => !/^(READ-LIST|READ-GET|SEARCH)$/.test(f[crud]))
		.map((f) => f[outil]);
};

describe("guard: no MCP write door without a seat two-pole (or seat-refusal) test", () => {
	const covered = new Set<string>([
		...DOORS.map((d) => d.tool),
		...MASTER_ONLY.map((d) => d.tool),
		...Object.keys(EARLIER),
		...Object.keys(EXEMPT),
	]);

	it("every write door of the oracle CSVs has an entry", () => {
		const inventory = new Set([...writerTierDoors(), ...byToolWriteDoors()]);
		const missing = [...inventory].filter((tool) => !covered.has(tool)).sort();
		expect(
			missing,
			`write doors with no seat two-pole test (add one to DOORS, MASTER_ONLY or EARLIER, or exempt it with a reason): ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("every registered tool that is not read-only has an entry", async () => {
		const annotations = new Map<string, { readOnlyHint?: boolean }>();
		const reg = (...a: unknown[]) => {
			const cfg = a[1] as
				| { annotations?: { readOnlyHint?: boolean } }
				| undefined;
			annotations.set(a[0] as string, cfg?.annotations ?? {});
			return {};
		};
		registerTools(
			{ tool: reg, registerTool: reg } as never,
			withActingOrg(bridge(t), A_ID),
			seatA,
		);
		const writers = [...annotations]
			.filter(([, ann]) => ann.readOnlyHint !== true)
			.map(([name]) => name)
			.sort();
		const missing = writers.filter((tool) => !covered.has(tool));
		expect(
			missing,
			`registered write tools with no seat two-pole test: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("no entry is stale: each names a door that still exists", () => {
		const inventory = new Set([...writerTierDoors(), ...byToolWriteDoors()]);
		const stale = [...covered].filter((tool) => !inventory.has(tool)).sort();
		expect(
			stale,
			`entries for doors no longer in the CSVs: ${stale.join(", ")}`,
		).toEqual([]);
	});

	it("every exemption carries a reason of substance", () => {
		for (const [tool, reason] of Object.entries(EXEMPT)) {
			expect(reason.length, `exemption for ${tool}`).toBeGreaterThanOrEqual(30);
		}
	});

	it("each earlier-suite entry still carries its function, the acting org and a refusal", () => {
		for (const [tool, { suite, ref }] of Object.entries(EARLIER)) {
			const src = read(suite);
			expect(src, `${tool}: ${suite} must call ${ref}`).toContain(ref);
			expect(src, `${tool}: ${suite} must act for an org`).toContain(
				"__actingOrg",
			);
			expect(src, `${tool}: ${suite} must assert a refusal`).toMatch(
				/RBAC_DENIED|ORG_MISMATCH/,
			);
		}
	});

	it("the guard bites: a door missing from every list is reported", () => {
		const inventory = new Set([...writerTierDoors(), "a_brand_new_write_door"]);
		const missing = [...inventory].filter((tool) => !covered.has(tool));
		expect(missing).toEqual(["a_brand_new_write_door"]);
	});
});
