/**
 * Every tool that declares an outputSchema answers a REAL success with a
 * structuredContent that validates against it, and its text is the JSON of
 * that same object (VantagePeers Cloud, task k1793xkjhzh1xm23gmmwjgwfyx8htbv0,
 * PR C, finding 6).
 *
 * Real /mcp route (Hono app + bearer middleware + createMcpHandler), real Convex
 * functions (convex-test, reached as the fleet service account), the official
 * v2 client. Each call is made by the seat a client of that tool really is: the
 * person with a bound agent (ulysse), or the fleet master for a master-only door.
 *
 * The decided set is STRUCTURED_TOOLS (test/tool-documentation-quality.test.ts):
 * a tool added there without a call here fails the coverage assertion.
 */

import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	closeWorld,
	connectAs,
	freshBackend,
	ORG_ID,
	SLUG,
	tokenFor,
} from "./lib/seatWorld.js";
import { STRUCTURED_TOOLS } from "./lib/toolMetadataDecisions.js";

vi.mock("convex/browser", async () => ({
	ConvexHttpClient: (await import("./lib/forwardingConvex.js"))
		.ForwardingConvexHttpClient,
}));

type CallResult = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
};

type World = Awaited<ReturnType<typeof freshBackend>>;
type Seeded = World["fixtures"]["ids"] & {
	episodeId: string;
	patternId: string;
	bulkRunId: string;
	recurringTaskId?: string;
	/** Tasks seeded in the person's org for the task lifecycle writes. */
	tasks: Record<
		"done" | "fail" | "block" | "dep" | "seg" | "checkout" | "seatbot",
		string
	>;
	receiptId: string;
};

/** Reads one tool's JSON answer as the person (a test-side lookup, not a decided call). */
type Read = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

type Call = {
	tool: (typeof STRUCTURED_TOOLS)[number];
	as: "person" | "master";
	args: (
		s: Seeded,
		read: Read,
	) => Record<string, unknown> | Promise<Record<string, unknown>>;
	/** A call that must run before this one, whose result this one reads. */
	after?: (r: CallResult, s: Seeded) => void;
};

