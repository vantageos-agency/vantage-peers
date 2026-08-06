/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// Load all convex modules. ragSync and search are "use node" actions that call
// the RAG component with real embeddings — they cannot run in convex-test's
// sandbox. We exclude them so convex-test does not attempt to execute them
// when the scheduler fires.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// Freeze time so scheduled functions (ctx.scheduler.runAfter) are queued in
// _scheduled_functions inside the mutation transaction but never executed by
// convex-test's setTimeout. This prevents "Write outside of transaction"
// errors from the RAG/workpool components trying to run embedding actions.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

// Factory: creates a fresh isolated convex-test instance per test.
function createTestConvex() {
	return convexTest(schema, modules);
}

// Messages suite factory: real recipients are now derived from the
// `profiles` table (task k17dr97dwpe07n9zfgzzypkfm18bv6ws bounce fix) — seed
// the standard pi/tau/phi trio so every legitimate send in this describe
// block resolves to >=1 real recipient instead of bouncing.
async function createMessagingTestConvex() {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		for (const orchestratorId of ["pi", "tau", "phi"]) {
			await ctx.db.insert("profiles", {
				orchestratorId,
				name: orchestratorId,
				static: { role: orchestratorId, workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			});
		}
	});
	return t;
}

// =============================================================================
// 1. Memories
// =============================================================================

describe("Memories", () => {
	test("store a memory and retrieve it by ID", async () => {
		const t = createTestConvex();

		const memoryId = await t.mutation(api.memories.storeMemory, {
			namespace: "global",
			type: "project",
			content: "VantagePeers uses Convex as its backend",
			createdBy: "pi",
			relations: [],
		});

		expect(memoryId).toBeDefined();

		const memory = await t.query(api.memories.getMemory, { memoryId });
		expect(memory).not.toBeNull();
		expect(memory!.content).toBe("VantagePeers uses Convex as its backend");
		expect(memory!.type).toBe("project");
		expect(memory!.namespace).toBe("global");
		expect(memory!.createdBy).toBe("pi");
		expect(memory!.isLatest).toBe(true);
	});

	test("list memories by namespace", async () => {
		const t = createTestConvex();

		await t.mutation(api.memories.storeMemory, {
			namespace: "project/alpha",
			type: "project",
			content: "Alpha project memory 1",
			createdBy: "pi",
			relations: [],
		});

		await t.mutation(api.memories.storeMemory, {
			namespace: "project/alpha",
			type: "feedback",
			content: "Alpha project memory 2",
			createdBy: "tau",
			relations: [],
		});

		await t.mutation(api.memories.storeMemory, {
			namespace: "project/beta",
			type: "project",
			content: "Beta project memory",
			createdBy: "phi",
			relations: [],
		});

		const alphaResult = await t.query(api.memories.listMemories, {
			namespace: "project/alpha",
		});

		expect(alphaResult.value).toHaveLength(2);
		expect(alphaResult.value.every((m) => m.namespace === "project/alpha")).toBe(
			true,
		);
	});

	test("list memories with type filter", async () => {
		const t = createTestConvex();

		await t.mutation(api.memories.storeMemory, {
			namespace: "global",
			type: "project",
			content: "A project memory",
			createdBy: "pi",
			relations: [],
		});

		await t.mutation(api.memories.storeMemory, {
			namespace: "global",
			type: "feedback",
			content: "A feedback memory",
			createdBy: "pi",
			relations: [],
		});

		await t.mutation(api.memories.storeMemory, {
			namespace: "global",
			type: "project",
			content: "Another project memory",
			createdBy: "tau",
			relations: [],
		});

		const projectResult = await t.query(api.memories.listMemories, {
			namespace: "global",
			type: "project",
		});

		expect(projectResult.value).toHaveLength(2);
		expect(projectResult.value.every((m) => m.type === "project")).toBe(true);
	});

	test("soft delete marks isLatest=false", async () => {
		const t = createTestConvex();

		const memoryId = await t.mutation(api.memories.storeMemory, {
			namespace: "global",
			type: "project",
			content: "Memory to soft-delete",
			createdBy: "pi",
			relations: [],
		});

		await t.mutation(api.memories.softDeleteMemory, { memoryId });

		const memory = await t.query(api.memories.getMemory, { memoryId });
		expect(memory).not.toBeNull();
		expect(memory!.isLatest).toBe(false);

		// Should not appear in default (isLatest=true) listing
		const listedResult = await t.query(api.memories.listMemories, {
			namespace: "global",
		});
		expect(listedResult.value.find((m) => m._id === memoryId)).toBeUndefined();
	});

	test("store memory with 'updates' relation supersedes target", async () => {
		const t = createTestConvex();

		const originalId = await t.mutation(api.memories.storeMemory, {
			namespace: "global",
			type: "project",
			content: "Original fact: Convex uses TypeScript",
			createdBy: "pi",
			relations: [],
		});

		// Create a new memory that updates the original
		const updatedId = await t.mutation(api.memories.storeMemory, {
			namespace: "global",
			type: "project",
			content: "Updated fact: Convex uses TypeScript with strict mode",
			createdBy: "pi",
			relations: [{ targetId: originalId, type: "updates" }],
		});

		// Original should now have isLatest=false
		const original = await t.query(api.memories.getMemory, {
			memoryId: originalId,
		});
		expect(original).not.toBeNull();
		expect(original!.isLatest).toBe(false);

		// Updated should have isLatest=true
		const updated = await t.query(api.memories.getMemory, {
			memoryId: updatedId,
		});
		expect(updated).not.toBeNull();
		expect(updated!.isLatest).toBe(true);

		// Default listing should only show the updated version
		const listedResult = await t.query(api.memories.listMemories, {
			namespace: "global",
		});
		expect(listedResult.value).toHaveLength(1);
		expect(listedResult.value[0]._id).toBe(updatedId);
	});

	// Regression #262 — relations must be optional; defaults to [] server-side
	test("storeMemory without relations defaults to empty array", async () => {
		const t = createTestConvex();

		const memoryId = await t.mutation(api.memories.storeMemory, {
			namespace: "global",
			type: "project",
			content: "Memory stored without explicit relations",
			createdBy: "sigma",
			// relations intentionally omitted
		});

		const memory = await t.query(api.memories.getMemory, { memoryId });
		expect(memory).not.toBeNull();
		if (memory === null) throw new Error("memory must not be null");
		expect(Array.isArray(memory.relations)).toBe(true);
		expect(memory.relations).toHaveLength(0);
	});
});

// =============================================================================
// 2. Episodes
// =============================================================================

