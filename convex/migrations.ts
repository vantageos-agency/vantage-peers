import { internalMutation } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Migration: backfill startedAt + completedAt on tasks
// Run: npx convex run migrations:backfillTaskTimes
// ─────────────────────────────────────────────────────────────────────────────

export const backfillTaskTimes = internalMutation({
	args: {},
	handler: async (ctx) => {
		const tasks = await ctx.db.query("tasks").collect();
		let startedFixed = 0;
		let completedFixed = 0;

		for (const task of tasks) {
			const patch: Record<string, any> = {};

			// Backfill startedAt for in_progress/done/review tasks
			if (
				!task.startedAt &&
				(task.status === "in_progress" || task.status === "done" || task.status === "review")
			) {
				patch.startedAt = task.createdAt;
				startedFixed++;
			}

			// Backfill completedAt for done tasks
			if (!task.completedAt && task.status === "done") {
				patch.completedAt = task.updatedAt;
				completedFixed++;
			}

			// Calculate actualMinutes if both timestamps exist
			const startedAt = patch.startedAt ?? task.startedAt;
			const completedAt = patch.completedAt ?? task.completedAt;
			if (startedAt && completedAt && !task.actualMinutes) {
				patch.actualMinutes = Math.round((completedAt - startedAt) / 60_000);
			}

			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(task._id, patch);
			}
		}

		console.log(`Backfilled: ${startedFixed} startedAt, ${completedFixed} completedAt`);
		return { startedFixed, completedFixed, total: tasks.length };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: delete test briefing notes (MCP Test Briefing entries)
// Run: npx convex run migrations:deleteTestBriefings
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTestBriefings = internalMutation({
	args: {},
	handler: async (ctx) => {
		const notes = await ctx.db.query("briefingNotes").collect();
		let deleted = 0;

		for (const note of notes) {
			if (note.title === "MCP Test Briefing") {
				await ctx.db.delete(note._id);
				deleted++;
			}
		}

		console.log(`Deleted ${deleted} test briefing notes`);
		return { deleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: delete test tasks created by MCP tester
// Run: npx convex run migrations:deleteTestTasks
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTestTasks = internalMutation({
	args: {},
	handler: async (ctx) => {
		const tasks = await ctx.db.query("tasks").collect();
		let deleted = 0;

		for (const task of tasks) {
			if (
				task.title === "Test task from MCP tester" ||
				task.title === "Mission-linked task from MCP tester"
			) {
				await ctx.db.delete(task._id);
				deleted++;
			}
		}

		console.log(`Deleted ${deleted} test tasks`);
		return { deleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: delete test missions created by MCP tester
// Run: npx convex run migrations:deleteTestMissions
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTestMissions = internalMutation({
	args: {},
	handler: async (ctx) => {
		const missions = await ctx.db.query("missions").collect();
		let deleted = 0;

		for (const mission of missions) {
			if (
				mission.name === "Test mission from MCP tester" ||
				mission.name === "Updated test mission"
			) {
				await ctx.db.delete(mission._id);
				deleted++;
			}
		}

		console.log(`Deleted ${deleted} test missions`);
		return { deleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: delete test memories from test/mcp-tester namespace
// Run: npx convex run migrations:deleteTestMemories
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTestMemories = internalMutation({
	args: {},
	handler: async (ctx) => {
		const memories = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) => q.eq("namespace", "test/mcp-tester"))
			.collect();
		let deleted = 0;

		for (const mem of memories) {
			await ctx.db.delete(mem._id);
			deleted++;
		}

		console.log(`Deleted ${deleted} test memories from test/mcp-tester`);
		return { deleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: delete test messages from MCP tester
// Run: npx convex run migrations:deleteTestMessages
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTestMessages = internalMutation({
	args: {},
	handler: async (ctx) => {
		const messages = await ctx.db.query("messages").collect();
		let deleted = 0;

		for (const msg of messages) {
			if (msg.content === "Test message from MCP tester") {
				// Delete receipts first
				const receipts = await ctx.db
					.query("messageReceipts")
					.withIndex("by_message", (q) => q.eq("messageId", msg._id))
					.collect();
				for (const receipt of receipts) {
					await ctx.db.delete(receipt._id);
				}
				await ctx.db.delete(msg._id);
				deleted++;
			}
		}

		console.log(`Deleted ${deleted} test messages and their receipts`);
		return { deleted };
	},
});