// In order: a later call may depend on an earlier one's state.
const CALLS: Call[] = [
	{ tool: "whoami", as: "person", args: () => ({}) },
	{ tool: "get_memory", as: "person", args: (s) => ({ memoryId: s.memoryId }) },
	{
		tool: "get_episode",
		as: "person",
		args: (s) => ({ episodeId: s.episodeId }),
	},
	{ tool: "get_task", as: "person", args: (s) => ({ taskId: s.taskId }) },
	{
		tool: "get_fix_pattern",
		as: "master",
		args: (s) => ({ patternId: s.patternId }),
	},
	{
		tool: "get_message",
		as: "person",
		args: (s) => ({ messageId: s.messageId }),
	},
	{
		tool: "get_briefing_note",
		as: "person",
		args: (s) => ({ noteId: s.noteId }),
	},
	{
		tool: "get_bulk_complete_run",
		as: "person",
		args: (s) => ({ bulkRunId: s.bulkRunId }),
	},
	{ tool: "list_blocked_on_me", as: "person", args: () => ({}) },
	{
		tool: "list_broadcast_status",
		as: "person",
		args: (s) => ({ messageId: s.messageId }),
	},
	{ tool: "get_github_owner_bindings", as: "person", args: () => ({}) },
	{ tool: "billing_summary_by_project", as: "master", args: () => ({}) },
	{
		tool: "store_memory",
		as: "person",
		args: () => ({
			content: "a stored memory",
			type: "reference",
			namespace: `team/${SLUG}`,
		}),
	},
	{
		tool: "create_recurring_task",
		as: "person",
		args: () => ({
			title: "weekly review",
			assignedTo: "ulysse",
			priority: "low",
			project: "p",
			cronExpression: "0 9 * * 1",
		}),
		after: (r, s) => {
			s.recurringTaskId = String(
				(JSON.parse(r.content[0].text) as { taskId: string }).taskId,
			);
		},
	},
	{
		tool: "get_recurring_task",
		as: "person",
		args: (s) => ({ recurringTaskId: s.recurringTaskId }),
	},
	{
		tool: "write_diary",
		as: "person",
		args: () => ({ date: "2026-11-08", content: "a day" }),
	},
	{
		tool: "update_briefing_note",
		as: "person",
		args: (s) => ({ noteId: s.noteId, topic: "t2" }),
	},
	{
		tool: "update_task",
		as: "person",
		args: (s) => ({ taskId: s.taskId, title: "renamed" }),
	},
	{ tool: "start_task", as: "person", args: (s) => ({ taskId: s.taskId }) },
	{ tool: "pause_task", as: "person", args: (s) => ({ taskId: s.taskId }) },
	{ tool: "resume_task", as: "person", args: (s) => ({ taskId: s.taskId }) },
	{
		tool: "update_mission",
		as: "person",
		args: (s) => ({ missionId: s.missionId, name: "renamed" }),
	},
	{
		tool: "update_mission_status",
		as: "master",
		args: (s) => ({ missionId: s.missionId, status: "plan" }),
	},
	{
		tool: "create_task",
		as: "person",
		args: () => ({
			title: "a new task",
			assignedTo: "ulysse",
			priority: "low",
			project: "p",
		}),
	},
	{
		tool: "complete_task",
		as: "person",
		args: (s) => ({
			taskId: s.tasks.done,
			completionNote:
				"Shipped in PR #1234 at commit abc1234, 18/18 tests pass.",
		}),
	},
	{
		tool: "fail_task",
		as: "person",
		args: (s) => ({
			taskId: s.tasks.fail,
			failureNote:
				"Failed: the build broke at commit abc1234 (PR #12), 3/18 tests red.",
		}),
	},
	{
		tool: "correct_task_segment",
		as: "person",
		args: async (s, read) => {
			const task = (await read("get_task", { taskId: s.tasks.seg })) as {
				workSegments: Array<{ start: number; end: number }>;
			};
			const seg = task.workSegments[0];
			return {
				taskId: s.tasks.seg,
				segmentIndex: 0,
				start: seg.start,
				end: seg.end,
				reason: "unrecorded break, the real work was shorter",
			};
		},
	},
	{
		tool: "checkout_task",
		as: "person",
		args: (s) => ({ taskId: s.tasks.checkout }),
	},
	{
		tool: "block_task",
		as: "person",
		args: (s) => ({
			taskId: s.tasks.block,
			reason: "waiting on the seatbot task to land first",
			blockedOnTaskId: s.tasks.seatbot,
		}),
	},
	{
		tool: "add_task_dependency",
		as: "person",
		args: (s) => ({ taskId: s.tasks.dep, dependsOn: [s.tasks.block] }),
	},
	{ tool: "delete_task", as: "person", args: (s) => ({ taskId: s.tasks.dep }) },
	{
		tool: "create_mission",
		as: "person",
		args: () => ({
			name: "a mission",
			project: "p",
			priority: "low",
			pilot: "ulysse",
			agents: ["ulysse"],
		}),
	},
	{
		tool: "create_briefing_note",
		as: "person",
		args: () => ({
			title: "a note",
			topic: "t",
			participants: ["ulysse"],
			content: "what was decided",
		}),
	},
	{
		tool: "store_episode",
		as: "person",
		args: () => ({
			namespace: `team/${SLUG}`,
			context: "c",
			goal: "g",
			action: "a",
			outcome: "o",
			insight: "i",
			severity: "minor",
		}),
	},
	{
		tool: "update_profile",
		as: "person",
		args: () => ({ orchestratorId: "ulysse", name: "Ulysse" }),
	},
	{
		tool: "set_summary",
		as: "person",
		args: () => ({ orchestratorId: "ulysse", summary: "working" }),
	},
	{
		tool: "send_message",
		as: "person",
		args: () => ({
			recipientAgentIds: [world.fixtures.strings.seatAgentId],
			content: "hello",
		}),
	},
	{
		tool: "mark_as_read",
		as: "person",
		args: (s) => ({ receiptIds: [s.receiptId] }),
	},
	{
		tool: "delete_message",
		as: "person",
		args: (s) => ({ messageId: s.messageId }),
	},
	{
		tool: "update_recurring_task",
		as: "person",
		args: (s) => ({ recurringTaskId: s.recurringTaskId, title: "renamed" }),
	},
	{
		tool: "pause_recurring_task",
		as: "person",
		args: (s) => ({ taskId: s.recurringTaskId }),
	},
	{
		tool: "resume_recurring_task",
		as: "person",
		args: (s) => ({ taskId: s.recurringTaskId }),
	},
	{
		tool: "delete_recurring_task",
		as: "person",
		args: (s) => ({ taskId: s.recurringTaskId }),
	},
	{
		tool: "add_repo_mapping",
		as: "master",
		args: () => ({ repo: "owner/repo", orchestrator: "ulysse", project: "p" }),
	},
	{
		tool: "remove_repo_mapping",
		as: "master",
		args: () => ({ repo: "owner/repo" }),
	},
	{
		tool: "validate_fix",
		as: "master",
		args: (s) => ({
			patternId: s.patternId,
			validatedFix: "the fix that worked",
		}),
	},
	{
		tool: "link_issue_to_pattern",
		as: "master",
		args: (s) => ({ patternId: s.patternId, issueId: "issue-1" }),
	},
	{
		tool: "soft_delete_memory",
		as: "master",
		args: (s) => ({ memoryId: s.memoryId }),
	},
];

