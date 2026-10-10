import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { api } from "./_generated/api";
import {
	afterDeliveryWork,
	claimDeliveryStep,
	deliveryClaimValidator,
} from "./deliveryLedger";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { creatorValidator } from "./schema";
import {
	withOrgScope,
	requireOrchestratorOnRoster,
	filterByOrgScope,
	isRowVisibleToScope,
	requireScope,
} from "./lib/auth";
import type { OrgScope } from "./lib/auth";
import { isFleetSystemCaller } from "./lib/systemCaller";
import { requireId } from "./lib/ids";
import { resolveHumanActor } from "./lib/humanActor";
import {
	resolveVerifiedPerson,
	verifiedPersonValidator,
} from "./lib/personPrincipal";
import { clerkOrgIdForSlug } from "./lib/orgClerkId";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const missionStatusValidator = v.union(
	v.literal("brainstorm"),
	v.literal("plan"),
	v.literal("execute"),
	v.literal("validate"),
	v.literal("complete"),
	v.literal("cancelled"),
);

// Valid mission status values for runtime validation
const MISSION_STATUSES = [
	"brainstorm",
	"plan",
	"execute",
	"validate",
	"complete",
	"cancelled",
] as const;
type MissionStatus = (typeof MISSION_STATUSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Status alias expansion helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand a status arg (string | string[] | undefined) into a concrete array
 * of MissionStatus values. Handles aliases "open" and "active".
 *
 * - "open"   → ["brainstorm","plan","execute","validate"] (everything except complete)
 * - "active" → ["plan","execute"]
 * - array    → validated element by element; no alias mixing
 * - single   → validated enum value wrapped in array
 * - undefined → undefined (no filter)
 *
 * Throws ConvexError on unknown status values.
 */
function expandMissionStatuses(
	status: string | string[] | undefined,
): MissionStatus[] | undefined {
	if (status === undefined) return undefined;
	if (status === "all") return undefined;

	if (Array.isArray(status)) {
		const result: MissionStatus[] = [];
		for (const s of status) {
			if (s === "open" || s === "active" || s === "all") {
				throw new ConvexError(
					`invalid status: alias "${s}" is not allowed inside an array — use a direct string instead`,
				);
			}
			if (!MISSION_STATUSES.includes(s as MissionStatus)) {
				throw new ConvexError(`invalid status: "${s}"`);
			}
			result.push(s as MissionStatus);
		}
		return result;
	}

	// Single string
	if (status === "open") return ["brainstorm", "plan", "execute", "validate"];
	if (status === "active") return ["plan", "execute"];
	if (!MISSION_STATUSES.includes(status as MissionStatus)) {
		throw new ConvexError(`invalid status: "${status}"`);
	}
	return [status as MissionStatus];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lite projection helpers
// ─────────────────────────────────────────────────────────────────────────────

type MissionLite = {
	_id: string;
	_creationTime: number;
	name: string;
	status: MissionStatus;
	pilot: string;
	priority: "urgent" | "high" | "medium" | "low";
	project: string;
};

function projectMissionLite(doc: Record<string, unknown>): MissionLite {
	return {
		_id: doc._id as string,
		_creationTime: doc._creationTime as number,
		name: doc.name as string,
		status: doc.status as MissionStatus,
		pilot: doc.pilot as string,
		priority: doc.priority as "urgent" | "high" | "medium" | "low",
		project: doc.project as string,
	};
}

const priorityValidator = v.union(
	v.literal("urgent"),
	v.literal("high"),
	v.literal("medium"),
	v.literal("low"),
);

// ─────────────────────────────────────────────────────────────────────────────
// Org-scope owner enforcement (same defect class as convex/messages.ts's
// isOrchestratorAllowedForScope / convex/briefingNotes.ts's
// isOrgAllowedForScope — see
// .claude/rules/authority-attached-to-anonymous-object.md). create, update,
// updateStatus and updateProgress used to take NO caller-identity check at
// all: any caller holding the deployment URL could create a mission under
// any org, or reach into and mutate ANY org's mission.
//
// A mission's owner is its STORED `orgId` (Beta multi-tenant scope field —
// null/undefined = master/internal Alpha). Master scope (no identity with
// legacy opt-in, or the recognized service-account identity) retains
// unrestricted access. A Clerk-org-scoped caller may only act on a mission
// whose `orgId` equals its OWN resolved org slug; a mission with no `orgId`
// (master-created, legacy) is never visible/writable to an org caller.
// ─────────────────────────────────────────────────────────────────────────────

function isOrgAllowedForScope(
	scope: OrgScope,
	orgId: string | undefined,
): boolean {
	if (scope.isMaster) return true;
	if (scope.orgSlug === null) return false;
	return orgId === scope.orgSlug;
}

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new mission
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		name: v.string(),
		description: v.optional(v.string()),
		project: v.string(),
		status: missionStatusValidator,
		priority: priorityValidator,
		// pilot is required on BOTH paths (checked at runtime below): optional
		// only so the dashboard's human path shares one args shape.
		pilot: v.optional(creatorValidator),
		agents: v.array(v.string()),
		brief: v.optional(v.string()),
		startDate: v.optional(v.number()),
		targetDate: v.optional(v.number()),
		progress: v.optional(v.number()),
		// Absent = the HUMAN path (a dashboard org member acting in its own name).
		createdBy: v.optional(creatorValidator),
		// A person reached through the MCP service account (convex/lib/personPrincipal.ts).
		verifiedPerson: v.optional(verifiedPersonValidator),
	},
	returns: v.id("missions"),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("missions:create", …) at mcp-server/src/tools.ts:5473 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main 2498c00); never a subscribing pre-org client shell. The RBAC_DENIED throw is the R-16 coded refusal the MCP layer catches, not an uncaught Server Error.
		// Fail-closed multi-tenant fix — create used to insert with NO
		// identity/scope check at all (the `orgId` field simply was not set,
		// leaving every created mission unscoped). withOrgScope is called
		// WITHOUT allowNoIdentityMaster — the MCP server always presents a
		// real Clerk identity (its caller's own org JWT or its
		// service-account token). `orgId` is derived SOLELY from the
		// resolved scope, never a client-supplied argument (there is no
		// `orgId` in this mutation's args) — an org caller may create only
		// for an owner (org) inside its own scope, by construction.
		// The transport's own scope is bound first (the service account, or the
		// dashboard member); resolveVerifiedPerson returns it unchanged unless a
		// person is carried (convex/lib/personPrincipal.ts).
		const transportScope = await withOrgScope(ctx);
		const scope = await resolveVerifiedPerson(
			ctx,
			transportScope,
			args.verifiedPerson,
			{ door: "missions:create", assertedName: args.createdBy },
		);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not create a mission — ${JSON.stringify({ orgSlug: null })}`,
			);
		}
		// Acting identity and pilot derive from the verified caller: a member
		// may create only as, and assign the pilot role only to, an orchestrator
		// on its OWN resolved roster. Master unchanged.
		if (args.pilot === undefined) {
			throw new ConvexError(
				`PILOT_REQUIRED: a mission needs a pilot — ${JSON.stringify({ door: "missions:create" })}`,
			);
		}
		const {
			pilot,
			createdBy: claimedCreator,
			verifiedPerson: _verifiedPerson,
			...rest
		} = args;
		// HUMAN path (no createdBy): the actor is the verified Clerk subject, the
		// writer-role allowlist decides, createdBy/lastActedBy are "user:<subject>".
		// A client-supplied createdBy is never an identity on this path: with one
		// present the unchanged agent path below runs and the roster refuses any
		// name that is not an orchestrator of the caller's own org.
		const actor =
			claimedCreator === undefined
				? await resolveHumanActor(ctx, scope, { door: "missions:create" })
				: undefined;
		if (claimedCreator !== undefined) {
			requireOrchestratorOnRoster(scope, claimedCreator, "missions:create", "actor");
		}
		requireOrchestratorOnRoster(scope, pilot, "missions:create", "assignee");
		const now = Date.now();
		return await ctx.db.insert("missions", {
			...rest,
			pilot,
			createdBy: (claimedCreator ?? actor) as string,
			...(actor !== undefined ? { lastActedBy: actor } : {}),
			createdAt: now,
			updatedAt: now,
			orgId: scope.isMaster ? undefined : (scope.orgSlug as string),
			clerkOrgId: scope.isMaster
				? undefined
				: await clerkOrgIdForSlug(ctx, scope.orgSlug),
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single mission by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { missionId: v.string() },
	returns: v.union(
		v.object({
			_id: v.id("missions"),
			_creationTime: v.number(),
			name: v.string(),
			description: v.optional(v.string()),
			project: v.string(),
			status: missionStatusValidator,
			priority: priorityValidator,
			pilot: creatorValidator,
			agents: v.array(v.string()),
			brief: v.optional(v.string()),
			startDate: v.optional(v.number()),
			targetDate: v.optional(v.number()),
			progress: v.optional(v.number()),
			createdBy: creatorValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
			// PR #360 — Beta multi-tenant scope field. Optional so pre-PR #360 docs pass.
			orgId: v.optional(v.string()),
			clerkOrgId: v.optional(v.string()),
			// Day 157 — terminal cancelled status (see schema.ts).
			cancelledBy: v.optional(creatorValidator),
			cancelReason: v.optional(v.string()),
			// Admin CRUD B2 — human actor "user:<subject>" (memberActorOf).
			lastActedBy: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const missionId = requireId(
			ctx,
			"missions",
			args.missionId,
			"missionId",
			"Use the full 32-char missionId returned by list_missions or create_mission.",
		);
		const mission = await ctx.db.get(missionId);
		if (mission === null) return null;
		// RESOURCE-ID class — the authorisation is derived from the TARGET ROW's
		// own organisation (its `orgId`, falling back to the `pilot`-roster control
		// `runMissionsList` above already applies for rows that state none), never
		// from an argument and never from the mere existence of a caller
		// organisation. See isRowVisibleToScope in convex/lib/auth.ts.
		// refuseWithoutThrow: a reactively-subscribed public read refuses with a
		// typed null rather than a throw (R-50/R-51).
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (!isRowVisibleToScope(scope, mission)) return null;
		return mission;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list missions with optional filters (project, pilot, status)
//
// New in v1.1:
//   fields="lite" — compact projection: {_id,_creationTime,name,status,pilot,priority,project}
//   fields="full" (default) — full doc (backward-compatible)
//   status="open"    — expands to ["brainstorm","plan","execute","validate"]
//   status="active"  — expands to ["plan","execute"]
//   status=["plan","execute"] — multi-value array (no alias mixing)
// ─────────────────────────────────────────────────────────────────────────────

// updatedSince widened-scan fix (same defect class as #1110 on billing, and
// convex/tasks.ts `list`/`listByMission`): the filter used to run in-memory
// after a `.take(limit)` that had already bounded the page in creation-
// descending order — a mission updated recently but created outside that
// page was invisible while the response looked complete. When updatedSince
// is supplied, the per-branch fetch is widened to MISSION_LIST_SCAN_CAP + 1
// rows before the filter runs, then re-sliced to `limit`. If the widened
// scan itself hits its cap, we refuse to return a silently-incomplete page.
export const MISSION_LIST_SCAN_CAP = 2000;

interface MissionsListArgs {
	project?: string;
	pilot?: string;
	status?: string | string[];
	limit?: number;
	fields?: "lite" | "full";
	updatedSince?: number;
	createdBefore?: number;
}

// Internal mirror of `create` for the GitHub webhook's issues.opened cascade.
// The delivery claim is the FIRST write, and `create` then runs as a nested
// mutation in the SAME transaction: the claim and the mission commit together
// or not at all (a throw in `create` rolls the claim back too). null = this
// delivery step was already claimed (a redelivery or a concurrent duplicate).
export const createForWebhookDelivery = internalMutation({
	args: {
		delivery: deliveryClaimValidator,
		name: v.string(),
		project: v.string(),
		status: missionStatusValidator,
		priority: priorityValidator,
		pilot: creatorValidator,
		agents: v.array(v.string()),
		createdBy: creatorValidator,
	},
	returns: v.union(v.id("missions"), v.null()),
	handler: async (ctx, args): Promise<Id<"missions"> | null> => {
		const { delivery, ...mission } = args;
		if (!(await claimDeliveryStep(ctx, delivery))) return null;
		const id = await ctx.runMutation(api.missions.create, mission);
		afterDeliveryWork(delivery.deliveryId);
		return id;
	},
});

// Shared handler body for missions.list (public, org-scoped) and
// missions.listForWebhook (internal, master-scoped — SEC-AUDIT Day 156: the
// only genuine no-identity caller was convex/http.ts's GitHub webhook
// handler, itself gated by HMAC signature verification, not by Clerk
// identity. Splitting the caller lets the public surface go fail-closed
// (withOrgScope default) without breaking that internal, structurally
// unreachable-by-clients call site.
async function runMissionsList(
	ctx: QueryCtx,
	args: MissionsListArgs,
	scope: OrgScope,
) {
	requireScope(scope, "view-own-missions");

	const statuses = expandMissionStatuses(args.status);
	const lite = args.fields === "lite";
	const project = args.project;
	const pilot = args.pilot;
	const updatedSince = args.updatedSince;
	// v2.3.3 — auto-clamp limit when fields=full + no explicit limit
	const explicitLimit = args.limit !== undefined;
	let limit = args.limit ?? 50;
	if (!explicitLimit && !lite) {
		limit = 30;
		console.warn(
			`[missions.list] auto-clamp: limit=30 applied (fields=full, no explicit limit).`,
		);
	}
	const needsWideScan = updatedSince !== undefined;
	const fetchCap = needsWideScan ? MISSION_LIST_SCAN_CAP + 1 : limit;

	type MissionRow = Doc<"missions">;
	const applyStatusFilter = (rows: MissionRow[]) => {
		if (statuses === undefined) return rows;
		if (statuses.length === 1) return rows.filter((r) => r.status === statuses[0]);
		return rows.filter((r) => statuses.includes(r.status as MissionStatus));
	};

	let allRows: MissionRow[];
	const orgSlug = scope.orgSlug;

	// Guard: project + pilot together is NOT covered by any compound index.
	// The branches below pick ONE of {project, pilot} — silently combining
	// both without a matching index would risk applying only one filter
	// and returning a result silently broader than the question asked.
	// Refuse loudly instead (same class fix as convex/tasks.ts `list`).
	if (project !== undefined && pilot !== undefined) {
		throw new Error(
			`missions.list: project and pilot cannot be combined in a single call ` +
				`(received project="${project}" pilot="${pilot}"). ` +
				`Call list once per filter, or drop one of the two args.`,
		);
	}

	// NON-MASTER callers read through an ORG-KEYED index: the tenant predicate is
	// inside the query, so `take` pages the caller's OWN rows. The earlier shape
	// (fleet-wide take, then filterByOrgScope) consulted the grant AFTER the
	// read — a member whose missions sat behind `limit` newer rows of other
	// orgs was served [] (PR #1394 review). Rows with NO orgId never match
	// `eq("orgId", slug)`, so legacy rows are invisible to a member (the same
	// verdict filterByOrgScope's tenant gate gives); master still reads them.
	if (!scope.isMaster) {
		if (orgSlug === null) return [];
		// createdBefore (cursor anchor) is pushed INTO the index range so the
		// page is the next `limit` rows older than the anchor, not a short page.
		// No anchor = an upper bound no creation time can reach.
		const before = args.createdBefore ?? Number.MAX_VALUE;
		// [orgId, project|pilot, status, _creationTime]: a range on creation time
		// needs `status` pinned, so project/pilot without a status fan out over
		// every status and merge newest-first below.
		const statusList: (MissionStatus | undefined)[] =
			statuses !== undefined
				? (statuses as MissionStatus[])
				: project !== undefined || pilot !== undefined
					? [...MISSION_STATUSES]
					: [undefined];
		const perStatus = await Promise.all(
			statusList.map(async (status) => {
				const q = ctx.db.query("missions");
				if (project !== undefined) {
					return await q
						.withIndex("by_orgId_project_status", (i) => {
							return i
								.eq("orgId", orgSlug)
								.eq("project", project)
								.eq("status", status as MissionStatus)
								.lt("_creationTime", before);
						})
						.order("desc")
						.take(fetchCap);
				}
				if (pilot !== undefined) {
					return await q
						.withIndex("by_orgId_pilot_status", (i) => {
							return i
								.eq("orgId", orgSlug)
								.eq("pilot", pilot as MissionRow["pilot"])
								.eq("status", status as MissionStatus)
								.lt("_creationTime", before);
						})
						.order("desc")
						.take(fetchCap);
				}
				if (status !== undefined) {
					return await q
						.withIndex("by_orgId_status", (i) => {
							return i.eq("orgId", orgSlug).eq("status", status).lt("_creationTime", before);
						})
						.order("desc")
						.take(fetchCap);
				}
				const rows = await q
					.withIndex("by_orgId", (i) => {
						return i.eq("orgId", orgSlug).lt("_creationTime", before);
					})
					.order("desc")
					.take(fetchCap);
				return rows;
			}),
		);
		allRows = perStatus
			.flat()
			.sort((a, b) => b._creationTime - a._creationTime)
			.slice(0, fetchCap);
	}
	// Filter by project + single status — use compound index
	else if (project !== undefined && statuses !== undefined && statuses.length === 1) {
		allRows = await ctx.db
			.query("missions")
			.withIndex("by_project", (q) =>
				q.eq("project", project).eq("status", statuses[0]),
			)
			.order("desc")
			.take(fetchCap);
	}
	// Filter by project only (or project + multi-status filtered in-memory)
	else if (project !== undefined) {
		const base = await ctx.db
			.query("missions")
			.withIndex("by_project", (q) => q.eq("project", project))
			.order("desc")
			.take(fetchCap);
		allRows = applyStatusFilter(base);
	}
	// Filter by pilot + single status — use compound index
	else if (pilot !== undefined && statuses !== undefined && statuses.length === 1) {
		allRows = await ctx.db
			.query("missions")
			.withIndex("by_pilot", (q) =>
				q.eq("pilot", pilot as MissionRow["pilot"]).eq("status", statuses[0]),
			)
			.order("desc")
			.take(fetchCap);
	}
	// Filter by pilot only (or pilot + multi-status filtered in-memory)
	else if (pilot !== undefined) {
		const base = await ctx.db
			.query("missions")
			.withIndex("by_pilot", (q) => q.eq("pilot", pilot as MissionRow["pilot"]))
			.order("desc")
			.take(fetchCap);
		allRows = applyStatusFilter(base);
	}
	// Filter by status only
	else if (statuses !== undefined) {
		if (statuses.length === 1) {
			allRows = await ctx.db
				.query("missions")
				.withIndex("by_status", (q) => q.eq("status", statuses[0]))
				.order("desc")
				.take(fetchCap);
		} else {
			const base = await ctx.db.query("missions").order("desc").take(fetchCap);
			allRows = applyStatusFilter(base);
		}
	}
	// No filters — return all, newest first
	else {
		allRows = await ctx.db.query("missions").order("desc").take(fetchCap);
	}

	// Refuse to return a silently-incomplete page: if the widened scan
	// itself hit its cap, there may be matching rows we never looked at.
	// "I couldn't measure" must never render identically to "complete".
	// No branch here was measured to exceed the cap in production (unlike
	// tasks.list's assignedTo branches), so no index was added and the
	// fetch is still a fixed-size widened scan — "shrink the updatedSince
	// window" would be a false remedy and is left out of the message.
	if (needsWideScan && allRows.length > MISSION_LIST_SCAN_CAP) {
		throw new ConvexError(
			`missions.list: SCAN_CAP_EXCEEDED — widened scan for updatedSince hit the cap of ${MISSION_LIST_SCAN_CAP} candidate rows before the filter ran. The result would be incomplete and indistinguishable from a full match. Narrow with project/pilot/status.`,
		);
	}

	// v2.3.3 — updatedSince in-memory filter
	let filtered = allRows;
	if (updatedSince !== undefined) {
		filtered = filtered.filter((r) => (r.updatedAt ?? 0) >= updatedSince);
	}
	// Re-bound to the requested page size now that the filter has run over
	// the widened superset (no-op when a wide scan wasn't needed).
	filtered = filtered.slice(0, limit);
	// S3.3 B8 follow-up batch 1 — cursor paging anchor: drop rows newer-or-equal to before.
	if (args.createdBefore !== undefined) {
		const before = args.createdBefore;
		filtered = filtered.filter((r) => r._creationTime < before);
	}

	const scoped = filterByOrgScope(filtered, scope);
	if (lite) return scoped.map(projectMissionLite);
	return scoped;
}

const missionsListArgsValidator = {
	project: v.optional(v.string()),
	pilot: v.optional(creatorValidator),
	status: v.optional(v.union(v.string(), v.array(v.string()))),
	limit: v.optional(v.number()),
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
	updatedSince: v.optional(v.number()),
	// S3.3 B8 follow-up batch 1 — cursor paging anchor (forward, newest-first).
	createdBefore: v.optional(v.number()),
};

export const list = query({
	args: missionsListArgsValidator,
	// Returns validator omitted because union of full+lite produces overly strict types vs Doc<"missions"> optionality
	handler: async (ctx, args) => {
		// ── Beta multi-tenant scope gate — fail-closed default (SEC-AUDIT Day
		// 156): no Clerk identity is no longer master. The only legitimate
		// no-identity caller (GitHub webhook, HMAC-verified) uses
		// listForWebhook (internalQuery) below instead.
		// R-50: reactively-subscribed public query — refuseWithoutThrow
		// narrows the signed-in-no-org branch to a typed-empty result (the
		// pre-existing requireScope inside runMissionsList would otherwise
		// throw for that same caller).
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (scope.refused) return [];
		return await runMissionsList(ctx, args, scope);
	},
});

// Internal-only mirror of `list`, used exclusively by convex/http.ts's
// GitHub webhook handler (HMAC-signature-verified, not Clerk-identity
// gated). `internal.*` functions are never exposed to `api.*` clients — no
// MCP tool, dashboard route, or direct Convex client call can reach this,
// which is the structural (not disciplinary) guard SEC-AUDIT Day 156
// requires for a genuine internal-fleet-only surface.
export const listForWebhook = internalQuery({
	args: missionsListArgsValidator,
	handler: async (ctx, args) => {
		const masterScope: OrgScope = {
			userId: "internal-webhook",
			orgSlug: null,
			allowedOrchestrators: [],
			allowedAgentIds: [],
			fleetWide: true,
			scopes: [
				"cross-tenant-read",
				"view-own-tasks",
				"view-own-missions",
				"view-stats-aggregated",
				"view-orchestrator-summary",
			],
			isMaster: true,
			masterSource: "internal",
		};
		return await runMissionsList(ctx, args, masterScope);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of any mutable mission field
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		missionId: v.id("missions"),
		callerOrchestrator: v.optional(creatorValidator),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		project: v.optional(v.string()),
		status: v.optional(missionStatusValidator),
		priority: v.optional(priorityValidator),
		pilot: v.optional(creatorValidator),
		agents: v.optional(v.array(v.string())),
		brief: v.optional(v.string()),
		startDate: v.optional(v.number()),
		targetDate: v.optional(v.number()),
		progress: v.optional(v.number()),
		// Mandatory reason when status is being set to "cancelled" (Day 157).
		cancelReason: v.optional(v.string()),
		// A person reached through the MCP service account (convex/lib/personPrincipal.ts).
		verifiedPerson: v.optional(verifiedPersonValidator),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("missions:update", …) at mcp-server/src/tools.ts:5509 (imperative), never a subscribing pre-org client shell; the RBAC/org-keyed throw is an R-16 refusal the MCP layer catches, not an uncaught Server Error.
		const {
			missionId,
			callerOrchestrator,
			cancelReason,
			verifiedPerson,
			...fields
		} = args;

		// Fail-closed multi-tenant fix (same defect class as create above) —
		// update used to authorize on NOTHING outside the cancel branch (and
		// the cancel branch itself authorized solely on the client-supplied
		// callerOrchestrator argument): an anonymous caller (or a caller from
		// a DIFFERENT org) could patch any org's mission. withOrgScope is
		// called WITHOUT allowNoIdentityMaster for the same reason as
		// create: the MCP server always presents a real Clerk identity on
		// this path.
		//
		// Resolved BEFORE ctx.db.get(missionId) (mirrors convex/briefingNotes.ts
		// update/deleteBriefingNote, convex/messages.ts deleteMessage): an
		// anonymous caller must get RBAC_DENIED, never "Mission ... not
		// found" — a get-then-scope order lets missionId existence act as an
		// unauthenticated existence oracle.
		// The transport's own scope is bound first (the service account, or the
		// dashboard member); resolveVerifiedPerson returns it unchanged unless a
		// person is carried (convex/lib/personPrincipal.ts).
		const transportScope = await withOrgScope(ctx);
		const scope = await resolveVerifiedPerson(
			ctx,
			transportScope,
			verifiedPerson,
			{ door: "missions:update", assertedName: callerOrchestrator },
		);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update mission ${missionId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const mission = await ctx.db.get(missionId);
		if (mission === null) {
			throw new Error(`Mission ${missionId} not found`);
		}

		// `fields` never includes `orgId` (not part of this mutation's args
		// validator) — an org caller can never move a mission into another
		// org's scope via the patch; the org-scope check below binds ONLY to
		// the mission's STORED orgId, never anything caller-supplied.
		if (!isOrgAllowedForScope(scope, mission.orgId)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update mission ${missionId} (orgId "${mission.orgId ?? "none"}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		// HUMAN path: a non-master caller with no callerOrchestrator is a dashboard
		// org member acting in its own name. Writer role from the allowlist;
		// cancelling (and reopening a cancelled mission, which undoes a cancel)
		// is destructive and needs org:admin. Master / agent paths unchanged.
		const isCancel = fields.status === "cancelled";
		const humanActor =
			!scope.isMaster && callerOrchestrator === undefined
				? await resolveHumanActor(ctx, scope, {
						door: "missions:update",
						row: mission,
						rowKind: "mission",
						rowId: missionId,
						adminOnly:
							isCancel || (mission.status === "cancelled" && fields.status !== undefined),
					})
				: undefined;

		// A pilot reassignment must land on the caller's own roster — a member
		// cannot hand a mission to an orchestrator of another organisation.
		if (fields.pilot !== undefined) {
			requireOrchestratorOnRoster(scope, fields.pilot, "missions:update", "assignee");
		}

		// Build patch object with only provided fields
		const patch: Record<string, any> = { updatedAt: Date.now() };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}
		if (humanActor !== undefined) patch.lastActedBy = humanActor;

		// Day 157 — cancelled is a terminal status, settable only by the
		// mission's CREATOR, and requires a non-empty reason. Mirrors the
		// tasks.update cancel gate (convex/tasks.ts update).
		if (patch.status === "cancelled") {
			// MAJOR #4 (convex-reviewer REVISE) — mirrors the tasks.update guard:
			// a mission already closed as "complete" is terminal and cannot be
			// re-terminated as cancelled.
			if (mission.status === "complete") {
				throw new ConvexError(
					`CANNOT_CANCEL_DONE: mission ${missionId} is already complete — a completed mission cannot be cancelled — ${JSON.stringify({ missionId })}`,
				);
			}
			if (callerOrchestrator === undefined && humanActor === undefined) {
				throw new ConvexError(
					`RBAC_DENIED: callerOrchestrator is required to cancel mission ${missionId} — omitting it is refused, not exempted — ${JSON.stringify({ missionId })}`,
				);
			}
			// The human path replaced the creator-only rule with org:admin above
			// (resolveHumanActor adminOnly); the creator rule binds the agent path.
			if (
				callerOrchestrator !== undefined &&
				!isFleetSystemCaller(scope, callerOrchestrator) &&
				mission.createdBy !== callerOrchestrator
			) {
				throw new ConvexError(
					`RBAC_DENIED: Only ${mission.createdBy} (creator) or system can cancel mission ${missionId} — ${JSON.stringify({ caller: callerOrchestrator, creator: mission.createdBy, missionId })}`,
				);
			}
			if (!cancelReason || cancelReason.trim() === "") {
				throw new ConvexError(
					`CANCEL_REASON_REQUIRED: cancelReason is required to cancel mission ${missionId} — ${JSON.stringify({ missionId })}`,
				);
			}
			patch.cancelledBy = callerOrchestrator ?? humanActor;
			patch.cancelReason = cancelReason;
		}

		await ctx.db.patch(missionId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// updateStatus — shortcut: sets status + updatedAt
// ─────────────────────────────────────────────────────────────────────────────

export const updateStatus = mutation({
	args: {
		missionId: v.id("missions"),
		status: missionStatusValidator,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("missions:updateStatus", …) at mcp-server/src/tools.ts:5816 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main 2498c00); never a subscribing pre-org client shell. The RBAC_DENIED throw is the R-16 coded refusal the MCP layer catches, not an uncaught Server Error.
		// Fail-closed multi-tenant fix (same defect class and same fix as
		// `update` above) — updateStatus used to take NO caller-identity
		// check of any kind. Resolved BEFORE ctx.db.get for the same
		// existence-oracle reason documented on `update`.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update mission ${args.missionId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const mission = await ctx.db.get(args.missionId);
		if (mission === null) {
			throw new Error(`Mission ${args.missionId} not found`);
		}

		if (!isOrgAllowedForScope(scope, mission.orgId)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update mission ${args.missionId} (orgId "${mission.orgId ?? "none"}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		// HUMAN path: this door has no agent identity argument, so every
		// non-master caller is a dashboard org member — writer role required and
		// recorded. Cancelling is not done here (it needs a reason and org:admin:
		// use `update`), and a cancelled mission is reopened only by an admin.
		// Master unchanged.
		let humanActor: string | undefined;
		if (!scope.isMaster) {
			if (args.status === "cancelled") {
				throw new ConvexError(
					`CANCEL_REASON_REQUIRED: cancel a mission through missions:update with a cancelReason — ${JSON.stringify({ missionId: args.missionId })}`,
				);
			}
			humanActor = await resolveHumanActor(ctx, scope, {
				door: "missions:updateStatus",
				row: mission,
				rowKind: "mission",
				rowId: args.missionId,
				adminOnly: mission.status === "cancelled",
			});
		}
		await ctx.db.patch(args.missionId, {
			status: args.status,
			updatedAt: Date.now(),
			...(humanActor !== undefined ? { lastActedBy: humanActor } : {}),
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// updateProgress — shortcut: sets progress (0-100) + updatedAt
// ─────────────────────────────────────────────────────────────────────────────

export const updateProgress = mutation({
	args: {
		missionId: v.id("missions"),
		progress: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: no caller exists outside convex-test — measured 2026-10-01 at origin/main 2498c00 with `grep -rnE "updateProgress" /root/coding/vantage-peers-dashboard/{app,components,hooks,lib,contexts,providers} mcp-server/src --include=*.ts --include=*.tsx` (0 hits in the dashboard and mcp-server/src). A pre-organisation client shell cannot reach this write; the RBAC_DENIED throw below is the R-16 coded refusal of an unauthorised write, never an uncaught pre-org render crash.
		// Fail-closed multi-tenant fix (same defect class and same fix as
		// `update`/`updateStatus` above) — updateProgress used to take NO
		// caller-identity check of any kind. Resolved BEFORE ctx.db.get for
		// the same existence-oracle reason documented on `update`.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update mission ${args.missionId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const mission = await ctx.db.get(args.missionId);
		if (mission === null) {
			throw new Error(`Mission ${args.missionId} not found`);
		}

		if (!isOrgAllowedForScope(scope, mission.orgId)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update mission ${args.missionId} (orgId "${mission.orgId ?? "none"}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		// HUMAN path (see updateStatus): non-master = org member, writer role.
		const humanActor = !scope.isMaster
			? await resolveHumanActor(ctx, scope, {
					door: "missions:updateProgress",
					row: mission,
					rowKind: "mission",
					rowId: args.missionId,
				})
			: undefined;
		await ctx.db.patch(args.missionId, {
			progress: args.progress,
			updatedAt: Date.now(),
			...(humanActor !== undefined ? { lastActedBy: humanActor } : {}),
		});
		return null;
	},
});
