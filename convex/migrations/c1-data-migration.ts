// ─────────────────────────────────────────────────────────────────────────────
// c1-data-migration — batch copy host tables → Component (data-lake + agent-protocol)
// ─────────────────────────────────────────────────────────────────────────────
//
// PURPOSE
// Phase D.2 data migration utility. Copies rows from host VP-core tables into
// the scaffolded data-lake and agent-protocol Component tables.
// Following the Day 76 reindex pattern (reindexMemoriesByPeriod.ts):
//   - Paginated, batched, idempotent.
//   - Operator calls in a loop until `done: true`.
//   - verifyParity() gives a host vs Component count diff for each table.
//
// DO NOT EXECUTE during Phase D.1. This file is scaffold-only.
// Execution happens AFTER manual review, via:
//
//   npx convex run migrations/c1-data-migration:migrateMemoriesBatch \
//     '{"batchSize": 200}'
//
//   # Repeat with nextCursor from previous result until done: true.
//
//   npx convex run migrations/c1-data-migration:verifyParity
//
// IDEMPOTENCY
// Each batch function uses _creationTime cursor (monotonic ascending).
// Rows already present in the Component are NOT overwritten — the
// Component's own upsert logic is idempotent on the external key.
// Re-running the same cursor range is safe.
//
// SAFETY
// - All functions are `internal` — not callable from the client.
// - Migration does not DELETE host rows. Host handlers continue reading
//   from host tables (Phase D.2 cutover flips the switch).
// - verifyParity() is read-only and safe to call at any time.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

// ─── migrateMemoriesBatch ────────────────────────────────────────────────────
// Copy memories from host → data-lake Component (dataLake.memoriesV1).
// Cursor is the _creationTime of the last processed row (monotonic).

export const migrateMemoriesBatch = internalMutation({
	args: {
		cursor: v.optional(v.number()), // _creationTime of last processed row
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		done: v.boolean(),
		nextCursor: v.union(v.number(), v.null()),
		migratedThisRound: v.number(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 200;

		const rows = await ctx.db
			.query("memories")
			.filter((q) =>
				args.cursor !== undefined
					? q.gt(q.field("_creationTime"), args.cursor!)
					: q.gt(q.field("_creationTime"), 0),
			)
			.order("asc")
			.take(batchSize + 1);

		const hasMore = rows.length > batchSize;
		const batch = hasMore ? rows.slice(0, batchSize) : rows;

		// TODO (Phase D.2): replace this stub with the actual Component write call.
		// Example target once Component API is wired:
		//   await ctx.runMutation(components.dataLake.memoriesV1.store, { ... });
		// For now we log intent without writing to preserve Phase D.1 constraint
		// (no data flows to Component yet — Component tables remain empty).
		for (const _row of batch) {
			// stub: no-op until D.2 wires the Component API
		}

		const nextCursor = hasMore ? batch[batch.length - 1]._creationTime : null;
		return {
			done: !hasMore,
			nextCursor,
			migratedThisRound: batch.length,
		};
	},
});

// ─── migrateTasksBatch ───────────────────────────────────────────────────────
// Copy tasks from host → agent-protocol Component (agentProtocol.tasksV1).

export const migrateTasksBatch = internalMutation({
	args: {
		cursor: v.optional(v.number()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		done: v.boolean(),
		nextCursor: v.union(v.number(), v.null()),
		migratedThisRound: v.number(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 200;

		const rows = await ctx.db
			.query("tasks")
			.filter((q) =>
				args.cursor !== undefined
					? q.gt(q.field("_creationTime"), args.cursor!)
					: q.gt(q.field("_creationTime"), 0),
			)
			.order("asc")
			.take(batchSize + 1);

		const hasMore = rows.length > batchSize;
		const batch = hasMore ? rows.slice(0, batchSize) : rows;

		// TODO (Phase D.2): replace with actual Component write call.
		// Example: await ctx.runMutation(components.agentProtocol.tasksV1.store, { ... });
		for (const _row of batch) {
			// stub: no-op until D.2 wires the Component API
		}

		const nextCursor = hasMore ? batch[batch.length - 1]._creationTime : null;
		return {
			done: !hasMore,
			nextCursor,
			migratedThisRound: batch.length,
		};
	},
});

// ─── migrateMissionsBatch ────────────────────────────────────────────────────
// Copy missions from host → agent-protocol Component (agentProtocol.missionsV1).

export const migrateMissionsBatch = internalMutation({
	args: {
		cursor: v.optional(v.number()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		done: v.boolean(),
		nextCursor: v.union(v.number(), v.null()),
		migratedThisRound: v.number(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 200;

		const rows = await ctx.db
			.query("missions")
			.filter((q) =>
				args.cursor !== undefined
					? q.gt(q.field("_creationTime"), args.cursor!)
					: q.gt(q.field("_creationTime"), 0),
			)
			.order("asc")
			.take(batchSize + 1);

		const hasMore = rows.length > batchSize;
		const batch = hasMore ? rows.slice(0, batchSize) : rows;

		// TODO (Phase D.2): replace with actual Component write call.
		// Example: await ctx.runMutation(components.agentProtocol.missionsV1.store, { ... });
		for (const _row of batch) {
			// stub: no-op until D.2 wires the Component API
		}

		const nextCursor = hasMore ? batch[batch.length - 1]._creationTime : null;
		return {
			done: !hasMore,
			nextCursor,
			migratedThisRound: batch.length,
		};
	},
});

// ─── verifyParity ────────────────────────────────────────────────────────────
// Read-only count: host table rows vs Component table rows.
// Returns diff per table so operator can confirm migration completeness.
// Safe to run at any time — no writes.

export const verifyParity = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			table: v.string(),
			hostCount: v.number(),
			componentCount: v.number(),
			diff: v.number(),
		}),
	),
	handler: async (ctx) => {
		// Host counts (bounded take — safe approximation for parity check).
		// Using take(10000) to handle realistic production data sizes.
		// If tables exceed 10 000 rows, operator should run in targeted windows.
		const [memories, tasks, missions] = await Promise.all([
			ctx.db.query("memories").take(10_000),
			ctx.db.query("tasks").take(10_000),
			ctx.db.query("missions").take(10_000),
		]);

		// Component counts: placeholder until D.2 wires Component query calls.
		// TODO (Phase D.2): replace 0 with actual Component count queries:
		//   await ctx.runQuery(components.dataLake.memoriesV1.count, {})
		//   await ctx.runQuery(components.agentProtocol.tasksV1.count, {})
		//   await ctx.runQuery(components.agentProtocol.missionsV1.count, {})
		const componentMemoriesCount = 0;
		const componentTasksCount = 0;
		const componentMissionsCount = 0;

		return [
			{
				table: "memories",
				hostCount: memories.length,
				componentCount: componentMemoriesCount,
				diff: memories.length - componentMemoriesCount,
			},
			{
				table: "tasks",
				hostCount: tasks.length,
				componentCount: componentTasksCount,
				diff: tasks.length - componentTasksCount,
			},
			{
				table: "missions",
				hostCount: missions.length,
				componentCount: componentMissionsCount,
				diff: missions.length - componentMissionsCount,
			},
		];
	},
});