let world: World;
let seeded: Seeded;
const results = new Map<string, CallResult>();
const schemas = new Map<string, unknown>();

beforeAll(async () => {
	vi.stubGlobal("fetch", async () => new Response("offline", { status: 503 }));
	world = await freshBackend("person-bound");
	const extra = await world.t.run(async (ctx) => {
		const now = Date.now();
		const episodeId = await ctx.db.insert("memories", {
			namespace: `team/${SLUG}`,
			clerkOrgId: ORG_ID,
			type: "episode",
			content: "an episode",
			createdBy: "ulysse",
			relations: [],
			isLatest: true,
			episode: {
				context: "c",
				goal: "g",
				action: "a",
				outcome: "o",
				insight: "i",
				severity: "minor",
			},
			createdAt: now,
			updatedAt: now,
		});
		const patternId = await ctx.db.insert("fixPatterns", {
			symptom: "a symptom",
			rootCause: "a cause",
			tags: [],
			stack: [],
			sourceProject: "p",
			createdBy: "ulysse",
			severity: "minor",
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("fixAttempts", {
			patternId,
			description: "tried",
			worked: true,
			why: "because",
			createdBy: "ulysse",
			createdAt: now,
		});
		await ctx.db.insert("bulk_complete_runs", {
			bulkRunId: "bulk-run-structured-1",
			orgId: SLUG,
			clerkOrgId: ORG_ID,
			createdBy: "ulysse",
			status: "complete",
			closed: 0,
			remaining: false,
			startedAt: now,
			updatedAt: now,
		});
		// complete_task reads the billable-project list; empty: no project is billable.
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: now,
		});
		const agents = await ctx.db.query("agents").collect();
		const agentId = (name: string) =>
			String(agents.find((x) => x.name === name)?._id);
		const task = (title: string, assignee: string, project = "p") =>
			ctx.db.insert("tasks", {
				title,
				assignedTo: assignee,
				assignedToId: agentId(assignee),
				priority: "low",
				status: "todo",
				project,
				createdBy: "ulysse",
				createdById: agentId("ulysse"),
				createdAt: now,
				updatedAt: now,
				orgId: SLUG,
				clerkOrgId: ORG_ID,
			});
		const tasks = {
			done: String(await task("to complete", "ulysse")),
			fail: String(await task("to fail", "ulysse", "q")),
			block: String(await task("to block", "ulysse")),
			dep: String(await task("to depend", "ulysse")),
			seg: String(await task("to correct", "ulysse")),
			checkout: String(await task("to check out", "ulysse")),
			seatbot: String(await task("seatbot's", "seatbot")),
		};
		const messages = await ctx.db.query("messages").collect();
		const receiptId = await ctx.db.insert("messageReceipts", {
			messageId: messages[0]._id,
			recipient: "ulysse",
			recipientId: agentId("ulysse"),
			tenantId: SLUG,
			tenantOrgId: ORG_ID,
		});
		return {
			episodeId: String(episodeId),
			patternId: String(patternId),
			tasks,
			receiptId: String(receiptId),
		};
	});
	seeded = {
		...world.fixtures.ids,
		episodeId: world.ids.alias(extra.episodeId),
		patternId: world.ids.alias(extra.patternId),
		bulkRunId: "bulk-run-structured-1",
		tasks: Object.fromEntries(
			Object.entries(extra.tasks).map(([k, v]) => [k, world.ids.alias(v)]),
		) as Seeded["tasks"],
		receiptId: world.ids.alias(extra.receiptId),
	};
	const person = await connectAs(await tokenFor("person-bound", world));
	const master = await connectAs("test-master-token");
	for (const t of (await person.listTools()).tools) {
		if (t.outputSchema) schemas.set(t.name, t.outputSchema);
	}
	for (const t of (await master.listTools()).tools) {
		if (t.outputSchema) schemas.set(t.name, t.outputSchema);
	}
	const read: Read = async (tool, args) => {
		const r = (await person.callTool({
			name: tool,
			arguments: args,
		})) as CallResult;
		if (r.isError) throw new Error(`${tool}: ${r.content[0]?.text}`);
		return JSON.parse(r.content[0].text);
	};
	// Lifecycle preconditions (not decided calls): a task fails from in_progress
	// (hence its own project "q": one in_progress task per project), and a
	// segment exists only once work started and paused.
	await read("start_task", { taskId: seeded.tasks.fail });
	await read("start_task", { taskId: seeded.tasks.seg });
	await new Promise((r) => setTimeout(r, 20));
	await read("pause_task", { taskId: seeded.tasks.seg });
	for (const call of CALLS) {
		const client = call.as === "master" ? master : person;
		const r = (await client.callTool({
			name: call.tool,
			arguments: await call.args(seeded, read),
		})) as CallResult;
		results.set(call.tool, r);
		call.after?.(r, seeded);
	}
	await person.close();
	await master.close();
}, 120_000);

