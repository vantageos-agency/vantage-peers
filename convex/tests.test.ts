/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
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

		const alphaMemories = await t.query(api.memories.listMemories, {
			namespace: "project/alpha",
		});

		expect(alphaMemories).toHaveLength(2);
		expect(alphaMemories.every((m) => m.namespace === "project/alpha")).toBe(
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

		const projectMemories = await t.query(api.memories.listMemories, {
			namespace: "global",
			type: "project",
		});

		expect(projectMemories).toHaveLength(2);
		expect(projectMemories.every((m) => m.type === "project")).toBe(true);
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
		const listed = await t.query(api.memories.listMemories, {
			namespace: "global",
		});
		expect(listed.find((m) => m._id === memoryId)).toBeUndefined();
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
		const listed = await t.query(api.memories.listMemories, {
			namespace: "global",
		});
		expect(listed).toHaveLength(1);
		expect(listed[0]._id).toBe(updatedId);
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
		const t = createTestConvex();

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
		const t = createTestConvex();

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
		const t = createTestConvex();

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
		const t = createTestConvex();

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
		const t = createTestConvex();

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
		const t = createTestConvex();

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
		const t = createTestConvex();

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
		const t = createTestConvex();

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
		const t = createTestConvex();

		// Send one message so we have a valid-shape ID, then delete it to get a
		// missing ID for the error path
		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "tau",
			content: "Temporary",
		});

		await t.mutation(api.messages.deleteMessage, { messageId });

		// Deleting again should throw "Message not found"
		await expect(
			t.mutation(api.messages.deleteMessage, { messageId }),
		).rejects.toThrow("Message not found");
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

		const piTasks = await t.query(api.tasks.list, { assignedTo: "pi" });
		expect(piTasks).toHaveLength(2);
		expect(piTasks.every((t) => t.assignedTo === "pi")).toBe(true);
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

		const vmMissions = await t.query(api.missions.list, {
			project: "vantage-peers",
		});
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
