#!/usr/bin/env bun
/**
 * VantagePeers MCP Server
 * Exposes Convex memory functions as Claude Code tools via stdio transport.
 *
 * Tools:
 *   store_memory    — create a typed memory entry
 *   recall          — semantic vector search over memories
 *   store_episode   — create an episodic memory with structured fields
 *   get_profile     — fetch an orchestrator profile
 *   update_profile  — upsert an orchestrator profile
 *   list_memories   — list memories by namespace with optional type filter
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "fs";
import { resolve } from "path";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap: resolve CONVEX_URL from env or .env.local
// ─────────────────────────────────────────────────────────────────────────────

function loadConvexUrl(): string {
	// 1. Explicit env var always wins
	if (process.env.CONVEX_URL) {
		return process.env.CONVEX_URL;
	}

	// 2. Parse .env.local from the project root (one level up from mcp-server/)
	const envPath = resolve(import.meta.dirname ?? __dirname, "../.env.local");
	try {
		const raw = readFileSync(envPath, "utf-8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("CONVEX_URL=")) {
				const value = trimmed.slice("CONVEX_URL=".length).split("#")[0].trim();
				if (value) return value;
			}
		}
	} catch {
		// .env.local not found — fall through to error
	}

	throw new Error(
		"CONVEX_URL not found. Set it as an environment variable or add it to .env.local",
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Zod schemas for validated params
// ─────────────────────────────────────────────────────────────────────────────

const memoryTypeSchema = z
	.enum(["user", "feedback", "project", "reference", "episode"])
	.describe("Memory classification type");

const creatorSchema = z
	.enum(["pi", "tau", "phi", "system"])
	.describe("Which orchestrator is creating this memory");

const severitySchema = z
	.enum(["critical", "major", "minor"])
	.describe("Episode severity — critical = cross-orchestrator lesson");

// ─────────────────────────────────────────────────────────────────────────────
// Helper: normalize string|array inputs to array (agents pass strings for arrays)
// ─────────────────────────────────────────────────────────────────────────────

function toArray(val: string | string[] | undefined): string[] | undefined {
	if (val === undefined) return undefined;
	return Array.isArray(val) ? val : [val];
}

// Schema helper: accepts string or array of strings
const flexArray = z.union([z.array(z.string()), z.string()]);
const flexArrayOptional = flexArray.optional();

// ─────────────────────────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────────────────────────

const convexUrl = loadConvexUrl();
const convex = new ConvexHttpClient(convexUrl);

const server = new McpServer({
	name: "vantage-peers",
	version: "1.0.0",
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool: store_memory
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"store_memory",
	"Store a typed memory entry in VantagePeers. Supports user, feedback, project, and reference types. " +
		"Optional relatesTo creates a graph relation (updates supersedes the target, extends adds detail, derives is an inference).",
	{
		namespace: z
			.string()
			.describe(
				"Memory namespace — e.g. 'global', 'orchestrator/pi', 'project/vantage-starter'",
			),
		type: memoryTypeSchema,
		content: z
			.string()
			.describe("Human-readable memory content — what the memory says"),
		createdBy: creatorSchema,
		relatesTo: z
			.object({
				targetId: z
					.string()
					.describe("ID of the memory this relates to (Convex document ID)"),
				type: z
					.enum(["updates", "extends", "derives"])
					.describe(
						"Relation type: updates=supersedes, extends=adds detail, derives=inference",
					),
			})
			.optional()
			.describe("Optional graph relation to another memory"),
		ttl: z
			.string()
			.optional()
			.describe("Optional expiry ISO timestamp e.g. '2026-06-01T00:00:00Z'"),
	},
	async ({ namespace, type, content, createdBy, relatesTo, ttl }) => {
		const relations = relatesTo
			? [{ targetId: relatesTo.targetId as any, type: relatesTo.type }]
			: [];

		const memoryId = await convex.mutation(api.memories.storeMemory, {
			namespace,
			type,
			content,
			createdBy,
			relations,
			ttl,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ memoryId, namespace, type, content }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: recall
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"recall",
	"Semantic vector search over VantagePeers. Returns top K memories ranked by cosine similarity to the query. " +
		"Optionally filter by namespace and/or type.",
	{
		query: z
			.string()
			.describe("Natural language query to search for relevant memories"),
		namespace: z
			.string()
			.optional()
			.describe("Filter to a specific namespace — omit to search all"),
		type: memoryTypeSchema
			.optional()
			.describe("Filter to a specific memory type — omit to search all"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(50)
			.optional()
			.default(5)
			.describe("Maximum number of results to return (default 5)"),
	},
	async ({ query, namespace, type, limit }) => {
		const results = await convex.action(api.search.recall, {
			query,
			namespace,
			type,
			limit: limit ?? 5,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(results, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: store_episode
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"store_episode",
	"Store an episodic memory with structured context/goal/action/outcome/insight fields. " +
		"Episodes are the 'other half' of memory — not just facts, but what happened and what was learned. " +
		"Use severity=critical for lessons that should be shared across all orchestrators.",
	{
		namespace: z.string().describe("Memory namespace — e.g. 'orchestrator/pi'"),
		createdBy: creatorSchema,
		context: z
			.string()
			.describe("Situation that triggered this episode — what was the setup"),
		goal: z.string().describe("What was being attempted"),
		action: z.string().describe("What was actually done"),
		outcome: z.string().describe("What happened — success or failure"),
		insight: z
			.string()
			.describe(
				"The lesson extracted — procedural memory, what to do differently",
			),
		severity: severitySchema,
	},
	async ({
		namespace,
		createdBy,
		context,
		goal,
		action,
		outcome,
		insight,
		severity,
	}) => {
		const memoryId = await convex.mutation(api.episodes.storeEpisode, {
			namespace,
			createdBy,
			context,
			goal,
			action,
			outcome,
			insight,
			severity,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{ memoryId, type: "episode", severity, namespace },
						null,
						2,
					),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_profile
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"get_profile",
	"Fetch an orchestrator profile (static identity + dynamic session state). " +
		"Returns null if the profile does not exist yet — call update_profile to create it.",
	{
		orchestratorId: z
			.enum(["pi", "tau", "phi"])
			.describe("Orchestrator identifier"),
	},
	async ({ orchestratorId }) => {
		const profile = await convex.query(api.profiles.getProfile, {
			orchestratorId,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(profile, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_profile
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"update_profile",
	"Create or update an orchestrator profile. " +
		"static fields are stable identity facts (role, workspace, capabilities). " +
		"dynamic fields are mutable session state (currentTask, lastSeen, sessionCount).",
	{
		orchestratorId: z
			.enum(["pi", "tau", "phi"])
			.describe("Orchestrator identifier"),
		name: z.string().describe("Human-readable orchestrator name"),
		static: z
			.object({
				role: z.string().describe("Orchestrator role description"),
				workspace: z.string().describe("Primary working directory"),
				capabilities: z
					.array(z.string())
					.describe("List of capability keywords"),
			})
			.describe("Stable identity facts — infrequently updated"),
		dynamic: z
			.object({
				currentTask: z
					.string()
					.optional()
					.describe("Current task or goal in progress"),
				lastSeen: z
					.number()
					.describe("Unix timestamp (ms) of last session start"),
				sessionCount: z.number().int().describe("Total sessions to date"),
			})
			.describe("Mutable session state — updated each session"),
	},
	async ({ orchestratorId, name, static: staticFields, dynamic }) => {
		const profileId = await convex.mutation(api.profiles.upsertProfile, {
			orchestratorId,
			name,
			static: staticFields,
			dynamic,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ profileId, orchestratorId, name }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_memories
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"list_memories",
	"List active memories for a namespace, ordered newest first. " +
		"Only returns isLatest=true memories (superseded memories are excluded by default). " +
		"Use type to filter to a specific memory category.",
	{
		namespace: z
			.string()
			.describe(
				"Namespace to list memories from — e.g. 'global', 'orchestrator/pi'",
			),
		type: memoryTypeSchema
			.optional()
			.describe("Filter to a specific type — omit to return all types"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.default(20)
			.describe("Maximum number of memories to return (default 20)"),
	},
	async ({ namespace, type, limit }) => {
		const memories = await convex.query(api.memories.listMemories, {
			namespace,
			type,
			limit: limit ?? 20,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(memories, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: send_message
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"send_message",
	"Send a message to one, many, or all orchestrators. " +
		"channel: 'broadcast' = all, 'tau' = role DM, 'pi-vps' = instance DM, 'tau,phi' = multi. " +
		"Creates message + one receipt per recipient. Replaces claude-peers send_message.",
	{
		from: creatorSchema.describe("Sender role (pi/tau/phi)"),
		fromInstanceId: z
			.string()
			.optional()
			.describe("Sender instance ID — e.g. 'pi-chromebook', 'tau-vps-1'"),
		channel: z
			.string()
			.describe(
				"Recipients: 'broadcast' | 'tau' | 'pi-vps' | 'tau,phi' (comma-separated)",
			),
		content: z.string().describe("Message content"),
		sessionDay: z
			.number()
			.int()
			.optional()
			.describe("Day number (e.g. 19 for Day 19)"),
	},
	async ({ from, fromInstanceId, channel, content, sessionDay }) => {
		const messageId = await convex.mutation(api.messages.sendMessage, {
			from,
			fromInstanceId,
			channel,
			content,
			sessionDay,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ messageId, from, channel }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: check_messages
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"check_messages",
	"Check for unread messages. Returns messages with receiptIds for marking as read. " +
		"If recipientInstanceId is provided, returns instance-targeted + role-level messages. " +
		"Replaces claude-peers check_messages.",
	{
		recipient: creatorSchema.describe("Orchestrator role (pi/tau/phi)"),
		recipientInstanceId: z
			.string()
			.optional()
			.describe("Instance ID — e.g. 'pi-chromebook'. Gets instance + role messages."),
	},
	async ({ recipient, recipientInstanceId }) => {
		const messages = await convex.query(api.messages.checkNewMessages, {
			recipient,
			recipientInstanceId,
		});

		return {
			content: [
				{
					type: "text",
					text:
						messages.length === 0
							? "No new messages."
							: JSON.stringify(messages, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: mark_as_read
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"mark_as_read",
	"Mark one or more message receipts as read. Pass the receiptIds from check_messages.",
	{
		receiptIds: z
			.union([z.array(z.string()), z.string()])
			.describe("Receipt IDs to mark as read — array or single string"),
	},
	async ({ receiptIds }) => {
		const receiptIdsArray = Array.isArray(receiptIds) ? receiptIds : [receiptIds];
		const count = await convex.mutation(api.messages.markAsRead, {
			receiptIds: receiptIdsArray as any,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ markedAsRead: count }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: set_summary
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"set_summary",
	"Set a brief summary of what you are currently working on. " +
		"Visible to other orchestrators via list_peers. Uses the profiles table. " +
		"Provide instanceId to register as a specific instance (e.g. 'pi-chromebook').",
	{
		orchestratorId: z
			.enum(["pi", "tau", "phi"])
			.describe("Orchestrator role"),
		instanceId: z
			.string()
			.optional()
			.describe("Instance ID — e.g. 'pi-chromebook', 'pi-vps', 'tau-vps-1'"),
		summary: z
			.string()
			.describe("1-2 sentence summary of current work"),
	},
	async ({ orchestratorId, instanceId, summary }) => {
		await convex.mutation(api.profiles.updateDynamic, {
			orchestratorId,
			instanceId,
			currentTask: summary,
			lastSeen: Date.now(),
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ orchestratorId, instanceId, summary }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_peers
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"list_peers",
	"List all orchestrator profiles with their current status and summary. " +
		"Replaces claude-peers list_peers.",
	{},
	async () => {
		const profiles = await convex.query(api.profiles.listProfiles, {});

		const peers = profiles.map((p: any) => ({
			id: p.orchestratorId,
			instanceId: p.instanceId ?? p.orchestratorId,
			name: p.name,
			role: p.static.role,
			workspace: p.static.workspace,
			currentTask: p.dynamic.currentTask ?? "idle",
			lastSeen: new Date(p.dynamic.lastSeen).toISOString(),
			sessionCount: p.dynamic.sessionCount,
		}));

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(peers, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_messages
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"list_messages",
	"List message history. Filter by day or sender. For unread messages use check_messages instead.",
	{
		sessionDay: z
			.number()
			.int()
			.optional()
			.describe("Filter to a specific day"),
		from: creatorSchema.optional().describe("Filter by sender"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(500)
			.optional()
			.default(100)
			.describe("Max messages to return (default 100)"),
	},
	async ({ sessionDay, from, limit }) => {
		const messages = await convex.query(api.messages.listMessages, {
			sessionDay,
			from,
			limit: limit ?? 100,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(messages, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_task
// ─────────────────────────────────────────────────────────────────────────────

const assigneeSchema = z
	.enum(["pi", "tau", "phi", "laurent"])
	.describe("Who the task is assigned to");

const prioritySchema = z
	.enum(["urgent", "high", "medium", "low"])
	.describe("Task priority level");

const taskStatusSchema = z
	.enum(["todo", "in_progress", "review", "blocked", "done"])
	.describe("Task status");

server.tool(
	"create_task",
	"Create a task in VantagePeers. Tasks are assigned to an orchestrator or Laurent, " +
		"with priority and status tracking. Optionally link to a project or mission.",
	{
		title: z.string().describe("Task title"),
		description: z.string().optional().describe("Detailed task description"),
		project: z
			.string()
			.optional()
			.describe("Project name — e.g. 'vantage-starter', 'perfect-ai-agent'"),
		tags: flexArrayOptional
			.describe("Optional tags for categorization"),
		assignedTo: assigneeSchema,
		assignedToInstance: z
			.string()
			.optional()
			.describe("Instance-level assignment — e.g. 'pi-vps', 'tau-chromebook'. Optional."),
		priority: prioritySchema,
		status: taskStatusSchema.default("todo"),
		dependsOn: z
			.array(z.string())
			.optional()
			.describe("Task IDs that must be completed before this task can start"),
		missionId: z
			.string()
			.optional()
			.describe("Convex document ID of the parent mission"),
		estimatedMinutes: z
			.number()
			.optional()
			.describe("Estimated duration in minutes"),
		dueDate: z
			.number()
			.optional()
			.describe("Optional due date as Unix timestamp (ms)"),
		createdBy: creatorSchema,
	},
	async ({
		title,
		description,
		project,
		tags,
		assignedTo,
		assignedToInstance,
		priority,
		status,
		dependsOn,
		missionId,
		estimatedMinutes,
		dueDate,
		createdBy,
	}) => {
		const taskId = await convex.mutation(api.tasks.create, {
			title,
			description,
			project,
			tags: toArray(tags),
			assignedTo,
			assignedToInstance,
			priority,
			status,
			dependsOn: toArray(dependsOn) as any,
			missionId: missionId as any,
			estimatedMinutes,
			dueDate,
			createdBy,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{ taskId, title, assignedTo, priority, status },
						null,
						2,
					),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_tasks
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"list_tasks",
	"List tasks from VantagePeers with optional filters. " +
		"Filter by assignee, instance, status, and/or project. Returns newest first.",
	{
		assignedTo: assigneeSchema.optional().describe("Filter by assignee"),
		assignedToInstance: z
			.string()
			.optional()
			.describe("Filter by instance — e.g. 'pi-vps'. Returns only tasks assigned to that instance."),
		status: taskStatusSchema.optional().describe("Filter by status"),
		project: z.string().optional().describe("Filter by project name"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.default(50)
			.describe("Maximum number of tasks to return (default 50)"),
	},
	async ({ assignedTo, assignedToInstance, status, project, limit }) => {
		const tasks = await convex.query(api.tasks.list, {
			assignedTo,
			assignedToInstance,
			status,
			project,
			limit: limit ?? 50,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(tasks, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_task
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"update_task",
	"Update any mutable field on a task. Provide only the fields you want to change. " +
		"updatedAt is set automatically.",
	{
		taskId: z.string().describe("Convex document ID of the task to update"),
		title: z.string().optional().describe("New title"),
		description: z.string().optional().describe("New description"),
		project: z.string().optional().describe("New project"),
		tags: flexArrayOptional.describe("New tags"),
		assignedTo: assigneeSchema.optional().describe("Reassign to"),
		priority: prioritySchema.optional().describe("New priority"),
		status: taskStatusSchema.optional().describe("New status"),
		dependsOn: z
			.array(z.string())
			.optional()
			.describe("Task IDs that must be completed before this task can start"),
		missionId: z
			.string()
			.optional()
			.describe("Link to a mission (Convex document ID)"),
		estimatedMinutes: z
			.number()
			.optional()
			.describe("Estimated duration in minutes"),
		actualMinutes: z.number().optional().describe("Actual duration in minutes"),
		startedAt: z.number().optional().describe("When work started (Unix ms)"),
		completedAt: z
			.number()
			.optional()
			.describe("When work completed (Unix ms)"),
		dueDate: z.number().optional().describe("New due date (Unix ms)"),
		callerOrchestrator: creatorSchema.optional().describe("Optional RBAC — if provided, must be creator or assignee"),
	},
	async ({
		taskId,
		title,
		description,
		project,
		tags,
		assignedTo,
		priority,
		status,
		dependsOn,
		missionId,
		estimatedMinutes,
		actualMinutes,
		startedAt,
		completedAt,
		dueDate,
		callerOrchestrator,
	}) => {
		await convex.mutation(api.tasks.update, {
			taskId: taskId as any,
			title,
			description,
			project,
			tags: toArray(tags),
			assignedTo,
			priority,
			status,
			dependsOn: toArray(dependsOn) as any,
			missionId: missionId as any,
			estimatedMinutes,
			actualMinutes,
			startedAt,
			completedAt,
			dueDate,
			callerOrchestrator,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ taskId, updated: true }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: complete_task
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"complete_task",
	"Mark a task as done. ALWAYS provide a completionNote describing what was actually done. " +
		"This is mandatory — never complete a task without explaining the work. " +
		"After completing, ALWAYS send_message to the task creator (check createdBy field) with a summary of what was done.",
	{
		taskId: z.string().describe("Convex document ID of the task to complete"),
		completionNote: z
			.string()
			.optional()
			.describe("What was actually done — summary of work completed (MANDATORY)"),
		callerOrchestrator: creatorSchema.optional().describe("Optional RBAC — if provided, must be creator or assignee"),
	},
	async ({ taskId, completionNote, callerOrchestrator }) => {
		await convex.mutation(api.tasks.complete, {
			taskId: taskId as any,
			completionNote,
			callerOrchestrator,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ taskId, status: "done" }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: start_task
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"start_task",
	"Start a task — sets status to in_progress and records startedAt timestamp. " +
		"Use this when beginning work on a task to enable automatic duration tracking.",
	{
		taskId: z.string().describe("Convex document ID of the task to start"),
		callerOrchestrator: creatorSchema.optional().describe("Optional RBAC — if provided, must be creator or assignee"),
	},
	async ({ taskId, callerOrchestrator }) => {
		await convex.mutation(api.tasks.start, {
			taskId: taskId as any,
			callerOrchestrator,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ taskId, status: "in_progress" }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_tasks_by_mission
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"list_tasks_by_mission",
	"List all tasks linked to a specific mission. Optionally filter by status.",
	{
		missionId: z.string().describe("Convex document ID of the mission"),
		status: taskStatusSchema.optional().describe("Filter by task status"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.default(50)
			.describe("Maximum number of tasks to return (default 50)"),
	},
	async ({ missionId, status, limit }) => {
		const tasks = await convex.query(api.tasks.listByMission, {
			missionId: missionId as any,
			status,
			limit: limit ?? 50,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(tasks, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_mission
// ─────────────────────────────────────────────────────────────────────────────

const missionStatusSchema = z
	.enum(["brainstorm", "plan", "execute", "validate", "complete"])
	.describe("Mission lifecycle status");

const missionPrioritySchema = z
	.enum(["urgent", "high", "medium", "low"])
	.describe("Mission priority level");

server.tool(
	"create_mission",
	"Create a mission in VantagePeers. Missions group related tasks under a project, " +
		"with a pilot orchestrator and assigned agents. Track progress through lifecycle statuses.",
	{
		name: z.string().describe("Mission name"),
		description: z.string().optional().describe("Mission description"),
		project: z
			.string()
			.describe("Project name — e.g. 'my-project', 'shared'"),
		status: missionStatusSchema.default("brainstorm"),
		priority: missionPrioritySchema,
		pilot: creatorSchema.describe("Lead orchestrator for this mission"),
		agents: flexArray.describe("List of agent names involved"),
		brief: z.string().optional().describe("Mission brief / instructions"),
		startDate: z.number().optional().describe("Planned start date (Unix ms)"),
		targetDate: z
			.number()
			.optional()
			.describe("Target completion date (Unix ms)"),
		progress: z.number().optional().describe("Progress percentage (0-100)"),
		createdBy: creatorSchema,
	},
	async ({
		name,
		description,
		project,
		status,
		priority,
		pilot,
		agents,
		brief,
		startDate,
		targetDate,
		progress,
		createdBy,
	}) => {
		const missionId = await convex.mutation(api.missions.create, {
			name,
			description,
			project,
			status,
			priority,
			pilot,
			agents: toArray(agents) as string[],
			brief,
			startDate,
			targetDate,
			progress,
			createdBy,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{ missionId, name, project, pilot, status },
						null,
						2,
					),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_missions
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"list_missions",
	"List missions from VantagePeers with optional filters. " +
		"Filter by project, pilot, and/or status. Returns newest first.",
	{
		project: z.string().optional().describe("Filter by project name"),
		pilot: creatorSchema.optional().describe("Filter by pilot orchestrator"),
		status: missionStatusSchema.optional().describe("Filter by status"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.default(50)
			.describe("Maximum number of missions to return (default 50)"),
	},
	async ({ project, pilot, status, limit }) => {
		const missions = await convex.query(api.missions.list, {
			project,
			pilot,
			status,
			limit: limit ?? 50,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(missions, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_mission
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"update_mission",
	"Update any mutable field on a mission. Provide only the fields you want to change. " +
		"updatedAt is set automatically.",
	{
		missionId: z
			.string()
			.describe("Convex document ID of the mission to update"),
		name: z.string().optional().describe("New name"),
		description: z.string().optional().describe("New description"),
		project: z.string().optional().describe("New project"),
		status: missionStatusSchema.optional().describe("New status"),
		priority: missionPrioritySchema.optional().describe("New priority"),
		pilot: creatorSchema.optional().describe("New pilot"),
		agents: flexArrayOptional.describe("New agents list"),
		brief: z.string().optional().describe("New brief"),
		startDate: z.number().optional().describe("New start date (Unix ms)"),
		targetDate: z.number().optional().describe("New target date (Unix ms)"),
		progress: z.number().optional().describe("New progress (0-100)"),
	},
	async ({
		missionId,
		name,
		description,
		project,
		status,
		priority,
		pilot,
		agents,
		brief,
		startDate,
		targetDate,
		progress,
	}) => {
		await convex.mutation(api.missions.update, {
			missionId: missionId as any,
			name,
			description,
			project,
			status,
			priority,
			pilot,
			agents: toArray(agents) as string[],
			brief,
			startDate,
			targetDate,
			progress,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ missionId, updated: true }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_mission_status
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"update_mission_status",
	"Change a mission's status. Shortcut for updating only the status field.",
	{
		missionId: z.string().describe("Convex document ID of the mission"),
		status: missionStatusSchema.describe("New status"),
	},
	async ({ missionId, status }) => {
		await convex.mutation(api.missions.updateStatus, {
			missionId: missionId as any,
			status,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ missionId, status }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: write_diary
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"write_diary",
	"Write or update a diary entry for a specific date and orchestrator. " +
		"If an entry already exists for that date+orchestrator, it will be updated (upsert).",
	{
		date: z.string().describe("ISO date string — e.g. '2026-03-25'"),
		orchestrator: creatorSchema.describe("Which orchestrator is writing"),
		content: z.string().describe("Full diary entry content"),
		highlights: flexArrayOptional
			.describe("Key highlights of the day"),
		blockers: flexArrayOptional.describe("Blockers encountered"),
	},
	async ({ date, orchestrator, content, highlights, blockers }) => {
		const diaryId = await convex.mutation(api.diary.write, {
			date,
			orchestrator,
			content,
			highlights: toArray(highlights),
			blockers: toArray(blockers),
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ diaryId, date, orchestrator }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_diary
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"get_diary",
	"Fetch a diary entry for a specific date and orchestrator. Returns null if no entry exists.",
	{
		date: z.string().describe("ISO date string — e.g. '2026-03-25'"),
		orchestrator: creatorSchema.describe("Which orchestrator's diary to fetch"),
	},
	async ({ date, orchestrator }) => {
		const entry = await convex.query(api.diary.get, {
			date,
			orchestrator,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(entry, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_diaries
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"list_diaries",
	"List diary entries, optionally filtered by orchestrator. Returns newest first.",
	{
		orchestrator: creatorSchema
			.optional()
			.describe("Filter to a specific orchestrator — omit for all"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.default(20)
			.describe("Maximum entries to return (default 20)"),
	},
	async ({ orchestrator, limit }) => {
		const entries = await convex.query(api.diary.list, {
			orchestrator,
			limit: limit ?? 20,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(entries, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_briefing_note
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"create_briefing_note",
	"Create a briefing note — a structured record of a topic discussion, with participants, " +
		"content, optional decisions, and optional links to existing memories.",
	{
		title: z.string().describe("Briefing note title"),
		topic: z
			.string()
			.describe("Topic category — e.g. 'architecture', 'revenue', 'product'"),
		participants: z
			.union([z.array(z.string()), z.string()])
			.describe("Who participated — e.g. ['pi', 'laurent'] or 'pi'"),
		content: z.string().describe("Full briefing content"),
		decisions: flexArrayOptional
			.describe("Decisions made during the briefing"),
		linkedMemoryIds: flexArrayOptional
			.describe("Convex document IDs of related memories"),
		createdBy: creatorSchema,
	},
	async ({
		title,
		topic,
		participants,
		content,
		decisions,
		linkedMemoryIds,
		createdBy,
	}) => {
		const noteId = await convex.mutation(api.briefingNotes.create, {
			title,
			topic,
			participants: toArray(participants) as string[],
			content,
			decisions: toArray(decisions),
			linkedMemoryIds: toArray(linkedMemoryIds) as any,
			createdBy,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ noteId, title, topic, createdBy }, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_briefing_notes
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"list_briefing_notes",
	"List briefing notes, optionally filtered by topic. Returns newest first.",
	{
		topic: z
			.string()
			.optional()
			.describe("Filter to a specific topic — omit for all"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.default(20)
			.describe("Maximum notes to return (default 20)"),
	},
	async ({ topic, limit }) => {
		const notes = await convex.query(api.briefingNotes.list, {
			topic,
			limit: limit ?? 20,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(notes, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: register_component
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"register_component",
	"Register or update a component (agent, skill, hook, or plugin) in the registry. " +
		"Upserts by name+type — if a component with the same name and type exists, it updates the content.",
	{
		name: z.string().describe("Component name — e.g. 'copywriter', 'check-tasks'"),
		type: z
			.enum(["agent", "skill", "hook", "plugin"])
			.describe("Component type"),
		team: z
			.string()
			.optional()
			.describe("Team this component belongs to — e.g. 'marketing', 'development'"),
		content: z.string().describe("Full file content of the component"),
		version: z.string().optional().describe("Version string — e.g. '1.0.0'"),
		project: z.string().optional().describe("Project this component belongs to"),
		createdBy: creatorSchema,
	},
	async ({ name, type, team, content, version, project, createdBy }) => {
		const result = await convex.mutation(api.components.register, {
			name,
			type,
			team,
			content,
			version,
			project,
			createdBy,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(result, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_components
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"list_components",
	"List registered components. Filter by type (agent/skill/hook/plugin) and/or team.",
	{
		type: z
			.enum(["agent", "skill", "hook", "plugin"])
			.optional()
			.describe("Filter by component type"),
		team: z.string().optional().describe("Filter by team"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(500)
			.optional()
			.default(100)
			.describe("Maximum components to return (default 100)"),
	},
	async ({ type, team, limit }) => {
		const components = await convex.query(api.components.list, {
			type,
			team,
			limit: limit ?? 100,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(components, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_component
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"get_component",
	"Fetch a single component by name and type. Returns the full content.",
	{
		name: z.string().describe("Component name"),
		type: z
			.enum(["agent", "skill", "hook", "plugin"])
			.describe("Component type"),
	},
	async ({ name, type }) => {
		const component = await convex.query(api.components.get, {
			name,
			type,
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(component, null, 2),
				},
			],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"create_recurring_task",
	"Create a recurring task that auto-creates tasks on a schedule. " +
		"Uses cron expressions: '0 9 * * *' = daily 9am, '0 9 * * 1' = Monday 9am, '*/30 * * * *' = every 30min.",
	{
		title: z.string().describe("Task title — created each time the cron fires"),
		description: z.string().optional().describe("Task description"),
		assignedTo: z.enum(["pi", "tau", "phi", "laurent"]).describe("Who gets the created tasks"),
		priority: z.enum(["urgent", "high", "medium", "low"]).describe("Priority of created tasks"),
		project: z.string().optional().describe("Project name"),
		tags: flexArray.optional().describe("Tags for created tasks"),
		cronExpression: z.string().describe("5-field cron: minute hour day-of-month month day-of-week"),
		createdBy: creatorSchema,
	},
	async ({ title, description, assignedTo, priority, project, tags, cronExpression, createdBy }) => {
		const tagsArray = tags ? (Array.isArray(tags) ? tags : [tags]) : undefined;
		const taskId = await convex.mutation(api.recurringTasks.create, {
			title,
			description,
			assignedTo,
			priority,
			project,
			tags: tagsArray,
			cronExpression,
			createdBy,
		});

		return {
			content: [{ type: "text", text: JSON.stringify({ taskId, cronExpression }, null, 2) }],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_recurring_tasks
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"list_recurring_tasks",
	"List recurring task templates. Filter by assignee or active status.",
	{
		assignedTo: z.enum(["pi", "tau", "phi", "laurent"]).optional().describe("Filter by assignee"),
		active: z.boolean().optional().describe("Filter by active status"),
		limit: z.number().int().min(1).max(200).optional().default(50).describe("Max results"),
	},
	async ({ assignedTo, active, limit }) => {
		const tasks = await convex.query(api.recurringTasks.list, {
			assignedTo,
			active,
			limit: limit ?? 50,
		});

		return {
			content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: pause_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"pause_recurring_task",
	"Pause a recurring task — stops auto-creating tasks until resumed.",
	{
		taskId: z.string().describe("Recurring task ID"),
	},
	async ({ taskId }) => {
		const result = await convex.mutation(api.recurringTasks.pause, {
			taskId: taskId as any,
		});

		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: resume_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"resume_recurring_task",
	"Resume a paused recurring task — recalculates next run time.",
	{
		taskId: z.string().describe("Recurring task ID"),
	},
	async ({ taskId }) => {
		const result = await convex.mutation(api.recurringTasks.resume, {
			taskId: taskId as any,
		});

		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: delete_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
	"delete_recurring_task",
	"Permanently delete a recurring task template.",
	{
		taskId: z.string().describe("Recurring task ID"),
	},
	async ({ taskId }) => {
		const result = await convex.mutation(api.recurringTasks.remove, {
			taskId: taskId as any,
		});

		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		};
	},
);

// ─────────────────────────────────────────────────────────────────────────────
// Start server on stdio transport
// ─────────────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