afterAll(() => {
	closeWorld(world.harness);
	vi.unstubAllGlobals();
});

describe("outputSchema: a real success carries structuredContent that validates", () => {
	it("every decided tool is called here (no tool declares a schema unexercised)", () => {
		expect(CALLS.map((c) => c.tool).sort()).toEqual(
			[...STRUCTURED_TOOLS].sort(),
		);
	});

	const ajv = new Ajv2020({ strict: false, allErrors: true });

	for (const call of CALLS) {
		it(`${call.tool} (${call.as})`, () => {
			const r = results.get(call.tool) as CallResult;
			expect(r.isError, r.content?.[0]?.text).not.toBe(true);
			const schema = schemas.get(call.tool);
			expect(schema, "tools/list declares an outputSchema").toBeDefined();
			expect(r.structuredContent, "structuredContent present").toBeDefined();
			const { $schema: _ignored, ...body } = schema as Record<string, unknown>;
			const validate = ajv.compile(body);
			expect(
				validate(r.structuredContent),
				JSON.stringify(validate.errors),
			).toBe(true);
			// The text a client without structuredContent support reads is the
			// same two-space JSON of the same object: one answer, two encodings.
			expect(r.content).toHaveLength(1);
			expect(r.content[0].type).toBe("text");
			expect(r.content[0].text).toBe(
				JSON.stringify(r.structuredContent, null, 2),
			);
		});
	}
});