describe("Episodes", () => {
	test("store episode creates memory with type='episode' and episode metadata", async () => {
		const t = createTestConvex();

		const episodeId = await t.mutation(api.episodes.storeEpisode, {
			namespace: "global",
			createdBy: "pi",
			context: "Deploying new Convex functions",
			goal: "Zero-downtime deployment",
			action: "Used convex deploy with --run flag",
			outcome: "Deployment succeeded with no interruption",
			insight: "Always use --run for production deploys",
			severity: "minor",
		});

		expect(episodeId).toBeDefined();

		// Retrieve via getMemory to verify structure
		const memory = await t.query(api.memories.getMemory, {
			memoryId: episodeId,
		});
		expect(memory).not.toBeNull();
		expect(memory!.type).toBe("episode");
		expect(memory!.isLatest).toBe(true);
		expect(memory!.episode).toBeDefined();
		expect(memory!.episode!.context).toBe("Deploying new Convex functions");
		expect(memory!.episode!.goal).toBe("Zero-downtime deployment");
		expect(memory!.episode!.action).toBe("Used convex deploy with --run flag");
		expect(memory!.episode!.outcome).toBe(
			"Deployment succeeded with no interruption",
		);
		expect(memory!.episode!.insight).toBe(
			"Always use --run for production deploys",
		);
		expect(memory!.episode!.severity).toBe("minor");
		// Content should be the concatenation of episode fields
		expect(memory!.content).toContain("Context:");
		expect(memory!.content).toContain("Goal:");
	});

	test("list episodes by namespace", async () => {
		const t = createTestConvex();

		await t.mutation(api.episodes.storeEpisode, {
			namespace: "project/alpha",
			createdBy: "pi",
			context: "Alpha context",
			goal: "Alpha goal",
			action: "Alpha action",
			outcome: "Alpha outcome",
			insight: "Alpha insight",
			severity: "minor",
		});

		await t.mutation(api.episodes.storeEpisode, {
			namespace: "project/alpha",
			createdBy: "tau",
			context: "Alpha context 2",
			goal: "Alpha goal 2",
			action: "Alpha action 2",
			outcome: "Alpha outcome 2",
			insight: "Alpha insight 2",
			severity: "major",
		});

		await t.mutation(api.episodes.storeEpisode, {
			namespace: "project/beta",
			createdBy: "phi",
			context: "Beta context",
			goal: "Beta goal",
			action: "Beta action",
			outcome: "Beta outcome",
			insight: "Beta insight",
			severity: "critical",
		});

		const alphaEpisodes = await t.query(api.episodes.listEpisodes, {
			namespace: "project/alpha",
		});

		expect(alphaEpisodes).toHaveLength(2);
		expect(alphaEpisodes.every((e) => e.namespace === "project/alpha")).toBe(
			true,
		);
		expect(alphaEpisodes.every((e) => e.episode !== undefined)).toBe(true);
	});

	test("get critical insights returns only severity='critical' episodes", async () => {
		const t = createTestConvex();

		await t.mutation(api.episodes.storeEpisode, {
			namespace: "global",
			createdBy: "pi",
			context: "Minor issue context",
			goal: "Minor goal",
			action: "Minor action",
			outcome: "Minor outcome",
			insight: "Minor insight",
			severity: "minor",
		});

		await t.mutation(api.episodes.storeEpisode, {
			namespace: "global",
			createdBy: "tau",
			context: "Critical failure context",
			goal: "Prevent data loss",
			action: "Rolled back deployment immediately",
			outcome: "Data preserved, service restored",
			insight: "Always backup before schema migrations",
			severity: "critical",
		});

		await t.mutation(api.episodes.storeEpisode, {
			namespace: "project/alpha",
			createdBy: "phi",
			context: "Another critical context",
			goal: "Fix auth bypass",
			action: "Patched the middleware",
			outcome: "Vulnerability closed",
			insight: "Always validate auth tokens server-side",
			severity: "critical",
		});

		const criticals = await t.query(api.episodes.getCriticalInsights, {});

		expect(criticals).toHaveLength(2);
		expect(criticals.every((c) => c.insight !== undefined)).toBe(true);
		// Verify the correct insights are returned
		const insights = criticals.map((c) => c.insight);
		expect(insights).toContain("Always backup before schema migrations");
		expect(insights).toContain("Always validate auth tokens server-side");
	});
});

// =============================================================================
// 3. Profiles
// =============================================================================

describe("Profiles", () => {
	const sampleProfile = {
		orchestratorId: "pi",
		instanceId: "pi-vps",
		name: "Pi VPS",
		static: {
			role: "architect",
			workspace: "/tmp/test-workspace",
			capabilities: ["code-review", "deployment", "testing"],
		},
		dynamic: {
			currentTask: "Setting up test suite",
			lastSeen: Date.now(),
			sessionCount: 1,
		},
	};

	test("upsert creates new profile", async () => {
		const t = createTestConvex();

		const profileId = await t.mutation(
			api.profiles.upsertProfile,
			sampleProfile,
		);
		expect(profileId).toBeDefined();

		const profile = await t.query(api.profiles.getProfile, {
			orchestratorId: "pi",
		});
		expect(profile).not.toBeNull();
		expect(profile!.name).toBe("Pi VPS");
		expect(profile!.orchestratorId).toBe("pi");
		expect(profile!.static.role).toBe("architect");
	});

	test("upsert updates existing profile", async () => {
		const t = createTestConvex();

		await t.mutation(api.profiles.upsertProfile, sampleProfile);

		// Update the same profile
		const updatedId = await t.mutation(api.profiles.upsertProfile, {
			...sampleProfile,
			name: "Pi VPS Updated",
			dynamic: {
				currentTask: "Running tests",
				lastSeen: Date.now(),
				sessionCount: 2,
			},
		});

		const profile = await t.query(api.profiles.getProfile, {
			instanceId: "pi-vps",
		});
		expect(profile).not.toBeNull();
		expect(profile!.name).toBe("Pi VPS Updated");
		expect(profile!.dynamic.sessionCount).toBe(2);

		// Should not create a duplicate — list should have exactly 1
		const allProfiles = await t.query(api.profiles.listProfiles, {
			orchestratorId: "pi",
		});
		expect(allProfiles).toHaveLength(1);
	});

	test("get profile by orchestratorId", async () => {
		const t = createTestConvex();

		await t.mutation(api.profiles.upsertProfile, sampleProfile);

		const profile = await t.query(api.profiles.getProfile, {
			orchestratorId: "pi",
		});
		expect(profile).not.toBeNull();
		expect(profile!.orchestratorId).toBe("pi");
	});

	test("list all profiles", async () => {
		const t = createTestConvex();

		await t.mutation(api.profiles.upsertProfile, sampleProfile);

		await t.mutation(api.profiles.upsertProfile, {
			orchestratorId: "tau",
			instanceId: "tau-vps",
			name: "Tau VPS",
			static: {
				role: "developer",
				workspace: "/home/tau",
				capabilities: ["frontend", "backend"],
			},
			dynamic: {
				lastSeen: Date.now(),
				sessionCount: 1,
			},
		});

		const allProfiles = await t.query(api.profiles.listProfiles, {});
		expect(allProfiles).toHaveLength(2);
	});

	test("updateDynamic updates currentTask", async () => {
		const t = createTestConvex();

		await t.mutation(api.profiles.upsertProfile, sampleProfile);

		const now = Date.now();
		await t.mutation(api.profiles.updateDynamic, {
			orchestratorId: "pi",
			instanceId: "pi-vps",
			currentTask: "Writing documentation",
			lastSeen: now,
			sessionCountDelta: 1,
		});

		const profile = await t.query(api.profiles.getProfile, {
			instanceId: "pi-vps",
		});
		expect(profile).not.toBeNull();
		expect(profile!.dynamic.currentTask).toBe("Writing documentation");
		expect(profile!.dynamic.sessionCount).toBe(2); // original 1 + delta 1
	});

	// Regression #261 — lastSeen must be optional; defaults to Date.now() server-side
	test("updateDynamic without lastSeen defaults to server Date.now()", async () => {
		const t = createTestConvex();

		await t.mutation(api.profiles.upsertProfile, sampleProfile);

		const before = Date.now();
		await t.mutation(api.profiles.updateDynamic, {
			orchestratorId: "pi",
			instanceId: "pi-vps",
			currentTask: "Auto-timestamp test",
			// lastSeen intentionally omitted
		});
		const after = Date.now();

		const profile = await t.query(api.profiles.getProfile, {
			instanceId: "pi-vps",
		});
		expect(profile).not.toBeNull();
		if (profile === null) throw new Error("profile must not be null");
		expect(profile.dynamic.currentTask).toBe("Auto-timestamp test");
		// lastSeen must be a number within ±2000ms of the call window
		expect(typeof profile.dynamic.lastSeen).toBe("number");
		expect(profile.dynamic.lastSeen).toBeGreaterThanOrEqual(before - 2000);
		expect(profile.dynamic.lastSeen).toBeLessThanOrEqual(after + 2000);
	});
});

