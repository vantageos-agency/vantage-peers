import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";
import { withOrgScope } from "./lib/auth";
import type { OrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed multi-tenant fix (defect class: authority attached to an
// anonymously-registered object — see
// .claude/rules/authority-attached-to-anonymous-object.md). upsert,
// softDelete and instantiateTemplateIntoMission used to take NO
// caller-identity check of any kind: any caller holding the deployment URL
// could rewrite or delete the FLEET-WIDE shared template catalog (the
// `missionTemplates` table carries no `orgId` — it is a single global set
// of reusable blueprints, e.g. "issue-resolution-v2", keyed by fleet
// orchestrator name — see convex/schema.ts's missionTemplates doc comment),
// or fan out tasks into ANY org's mission.
//
// upsert/softDelete manage the SHARED catalog itself: a write here changes
// behaviour for every org that later instantiates the template, so — same
// as the MCP server's own pre-existing `soft_delete_mission_template`
// tool-guard (`{ kind: "master" }`, mcp-server/src/tools.ts) — both are
// restricted to the verified MASTER scope only. Per
// .claude/rules/http-boundary-derives-from-principal.md's sibling doctrine
// ("a guard in the MCP server is NOT a defence"), Convex re-derives and
// re-enforces this independently: the fleet's own orchestrators (alpha,
// proxima, ...) all authenticate to Convex through the MCP server's ONE
// shared service-account identity, which always resolves to
// `scope.isMaster === true` (convex/lib/auth.ts's
// CLERK_SERVICE_ACCOUNT_USER_ID carve-out) — so this is byte-behaviour-
// unchanged for that live path and closes the door for anyone else holding
// the deployment URL directly.
//
// instantiateTemplateIntoMission READS the shared (unscoped) template
// catalog but WRITES tasks into a caller-supplied, org-scoped `missionId` —
// so unlike upsert/softDelete it is not master-restricted (Beta org
// clients legitimately use it against their OWN missions, mirroring the
// MCP tool's "filtered", not master-only, guard kind). Authority is
// derived from the TARGET MISSION's stored `orgId` against the caller's
// verified scope (same isOrgAllowedForScope shape as convex/missions.ts
// and convex/briefingNotes.ts), never from a caller-supplied argument.
// ─────────────────────────────────────────────────────────────────────────────

function isMissionAllowedForScope(
	scope: OrgScope,
	orgId: string | undefined,
): boolean {
	if (scope.isMaster) return true;
	if (scope.orgSlug === null) return false;
	return orgId === scope.orgSlug;
}

// missionTemplates is a small, curated table (one row per named template);
// 1000 is a generous ceiling well above any realistic template count.
const MISSION_TEMPLATES_SCAN_CAP = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Shared validator for a single template step
// ─────────────────────────────────────────────────────────────────────────────

const stepValidator = v.object({
	title: v.string(),
	description: v.string(),
	tags: v.optional(v.array(v.string())),
	assignedTo: v.optional(v.string()),
	assignedToInstance: v.optional(v.string()),
	dependsOn: v.optional(v.array(v.number())),
});

const templateDocValidator = v.object({
	_id: v.id("missionTemplates"),
	_creationTime: v.number(),
	name: v.string(),
	description: v.optional(v.string()),
	brief: v.optional(v.string()),
	steps: v.array(stepValidator),
	isDefault: v.boolean(),
	createdBy: creatorValidator,
	createdAt: v.number(),
	updatedAt: v.number(),
	deletedAt: v.optional(v.number()),
});

// ─────────────────────────────────────────────────────────────────────────────
// getByName — fetch a template by its unique name
// ─────────────────────────────────────────────────────────────────────────────

export const getByName = query({
	args: { name: v.string() },
	returns: v.union(templateDocValidator, v.null()),
	handler: async (ctx, args) => {
		const template = await ctx.db
			.query("missionTemplates")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.unique();
		// Soft-deleted templates are invisible to reads, like a superseded memory.
		if (template !== null && template.deletedAt !== undefined) {
			return null;
		}
		return template;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listNames — the live source of truth for "which template names exist".
//
// Root cause this closes (Day 159): the mission-template guard hook
// (enforce-mission-template.py) can only be as good as the source it probes.
// Without a query exposing the LIVE table, the only sources available were a
// hardcoded whitelist or a cached/static manifest file — both drift the moment
// a new template is upserted (e.g. orchestrator-config-update-v1), refusing a
// template that genuinely exists. This query IS the live source: wire
// MISSION_TEMPLATE_PROBE_CMD at each station to a command that calls it, so
// the guard always interrogates the real table instead of a stale copy.
//
// Mirrors getByName's soft-delete convention: a template with deletedAt set is
// invisible, exactly like a superseded memory.
// ─────────────────────────────────────────────────────────────────────────────

export const listNames = query({
	args: {},
	returns: v.array(v.string()),
	handler: async (ctx) => {
		const templates = await ctx.db
			.query("missionTemplates")
			.take(MISSION_TEMPLATES_SCAN_CAP);
		return templates
			.filter((t) => t.deletedAt === undefined)
			.map((t) => t.name);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// upsert — create or update a template by name
// ─────────────────────────────────────────────────────────────────────────────

export const upsert = mutation({
	args: {
		name: v.string(),
		description: v.optional(v.string()),
		brief: v.optional(v.string()),
		steps: v.array(stepValidator),
		isDefault: v.optional(v.boolean()),
		createdBy: creatorValidator,
	},
	returns: v.id("missionTemplates"),
	handler: async (ctx, args) => {
		// Master-only fail-closed fix — see the file-header comment block
		// above for the full rationale (shared, unscoped catalog write).
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster) {
			throw new ConvexError(
				"RBAC_DENIED: update_mission_template is a master-only operation — the mission-template catalog is shared fleet-wide, never per-org",
			);
		}

		const now = Date.now();
		const existing = await ctx.db
			.query("missionTemplates")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.unique();

		if (existing !== null) {
			await ctx.db.patch(existing._id, {
				description: args.description,
				brief: args.brief ?? existing.brief,
				steps: args.steps,
				isDefault: args.isDefault ?? existing.isDefault,
				updatedAt: now,
			});
			return existing._id;
		}

		return await ctx.db.insert("missionTemplates", {
			name: args.name,
			description: args.description,
			brief: args.brief,
			steps: args.steps,
			isDefault: args.isDefault ?? false,
			createdBy: args.createdBy,
			createdAt: now,
			updatedAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// softDelete — marks a mission template as no longer active (audit-preserving)
// Mirrors memories.softDeleteMemory's motif: PATCH a flag rather than hard
// `ctx.db.delete`, so the row (and its history) survives for audit. Templates
// carry no RAG entries, so only the flag-patch half of that motif applies.
// ─────────────────────────────────────────────────────────────────────────────

export const softDelete = mutation({
	args: {
		templateId: v.optional(v.id("missionTemplates")),
		name: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Master-only fail-closed fix — see the file-header comment block
		// above for the full rationale (shared, unscoped catalog write).
		// Mirrors the MCP server's own pre-existing `guardMasterOnly` gate on
		// this same tool (soft_delete_mission_template).
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster) {
			throw new ConvexError(
				"RBAC_DENIED: soft_delete_mission_template is a master-only operation — the mission-template catalog is shared fleet-wide, never per-org",
			);
		}

		if (args.templateId === undefined && args.name === undefined) {
			throw new Error("Provide either templateId or name");
		}

		const template = args.templateId
			? await ctx.db.get(args.templateId)
			: await ctx.db
					.query("missionTemplates")
					.withIndex("by_name", (q) => q.eq("name", args.name as string))
					.unique();

		if (template === null || template === undefined) {
			const ref = args.templateId ?? args.name;
			throw new Error(`Mission template ${ref} not found`);
		}

		await ctx.db.patch(template._id, {
			deletedAt: Date.now(),
			updatedAt: Date.now(),
		});

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// seed — internal mutation that seeds the "issue-resolution-v2" template
// Call once during initial deployment or via npx convex run missionTemplates:seed
// ─────────────────────────────────────────────────────────────────────────────

export const seed = internalMutation({
	args: {},
	returns: v.id("missionTemplates"),
	handler: async (ctx) => {
		const now = Date.now();
		const name = "issue-resolution-v3";

		const steps = [
			{
				title: "Acknowledge",
				description:
					"Auto-posted GitHub comment confirming receipt and assignment of the issue to the AI orchestrator.",
				tags: ["automated", "github"],
			},
			{
				title: "KB Search",
				description:
					'Search fixPatterns and episodes for similar issues using recall queries. Run: recall query="[issue keywords]" and recall query="[error message]". If match found: document which fix pattern applies in completionNote. If no match: document "No prior pattern found". completionNote is MANDATORY before proceeding.',
				tags: ["research", "kb"],
			},
			{
				title: "Identify & Run Tests",
				description:
					"Grep test suites related to the affected component. Run identified tests and document PASS/FAIL. If the issue involves an external API: run REAL integration tests with actual API calls, not just unit tests.",
				tags: ["testing", "analysis"],
			},
			{
				title: "Write Missing Tests",
				description:
					'Write a test that reproduces the bug. The test MUST FAIL against the current code (this proves the bug exists). Commit the failing test. completionNote MUST contain "X tests FAIL" as proof.',
				tags: ["testing", "tdd"],
			},
			{
				title: "Fix",
				description:
					'Delegate the fix to the appropriate specialist agent. The test written in T3 MUST PASS after the fix is applied. No fix is accepted if the T3 test still fails. completionNote MUST contain "X tests PASS (including regression test)" as proof.',
				tags: ["implementation"],
			},
			{
				title: "Run ALL Tests",
				description:
					"Run the full test suite. Zero regressions are acceptable. Document any failures and resolve them before proceeding.",
				tags: ["testing", "qa"],
			},
			{
				title: "Deploy Dev + Push",
				description:
					"Run `npx convex dev --once` to verify Convex compilation. Push to upstream (NOT origin/fork): `git push upstream fix/issue-{number}`. Then IMMEDIATELY create a PR: `gh pr create --repo {repo} --base main --head fix/issue-{number} --title 'Fix #{number}: ...' --body '...'`. The PR is MANDATORY — never push without creating a PR in the same step.",
				tags: ["deployment", "ci"],
			},
			{
				title: "Verification Preview",
				description:
					"Test the fix on the preview deployment. Confirm the original issue is resolved. Request human confirmation before closing.",
				tags: ["verification", "human-review"],
			},
			{
				title: "Code Review",
				description:
					"Run the code-reviewer agent on the diff. Address all blocking feedback. Document the review outcome and any changes made. Update KB: store the fix pattern in VantagePeers fixPatterns table.",
				tags: ["review", "quality"],
			},
		];

		const existing = await ctx.db
			.query("missionTemplates")
			.withIndex("by_name", (q) => q.eq("name", name))
			.unique();

		if (existing !== null) {
			await ctx.db.patch(existing._id, {
				steps,
				description:
					"Issue Resolution Protocol v3 — 9-step structured process (T0-T8) for investigating, fixing, and documenting GitHub issues.",
				isDefault: true,
				updatedAt: now,
			});
			return existing._id;
		}

		return await ctx.db.insert("missionTemplates", {
			name,
			description:
				"Issue Resolution Protocol v3 — 9-step structured process (T0-T8) for investigating, fixing, and documenting GitHub issues.",
			steps,
			isDefault: true,
			createdBy: "system",
			createdAt: now,
			updatedAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// instantiateTemplateIntoMission
//
// Creates N tasks from a mission template in one call, one task per step.
// Each task is pre-assigned to the step's declared orchestrator (assignedTo),
// falling back to mission.pilot when the step has none.
//
// After all tasks are inserted (pass 1), a second pass resolves dependsOn
// step-indexes to actual task IDs and patches each dependent task.
// ─────────────────────────────────────────────────────────────────────────────

export const instantiateTemplateIntoMission = mutation({
	args: {
		templateName: v.string(),
		missionId: v.id("missions"),
		context: v.optional(v.record(v.string(), v.string())),
		titlePrefix: v.optional(v.string()),
		callerOrchestrator: v.optional(v.string()),
	},
	returns: v.object({
		taskIds: v.array(v.id("tasks")),
		count: v.number(),
	}),
	handler: async (ctx, args) => {
		// Fail-closed multi-tenant fix — see the file-header comment block
		// above for the full rationale. Resolved BEFORE either fetch below
		// (mirrors convex/missions.ts update / convex/briefingNotes.ts
		// update): an anonymous caller must get RBAC_DENIED, never "Mission
		// not found" — a get-then-scope order lets missionId existence act
		// as an unauthenticated existence oracle.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not instantiate a mission template — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		// 1. Fetch template
		const template = await ctx.db
			.query("missionTemplates")
			.withIndex("by_name", (q) => q.eq("name", args.templateName))
			.unique();
		// A soft-deleted template is invisible to reads, like a superseded memory.
		if (!template || template.deletedAt !== undefined) {
			throw new Error(`Template not found: "${args.templateName}"`);
		}

		// 2. Fetch mission
		const mission = await ctx.db.get(args.missionId);
		if (!mission) {
			throw new Error(`Mission not found: ${args.missionId}`);
		}

		// The template catalog is shared/global (no orgId to check), but the
		// TARGET MISSION is org-scoped — a caller may only fan tasks out
		// into its OWN org's mission, never a foreign org's, regardless of
		// which (shared) template name it names.
		if (!isMissionAllowedForScope(scope, mission.orgId)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not instantiate a template into mission ${args.missionId} (orgId "${mission.orgId ?? "none"}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		const now = Date.now();
		const createdBy = args.callerOrchestrator ?? "system";

		// Copy the template's brief onto the mission ONLY when the mission
		// doesn't already carry one. Instance-specific fields supplied by the
		// caller at mission creation (pilot, project, name, dates, ...) are
		// never touched here — this patches `brief` alone.
		if (template.brief !== undefined && mission.brief === undefined) {
			await ctx.db.patch(args.missionId, {
				brief: template.brief,
				updatedAt: now,
			});
		}

		// Helper: simple {{key}} interpolation
		const contextMap = args.context;
		function interpolate(text: string): string {
			if (!contextMap) return text;
			return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
				const val = contextMap[key];
				return val !== undefined ? val : match;
			});
		}

		// Pass 1: insert all tasks, record ids by step index
		const taskIds: Array<string & { __tableName: "tasks" }> = [];

		for (const step of template.steps) {
			const title = args.titlePrefix
				? `${args.titlePrefix} ${step.title}`
				: step.title;

			const taskId = await ctx.db.insert("tasks", {
				title,
				description: interpolate(step.description),
				tags: step.tags,
				assignedTo: step.assignedTo ?? mission.pilot,
				assignedToInstance: step.assignedToInstance,
				missionId: args.missionId,
				project: mission.project,
				status: "todo",
				priority: mission.priority,
				createdBy,
				createdAt: now,
				updatedAt: now,
			});
			taskIds.push(taskId);
		}

		// Pass 2: resolve dependsOn indexes → task ids
		for (let i = 0; i < template.steps.length; i++) {
			const step = template.steps[i];
			if (!step.dependsOn || step.dependsOn.length === 0) continue;

			for (const depIndex of step.dependsOn) {
				if (depIndex < 0 || depIndex >= taskIds.length) {
					throw new Error(
						`Step ${i} has dependsOn index ${depIndex} which is out of range (template has ${taskIds.length} steps)`,
					);
				}
			}

			const resolvedDeps = step.dependsOn.map((idx) => taskIds[idx]);
			await ctx.db.patch(taskIds[i], { dependsOn: resolvedDeps });
		}

		return { taskIds, count: taskIds.length };
	},
});
