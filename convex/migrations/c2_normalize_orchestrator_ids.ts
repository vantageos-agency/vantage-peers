/**
 * C2 migration — NFC-normalize all orchestrator-id fields across VP tables.
 *
 * B2 standard §6 (case-insensitive) + §7 (Unicode NFC). Day 92.
 * Mission: k57a36y8w5t085bqr23dsmvb2d882506
 * Task:    k171h140m044rpr0ayh4fmpqvd883sk4
 *
 * Tables migrated:
 *   tasks          — assignedTo, createdBy
 *   messages       — from, channel (single-role only, not broadcast/CSV)
 *   messageReceipts — recipient
 *   missions       — pilot, createdBy
 *   briefingNotes  — createdBy, participants[]
 *   profiles       — orchestratorId
 *   memories       — createdBy
 *
 * Idempotent: skips rows where every field already equals its normalized form.
 *
 * MANUAL INVOCATION post-deploy (run repeatedly until updated=0):
 *   npx convex run migrations/c2-normalize-orchestrator-ids:run '{}'
 *
 * Dry-run (no writes):
 *   npx convex run migrations/c2-normalize-orchestrator-ids:run '{"dryRun":true}'
 */

import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

// Inline normalize to avoid cross-file import issues in the Convex runtime.
// Must stay in sync with convex/_helpers/normalizeOrchestratorId.ts.
function norm(s: string): string {
	return s.normalize("NFC").toLowerCase().trim();
}