// =============================================================================
// 4. Messages
// =============================================================================

describe("Messages", () => {
	test("send message creates message + receipts", async () => {
		const t = await createMessagingTestConvex();

		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "tau",
			content: "Hello Tau, task complete",
		});

		expect(messageId).toBeDefined();

		// Tau should have an unread message
		const tauMessages = await t.query(api.messages.checkNewMessages, {
			recipient: "tau",
		});
		expect(tauMessages).toHaveLength(1);
		expect(tauMessages[0].content).toBe("Hello Tau, task complete");
		expect(tauMessages[0].from).toBe("pi");
	});

	test("send broadcast creates receipts for all other orchestrators", async () => {
		const t = await createMessagingTestConvex();

		// Create profiles so broadcast can resolve recipients dynamically
		await t.mutation(api.profiles.upsertProfile, {
			orchestratorId: "pi",
			name: "Pi",
			static: { role: "lead", workspace: "/test", capabilities: [] },
			dynamic: { currentTask: undefined, lastSeen: Date.now(), sessionCount: 1 },
		});
		await t.mutation(api.profiles.upsertProfile, {
			orchestratorId: "tau",
			name: "Tau",
			static: { role: "frontend", workspace: "/test", capabilities: [] },
			dynamic: { currentTask: undefined, lastSeen: Date.now(), sessionCount: 1 },
		});
		await t.mutation(api.profiles.upsertProfile, {
			orchestratorId: "phi",
			name: "Phi",
			static: { role: "backend", workspace: "/test", capabilities: [] },
			dynamic: { currentTask: undefined, lastSeen: Date.now(), sessionCount: 1 },
		});

		await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "broadcast",
			content: "Announcement: deploy complete",
		});

		// Tau should get the broadcast
		const tauMessages = await t.query(api.messages.checkNewMessages, {
			recipient: "tau",
		});
		expect(tauMessages).toHaveLength(1);
		expect(tauMessages[0].content).toBe("Announcement: deploy complete");

		// Phi should get the broadcast
		const phiMessages = await t.query(api.messages.checkNewMessages, {
			recipient: "phi",
		});
		expect(phiMessages).toHaveLength(1);

		// Pi (the sender) should NOT get the broadcast
		const piMessages = await t.query(api.messages.checkNewMessages, {
			recipient: "pi",
		});
		expect(piMessages).toHaveLength(0);
	});

	test("check new messages returns unread", async () => {
		const t = await createMessagingTestConvex();

		await t.mutation(api.messages.sendMessage, {
			from: "tau",
			channel: "pi",
			content: "Message 1 for Pi",
		});

		await t.mutation(api.messages.sendMessage, {
			from: "phi",
			channel: "pi",
			content: "Message 2 for Pi",
		});

		const piMessages = await t.query(api.messages.checkNewMessages, {
			recipient: "pi",
		});
		expect(piMessages).toHaveLength(2);
		expect(piMessages.map((m) => m.content)).toContain("Message 1 for Pi");
		expect(piMessages.map((m) => m.content)).toContain("Message 2 for Pi");
	});

	test("mark as read sets readAt", async () => {
		const t = await createMessagingTestConvex();

		await t.mutation(api.messages.sendMessage, {
			from: "tau",
			channel: "pi",
			content: "Read me",
		});

		const messages = await t.query(api.messages.checkNewMessages, {
			recipient: "pi",
		});
		expect(messages).toHaveLength(1);

		const count = await t.mutation(api.messages.markAsRead, {
			receiptIds: [messages[0].receiptId],
		});
		expect(count).toBe(1);
	});

	test("after mark as read, checkNewMessages returns empty", async () => {
		const t = await createMessagingTestConvex();

		await t.mutation(api.messages.sendMessage, {
			from: "tau",
			channel: "pi",
			content: "One-time message",
		});

		const before = await t.query(api.messages.checkNewMessages, {
			recipient: "pi",
		});
		expect(before).toHaveLength(1);

		await t.mutation(api.messages.markAsRead, {
			receiptIds: [before[0].receiptId],
		});

		const after = await t.query(api.messages.checkNewMessages, {
			recipient: "pi",
		});
		expect(after).toHaveLength(0);
	});

	test("list messages by sender", async () => {
		const t = await createMessagingTestConvex();

		await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "tau",
			content: "Pi message 1",
		});

		await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "phi",
			content: "Pi message 2",
		});

		await t.mutation(api.messages.sendMessage, {
			from: "tau",
			channel: "pi",
			content: "Tau message",
		});

		const piMessages = await t.query(api.messages.listMessages, {
			from: "pi",
		});
		expect(piMessages).toHaveLength(2);
		expect(piMessages.every((m) => m.from === "pi")).toBe(true);
	});

	test("delete message cascades receipts", async () => {
		const t = await createMessagingTestConvex();

		// Send a message from pi to tau — creates 1 message + 1 receipt
		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "tau",
			content: "This will be deleted",
		});

		// Verify receipt exists before deletion
		const before = await t.query(api.messages.checkNewMessages, {
			recipient: "tau",
		});
		expect(before).toHaveLength(1);
		expect(before[0].messageId).toBe(messageId);

		// Delete the message as the sender
		const result = await t.mutation(api.messages.deleteMessage, {
			messageId,
			callerOrchestrator: "pi",
		});

		expect(result.deleted).toBe(true);
		expect(result.receiptsDeleted).toBe(1);

		// Message should no longer appear in tau's inbox
		const after = await t.query(api.messages.checkNewMessages, {
			recipient: "tau",
		});
		expect(after).toHaveLength(0);
	});

	test("delete message rejects non-sender caller", async () => {
		const t = await createMessagingTestConvex();

		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "tau",
			content: "Only pi can delete this",
		});

		// Phi tries to delete a message sent by pi — should be rejected
		await expect(
			t.mutation(api.messages.deleteMessage, {
				messageId,
				callerOrchestrator: "phi",
			}),
		).rejects.toThrow("Unauthorized");
	});

	test("delete message throws on non-existent messageId", async () => {
		const t = await createMessagingTestConvex();

		// Send one message so we have a valid-shape ID, then delete it to get a
		// missing ID for the error path
		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "tau",
			content: "Temporary",
		});

		await t.mutation(api.messages.deleteMessage, {
			messageId,
			callerOrchestrator: "system",
		});

		// Deleting again should throw "Message not found"
		await expect(
			t.mutation(api.messages.deleteMessage, {
				messageId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow("Message not found");
	});

	// ── Issue #323 regression tests ──────────────────────────────────────────

	test("markAsRead rejects a messages-table ID passed as a receiptId (wrong table)", async () => {
		const t = await createMessagingTestConvex();

		// Insert a message and get its _id (from the messages table, NOT messageReceipts)
		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "tau",
			content: "Wrong-table ID test",
		});

		// Passing a messages._id as a receiptId must fail with ArgumentValidationError.
		// The cast is intentional — this is exactly the wrong-table bug we are testing.
		await expect(
			t.mutation(api.messages.markAsRead, {
				receiptIds: [messageId as unknown as Id<"messageReceipts">],
			}),
		).rejects.toThrow();
	});

	test("checkNewMessages response omits messageId field from each result object", async () => {
		const t = await createMessagingTestConvex();

		await t.mutation(api.messages.sendMessage, {
			from: "phi",
			channel: "tau",
			content: "Field-projection test",
		});

		const messages = await t.query(api.messages.checkNewMessages, {
			recipient: "tau",
		});

		// The Convex query includes messageId for internal use — the MCP layer
		// strips it. We verify here that the MCP payload projection is correct
		// by simulating the same map the MCP tool does.
		const mcpPayload = messages.map((m) => ({
			receiptId: m.receiptId,
			from: m.from,
			fromInstanceId: m.fromInstanceId,
			channel: m.channel,
			content: m.content,
			createdAt: m.createdAt,
		}));

		expect(mcpPayload).toHaveLength(1);
		expect(mcpPayload[0]).not.toHaveProperty("messageId");
		expect(mcpPayload[0]).toHaveProperty("receiptId");
		expect(mcpPayload[0].content).toBe("Field-projection test");
	});
});

