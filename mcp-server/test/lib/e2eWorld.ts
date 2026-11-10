/**
 * The end-to-end world of the MCP suite (VantagePeers Cloud): one backend
 * (convex-test, the real Convex functions), the real /mcp route, and CALLS,
 * the table of tool calls made through it, each by the client a real caller
 * of that tool is. Shared by test/output-schema-structured-content.test.ts
 * (every structured answer validates) and test/tool-coverage.test.ts (every
 * served tool is called). Each test file runs runE2E() once in its own
 * worker; the importing file must `vi.mock("convex/browser")` with
 * ./forwardingConvex.js.
 *
 * Moved here from output-schema-structured-content.test.ts unchanged (task
 * k17d1q04zkfqnwxnjf6rjdbtqh8htnd0, coverage 3/3).
 */

import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { vi } from "vitest";
import {
	__setQueryEmbedderForTests,
	__setRagSearcherForTests,
} from "../../../convex/search";
import { testClerkOrgId } from "../../../tests/fixtures/testClerkOrgId";
import {
	BOUND,
	closeWorld,
	connectAs,
	freshBackend,
	personToken,
	ORG_ID,
	SLUG,
	tokenFor,
} from "./seatWorld.js";
import { membership } from "./authorizeHarness.js";

export type CallResult = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
};

export type World = Awaited<ReturnType<typeof freshBackend>>;
export type Seeded = World["fixtures"]["ids"] & {
	episodeId: string;
	patternId: string;
	bulkRunId: string;
	recurringTaskId?: string;
	/** Tasks seeded in the person's org for the task lifecycle writes. */
	tasks: Record<
		| "done"
		| "fail"
		| "block"
		| "dep"
		| "seg"
		| "checkout"
		| "seatbot"
		| "blocker",
		string
	>;
	receiptId: string;
	/** The rows the erase tools remove, and the debate room. */
	erase: {
		memoryId: string;
		taskId: string;
		/** A fix pattern (with an attempt) the operator admin erases, and one the refusal poles try. */
		patternId: string;
		keptPatternId: string;
	};
	roomId: string;
	/** IDs no row carries any more (a deleted mission), for the not-found poles. */
	goneMissionId: string;
	/** The Knowledge Base / OKF chain, filled call by call. */
	kb: {
		ticket?: string;
		storageId?: string;
		docId?: string;
		bundleStorageId?: string;
	};
};

/** The Knowledge Base document the chain uploads, and the sha256 its ticket binds. */
export const KB_BODY = "# Seeded document\n\nSome text to chunk.";
const KB_SHA = createHash("sha256").update(KB_BODY).digest("hex");

/** A RAG entry the stubbed searcher serves: the memory (or pattern) it indexes. */
type RagEntry = { key: string; text: string; type: string };

/** Reads one tool's JSON answer as the person (a test-side lookup, not a decided call). */
type Read = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export type Call = {
	/** Any served tool: the structured ones are checked against their schema too. */
	tool: string;
	/** person: a person with a bound agent; master: the fleet master bearer; fleet-agent: that bearer with a fleet agent's credential; operator-admin: a person who is org:admin of the operator organisation. */
	as: "person" | "master" | "fleet-agent" | "operator-admin";
	args: (
		s: Seeded,
		read: Read,
	) => Record<string, unknown> | Promise<Record<string, unknown>>;
	/** A call that must run before this one, whose result this one reads. */
	after?: (r: CallResult, s: Seeded) => void;
};