/** Return true when the string is already normalized. */
function alreadyNorm(s: string): boolean {
	return s === norm(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// tasks — assignedTo + createdBy
// ─────────────────────────────────────────────────────────────────────────────

export const migrateTasks = internalMutation({
	args: { batchSize: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
	returns: v.object({ updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;
		const dryRun = args.dryRun ?? false;
		const rows = await ctx.db.query("tasks").take(batchSize);
		let updated = 0;
		let skipped = 0;
		for (const row of rows) {
			const na = norm(row.assignedTo);
			const nc = norm(row.createdBy);
			if (row.assignedTo === na && row.createdBy === nc) {
				skipped++;
				continue;
			}
			if (!dryRun) {
				await ctx.db.patch(row._id, { assignedTo: na, createdBy: nc });
			}
			updated++;
		}
		return { updated, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// messages — from, channel (single-role only)
// ─────────────────────────────────────────────────────────────────────────────

export const migrateMessages = internalMutation({
	args: { batchSize: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
	returns: v.object({ updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;
		const dryRun = args.dryRun ?? false;
		const rows = await ctx.db.query("messages").take(batchSize);
		let updated = 0;
		let skipped = 0;
		for (const row of rows) {
			const nf = norm(row.from);
			// Normalize channel only when it's a single role (not "broadcast" or CSV).
			const nc =
				row.channel === "broadcast" || row.channel.includes(",")
					? row.channel
					: norm(row.channel);
			if (row.from === nf && row.channel === nc) {
				skipped++;
				continue;
			}
			if (!dryRun) {
				await ctx.db.patch(row._id, { from: nf, channel: nc });
			}
			updated++;
		}
		return { updated, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// messageReceipts — recipient
// ─────────────────────────────────────────────────────────────────────────────

export const migrateMessageReceipts = internalMutation({
	args: { batchSize: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
	returns: v.object({ updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;
		const dryRun = args.dryRun ?? false;
		const rows = await ctx.db.query("messageReceipts").take(batchSize);
		let updated = 0;
		let skipped = 0;
		for (const row of rows) {
			const nr = norm(row.recipient);
			if (row.recipient === nr) {
				skipped++;
				continue;
			}
			if (!dryRun) {
				await ctx.db.patch(row._id, { recipient: nr });
			}
			updated++;
		}
		return { updated, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// missions — pilot + createdBy
// ─────────────────────────────────────────────────────────────────────────────

export const migrateMissions = internalMutation({
	args: { batchSize: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
	returns: v.object({ updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;
		const dryRun = args.dryRun ?? false;
		const rows = await ctx.db.query("missions").take(batchSize);
		let updated = 0;
		let skipped = 0;
		for (const row of rows) {
			const np = norm(row.pilot);
			const nc = norm(row.createdBy);
			if (row.pilot === np && row.createdBy === nc) {
				skipped++;
				continue;
			}
			if (!dryRun) {
				await ctx.db.patch(row._id, { pilot: np, createdBy: nc });
			}
			updated++;
		}
		return { updated, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// briefingNotes — createdBy + participants[]
// ─────────────────────────────────────────────────────────────────────────────

export const migrateBriefingNotes = internalMutation({
	args: { batchSize: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
	returns: v.object({ updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;
		const dryRun = args.dryRun ?? false;
		const rows = await ctx.db.query("briefingNotes").take(batchSize);
		let updated = 0;
		let skipped = 0;
		for (const row of rows) {
			const nc = norm(row.createdBy);
			const np = row.participants.map(norm);
			const participantsChanged = row.participants.some(
				(p, i) => p !== np[i],
			);
			if (row.createdBy === nc && !participantsChanged) {
				skipped++;
				continue;
			}
			if (!dryRun) {
				await ctx.db.patch(row._id, {
					createdBy: nc,
					participants: np,
				});
			}
			updated++;
		}
		return { updated, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// profiles — orchestratorId
// ─────────────────────────────────────────────────────────────────────────────

export const migrateProfiles = internalMutation({
	args: { batchSize: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
	returns: v.object({ updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;
		const dryRun = args.dryRun ?? false;
		const rows = await ctx.db.query("profiles").take(batchSize);
		let updated = 0;
		let skipped = 0;
		for (const row of rows) {
			const ni = norm(row.orchestratorId);
			if (row.orchestratorId === ni) {
				skipped++;
				continue;
			}
			if (!dryRun) {
				await ctx.db.patch(row._id, { orchestratorId: ni });
			}
			updated++;
		}
		return { updated, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// memories — createdBy
// ─────────────────────────────────────────────────────────────────────────────

export const migrateMemories = internalMutation({
	args: { batchSize: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
	returns: v.object({ updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;
		const dryRun = args.dryRun ?? false;
		const rows = await ctx.db.query("memories").take(batchSize);
		let updated = 0;
		let skipped = 0;
		for (const row of rows) {
			const nc = norm(row.createdBy);
			if (row.createdBy === nc) {
				skipped++;
				continue;
			}
			if (!dryRun) {
				await ctx.db.patch(row._id, { createdBy: nc });
			}
			updated++;
		}
		return { updated, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// run — orchestrator: call all six table migrations in sequence
// ─────────────────────────────────────────────────────────────────────────────

export const run = internalMutation({
	args: {
		batchSize: v.optional(v.number()),
		dryRun: v.optional(v.boolean()),
	},
	returns: v.object({
		tasks: v.object({ updated: v.number(), skipped: v.number() }),
		messages: v.object({ updated: v.number(), skipped: v.number() }),
		messageReceipts: v.object({ updated: v.number(), skipped: v.number() }),
		missions: v.object({ updated: v.number(), skipped: v.number() }),
		briefingNotes: v.object({ updated: v.number(), skipped: v.number() }),
		profiles: v.object({ updated: v.number(), skipped: v.number() }),
		memories: v.object({ updated: v.number(), skipped: v.number() }),
		totalUpdated: v.number(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;
		const dryRun = args.dryRun ?? false;

		// Each sub-migration is an internalMutation — call them as helpers by
		// extracting the handler logic inline (actions can't call mutations, and
		// we want a single transaction boundary per table batch).
		// The run mutation handles orchestration; callers repeat until
		// totalUpdated === 0 to process tables with > batchSize rows.

		const taskRows = await ctx.db.query("tasks").take(batchSize);
		let tasksR = { updated: 0, skipped: 0 };
		for (const row of taskRows) {
			const na = norm(row.assignedTo);
			const nc = norm(row.createdBy);
			if (row.assignedTo === na && row.createdBy === nc) {
				tasksR.skipped++;
			} else {
				if (!dryRun) await ctx.db.patch(row._id, { assignedTo: na, createdBy: nc });
				tasksR.updated++;
			}
		}

		const msgRows = await ctx.db.query("messages").take(batchSize);
		let messagesR = { updated: 0, skipped: 0 };
		for (const row of msgRows) {
			const nf = norm(row.from);
			const nc =
				row.channel === "broadcast" || row.channel.includes(",")
					? row.channel
					: norm(row.channel);
			if (row.from === nf && row.channel === nc) {
				messagesR.skipped++;
			} else {
				if (!dryRun) await ctx.db.patch(row._id, { from: nf, channel: nc });
				messagesR.updated++;
			}
		}

		const rcptRows = await ctx.db.query("messageReceipts").take(batchSize);
		let messageReceiptsR = { updated: 0, skipped: 0 };
		for (const row of rcptRows) {
			const nr = norm(row.recipient);
			if (row.recipient === nr) {
				messageReceiptsR.skipped++;
			} else {
				if (!dryRun) await ctx.db.patch(row._id, { recipient: nr });
				messageReceiptsR.updated++;
			}
		}

		const msnRows = await ctx.db.query("missions").take(batchSize);
		let missionsR = { updated: 0, skipped: 0 };
		for (const row of msnRows) {
			const np = norm(row.pilot);
			const nc = norm(row.createdBy);
			if (row.pilot === np && row.createdBy === nc) {
				missionsR.skipped++;
			} else {
				if (!dryRun) await ctx.db.patch(row._id, { pilot: np, createdBy: nc });
				missionsR.updated++;
			}
		}

		const bnRows = await ctx.db.query("briefingNotes").take(batchSize);
		let briefingNotesR = { updated: 0, skipped: 0 };
		for (const row of bnRows) {
			const nc = norm(row.createdBy);
			const np = row.participants.map(norm);
			const changed =
				row.createdBy !== nc ||
				row.participants.some((p, i) => p !== np[i]);
			if (!changed) {
				briefingNotesR.skipped++;
			} else {
				if (!dryRun)
					await ctx.db.patch(row._id, { createdBy: nc, participants: np });
				briefingNotesR.updated++;
			}
		}

		const profRows = await ctx.db.query("profiles").take(batchSize);
		let profilesR = { updated: 0, skipped: 0 };
		for (const row of profRows) {
			const ni = norm(row.orchestratorId);
			if (row.orchestratorId === ni) {
				profilesR.skipped++;
			} else {
				if (!dryRun) await ctx.db.patch(row._id, { orchestratorId: ni });
				profilesR.updated++;
			}
		}

		const memRows = await ctx.db.query("memories").take(batchSize);
		let memoriesR = { updated: 0, skipped: 0 };
		for (const row of memRows) {
			const nc = norm(row.createdBy);
			if (row.createdBy === nc) {
				memoriesR.skipped++;
			} else {
				if (!dryRun) await ctx.db.patch(row._id, { createdBy: nc });
				memoriesR.updated++;
			}
		}

		const totalUpdated =
			tasksR.updated +
			messagesR.updated +
			messageReceiptsR.updated +
			missionsR.updated +
			briefingNotesR.updated +
			profilesR.updated +
			memoriesR.updated;

		return {
			tasks: tasksR,
			messages: messagesR,
			messageReceipts: messageReceiptsR,
			missions: missionsR,
			briefingNotes: briefingNotesR,
			profiles: profilesR,
			memories: memoriesR,
			totalUpdated,
		};
	},
});