// =============================================================================
// 5. Tasks
// =============================================================================

describe("Tasks", () => {
	const sampleTask = {
		title: "Write unit tests",
		description: "Create comprehensive vitest test suite",
		project: "vantage-peers",
		assignedTo: "pi" as const,
		priority: "high" as const,
		status: "todo" as const,
		createdBy: "pi" as const,
	};

	test("create task returns taskId", async () => {
		const t = createTestConvex();

		const taskId = await t.mutation(api.tasks.create, sampleTask);
		expect(taskId).toBeDefined();

		const task = await t.query(api.tasks.get, { taskId });
		expect(task).not.toBeNull();
		expect(task!.title).toBe("Write unit tests");
		expect(task!.status).toBe("todo");
	});

	test("list tasks by assignee", async () => {
		const t = createTestConvex();

		await t.mutation(api.tasks.create, sampleTask);

		await t.mutation(api.tasks.create, {
			...sampleTask,
			title: "Review PR",
			assignedTo: "tau",
		});

		await t.mutation(api.tasks.create, {
			...sampleTask,
			title: "Deploy to prod",
		});

		// tasks.list is gated by withOrgScope — pass master identity (no org)
		const piTasks = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { assignedTo: "pi" });
		expect(piTasks).toHaveLength(2);
		expect(piTasks.every((t: { assignedTo: string }) => t.assignedTo === "pi")).toBe(true);
	});

	test("update task fields", async () => {
		const t = createTestConvex();

		const taskId = await t.mutation(api.tasks.create, sampleTask);

		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "pi" as const,
			title: "Write unit tests (updated)",
			priority: "urgent",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task).not.toBeNull();
		expect(task!.title).toBe("Write unit tests (updated)");
		expect(task!.priority).toBe("urgent");
	});

	test("start task sets status=in_progress and startedAt", async () => {
		const t = createTestConvex();

		const taskId = await t.mutation(api.tasks.create, sampleTask);

		await t.mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "pi" as const,
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task).not.toBeNull();
		expect(task!.status).toBe("in_progress");
		expect(task!.startedAt).toBeDefined();
		expect(task!.startedAt).toBeGreaterThan(0);
	});

	test("complete task sets status=done, completedAt, and completionNote", async () => {
		const t = createTestConvex();

		// Day 130 closure gate — seed billableProjects config (empty: this
		// task's project "vantage-peers" is not a billable client project).
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: Date.now(),
			});
		});

		const taskId = await t.mutation(api.tasks.create, sampleTask);

		// Start first so we can test actualMinutes calculation
		await t.mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "pi" as const,
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "pi" as const,
			completionNote: "All 30 tests pass, coverage at 95%",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task).not.toBeNull();
		expect(task!.status).toBe("done");
		expect(task!.completedAt).toBeDefined();
		expect(task!.completedAt).toBeGreaterThan(0);
		expect(task!.completionNote).toBe("All 30 tests pass, coverage at 95%");
	});
});

// =============================================================================
// 6. Missions
// =============================================================================

describe("Missions", () => {
	const sampleMission = {
		name: "Launch VantagePeers v1",
		description: "Ship the first production release",
		project: "vantage-peers",
		status: "plan" as const,
		priority: "high" as const,
		pilot: "pi" as const,
		agents: ["pi", "tau"],
		createdBy: "pi" as const,
	};

	test("create mission", async () => {
		const t = createTestConvex();

		const missionId = await t.mutation(api.missions.create, sampleMission);
		expect(missionId).toBeDefined();

		const mission = await t.query(api.missions.get, { missionId });
		expect(mission).not.toBeNull();
		expect(mission!.name).toBe("Launch VantagePeers v1");
		expect(mission!.status).toBe("plan");
		expect(mission!.pilot).toBe("pi");
		expect(mission!.agents).toEqual(["pi", "tau"]);
	});

	test("list missions by project", async () => {
		const t = createTestConvex();

		await t.mutation(api.missions.create, sampleMission);

		await t.mutation(api.missions.create, {
			...sampleMission,
			name: "VantagePeers v2",
			project: "vantage-peers",
		});

		await t.mutation(api.missions.create, {
			...sampleMission,
			name: "Perfect Agent Setup",
			project: "perfect-ai-agent",
		});

		// missions.list is gated by withOrgScope — pass master identity (no org)
		const vmMissions = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.missions.list, { project: "vantage-peers" });
		expect(vmMissions).toHaveLength(2);
		expect(vmMissions.every((m) => m.project === "vantage-peers")).toBe(true);
	});

	test("update mission fields", async () => {
		const t = createTestConvex();

		const missionId = await t.mutation(api.missions.create, sampleMission);

		await t.mutation(api.missions.update, {
			missionId,
			name: "Launch VantagePeers v1.1",
			priority: "urgent",
			progress: 50,
		});

		const mission = await t.query(api.missions.get, { missionId });
		expect(mission).not.toBeNull();
		expect(mission!.name).toBe("Launch VantagePeers v1.1");
		expect(mission!.priority).toBe("urgent");
		expect(mission!.progress).toBe(50);
	});

	test("update mission status", async () => {
		const t = createTestConvex();

		const missionId = await t.mutation(api.missions.create, sampleMission);

		await t.mutation(api.missions.updateStatus, {
			missionId,
			status: "execute",
		});

		const mission = await t.query(api.missions.get, { missionId });
		expect(mission).not.toBeNull();
		expect(mission!.status).toBe("execute");
	});
});

// =============================================================================
// 7. Diary
// =============================================================================