// In order: a later call may depend on an earlier one's state.
export const CALLS: Call[] = [
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
	{
		tool: "billing_summary_by_project",
		as: "master",
		args: () => ({ listNoDuration: true }),
	},
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
	// lists and searches, on the rows seeded above (before any delete below).
	// list_missions and list_diaries serve a non-master caller only its own
	// user ID as pilot / orchestrator, which no seeded row carries: the fleet
	// master is their client here.
	{
		tool: "recall",
		as: "person",
		args: () => ({ query: "seeded", namespace: `team/${SLUG}` }),
	},
	{
		tool: "text_search",
		as: "person",
		args: () => ({ query: "seeded", namespace: `team/${SLUG}` }),
	},
	{
		tool: "hybrid_search",
		as: "person",
		args: () => ({ query: "seeded", namespace: `team/${SLUG}` }),
	},
	{
		tool: "search_episodes_by_keyword",
		as: "person",
		args: () => ({ query: "episode", namespace: `team/${SLUG}` }),
	},
	{
		tool: "search_episodes_by_semantic",
		as: "person",
		args: () => ({ query: "episode", namespace: `team/${SLUG}` }),
	},
	{
		tool: "search_messages_by_keyword",
		as: "person",
		args: () => ({ query: "seeded" }),
	},
	{
		tool: "search_tasks_by_keyword",
		as: "person",
		args: () => ({ query: "seeded" }),
	},
	{
		tool: "search_briefing_notes_by_keyword",
		as: "person",
		args: () => ({ query: "seeded" }),
	},
	{
		tool: "search_fix_patterns",
		as: "master",
		args: () => ({ query: "a symptom" }),
	},
	{
		tool: "list_episodes",
		as: "person",
		args: () => ({ namespace: `team/${SLUG}` }),
	},
	{
		tool: "list_memories",
		as: "person",
		args: () => ({ namespace: `team/${SLUG}` }),
	},
	{ tool: "list_peers", as: "person", args: () => ({}) },
	{ tool: "list_messages", as: "person", args: () => ({}) },
	{ tool: "list_tasks", as: "person", args: () => ({}) },
	{
		tool: "list_tasks_by_mission",
		as: "person",
		args: (s) => ({ missionId: s.missionId }),
	},
	{ tool: "list_missions", as: "master", args: () => ({}) },
	{ tool: "list_diaries", as: "master", args: () => ({}) },
	{ tool: "list_briefing_notes", as: "person", args: () => ({}) },
	{ tool: "list_recurring_tasks", as: "person", args: () => ({}) },
	{ tool: "list_repo_mappings", as: "master", args: () => ({}) },
	{ tool: "list_fix_patterns", as: "master", args: () => ({}) },
	// null-able reads, each on a seeded row (the not-found poles are below)
	{
		tool: "get_profile",
		as: "person",
		args: () => ({ orchestratorId: "ulysse" }),
	},
	{
		tool: "get_mission",
		as: "person",
		args: (s) => ({ missionId: s.missionId }),
	},
	{
		tool: "get_mission_template",
		as: "master",
		args: () => ({ name: "seeded-template" }),
	},
	{
		tool: "get_diary",
		as: "person",
		args: () => ({ date: "2026-11-07", orchestrator: "ulysse" }),
	},
	// the inbox, before mark_as_read / delete_message below drain it
	{
		tool: "check_messages",
		as: "person",
		args: () => ({ recipient: "ulysse" }),
	},
	// the Knowledge Base / OKF chain: ticket, blob, claim, ingest, soft delete,
	// export, import (dry run)
	{
		tool: "generate_upload_url",
		as: "person",
		args: () => ({ sha256: KB_SHA }),
		after: (r, s) => {
			s.kb.ticket = (
				JSON.parse(r.content[1].text) as { ticket: string }
			).ticket;
		},
	},
	{
		tool: "claim_upload",
		as: "person",
		args: async (s) => {
			const stored = await world.t.run((ctx) =>
				ctx.storage.store(new Blob([KB_BODY], { type: "text/markdown" })),
			);
			s.kb.storageId = world.ids.alias(String(stored));
			return { storageId: s.kb.storageId, ticket: s.kb.ticket };
		},
	},
	{
		tool: "store_document_chunked",
		as: "person",
		args: (s) => ({
			storageId: s.kb.storageId,
			mimeType: "text/markdown",
			filename: "seeded.md",
		}),
		after: (r, s) => {
			s.kb.docId = (JSON.parse(r.content[0].text) as { docId: string }).docId;
		},
	},
	{
		tool: "soft_delete_document",
		as: "person",
		args: (s) => ({ docId: s.kb.docId }),
	},
	{
		tool: "export_okf_bundle",
		as: "person",
		args: () => ({ namespace: `team/${SLUG}`, format: "tarball" }),
		after: (r, s) => {
			s.kb.bundleStorageId = (
				JSON.parse(r.content[0].text) as { storageId: string }
			).storageId;
		},
	},
	{
		tool: "import_okf_bundle",
		as: "person",
		args: (s) => ({
			storageId: s.kb.bundleStorageId,
			targetNamespace: `team/${SLUG}`,
			mode: "dry-run",
		}),
	},
	// the debate room: ulysse's turn, then the room with it
	{
		tool: "debate_post_turn",
		as: "person",
		args: (s) => ({ roomId: s.roomId, turnSeq: 1, text: "ship it" }),
	},
	{
		tool: "debate_get_room",
		as: "person",
		args: (s) => ({ roomId: s.roomId }),
	},
	// a dry-run preview of the open tasks of the person's agent
	{
		tool: "bulk_complete_tasks",
		as: "person",
		args: () => ({ filter: { assignedTo: "ulysse", status: "todo" } }),
	},
	// the erase tools, on rows written for them
	{
		tool: "erase_memory",
		as: "person",
		args: (s) => ({
			memoryId: s.erase.memoryId,
			redactions: [{ find: "sk-live-LEAKED", replaceWith: "[REDACTED]" }],
		}),
	},
	{
		tool: "erase_row",
		as: "person",
		args: (s) => ({ table: "tasks", rowId: s.erase.taskId }),
	},
	// a fix pattern is owned by the operator organisation: its admin erases it
	{
		tool: "erase_fix_pattern",
		as: "operator-admin",
		args: (s) => ({ patternId: s.erase.patternId }),
	},
	// the fleet doors: the master acting as a fleet agent (its credential)
	{ tool: "improvisation_digest", as: "fleet-agent", args: () => ({}) },
	{
		tool: "create_fix_pattern",
		as: "fleet-agent",
		args: () => ({
			symptom: "a symptom seen by the fleet",
			rootCause: "its cause",
			tags: [],
			stack: [],
			sourceProject: "p",
			severity: "minor",
		}),
	},
	{
		tool: "add_fix_attempt",
		as: "fleet-agent",
		args: (s) => ({
			patternId: s.patternId,
			description: "tried a fix",
			worked: true,
			why: "it removed the cause",
		}),
	},
	{
		tool: "update_mission_template",
		as: "fleet-agent",
		args: () => ({
			name: "fleet-template",
			steps: [{ title: "triage", description: "look at it" }],
		}),
	},
	{
		tool: "instantiate_template_into_mission",
		as: "master",
		args: (s) => ({
			templateName: "seeded-template",
			missionId: s.missionId,
		}),
	},
	// after every call above, so that the person has a recorded usage to read
	{ tool: "get_tool_usage", as: "person", args: () => ({}) },
	{
		tool: "get_owner_tool_usage",
		as: "person",
		args: () => ({ ownerUserId: BOUND }),
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

export let world: World;
export let seeded: Seeded;
export const results = new Map<string, CallResult>();
export const schemas = new Map<string, unknown>();
export const descriptions = new Map<string, string>();
/** Each served tool's inputSchema, as tools/list declares it. */
export const inputSchemas = new Map<string, unknown>();
/** Every tool name tools/list serves to any client of the world. */
export const served = new Set<string>();
/**
 * For each null-able read, the call on a key no visible row carries: seatbot is
 * on the organisation's roster and has no profile (a name off the roster is
 * refused, not absent), the mission was deleted, no template or diary entry
 * has that name or date.
 */
export const NOT_FOUND: Array<
	[
		string,
		(s: Seeded) => Record<string, unknown>,
		"person" | "master",
		(s: Seeded) => string,
	]
> = [
	[
		"get_profile",
		() => ({ orchestratorId: "seatbot" }),
		"person",
		() => "seatbot",
	],
	[
		"get_mission",
		(s) => ({ missionId: s.goneMissionId }),
		"person",
		(s) => s.goneMissionId,
	],
	[
		"get_mission_template",
		() => ({ name: "no-such-template" }),
		"master",
		() => "no-such-template",
	],
	[
		"get_diary",
		() => ({ date: "1999-01-01", orchestrator: "ulysse" }),
		"person",
		() => "ulysse/1999-01-01",
	],
];

/** The extra poles: a page the byte cap cut, and a refused read. */
export const poles = new Map<string, CallResult>();
/** What the stubbed RAG searcher serves, by namespace. */
const ragIndex = new Map<string, RagEntry[]>();
/** The big memories the cut pole lists: over 60 KB together. */
export const BIG_NAMESPACE = `team/${SLUG}/big`;

/** The operator organisation of the world, whose agents are the fleet's. */
export const FLEET_SLUG = "vantage-fleet";
const FLEET_ORG_ID = testClerkOrgId(FLEET_SLUG) as string;

/**
 * An agent of the operator organisation (orgKind "operator"), owned by a live
 * member, and the credential an admin of that organisation mints for it: what
 * a fleet station presents beside the master bearer.
 */
async function fleetAgentCredential(): Promise<string> {
	const owner = "user_fleet_owner";
	const agentId = await world.t.run(async (ctx) => {
		const now = Date.now();
		const id = await ctx.db.insert("agents", {
			orgSlug: FLEET_SLUG,
			clerkOrgId: FLEET_ORG_ID,
			name: "sigma",
			normalizedName: "sigma",
			ownerPersonId: owner,
			isActive: true,
			createdAt: now,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: FLEET_SLUG,
			clerkOrgId: FLEET_ORG_ID,
			orgKind: "operator",
			allowedOrchestrators: ["sigma"],
			allowedAgentIds: [id],
			scopes: ["vantage:read", "vantage:write"],
			displayName: FLEET_SLUG,
			isActive: true,
			createdAt: now,
		});
		await ctx.db.insert("orgMembership", {
			clerkOrgSlug: FLEET_SLUG,
			clerkOrgId: FLEET_ORG_ID,
			clerkUserId: owner,
			role: "member",
			createdAt: now,
			updatedAt: now,
		});
		// A closed task of the operator organisation whose note states a
		// commit and a pull request without citing a source: what
		// improvisation_digest flags (a real sample row for its schema).
		await ctx.db.insert("tasks", {
			title: "a fleet task",
			assignedTo: "sigma",
			assignedToId: String(id),
			priority: "low",
			status: "done",
			project: "fleet",
			completionNote: "Merged PR #4242 at commit abc1234def, deployed.",
			createdBy: "sigma",
			createdById: String(id),
			createdAt: now,
			updatedAt: now,
			completedAt: now,
			orgId: FLEET_SLUG,
			clerkOrgId: FLEET_ORG_ID,
		});
		// The same kind of row for an orchestrator whose name is not ASCII: the
		// digest must serve it (task k178ty5ndzkyy8y4vd7c3jh0p58hxg2z).
		await ctx.db.insert("tasks", {
			title: "a task of an accented orchestrator",
			assignedTo: "h\u00e9lios",
			assignedToId: String(id),
			priority: "low",
			status: "done",
			project: "fleet",
			completionNote: "Merged PR #4243 at commit abc1234def, deployed.",
			createdBy: "sigma",
			createdById: String(id),
			createdAt: now,
			updatedAt: now,
			completedAt: now,
			orgId: FLEET_SLUG,
			clerkOrgId: FLEET_ORG_ID,
		});
		return id;
	});
	const minted = (await world.t
		.withIdentity({
			subject: "user_fleet_admin",
			org_slug: FLEET_SLUG,
			org_id: FLEET_ORG_ID,
			org_role: "org:admin",
		} as never)
		.mutation(
			makeFunctionReference<"mutation">(
				"agentCredentials:mintAgentCredential",
			) as never,
			{ agentId } as never,
		)) as { secret: string };
	return minted.secret;
}

/**
 * A debate room of the person's organisation between its two agents, ulysse
 * and seatbot, opened by an organisation admin, with the first turn (ulysse's)
 * delivered: debate_post_turn posts it, debate_get_room reads the room.
 */
async function openDebateRoom(): Promise<string> {
	const admin = world.t.withIdentity({
		subject: "user_debate_admin",
		org_slug: SLUG,
		org_id: ORG_ID,
		org_role: "org:admin",
	} as never);
	const ref = (name: string) =>
		makeFunctionReference<"mutation">(name) as never;
	const agents = await world.t.run(async (ctx) => {
		const rows = await ctx.db.query("agents").collect();
		const of = (n: string) => String(rows.find((r) => r.name === n)?._id);
		return { ulysse: of("ulysse"), seatbot: of("seatbot") };
	});
	await admin.mutation(ref("debate:upsertSettings"), {
		maxRoundLimit: 5,
		maxParticipants: 6,
		maxRefusalRows: 2,
		maxTurnMessageChars: 4000,
		pollSeconds: 5,
		maxAnswerCharsCeiling: 500,
		maxLabelChars: 40,
		maxTurnInstructionChars: 400,
		maxActiveRooms: 10,
	} as never);
	const templateId = await admin.mutation(ref("debate:upsertTemplate"), {
		template: {
			id: "review",
			name: "Review",
			language: "en",
			turnInstruction: "Answer in one paragraph.",
			participants: [
				{
					id: "p1",
					label: "ulysse",
					kind: "agent",
					agentId: agents.ulysse,
					transport: "waker",
				},
				{
					id: "p2",
					label: "seatbot",
					kind: "agent",
					agentId: agents.seatbot,
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
	const roomId = (await admin.mutation(ref("debate:createRoom"), {
		templateId,
		subject: "Ship it?",
	} as never)) as string;
	await world.t.mutation(ref("debate:deliverTurn"), {
		roomId,
		turnSeq: 1,
	} as never);
	return roomId;
}

/** Seeds the world and makes every call of CALLS, then the poles. */
export async function runE2E(): Promise<void> {
	vi.stubGlobal("fetch", async () => new Response("offline", { status: 503 }));
	world = await freshBackend("person-bound", { search: true });
	// The RAG component is answered from `ragIndex` (filled below from real
	// rows); the namespace gate, the type filter and the live-row check in
	// convex/search.ts all still run on what it serves.
	__setQueryEmbedderForTests(async () => [0.1, 0.2, 0.3]);
	__setRagSearcherForTests((async (
		_ctx: unknown,
		args: { namespace: string; limit?: number },
	) => {
		const hits = (ragIndex.get(args.namespace) ?? []).slice(
			0,
			args.limit ?? 10,
		);
		return {
			results: hits.map((e, i) => ({
				entryId: `${args.namespace}#${e.key}`,
				score: 0.9 - i * 0.01,
				content: [{ text: e.text }],
			})),
			entries: hits.map((e) => ({
				entryId: `${args.namespace}#${e.key}`,
				key: e.key,
				filterValues: [
					{ name: "namespace", value: args.namespace },
					{ name: "type", value: e.type },
					{ name: "isLatest", value: "true" },
				],
			})),
		};
	}) as unknown as Parameters<typeof __setRagSearcherForTests>[0]);
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
			// A live task of the person's agent that a peer waits on, so that
			// list_blocked_on_me answers a real entry and its item schema is exercised.
			blocker: String(await task("waited on", "ulysse", "w")),
		};
		await ctx.db.insert("tasks", {
			title: "waiting",
			assignedTo: "seatbot",
			assignedToId: agentId("seatbot"),
			priority: "low",
			status: "blocked",
			blockedOnTaskId: tasks.blocker as never,
			blockedCause: "peer_task",
			project: "w",
			createdBy: "seatbot",
			createdById: agentId("seatbot"),
			createdAt: now,
			updatedAt: now - 1000,
			orgId: SLUG,
			clerkOrgId: ORG_ID,
		});
		// A done task with a project and no measured duration, so that
		// billing_summary_by_project lists one in noDurationTasks.
		await ctx.db.insert("tasks", {
			title: "done without a duration",
			assignedTo: "ulysse",
			assignedToId: agentId("ulysse"),
			priority: "low",
			status: "done",
			project: "billed",
			createdBy: "ulysse",
			createdById: agentId("ulysse"),
			createdAt: now - 5000,
			updatedAt: now - 1000,
			completedAt: now - 1000,
			orgId: SLUG,
			clerkOrgId: ORG_ID,
		});
		// A task of the seeded mission (list_tasks_by_mission), a diary entry
		// (list_diaries), a repo mapping (list_repo_mappings).
		const mission = await ctx.db.query("missions").first();
		await ctx.db.insert("tasks", {
			title: "a mission task",
			assignedTo: "ulysse",
			assignedToId: agentId("ulysse"),
			priority: "low",
			status: "todo",
			project: "m",
			missionId: mission?._id,
			createdBy: "ulysse",
			createdById: agentId("ulysse"),
			createdAt: now,
			updatedAt: now,
			orgId: SLUG,
			clerkOrgId: ORG_ID,
		});
		await ctx.db.insert("diary", {
			date: "2026-11-07",
			orchestrator: "ulysse",
			content: "a seeded day",
			createdBy: "ulysse",
			createdById: agentId("ulysse"),
			createdAt: now,
			orgId: SLUG,
			clerkOrgId: ORG_ID,
		});
		// A GitHub owner bound to the person's organisation, so that
		// get_github_owner_bindings answers a real binding row.
		await ctx.db.insert("githubOwnerBindings", {
			owner: "immobiliere-pujol-gh",
			orgId: SLUG,
			clerkOrgId: ORG_ID,
			installationId: 4242,
			accountType: "Organization",
			githubUserLogin: "pujol-admin",
			boundBy: "user_admin",
			boundAt: now,
			active: true,
		});
		await ctx.db.insert("githubRepoMapping", {
			repo: "owner/seeded-repo",
			orchestrator: "ulysse",
			project: "p",
			active: true,
		});
		// A profile for get_profile, a template for get_mission_template, and a
		// mission deleted at once, whose ID no row carries (get_mission not found).
		await ctx.db.insert("profiles", {
			orchestratorId: "ulysse",
			instanceId: "ulysse-vps",
			name: "Ulysse",
			agentId: agentId("ulysse") as never,
			static: { role: "assistant", workspace: "/w", capabilities: ["mcp"] },
			dynamic: { currentTask: "seeding", lastSeen: now, sessionCount: 1 },
		});
		await ctx.db.insert("missionTemplates", {
			name: "seeded-template",
			description: "a template",
			steps: [{ title: "step one", description: "do it" }],
			isDefault: false,
			createdBy: "ulysse",
			createdAt: now,
			updatedAt: now,
		});
		const gone = await ctx.db.insert("missions", {
			name: "gone",
			project: "p",
			status: "plan",
			priority: "low",
			pilot: "ulysse",
			agents: ["ulysse"],
			createdBy: "ulysse",
			createdAt: now,
			updatedAt: now,
			orgId: SLUG,
			clerkOrgId: ORG_ID,
		});
		await ctx.db.delete(gone);
		// Three memories of 30 KB each: list_memories over them exceeds the 60 KB
		// cap, so capListResponseBytes cuts the page (the truncated pole).
		for (const n of [1, 2, 3]) {
			await ctx.db.insert("memories", {
				namespace: BIG_NAMESPACE,
				clerkOrgId: ORG_ID,
				type: "reference",
				content: `big ${n} ${"x".repeat(30_000)}`,
				createdBy: "ulysse",
				relations: [],
				isLatest: true,
				createdAt: now + n,
				updatedAt: now + n,
			});
		}
		// What the RAG index holds: the org's live memories (by their real IDs,
		// which the live-row check reads) and the seeded fix pattern.
		const indexed = await ctx.db
			.query("memories")
			.filter((q) => q.eq(q.field("namespace"), `team/${SLUG}`))
			.collect();
		ragIndex.set(
			`team/${SLUG}`,
			indexed.map((m) => ({
				key: String(m._id),
				text: m.content,
				type: m.type,
			})),
		);
		ragIndex.set("fixpatterns", [
			{ key: String(patternId), text: "a symptom", type: "reference" },
		]);
		// A memory holding a leaked token (erase_memory) and a task (erase_row),
		// both written by the person's own agent.
		const eraseMemoryId = await ctx.db.insert("memories", {
			namespace: `team/${SLUG}`,
			clerkOrgId: ORG_ID,
			type: "reference",
			content: "the key is sk-live-LEAKED, rotate it",
			createdBy: "ulysse",
			createdById: agentId("ulysse"),
			relations: [],
			isLatest: true,
			createdAt: now,
			updatedAt: now,
		});
		const eraseTaskId = await task("to erase", "ulysse", "e");
		const erasePattern = async () => {
			const id = await ctx.db.insert("fixPatterns", {
				symptom: "to erase",
				rootCause: "a cause",
				tags: [],
				stack: [],
				sourceProject: "p",
				createdBy: "sigma",
				severity: "minor",
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("fixAttempts", {
				patternId: id,
				description: "tried",
				worked: false,
				why: "because",
				createdBy: "sigma",
				createdAt: now,
			});
			return id;
		};
		const erasePatternId = await erasePattern();
		const keptPatternId = await erasePattern();
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
			goneMissionId: String(gone),
			erase: {
				memoryId: String(eraseMemoryId),
				taskId: String(eraseTaskId),
				patternId: String(erasePatternId),
				keptPatternId: String(keptPatternId),
			},
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
		goneMissionId: world.ids.alias(extra.goneMissionId),
		erase: {
			memoryId: world.ids.alias(extra.erase.memoryId),
			taskId: world.ids.alias(extra.erase.taskId),
			patternId: world.ids.alias(extra.erase.patternId),
			keptPatternId: world.ids.alias(extra.erase.keptPatternId),
		},
		roomId: world.ids.alias(await openDebateRoom()),
		kb: {},
	};
	const person = await connectAs(await tokenFor("person-bound", world));
	const master = await connectAs("test-master-token");
	// The fleet master acting as a fleet agent: the master bearer plus the
	// agent credential of an agent of the operator organisation.
	const fleetAgent = await connectAs(
		"test-master-token",
		await fleetAgentCredential(),
	);
	// An admin of the operator organisation, signed in as a person (no agent): the
	// only caller a fix pattern's erase serves. The operator mapping exists since
	// fleetAgentCredential seeded it.
	world.harness.setMemberships("user_fleet_admin", [
		membership(FLEET_ORG_ID, FLEET_SLUG, "org:admin"),
	]);
	const operatorAdmin = await connectAs(
		await personToken(world.harness, "user_fleet_admin", "", FLEET_ORG_ID),
	);
	for (const t of [
		...(await person.listTools()).tools,
		...(await master.listTools()).tools,
		...(await fleetAgent.listTools()).tools,
	]) {
		served.add(t.name);
		inputSchemas.set(t.name, t.inputSchema);
		if (t.outputSchema) {
			schemas.set(t.name, t.outputSchema);
			descriptions.set(t.name, t.description ?? "");
		}
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
		const client =
			call.as === "master"
				? master
				: call.as === "fleet-agent"
					? fleetAgent
					: call.as === "operator-admin"
						? operatorAdmin
						: person;
		const r = (await client.callTool({
			name: call.tool,
			arguments: await call.args(seeded, read),
		})) as CallResult;
		results.set(call.tool, r);
		call.after?.(r, seeded);
	}
	// The refusals of erase_fix_pattern: an agent seat of the operator org (the fleet
	// agent, never an admin) and a person of a client organisation.
	for (const [pole, client] of [
		["refused:erase_fix_pattern:agent-seat", fleetAgent],
		["refused:erase_fix_pattern:client-person", person],
	] as const) {
		poles.set(
			pole,
			(await client.callTool({
				name: "erase_fix_pattern",
				arguments: { patternId: seeded.erase.keptPatternId },
			})) as CallResult,
		);
	}
	poles.set(
		"truncated",
		(await person.callTool({
			name: "list_memories",
			arguments: { namespace: BIG_NAMESPACE },
		})) as CallResult,
	);
	for (const [tool, args, as] of NOT_FOUND) {
		const client = as === "master" ? master : person;
		poles.set(
			`not-found:${tool}`,
			(await client.callTool({
				name: tool,
				arguments: args(seeded),
			})) as CallResult,
		);
	}
	// The inbox once drained (mark_as_read and delete_message ran above; the
	// debate room's turn message, delivered to ulysse, is read here too).
	const pending = (await person.callTool({
		name: "check_messages",
		arguments: { recipient: "ulysse" },
	})) as CallResult;
	const receiptIds = (
		(pending.structuredContent?.messages as
			| Array<{ receiptId: string }>
			| undefined) ?? []
	).map((m) => m.receiptId);
	if (receiptIds.length > 0) {
		await person.callTool({ name: "mark_as_read", arguments: { receiptIds } });
	}
	poles.set(
		"inbox-empty",
		(await person.callTool({
			name: "check_messages",
			arguments: { recipient: "ulysse" },
		})) as CallResult,
	);
	// A URL with no ticket: the second text item says so.
	poles.set(
		"upload-url-no-ticket",
		(await person.callTool({
			name: "generate_upload_url",
			arguments: {},
		})) as CallResult,
	);
	// An invalid cursor ARGUMENT, through the real /mcp route and the v2 client
	// (task k171rk9evy8yy48tfx765zqwk18hwdvh, C-11 (b)): the literal mcp-doctor sends.
	poles.set(
		"invalid-cursor",
		(await person.callTool({
			name: "list_tasks",
			arguments: { cursor: "mcp-doctor:invalid-cursor:%%%" },
		})) as CallResult,
	);
	poles.set(
		"refused",
		(await person.callTool({
			name: "recall",
			arguments: { query: "seeded", namespace: "orchestrator/somebody-else" },
		})) as CallResult,
	);
	await person.close();
	await master.close();
	await fleetAgent.close();
	await operatorAdmin.close();
}

/** Undo what runE2E installed. */
export function closeE2E(): void {
	__setRagSearcherForTests(null);
	__setQueryEmbedderForTests(null);
	closeWorld(world.harness);
	vi.unstubAllGlobals();
}
