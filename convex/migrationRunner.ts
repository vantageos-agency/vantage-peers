import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Migration step registry
//
// Each entry defines one idempotent migration step that runs exactly once.
// Add new entries here as schema or data changes accumulate between releases.
// Version string must match the mcp-server/package.json version that ships
// the migration. Migrations run in order; already-applied versions are skipped.
//
// For v2.2.0: empty migration list — no-op on first deploy.
// Future entries follow this pattern:
//   { version: "2.3.0", description: "backfill X field on Y table", run: async (ctx) => { ... } }
// ─────────────────────────────────────────────────────────────────────────────

type MigrationStep = {
	version: string;
	description: string;
	run: (ctx: MutationCtx) => Promise<void>;
};

const MIGRATION_STEPS: MigrationStep[] = [
	// v2.2.0: baseline — no data migration required.
	// This entry bootstraps the vp_migrations table on first deploy.
	{
		version: "2.2.0",
		description: "baseline: vp_migrations table bootstrapped, no data changes",
		run: async (_ctx) => {
			// No-op: schema already ships with `vp_migrations` table.
		},
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// applyPendingMigrations — internalMutation, idempotent
//
// Called by the MCP server at startup (server-http.ts and server.ts) before
// serving any requests. Reads the vp_migrations table, compares applied versions
// against MIGRATION_STEPS, and runs any pending steps in order.
//
// Fail-fast: if a migration step throws, the error propagates to the caller.
// The MCP server must abort startup on migration failure — do NOT serve broken
// state to clients.
//
// Returns: { applied: number, current: string, alreadyApplied: string[] }
// ─────────────────────────────────────────────────────────────────────────────

export const applyPendingMigrations = internalMutation({
	args: {
		callerVersion: v.string(), // mcp-server package.json version (e.g. "2.2.0")
	},
	handler: async (ctx, args) => {
		// Load already-applied migration versions from DB
		const appliedRows = await ctx.db.query("vp_migrations").collect();
		const appliedVersions = new Set(appliedRows.map((r) => r.version));

		// Determine which steps still need to run (in order)
		const pending = MIGRATION_STEPS.filter(
			(step) => !appliedVersions.has(step.version),
		);

		const applied: string[] = [];

		for (const step of pending) {
			console.log(
				`[migrations] applying v${step.version}: ${step.description}`,
			);
			await step.run(ctx);
			await ctx.db.insert("vp_migrations", {
				version: step.version,
				appliedAt: Date.now(),
				description: step.description,
			});
			applied.push(step.version);
			console.log(`[migrations] v${step.version} applied OK`);
		}

		if (applied.length === 0) {
			console.log(
				`[migrations] already up-to-date at caller=${args.callerVersion}`,
			);
		}

		return {
			applied: applied.length,
			current: args.callerVersion,
			appliedVersions: applied,
			alreadyApplied: Array.from(appliedVersions),
		};
	},
});