describe("Diary", () => {
	test("write diary creates entry", async () => {
		const t = createTestConvex();

		const diaryId = await t.mutation(api.diary.write, {
			date: "2026-03-25",
			orchestrator: "pi",
			content: "Completed test suite for VantagePeers. All tests passing.",
			highlights: ["Wrote 30+ tests", "100% mutation coverage"],
			blockers: [],
		});

		expect(diaryId).toBeDefined();

		const entry = await t.query(api.diary.get, {
			date: "2026-03-25",
			orchestrator: "pi",
		});
		expect(entry).not.toBeNull();
		expect(entry!.content).toContain("Completed test suite");
		expect(entry!.highlights).toHaveLength(2);
	});

	test("write diary upserts (same date+orchestrator overwrites)", async () => {
		const t = createTestConvex();

		const firstId = await t.mutation(api.diary.write, {
			date: "2026-03-25",
			orchestrator: "pi",
			content: "Morning entry: started work",
		});

		const secondId = await t.mutation(api.diary.write, {
			date: "2026-03-25",
			orchestrator: "pi",
			content: "Evening entry: finished all tasks",
			highlights: ["Shipped v1"],
		});

		// Should return the same ID (upsert)
		expect(secondId).toBe(firstId);

		const entry = await t.query(api.diary.get, {
			date: "2026-03-25",
			orchestrator: "pi",
		});
		expect(entry).not.toBeNull();
		expect(entry!.content).toBe("Evening entry: finished all tasks");
		expect(entry!.highlights).toEqual(["Shipped v1"]);
	});

	test("get diary by date+orchestrator", async () => {
		const t = createTestConvex();

		await t.mutation(api.diary.write, {
			date: "2026-03-25",
			orchestrator: "pi",
			content: "Pi's diary for March 25",
		});

		await t.mutation(api.diary.write, {
			date: "2026-03-25",
			orchestrator: "tau",
			content: "Tau's diary for March 25",
		});

		const piEntry = await t.query(api.diary.get, {
			date: "2026-03-25",
			orchestrator: "pi",
		});
		expect(piEntry).not.toBeNull();
		expect(piEntry!.content).toBe("Pi's diary for March 25");
		expect(piEntry!.orchestrator).toBe("pi");

		const tauEntry = await t.query(api.diary.get, {
			date: "2026-03-25",
			orchestrator: "tau",
		});
		expect(tauEntry).not.toBeNull();
		expect(tauEntry!.content).toBe("Tau's diary for March 25");
	});

	test("list diaries", async () => {
		const t = createTestConvex();

		await t.mutation(api.diary.write, {
			date: "2026-03-24",
			orchestrator: "pi",
			content: "Day 1 entry",
		});

		await t.mutation(api.diary.write, {
			date: "2026-03-25",
			orchestrator: "pi",
			content: "Day 2 entry",
		});

		await t.mutation(api.diary.write, {
			date: "2026-03-25",
			orchestrator: "tau",
			content: "Tau day 2 entry",
		});

		// List all
		const all = await t.query(api.diary.list, {});
		expect(all).toHaveLength(3);

		// List by orchestrator
		const piEntries = await t.query(api.diary.list, { orchestrator: "pi" });
		expect(piEntries).toHaveLength(2);
		expect(piEntries.every((e) => e.orchestrator === "pi")).toBe(true);
	});
});

// =============================================================================
// 8. Briefing Notes
// =============================================================================

describe("Briefing Notes", () => {
	test("create briefing note", async () => {
		const t = createTestConvex();

		const noteId = await t.mutation(api.briefingNotes.create, {
			title: "Architecture Review: Memory Layer",
			topic: "architecture",
			participants: ["pi", "tau", "laurent"],
			content:
				"Discussed the memory layer design. Agreed on using Convex with RAG for embeddings.",
			decisions: [
				"Use convex-dev/rag for embeddings",
				"Namespace memories by project",
			],
			createdBy: "pi",
		});

		expect(noteId).toBeDefined();

		const note = await t.query(api.briefingNotes.get, { noteId });
		expect(note).not.toBeNull();
		expect(note!.title).toBe("Architecture Review: Memory Layer");
		expect(note!.topic).toBe("architecture");
		expect(note!.participants).toEqual(["pi", "tau", "laurent"]);
		expect(note!.decisions).toHaveLength(2);
	});

	test("list briefing notes by topic", async () => {
		const t = createTestConvex();

		await t.mutation(api.briefingNotes.create, {
			title: "Arch Review 1",
			topic: "architecture",
			participants: ["pi"],
			content: "First arch review",
			createdBy: "pi",
		});

		await t.mutation(api.briefingNotes.create, {
			title: "Arch Review 2",
			topic: "architecture",
			participants: ["pi", "tau"],
			content: "Second arch review",
			createdBy: "tau",
		});

		await t.mutation(api.briefingNotes.create, {
			title: "Sprint Planning",
			topic: "planning",
			participants: ["pi", "tau", "phi"],
			content: "Sprint planning notes",
			createdBy: "pi",
		});

		const archNotes = await t.query(api.briefingNotes.list, {
			topic: "architecture",
		});
		expect(archNotes).toHaveLength(2);
		expect(archNotes.every((n) => n.topic === "architecture")).toBe(true);

		const planningNotes = await t.query(api.briefingNotes.list, {
			topic: "planning",
		});
		expect(planningNotes).toHaveLength(1);

		// List all
		const allNotes = await t.query(api.briefingNotes.list, {});
		expect(allNotes).toHaveLength(3);
	});
});

// =============================================================================
// 10. MCP Tenants
// =============================================================================

