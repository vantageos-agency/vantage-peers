import { v } from "convex/values";
import { query } from "./_generated/server";
import {
	withOrgScope,
	filterByOrgScope,
	requireResolvedCaller,
	requireScope,
} from "./lib/auth";

// In-progress tasks and mandates are both small, bounded tables today; 500 rows
// is a comfortable ceiling well above observed volume for either.
const DASHBOARD_SCAN_CAP = 500;
// Message receipts and the tasks/missions full scans below are also small
// tables but can grow faster (one receipt per recipient per message), so a
// wider ceiling is used for those bounded scans.
const DASHBOARD_WIDE_SCAN_CAP = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// getDashboardSummary — high-level operational stats for VantagePeers dashboard
// Returns: tasks in progress, active orchestrator profiles, unread message count,
// open mandate count, and the 20 most recent cross-entity activity events.
// ─────────────────────────────────────────────────────────────────────────────

export const getDashboardSummary = query({
	args: {},
	returns: v.object({
		tasksInProgress: v.number(),
		activeOrchestrators: v.array(
			v.object({
				_id: v.id("profiles"),
				_creationTime: v.number(),
				orchestratorId: v.string(),
				instanceId: v.optional(v.string()),
				name: v.string(),
				static: v.object({
					role: v.string(),
					workspace: v.string(),
					capabilities: v.array(v.string()),
				}),
				dynamic: v.object({
					currentTask: v.optional(v.string()),
					lastSeen: v.number(),
					sessionCount: v.number(),
				}),
			}),
		),
		unreadMessages: v.number(),
		openMandates: v.number(),
		recentActivity: v.array(
			v.object({
				type: v.union(
					v.literal("task"),
					v.literal("message"),
					v.literal("mandate"),
				),
				id: v.string(),
				actor: v.string(),
				excerpt: v.string(),
				status: v.optional(v.string()),
				updatedAt: v.number(),
			}),
		),
	}),
	handler: async (ctx) => {
		// ── Beta multi-tenant scope gate ─────────────────────────────────────
		// Master scope: the whole fleet, unchanged.
		// Client org with view-stats-aggregated: ITS OWN TENANT ONLY — every
		// table read below is keyed on the caller's org (tenant index) or, where
		// a row carries only an orchestrator (profiles), narrowed to the org's
		// roster. `mandates` carries no tenant column (fleet-internal), so a
		// member is served none of it.
		// REFUSALS ARE CODED, NEVER ZEROED (.claude/rules/
		// refusal-is-distinguishable-from-absence.md): anonymous and
		// signed-in-no-org callers RAISE RBAC_DENIED (a zeroed aggregate is a
		// fabricated figure); the dashboard's route error boundary renders that
		// raise as a refusal (app/[locale]/dashboard/error.tsx). A member lacking
		// view-stats-aggregated is refused by requireScope below, same code.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "dashboard:getDashboardSummary", {
			alsoRefusePreOrg: true,
		});
		if (!scope.isMaster) {
			requireScope(scope, "view-stats-aggregated");
		}
		const orgSlug = scope.orgSlug;

		// Tasks in progress — uses index, bounded
		const inProgressTasksAll = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", "in_progress"))
			.take(DASHBOARD_SCAN_CAP);
		const inProgressTasks = filterByOrgScope(inProgressTasksAll, scope);

		// Open mandates — fleet-internal, no tenant column: master only. A member
		// has no mandates of its own, so 0 is the count of ITS data, not a refusal.
		const allMandates = scope.isMaster
			? await ctx.db.query("mandates").take(DASHBOARD_SCAN_CAP)
			: [];
		const openMandates = allMandates.filter((m) => m.status !== "settled").length;

		// Profiles (small table — one row per instance). No tenant column: a
		// member is narrowed to its org's roster.
		const allProfiles = await ctx.db.query("profiles").collect();
		const profiles = scope.isMaster
			? allProfiles
			: allProfiles.filter((p) => scope.allowedOrchestrators.includes(p.orchestratorId));

		// Unread messages — full scan bounded (receipts table is small)
		// Index is composite [recipient, readAt] so we cannot filter by readAt alone.
		// Member: the tenant index is bound BEFORE the cap, never a post-read filter.
		const allReceipts =
			scope.isMaster || orgSlug === null
				? await ctx.db.query("messageReceipts").take(DASHBOARD_WIDE_SCAN_CAP)
				: await ctx.db
						.query("messageReceipts")
						.withIndex("by_tenant", (q) => q.eq("tenantId", orgSlug))
						.take(DASHBOARD_WIDE_SCAN_CAP);
		const unreadMessages = allReceipts.filter((r) => r.readAt === undefined).length;

		// Recent activity — fetch bounded slices of each entity
		// Fetch more tasks before filtering so client-orgs still get 20 items.
		const recentTasksAll = await ctx.db.query("tasks").order("desc").take(100);
		const recentTasks = filterByOrgScope(recentTasksAll, scope).slice(0, 20);
		const recentMessages =
			scope.isMaster || orgSlug === null
				? await ctx.db.query("messages").order("desc").take(20)
				: await ctx.db
						.query("messages")
						.withIndex("by_tenant_created", (q) => q.eq("tenantId", orgSlug))
						.order("desc")
						.take(20);
		const recentMandates = scope.isMaster
			? await ctx.db.query("mandates").order("desc").take(20)
			: [];

		type ActivityEvent = {
			type: "task" | "message" | "mandate";
			id: string;
			actor: string;
			excerpt: string;
			status?: string;
			updatedAt: number;
		};

		const events: ActivityEvent[] = [
			...recentTasks.map((t) => ({
				type: "task" as const,
				id: t._id as string,
				actor: t.assignedTo,
				excerpt: t.title,
				status: t.status,
				updatedAt: t.updatedAt,
			})),
			...recentMessages.map((m) => ({
				type: "message" as const,
				id: m._id as string,
				actor: m.from,
				excerpt: m.content.slice(0, 80),
				updatedAt: m.createdAt,
			})),
			...recentMandates.map((m) => ({
				type: "mandate" as const,
				id: m._id as string,
				actor: m.requestedBy,
				excerpt: m.service.slice(0, 50),
				status: m.status,
				updatedAt: m.updatedAt,
			})),
		];

		events.sort((a, b) => b.updatedAt - a.updatedAt);

		return {
			tasksInProgress: inProgressTasks.length,
			activeOrchestrators: profiles,
			unreadMessages,
			openMandates,
			recentActivity: events.slice(0, 20),
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getProjectSummary — per-project task breakdown + mission counts
// Returns one entry per unique project name found across tasks and missions.
// ─────────────────────────────────────────────────────────────────────────────

const projectSummaryObject = v.object({
	name: v.string(),
	missionCount: v.number(),
	tasksByStatus: v.object({
		todo: v.number(),
		in_progress: v.number(),
		review: v.number(),
		blocked: v.number(),
		done: v.number(),
	}),
	activeOrchestrators: v.array(v.string()),
});

export const getProjectSummary = query({
	args: {},
	// Bare array for a served caller (rows or a genuine absence); the typed
	// refusal envelope for a signed-in caller with no organisation (the
	// dashboard reads `.items` via readList — never the bytes of an absence).
	returns: v.union(
		v.array(projectSummaryObject),
		v.object({ refused: v.literal(true), items: v.array(projectSummaryObject) }),
	),
	handler: async (ctx) => {
		// ── Beta multi-tenant scope gate ─────────────────────────────────────
		// R-50: reactively-subscribed public query — see getDashboardSummary
		// above for the typed-empty-not-throw rationale.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		// Anonymous RAISES (no mounted render). Signed-in-no-org is a mounted,
		// subscribed render: typed envelope, never a bare [] (an absence's bytes).
		requireResolvedCaller(scope, "dashboard:getProjectSummary");
		if (scope.refused) {
			return { refused: true as const, items: [] };
		}
		if (!scope.isMaster) {
			requireScope(scope, "view-stats-aggregated");
		}

		const allTasks = await ctx.db.query("tasks").take(DASHBOARD_WIDE_SCAN_CAP);
		const allMissions = await ctx.db
			.query("missions")
			.take(DASHBOARD_WIDE_SCAN_CAP);
		const tasks = filterByOrgScope(allTasks, scope);
		const missions = filterByOrgScope(allMissions, scope);

		const projectNames = new Set<string>();
		for (const t of tasks) {
			if (t.project !== undefined) projectNames.add(t.project);
		}
		for (const m of missions) {
			if (m.project !== undefined) projectNames.add(m.project);
		}

		return Array.from(projectNames).map((project) => {
			const projectTasks = tasks.filter((t) => t.project === project);
			const projectMissions = missions.filter((m) => m.project === project);

			return {
				name: project,
				missionCount: projectMissions.length,
				tasksByStatus: {
					todo: projectTasks.filter((t) => t.status === "todo").length,
					in_progress: projectTasks.filter((t) => t.status === "in_progress").length,
					review: projectTasks.filter((t) => t.status === "review").length,
					blocked: projectTasks.filter((t) => t.status === "blocked").length,
					done: projectTasks.filter((t) => t.status === "done").length,
				},
				activeOrchestrators: [
					...new Set(
						projectTasks
							.filter((t) => t.status !== "done")
							.map((t) => t.assignedTo),
					),
				],
			};
		});
	},
});