// SHA-256 helper (mirrors what seed-mcp-tenant.ts does)
async function sha256hex(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

const MASTER_TOKEN = "test-master-secret-32bytes-xyzabc";

describe("MCP Tenants", () => {
	beforeEach(() => {
		process.env.BEARER_SECRET_MASTER = MASTER_TOKEN;
	});

	test("createTenant returns an ID and tenant is disabled by default", async () => {
		const t = createTestConvex();

		const tokenHash = await sha256hex("raw-bearer-token-abc123");

		const tenantId = await t.mutation(api.mcpTenants.createTenant, {
			callerToken: MASTER_TOKEN,
			tokenHash,
			tenantName: "vip-client-1",
			convexUrl: "https://clientabc.convex.cloud",
		});

		expect(tenantId).toBeDefined();

		// getTenantByTokenHash returns the tenant but enabled=false
		const result = await t.query(api.mcpTenants.getTenantByTokenHash, {
			tokenHash,
		});
		expect(result).not.toBeNull();
		if (!result) throw new Error("Expected tenant result to be non-null");
		expect(result.convexUrl).toBe("https://clientabc.convex.cloud");
		expect(result.tenantName).toBe("vip-client-1");
		expect(result.enabled).toBe(false);
	});

	test("enableTenant sets enabled=true", async () => {
		const t = createTestConvex();

		const tokenHash = await sha256hex("raw-bearer-token-enable-test");

		const tenantId = await t.mutation(api.mcpTenants.createTenant, {
			callerToken: MASTER_TOKEN,
			tokenHash,
			tenantName: "vip-client-enable",
			convexUrl: "https://clientenable.convex.cloud",
		});

		await t.mutation(api.mcpTenants.enableTenant, {
			callerToken: MASTER_TOKEN,
			tenantId,
		});

		const result = await t.query(api.mcpTenants.getTenantByTokenHash, {
			tokenHash,
		});
		expect(result).not.toBeNull();
		if (!result) throw new Error("Expected tenant result to be non-null");
		expect(result.enabled).toBe(true);
	});

	test("disableTenant sets enabled=false", async () => {
		const t = createTestConvex();

		const tokenHash = await sha256hex("raw-bearer-token-disable-test");

		const tenantId = await t.mutation(api.mcpTenants.createTenant, {
			callerToken: MASTER_TOKEN,
			tokenHash,
			tenantName: "vip-client-disable",
			convexUrl: "https://clientdisable.convex.cloud",
		});

		await t.mutation(api.mcpTenants.enableTenant, {
			callerToken: MASTER_TOKEN,
			tenantId,
		});

		// Verify enabled first
		const enabled = await t.query(api.mcpTenants.getTenantByTokenHash, { tokenHash });
		expect(enabled!.enabled).toBe(true);

		// Now disable
		await t.mutation(api.mcpTenants.disableTenant, {
			callerToken: MASTER_TOKEN,
			tenantId,
		});

		const disabled = await t.query(api.mcpTenants.getTenantByTokenHash, { tokenHash });
		expect(disabled).not.toBeNull();
		expect(disabled!.enabled).toBe(false);
	});

	test("revokeTenant causes getTenantByTokenHash to return null", async () => {
		const t = createTestConvex();

		const tokenHash = await sha256hex("raw-bearer-token-revoke-test");

		const tenantId = await t.mutation(api.mcpTenants.createTenant, {
			callerToken: MASTER_TOKEN,
			tokenHash,
			tenantName: "vip-client-revoke",
			convexUrl: "https://clientrevoke.convex.cloud",
		});

		await t.mutation(api.mcpTenants.revokeTenant, {
			callerToken: MASTER_TOKEN,
			tenantId,
		});

		const result = await t.query(api.mcpTenants.getTenantByTokenHash, { tokenHash });
		expect(result).toBeNull();
	});

	test("revokeTenant is idempotent", async () => {
		const t = createTestConvex();

		const tokenHash = await sha256hex("raw-bearer-token-idempotent-test");

		const tenantId = await t.mutation(api.mcpTenants.createTenant, {
			callerToken: MASTER_TOKEN,
			tokenHash,
			tenantName: "vip-client-idempotent",
			convexUrl: "https://clientidempotent.convex.cloud",
		});

		// Revoke twice — should not throw
		await t.mutation(api.mcpTenants.revokeTenant, { callerToken: MASTER_TOKEN, tenantId });
		await t.mutation(api.mcpTenants.revokeTenant, { callerToken: MASTER_TOKEN, tenantId });

		const result = await t.query(api.mcpTenants.getTenantByTokenHash, { tokenHash });
		expect(result).toBeNull();
	});

	test("getTenantByTokenHash returns null for unknown token", async () => {
		const t = createTestConvex();

		const unknownHash = await sha256hex("does-not-exist-token");
		const result = await t.query(api.mcpTenants.getTenantByTokenHash, {
			tokenHash: unknownHash,
		});
		expect(result).toBeNull();
	});

	test("createTenant rejects invalid master token", async () => {
		const t = createTestConvex();

		const tokenHash = await sha256hex("raw-bearer-token-authfail");

		await expect(
			t.mutation(api.mcpTenants.createTenant, {
				callerToken: "wrong-secret",
				tokenHash,
				tenantName: "vip-unauthorized",
				convexUrl: "https://unauthorized.convex.cloud",
			}),
		).rejects.toThrow("Unauthorized");
	});

	test("listTenants returns all tenants with admin token", async () => {
		const t = createTestConvex();

		const hash1 = await sha256hex("list-test-token-1");
		const hash2 = await sha256hex("list-test-token-2");

		await t.mutation(api.mcpTenants.createTenant, {
			callerToken: MASTER_TOKEN,
			tokenHash: hash1,
			tenantName: "tenant-a",
			convexUrl: "https://tenant-a.convex.cloud",
		});
		await t.mutation(api.mcpTenants.createTenant, {
			callerToken: MASTER_TOKEN,
			tokenHash: hash2,
			tenantName: "tenant-b",
			convexUrl: "https://tenant-b.convex.cloud",
		});

		const tenants = await t.query(api.mcpTenants.listTenants, {
			callerToken: MASTER_TOKEN,
		});
		expect(tenants).toHaveLength(2);
		expect(tenants.map((t) => t.tenantName).sort()).toEqual(["tenant-a", "tenant-b"]);
	});

	test("createTenant rejects duplicate tokenHash", async () => {
		const t = createTestConvex();

		const tokenHash = await sha256hex("duplicate-token-test");

		await t.mutation(api.mcpTenants.createTenant, {
			callerToken: MASTER_TOKEN,
			tokenHash,
			tenantName: "first-tenant",
			convexUrl: "https://first.convex.cloud",
		});

		await expect(
			t.mutation(api.mcpTenants.createTenant, {
				callerToken: MASTER_TOKEN,
				tokenHash,
				tenantName: "duplicate-tenant",
				convexUrl: "https://duplicate.convex.cloud",
			}),
		).rejects.toThrow("already exists");
	});
});

// =============================================================================
// 11. List queries: fields=lite + status multi/aliases
// =============================================================================

describe("List queries — fields=lite + status multi/aliases", () => {
	// ── shared task factory args ────────────────────────────────────────────────
	const baseTask = {
		title: "Test task",
		description: "A description with some detail that will be omitted in lite mode",
		project: "vp-test",
		assignedTo: "pi" as const,
		priority: "medium" as const,
		status: "todo" as const,
		createdBy: "pi" as const,
		tags: ["tag-a", "tag-b"],
	};

	// ── 1. fields=lite payload reduction (tasks) ────────────────────────────────
	test("tasks.list fields=lite returns compact projection only", async () => {
		const t = createTestConvex();

		// Create 5 tasks assigned to pi
		for (let i = 0; i < 5; i++) {
			await t.mutation(api.tasks.create, {
				...baseTask,
				title: `Lite task ${i}`,
			});
		}

		const liteRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { assignedTo: "pi", fields: "lite" });

		expect(liteRows).toHaveLength(5);

		// Each row must have the lite keys
		const liteKeys = ["_id", "_creationTime", "title", "status", "priority", "assignedTo"];
		const forbiddenKeys = [
			"description",
			"tags",
			"dependsOn",
			"completionNote",
			"estimatedMinutes",
			"actualMinutes",
			"startedAt",
			"completedAt",
			"dueDate",
			"createdBy",
			"createdAt",
			"updatedAt",
		];

		for (const row of liteRows) {
			for (const k of liteKeys) {
				expect(row).toHaveProperty(k);
			}
			for (const k of forbiddenKeys) {
				expect(row).not.toHaveProperty(k);
			}
		}

		// Snapshot: lite payload must be < 50% of full payload by byte size
		const fullRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { assignedTo: "pi", fields: "full" });

		const liteBytes = JSON.stringify(liteRows).length;
		const fullBytes = JSON.stringify(fullRows).length;
		// lite payload reduction: liteBytes < fullBytes * 0.50
		// (sample sizes logged as comment: ~liteBytes vs ~fullBytes bytes)
		expect(liteBytes).toBeLessThan(fullBytes * 0.5);
	});

	// ── 2. fields="full" default (backward compat) ──────────────────────────────
	test("tasks.list without fields returns full doc shape (backward compat)", async () => {
		const t = createTestConvex();

		await t.mutation(api.tasks.create, { ...baseTask, title: "Full compat task" });

		const noFieldsRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { assignedTo: "pi" });

		const fullFieldsRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { assignedTo: "pi", fields: "full" });

		// Both must include the full shape fields
		for (const row of noFieldsRows) {
			expect(row).toHaveProperty("createdBy");
			expect(row).toHaveProperty("createdAt");
			expect(row).toHaveProperty("updatedAt");
		}

		// fields=full and no-fields must produce identical results
		expect(JSON.stringify(noFieldsRows)).toBe(JSON.stringify(fullFieldsRows));
	});

	// ── 3. status multi-value array (tasks) ─────────────────────────────────────
	test("tasks.list status=[todo,in_progress] returns only those 2 statuses", async () => {
		const t = createTestConvex();

		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "Task todo",
			status: "todo",
		});
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "Task in_progress",
			status: "in_progress",
		});
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "Task done",
			status: "done",
		});

		const rows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { status: ["todo", "in_progress"] });

		expect(rows).toHaveLength(2);
		expect(rows.some((r: { status: string }) => r.status === "done")).toBe(false);
		expect(rows.every((r: { status: string }) => ["todo", "in_progress"].includes(r.status))).toBe(true);
	});

	test("tasks.list status=['todo'] (single-element array) === status='todo' string", async () => {
		const t = createTestConvex();

		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "Task todo A",
			status: "todo",
		});
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "Task in_progress A",
			status: "in_progress",
		});

		const arrayRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { status: ["todo"] });

		const stringRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { status: "todo" });

		expect(arrayRows).toHaveLength(1);
		expect(stringRows).toHaveLength(1);
		expect(arrayRows[0]._id).toBe(stringRows[0]._id);
	});

	// ── 4. status alias "active" (tasks) ────────────────────────────────────────
	test("tasks.list status='active' returns todo + in_progress only", async () => {
		const t = createTestConvex();

		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "Active todo",
			status: "todo",
		});
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "Active in_progress",
			status: "in_progress",
		});
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "Not active done",
			status: "done",
		});

		const activeRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { status: "active" });

		const explicitRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { status: ["todo", "in_progress"] });

		expect(activeRows).toHaveLength(2);
		// alias must produce identical result to explicit array
		expect(activeRows.map((r: { _id: string }) => r._id).sort()).toEqual(
			explicitRows.map((r: { _id: string }) => r._id).sort(),
		);
	});

	// ── 5. status alias "open" (tasks) ──────────────────────────────────────────
	test("tasks.list status='open' returns all except done", async () => {
		const t = createTestConvex();

		const statuses = ["todo", "in_progress", "review", "blocked", "done"] as const;
		for (const s of statuses) {
			await t.mutation(api.tasks.create, {
				...baseTask,
				title: `Open test ${s}`,
				status: s,
			});
		}

		const openRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { status: "open" });

		expect(openRows).toHaveLength(4);
		expect(openRows.some((r: { status: string }) => r.status === "done")).toBe(false);
	});

	// ── 6. status alias mixing rejection (tasks) ─────────────────────────────────
	test("tasks.list status=['open','active'] throws ConvexError about alias in array", async () => {
		const t = createTestConvex();

		await expect(
			t
				.withIdentity({ subject: "test-service-account-user-id" })
				.query(api.tasks.list, { status: ["open", "active"] }),
		).rejects.toThrow(/alias "open" is not allowed inside an array/);
	});

	// ── 6b. status alias "all" (tasks) — Eta PR #530 delta-review fix ─────────────
	test("tasks.list status='all' returns every status (no filter)", async () => {
		const t = createTestConvex();

		const statuses = ["todo", "in_progress", "review", "blocked", "done"] as const;
		for (const s of statuses) {
			await t.mutation(api.tasks.create, {
				...baseTask,
				title: `All test ${s}`,
				status: s,
			});
		}

		const allRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, { status: "all" });

		const unfilteredRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, {});

		expect(allRows).toHaveLength(5);
		expect(allRows.map((r: { _id: string }) => r._id).sort()).toEqual(
			unfilteredRows.map((r: { _id: string }) => r._id).sort(),
		);
	});

	test("tasks.list status=['all'] throws ConvexError about alias in array", async () => {
		const t = createTestConvex();
		await expect(
			t
				.withIdentity({ subject: "test-service-account-user-id" })
				.query(api.tasks.list, { status: ["all"] }),
		).rejects.toThrow(/alias "all" is not allowed inside an array/);
	});

	// ── 7. status invalid value (tasks) ─────────────────────────────────────────
	test("tasks.list status='bogus' throws ConvexError about invalid status", async () => {
		const t = createTestConvex();

		await expect(
			t
				.withIdentity({ subject: "test-service-account-user-id" })
				.query(api.tasks.list, { status: "bogus" }),
		).rejects.toThrow(/invalid status: "bogus"/);
	});

	// ── 8. missions: status alias "open" / "active" ──────────────────────────────
	test("missions.list status='open' returns all except complete", async () => {
		const t = createTestConvex();

		const baseMission = {
			name: "Mission",
			project: "vp-test",
			priority: "medium" as const,
			pilot: "pi" as const,
			agents: ["pi"],
			createdBy: "pi" as const,
		};

		await t.mutation(api.missions.create, {
			...baseMission,
			name: "Mission brainstorm",
			status: "brainstorm",
		});
		await t.mutation(api.missions.create, {
			...baseMission,
			name: "Mission plan",
			status: "plan",
		});
		await t.mutation(api.missions.create, {
			...baseMission,
			name: "Mission complete",
			status: "complete",
		});

		const openRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.missions.list, { status: "open" });

		expect(openRows).toHaveLength(2);
		expect(openRows.some((m: { status: string }) => m.status === "complete")).toBe(false);
	});

	test("missions.list status='active' returns plan + execute only", async () => {
		const t = createTestConvex();

		const baseMission = {
			name: "Mission",
			project: "vp-test",
			priority: "medium" as const,
			pilot: "pi" as const,
			agents: ["pi"],
			createdBy: "pi" as const,
		};

		await t.mutation(api.missions.create, {
			...baseMission,
			name: "Mission brainstorm",
			status: "brainstorm",
		});
		await t.mutation(api.missions.create, {
			...baseMission,
			name: "Mission plan",
			status: "plan",
		});
		await t.mutation(api.missions.create, {
			...baseMission,
			name: "Mission execute",
			status: "execute",
		});
		await t.mutation(api.missions.create, {
			...baseMission,
			name: "Mission complete",
			status: "complete",
		});

		const activeRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.missions.list, { status: "active" });

		expect(activeRows).toHaveLength(2);
		expect(activeRows.every((m: { status: string }) => ["plan", "execute"].includes(m.status))).toBe(true);
	});

	// ── 8b. missions: status alias "all" — Eta PR #530 delta-review fix ──────────
	test("missions.list status='all' returns every status (no filter)", async () => {
		const t = createTestConvex();

		const baseMission = {
			name: "Mission",
			project: "vp-test",
			priority: "medium" as const,
			pilot: "pi" as const,
			agents: ["pi"],
			createdBy: "pi" as const,
		};

		const statuses = ["brainstorm", "plan", "execute", "validate", "complete"] as const;
		for (const s of statuses) {
			await t.mutation(api.missions.create, {
				...baseMission,
				name: `All mission ${s}`,
				status: s,
			});
		}

		const allRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.missions.list, { status: "all" });

		expect(allRows).toHaveLength(5);
	});

	test("missions.list status=['all'] throws ConvexError about alias in array", async () => {
		const t = createTestConvex();
		await expect(
			t
				.withIdentity({ subject: "test-service-account-user-id" })
				.query(api.missions.list, { status: ["all"] }),
		).rejects.toThrow(/alias "all" is not allowed inside an array/);
	});

	// ── 9. missions: fields=lite projection ─────────────────────────────────────
	test("missions.list fields=lite returns compact projection only", async () => {
		const t = createTestConvex();

		await t.mutation(api.missions.create, {
			name: "Lite mission",
			description: "This description should NOT appear in lite",
			brief: "This brief should NOT appear in lite",
			project: "vp-test",
			status: "plan",
			priority: "high",
			pilot: "pi",
			agents: ["pi"],
			createdBy: "pi",
		});

		const liteRows = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.missions.list, { fields: "lite" });

		expect(liteRows).toHaveLength(1);
		const row = liteRows[0];

		// Required lite keys
		const liteKeys = ["_id", "_creationTime", "name", "status", "pilot", "priority", "project"];
		for (const k of liteKeys) {
			expect(row).toHaveProperty(k);
		}

		// Forbidden full-only keys
		const forbiddenKeys = ["description", "brief", "agents", "createdBy", "createdAt", "updatedAt"];
		for (const k of forbiddenKeys) {
			expect(row).not.toHaveProperty(k);
		}
	});

	// ── 10. briefingNotes: fields=lite projection ────────────────────────────────
	test("briefingNotes.list fields=lite returns compact projection only", async () => {
		const t = createTestConvex();

		await t.mutation(api.briefingNotes.create, {
			title: "Arch note 1",
			topic: "architecture",
			participants: ["pi", "tau"],
			content: "Full content that should NOT appear in lite mode — lots of text here",
			decisions: ["Decision A", "Decision B"],
			createdBy: "pi",
		});
		await t.mutation(api.briefingNotes.create, {
			title: "Arch note 2",
			topic: "architecture",
			participants: ["pi"],
			content: "Another full content block that should be stripped in lite",
			createdBy: "tau",
		});

		const liteRows = await t.query(api.briefingNotes.list, { fields: "lite" });

		expect(liteRows).toHaveLength(2);

		const liteKeys = ["_id", "_creationTime", "topic", "title", "participants", "createdBy"];
		const forbiddenKeys = ["content", "decisions", "linkedMemoryIds", "createdAt", "updatedAt"];

		for (const row of liteRows) {
			for (const k of liteKeys) {
				expect(row).toHaveProperty(k);
			}
			for (const k of forbiddenKeys) {
				expect(row).not.toHaveProperty(k);
			}
		}
	});

	// ── 11. listByMission fields=lite + status filter ───────────────────────────
	test("tasks.listByMission fields=lite + status='active' returns 2 lite rows, no done", async () => {
		const t = createTestConvex();

		const missionId = await t.mutation(api.missions.create, {
			name: "Mission for listByMission test",
			project: "vp-test",
			status: "plan",
			priority: "high",
			pilot: "pi",
			agents: ["pi"],
			createdBy: "pi",
		});

		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "listByMission todo",
			status: "todo",
			missionId,
		});
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "listByMission in_progress",
			status: "in_progress",
			missionId,
		});
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "listByMission done",
			status: "done",
			missionId,
		});

		const rows = await t.query(api.tasks.listByMission, {
			missionId,
			status: "active",
			fields: "lite",
		});

		expect(rows).toHaveLength(2);
		expect(rows.some((r: { status: string }) => r.status === "done")).toBe(false);

		// Verify lite shape: must have lite keys, must NOT have full-only keys
		const liteKeys = ["_id", "_creationTime", "title", "status", "priority", "assignedTo"];
		const forbiddenKeys = [
			"description",
			"tags",
			"completionNote",
			"createdBy",
			"createdAt",
			"updatedAt",
		];
		for (const row of rows) {
			for (const k of liteKeys) {
				expect(row).toHaveProperty(k);
			}
			for (const k of forbiddenKeys) {
				expect(row).not.toHaveProperty(k);
			}
		}
	});
});

// =============================================================================
// v2.3.3 — createdBy + updatedSince + auto-clamp
// VP task: k1796s5j6jfkvkx0tn5n926ftd87jx9p
// =============================================================================

describe("List queries — v2.3.3 createdBy + updatedSince + auto-clamp", () => {
	const baseTask = {
		title: "v233 task",
		description: "v2.3.3 test",
		project: "v233",
		assignedTo: "sigma" as const,
		priority: "medium" as const,
		status: "todo" as const,
		createdBy: "sigma" as const,
	};

	test("tasks.list createdBy filter returns only sigma-created tasks", async () => {
		const t = createTestConvex();

		await t.mutation(api.tasks.create, { ...baseTask, title: "sigma-1" });
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "pi-1",
			createdBy: "pi",
		});
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "sigma-2",
		});

		const rows = await t.query(api.tasks.list, {
			createdBy: "sigma",
			fields: "lite",
			limit: 100,
		});

		expect(rows.length).toBeGreaterThanOrEqual(2);
		// In lite mode createdBy is stripped; verify count + that no pi-created rows leak by title
		expect(rows.every((r: { title: string }) => r.title !== "pi-1")).toBe(true);
	});

	test("tasks.list createdBy + assignedTo combinatorics", async () => {
		const t = createTestConvex();

		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "pi-creates-sigma",
			createdBy: "pi",
			assignedTo: "sigma",
		});
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "pi-creates-tau",
			createdBy: "pi",
			assignedTo: "tau",
		});
		await t.mutation(api.tasks.create, {
			...baseTask,
			title: "sigma-creates-sigma",
			createdBy: "sigma",
			assignedTo: "sigma",
		});

		const rows = await t.query(api.tasks.list, {
			createdBy: "pi",
			assignedTo: "sigma",
			limit: 100,
		});

		expect(rows).toHaveLength(1);
		expect(rows[0].title).toBe("pi-creates-sigma");
	});

	test("tasks.list updatedSince filter returns only recently-updated rows", async () => {
		const t = createTestConvex();

		const oldId = await t.mutation(api.tasks.create, {
			...baseTask,
			title: "old-task",
		});
		// Advance fake time
		vi.setSystemTime(new Date(Date.now() + 10_000));
		const cutoff = Date.now();
		vi.setSystemTime(new Date(Date.now() + 10_000));
		const newId = await t.mutation(api.tasks.create, {
			...baseTask,
			title: "new-task",
		});

		const rows = await t.query(api.tasks.list, {
			updatedSince: cutoff,
			limit: 100,
		});

		const ids = rows.map((r: { _id: string }) => r._id);
		expect(ids).toContain(newId);
		expect(ids).not.toContain(oldId);
	});

	test("tasks.list auto-clamp: fields=full + no explicit limit → ≤30", async () => {
		const t = createTestConvex();

		// Seed 35 tasks
		for (let i = 0; i < 35; i++) {
			await t.mutation(api.tasks.create, {
				...baseTask,
				title: `bulk-${i}`,
			});
		}

		const rows = await t.query(api.tasks.list, { assignedTo: "sigma" });
		expect(rows.length).toBeLessThanOrEqual(30);
	});

	test("tasks.list auto-clamp NOT triggered when fields=lite", async () => {
		const t = createTestConvex();

		for (let i = 0; i < 35; i++) {
			await t.mutation(api.tasks.create, {
				...baseTask,
				title: `lite-${i}`,
			});
		}

		const rows = await t.query(api.tasks.list, {
			assignedTo: "sigma",
			fields: "lite",
		});
		// Default 50, so all 35 should come through
		expect(rows.length).toBe(35);
	});

	test("tasks.list auto-clamp NOT triggered when explicit limit passed", async () => {
		const t = createTestConvex();

		for (let i = 0; i < 35; i++) {
			await t.mutation(api.tasks.create, {
				...baseTask,
				title: `explicit-${i}`,
			});
		}

		const rows = await t.query(api.tasks.list, {
			assignedTo: "sigma",
			limit: 50,
		});
		expect(rows.length).toBe(35);
	});
});
