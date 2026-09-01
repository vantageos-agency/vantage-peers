import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, internalMutation, internalQuery, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { creatorValidator, taskOriginValidator } from "./schema";
import {
	withOrgScope,
	filterByOrgScope,
	requireScope,
	requireAgentCredentialMatch,
} from "./lib/auth";
import type { OrgScope } from "./lib/auth";
import { requireId } from "./lib/ids";
import { enforceClosureGate } from "./lib/taskClosureGate";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

// Open string — any orchestrator name accepted (issue #132)
const assigneeValidator = v.string();

const priorityValidator = v.union(
	v.literal("urgent"),
	v.literal("high"),
	v.literal("medium"),
	v.literal("low"),
);

const statusValidator = v.union(
	v.literal("todo"),
	v.literal("in_progress"),
	v.literal("review"),
	v.literal("blocked"),
	v.literal("done"),
	v.literal("cancelled"),
	// T1 — see convex/schema.ts:status for the full rationale.
	v.literal("failed"),
);

// Valid task status values for runtime validation
const TASK_STATUSES = [
	"todo",
	"in_progress",
	"review",
	"blocked",
	"done",
	"cancelled",
	"failed",
] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];

// T1 — the structured outcome discriminator (see convex/schema.ts:
// completionOutcome for the full rationale). Never accepted as a public
// mutation arg on `complete` or `failTask` — each hardcodes its own value,
// so there is no validator for a caller-supplied outcome to satisfy.
export type CompletionOutcome = "succeeded" | "failed";

// deriveTerminalStatus — PURE function, completionOutcome -> status. The
// only place a terminal status string is produced from an outcome. Neither
// `complete` nor `failTask` writes `status` as an independent literal;
// both call this against a hardcoded outcome.
export function deriveTerminalStatus(
	outcome: CompletionOutcome,
): "done" | "failed" {
	return outcome === "succeeded" ? "done" : "failed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Status alias expansion helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand a status arg (string | string[] | undefined) into a concrete array
 * of TaskStatus values. Handles aliases "open" and "active".
 *
 * - "open"   → ["todo","in_progress","review","blocked"] (everything except done)
 * - "active" → ["todo","in_progress"]
 * - array    → validated element by element; no alias mixing (conservative choice)
 * - single   → validated enum value wrapped in array
 * - undefined → undefined (no filter)
 *
 * Throws ConvexError on unknown status values.
 */

// ─────────────────────────────────────────────────────────────────────────────
// assertTaskCallerAuthorized — resource-derived ownership gate, shared by
// update/complete/start. Authorization is derived from the TARGET task
// (createdBy/assignedTo), never from the caller's own claim alone.
//
// Cross-tenant fix (S0 campaign k17b9z5yjgd8301r6dfawefpzs8b3a03): the prior
// shape wrapped the entire check in `if (callerOrchestrator !== undefined)`,
// so omitting the argument skipped verification instead of failing it — the
// omission deleted the control rather than degrading it. Omitting the caller
// now REFUSES (RBAC_DENIED), it never bypasses. "system" and matching
// creator/assignee still pass unconditionally (regression-proofed by tests).
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// requireAuthenticatedCaller — SECURITY REMEDIATION (task
// k1712yrxjr570m6ks81rnhjh5n8cryf0, ruled by Pi). Closes the open door: none
// of the nine public task mutations consulted ctx.auth before this — any
// caller holding the deployment URL could invoke create/update/blockTask/
// complete/failTask/start/checkout/deleteTask/bulkComplete by simply
// asserting a `callerOrchestrator` string, with zero identity verification.
//
// CORE-A (closes the door): every public task mutation now requires a
// verified Convex/Clerk identity. `ctx.auth.getUserIdentity() === null` is
// refused unconditionally — no exception path.
//
// STEP 3 finding (for Pi): the verified identity yields `.subject` (Clerk
// user id) and an org claim (organizationId/organizationSlug — see
// convex/lib/auth.ts withOrgScope). It does NOT yield a single orchestrator
// name (sigma/eta/...): the MCP server's non-browser path authenticates as
// ONE SHARED service-account identity for every orchestrator (see
// CLERK_SERVICE_ACCOUNT_USER_ID carve-out in withOrgScope), and a client org
// maps to a LIST of allowedOrchestrators, not a single name. An orchestrator
// name is therefore NOT individually derivable from the JWT alone today.
// Comparing `callerOrchestrator` against a single "derived actor" name would
// be vacuous, so this function instead checks MEMBERSHIP of the asserted
// name in the scope's `allowedOrchestrators` list (or a master/service-
// account bypass) — that IS what's derivable. Closing the sigma-vs-eta gap
// requires a per-orchestrator claim upstream (a Clerk JWT template / custom
// claim); flagged to Pi as a FINDING, not fabricated here.
//
// STEP 4 semantics (Pi's exact three-way rule, applied against what's
// actually derivable):
//   Agreeing:      callerOrchestrator is in scope.allowedOrchestrators (or
//                  scope.isMaster) -> pass.
//   Contradicting: callerOrchestrator is supplied and is NOT in the derived
//                  scope's allowed set -> explicit refusal naming BOTH the
//                  asserted name and the derived scope (allowedOrchestrators
//                  + orgSlug).
//   Absent:        no callerOrchestrator supplied -> the derived scope
//                  stands alone (membership check skipped; CORE-A above
//                  still required an identity to exist at all).
// ─────────────────────────────────────────────────────────────────────────────
async function requireAuthenticatedCaller(
	ctx: MutationCtx,
	callerOrchestrator: string | undefined,
	agentCredentialSecret?: string,
): Promise<OrgScope> {
	const identity = await ctx.auth.getUserIdentity();
	if (identity === null) {
		throw new ConvexError(
			`AUTH_REQUIRED: no verified identity on this call — an unauthenticated caller cannot mutate tasks — ${JSON.stringify({ callerOrchestrator: callerOrchestrator ?? null })}`,
		);
	}

	// withOrgScope re-derives the same identity into an OrgScope (org lookup,
	// service-account carve-out, fail-closed default). Explicitly opt OUT of
	// allowNoIdentityMaster here — CORE-A already proved an identity exists,
	// but this call site must never silently upgrade a no-identity call to
	// master; that fail-open path is reserved for pre-audited internal call
	// sites (see convex/lib/auth.ts doc comment), not this public surface.
	const scope = await withOrgScope(ctx, { allowNoIdentityMaster: false });

	// [P-T5] THE LOCK — when a per-agent credential is presented, the
	// asserted `callerOrchestrator` MUST equal the agent identity the
	// credential resolves to (see requireAgentCredentialMatch). No-op when
	// the secret is omitted — pre-P-T5 callers are byte-unchanged.
	// [Pi ruling k1746tn3jy22k0jphbx48vzmvd8d0y50] ORG BIND: `scope.orgSlug`
	// (just derived above, never re-derived) is threaded through as the
	// operation's target org — a same-named agent credential from a
	// DIFFERENT organisation is refused (ORG_MISMATCH) even though the name
	// matches.
	await requireAgentCredentialMatch(
		ctx,
		agentCredentialSecret,
		callerOrchestrator,
		scope.orgSlug,
	);

	// LIMIT of this reconciliation (containment scope only — removed by T2
	// k172bccwcqajfetcrmm5wtasps8cs7tc when single-actor equality lands): it
	// refuses a callerOrchestrator that falls OUTSIDE the org's allowed list,
	// but it does NOT distinguish one orchestrator from another INSIDE that
	// list. On the MCP path the shared service account resolves
	// allowedOrchestrators ["*"] + isMaster, so every in-org name passes this
	// check. Membership ≠ single-actor identity; the equality gate is T2's job.
	if (
		callerOrchestrator !== undefined &&
		!scope.isMaster &&
		!scope.allowedOrchestrators.includes(callerOrchestrator)
	) {
		throw new ConvexError(
			`CALLER_IDENTITY_MISMATCH: asserted callerOrchestrator "${callerOrchestrator}" is outside the authenticated org's allowed-orchestrator list — this compares an ASSERTED name against the org's allowlist (org=${scope.orgSlug ?? "none"} allows ${JSON.stringify(scope.allowedOrchestrators)}); it does NOT verify the caller IS any particular orchestrator inside that list — ${JSON.stringify({ asserted: callerOrchestrator, derivedAllowedOrchestrators: scope.allowedOrchestrators, orgSlug: scope.orgSlug })}`,
		);
	}

	return scope;
}

// computeIsReviewTask — title/tags heuristic, evaluated ONCE at CREATE time and
// frozen into the immutable `isReviewTask` field (below). A task counts as a review
// task when its title is tagged "[REVIEW]"/"[Review]" OR its tags array includes
// "review". This is NEVER read at authorization time — see isReviewTask (Eta REVISE
// #1254): title and tags are patchable through `update`, so a caller who is currently
// the assignee could stamp review-ness onto any task it holds, hand it away, and keep
// the authority it should have lost at handoff (derive-never-type: authorization must
// not be decided by a caller-supplied, post-create-mutable value).
function computeIsReviewTask(title: string, tags?: string[]): boolean {
	return /^\[review\]/i.test(title) || (tags?.includes("review") ?? false);
}

// isReviewTask — the authorization predicate gating the reviewer-reclaim branch
// (task k17e1ar4s7pspb0rs74ms25hmd8dhv01). Reads ONLY the immutable `isReviewTask`
// field stamped at create — `update` cannot patch it, so review-ness cannot be forged
// after the fact to retain authority through a handoff (Eta REVISE #1254). A row
// created before this field exists has `isReviewTask === undefined` and cannot be
// reclaimed — correct for an authorization field: no row silently inherits a right.
function isReviewTask(task: { isReviewTask?: boolean }): boolean {
	return task.isReviewTask === true;
}

function assertTaskCallerAuthorized(
	task: {
		createdBy: string;
		assignedTo?: string;
		lastAssignedTo?: string;
		isReviewTask?: boolean;
	},
	callerOrchestrator: string | undefined,
	taskId: string,
): void {
	if (callerOrchestrator === undefined) {
		throw new ConvexError(
			`RBAC_DENIED: callerOrchestrator is required — omitting it is refused, not exempted — ${JSON.stringify({ taskId })}`,
		);
	}
	// Reviewer-reclaim (k17e1ar4s7pspb0rs74ms25hmd8dhv01) — narrowly scoped
	// THIRD branch: the caller is neither creator nor current assignee, but
	// IS the immediately PRIOR assignee of a REVIEW task (decided from the
	// lastAssignedTo field, never from history). This closes the
	// no-blocked-limbo doctrine's reclaim gap (a reviewer that reassigned a
	// [REVIEW] task to its author could never take it back) WITHOUT widening
	// authorization on non-review tasks — a prior assignee of a plain task
	// remains refused, same as before this branch existed.
	const isReviewerReclaim =
		isReviewTask(task) && task.lastAssignedTo === callerOrchestrator;
	const isAuthorized =
		task.createdBy === callerOrchestrator ||
		task.assignedTo === callerOrchestrator ||
		callerOrchestrator === "system" ||
		isReviewerReclaim;
	if (!isAuthorized) {
		throw new ConvexError(
			`RBAC_DENIED: ${callerOrchestrator} is not creator or assignee of task ${taskId} — ${JSON.stringify({ caller: callerOrchestrator, taskId })}`,
		);
	}
}

function expandTaskStatuses(
	status: string | string[] | undefined,
): TaskStatus[] | undefined {
	if (status === undefined) return undefined;
	if (status === "all") return undefined;

	if (Array.isArray(status)) {
		const result: TaskStatus[] = [];
		for (const s of status) {
			if (s === "open" || s === "active" || s === "all") {
				throw new ConvexError(
					`invalid status: alias "${s}" is not allowed inside an array — use a direct string instead`,
				);
			}
			if (!TASK_STATUSES.includes(s as TaskStatus)) {
				throw new ConvexError(`invalid status: "${s}"`);
			}
			result.push(s as TaskStatus);
		}
		return result;
	}

	// Single string
	if (status === "open") return ["todo", "in_progress", "review", "blocked"];
	if (status === "active") return ["todo", "in_progress"];
	if (!TASK_STATUSES.includes(status as TaskStatus)) {
		throw new ConvexError(`invalid status: "${status}"`);
	}
	return [status as TaskStatus];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lite projection helpers
// ─────────────────────────────────────────────────────────────────────────────

const taskFullValidator = v.object({
	_id: v.id("tasks"),
	_creationTime: v.number(),
	title: v.string(),
	description: v.optional(v.string()),
	project: v.optional(v.string()),
	tags: v.optional(v.array(v.string())),
	assignedTo: assigneeValidator,
	priority: priorityValidator,
	status: statusValidator,
	completionNote: v.optional(v.string()),
	assignedToInstance: v.optional(v.string()),
	claimedByInstance: v.optional(v.string()),
	dependsOn: v.optional(v.array(v.id("tasks"))),
	missionId: v.optional(v.id("missions")),
	estimatedMinutes: v.optional(v.number()),
	actualMinutes: v.optional(v.number()),
	startedAt: v.optional(v.number()),
	completedAt: v.optional(v.number()),
	dueDate: v.optional(v.number()),
	createdBy: creatorValidator,
	createdAt: v.number(),
	updatedAt: v.number(),
	// PR #360 — Beta multi-tenant scope field. Optional so pre-PR #360 docs pass.
	orgId: v.optional(v.string()),
	// Day 130 follow-up #2 — inforgeable automation signal (see schema.ts).
	origin: v.optional(taskOriginValidator),
	// Day 157 — terminal cancelled status (see schema.ts).
	cancelledBy: v.optional(creatorValidator),
	cancelReason: v.optional(v.string()),
	// Day 159 — block_task commitment fields (see schema.ts:293,298).
	blockedOnTaskId: v.optional(v.id("tasks")),
	blockedOnNobodyReason: v.optional(v.string()),
	// T1 — see convex/schema.ts:blockedCause for the full rationale.
	blockedCause: v.optional(
		v.union(
			v.literal("peer_task"),
			v.literal("human"),
			v.literal("authorisation"),
			v.literal("other"),
		),
	),
	// T1 — see convex/schema.ts:completionOutcome for the full rationale.
	completionOutcome: v.optional(
		v.union(v.literal("succeeded"), v.literal("failed")),
	),
	// Task k1798y530ytkgsd7259nj2heb58cszv4 — see convex/schema.ts:
	// reviewArtifactRef for the full rationale. Written only by
	// attachReviewArtifact, never by `update`.
	reviewArtifactRef: v.optional(v.string()),
	reviewArtifactAttachedBy: v.optional(creatorValidator),
	lastAssignedTo: v.optional(v.string()),
	isReviewTask: v.optional(v.boolean()), // create-time review-ness, immutable (Eta REVISE #1254)
	// R-18 import idempotency key; only OKF-imported rows carry it.
	contentHash: v.optional(v.string()),
});

type TaskLite = {
	_id: string;
	_creationTime: number;
	title: string;
	status: TaskStatus;
	priority: "urgent" | "high" | "medium" | "low";
	assignedTo: string;
	missionId?: string;
};

function projectTaskLite(doc: Record<string, unknown>): TaskLite {
	return {
		_id: doc._id as string,
		_creationTime: doc._creationTime as number,
		title: doc.title as string,
		status: doc.status as TaskStatus,
		priority: doc.priority as "urgent" | "high" | "medium" | "low",
		assignedTo: doc.assignedTo as string,
		...(doc.missionId !== undefined
			? { missionId: doc.missionId as string }
			: {}),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new task
// ─────────────────────────────────────────────────────────────────────────────

const createTaskArgsValidator = {
	title: v.string(),
	description: v.optional(v.string()),
	project: v.optional(v.string()),
	tags: v.optional(v.array(v.string())),
	assignedTo: assigneeValidator,
	assignedToInstance: v.optional(v.string()),
	priority: priorityValidator,
	status: statusValidator,
	dependsOn: v.optional(v.array(v.id("tasks"))),
	missionId: v.optional(v.id("missions")),
	estimatedMinutes: v.optional(v.number()),
	dueDate: v.optional(v.number()),
	createdBy: creatorValidator,
};

// [P-T5] THE LOCK — optional per-agent credential secret, public `create`
// only (never `createForWebhook`, which is HMAC-gated and has no orchestrator
// identity to lock at all). See requireAgentCredentialMatch: presenting it
// requires `createdBy` to equal the resolved agent identity, no-op if
// omitted.
const createTaskArgsValidatorWithCredential = {
	...createTaskArgsValidator,
	agentCredentialSecret: v.optional(v.string()),
};

interface CreateTaskArgs {
	title: string;
	description?: string;
	project?: string;
	tags?: string[];
	assignedTo: string;
	assignedToInstance?: string;
	priority: "urgent" | "high" | "medium" | "low";
	status: TaskStatus;
	dependsOn?: Array<import("./_generated/dataModel").Id<"tasks">>;
	missionId?: import("./_generated/dataModel").Id<"missions">;
	estimatedMinutes?: number;
	dueDate?: number;
	createdBy: string;
}

// Shared insert body for `create` (public, identity-gated) and
// `createForWebhook` (internal, HMAC-gated — see below). Splitting the
// caller keeps the public surface requiring a verified identity without
// breaking the GitHub webhook's structurally unreachable-by-clients path.
async function insertTask(
	ctx: MutationCtx,
	args: CreateTaskArgs,
): Promise<import("./_generated/dataModel").Id<"tasks">> {
	// Day 130 follow-up #2 (Eta REVISE, PR #1089) — the closure-gate
	// exemption is NOT driven by `createdBy` (see taskClosureGate.ts):
	// it reads `origin`, which this public mutation never accepts as an
	// arg and never writes — only the internal webhook path
	// (createOrUpdateReviewTask) can write it. `createdBy: "system"` is
	// intentionally still accepted here because it is used elsewhere in
	// this codebase as a plain non-billing convention (RBAC-bypass
	// semantics on update/complete/bulkComplete/start/deleteTask, and as
	// a generic creator string in stats/bridge-automation flows) — see
	// convex/__tests__/tasksMutationConvexErrors.test.ts and
	// convex/stats.test.ts. An earlier attempt to reject it outright
	// here regressed 44 pre-existing tests; that reservation attempt
	// was scoped back out. The billing-bypass vulnerability itself is
	// fully closed by the `origin`-based gate, independent of this
	// value.
	const now = Date.now();
	return await ctx.db.insert("tasks", {
		...args,
		// Stamp review-ness ONCE at create from the title/tags, into an immutable field
		// `update` cannot patch (Eta REVISE #1254) — the reviewer-reclaim authorization
		// reads this, never the mutable title/tags.
		isReviewTask: computeIsReviewTask(args.title, args.tags),
		createdAt: now,
		updatedAt: now,
	});
}

export const create = mutation({
	args: createTaskArgsValidatorWithCredential,
	returns: v.id("tasks"),
	handler: async (ctx, args) => {
		const { agentCredentialSecret, ...taskArgs } = args;
		// SECURITY REMEDIATION (task k1712yrxjr570m6ks81rnhjh5n8cryf0) — this
		// is the PUBLIC client-facing path; it now requires a verified
		// identity. See requireAuthenticatedCaller for the full rationale.
		await requireAuthenticatedCaller(
			ctx,
			args.createdBy,
			agentCredentialSecret,
		);
		return await insertTask(ctx, taskArgs);
	},
});

// Internal-only mirror of `create`, used exclusively by convex/http.ts's
// GitHub webhook handler (HMAC-signature-verified, not Clerk-identity
// gated — same split as `list`/`listForWebhook` above). `internal.*`
// functions are never exposed to `api.*` clients — no MCP tool, dashboard
// route, or direct Convex client call can reach this.
export const createForWebhook = internalMutation({
	args: createTaskArgsValidator,
	returns: v.id("tasks"),
	handler: async (ctx, args) => {
		return await insertTask(ctx, args);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single task by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { taskId: v.id("tasks") },
	returns: v.union(
		v.object({
			_id: v.id("tasks"),
			_creationTime: v.number(),
			title: v.string(),
			description: v.optional(v.string()),
			project: v.optional(v.string()),
			tags: v.optional(v.array(v.string())),
			assignedTo: assigneeValidator,
			priority: priorityValidator,
			status: statusValidator,
			completionNote: v.optional(v.string()),
			assignedToInstance: v.optional(v.string()),
			claimedByInstance: v.optional(v.string()),
			dependsOn: v.optional(v.array(v.id("tasks"))),
			missionId: v.optional(v.id("missions")),
			estimatedMinutes: v.optional(v.number()),
			actualMinutes: v.optional(v.number()),
			startedAt: v.optional(v.number()),
			completedAt: v.optional(v.number()),
			dueDate: v.optional(v.number()),
			createdBy: creatorValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
			// PR #360 — Beta multi-tenant scope field. Optional so pre-PR #360 docs pass.
			orgId: v.optional(v.string()),
			// Day 130 follow-up #2 — inforgeable automation signal (see schema.ts).
			origin: v.optional(taskOriginValidator),
			// Day 157 — terminal cancelled status (see schema.ts).
			cancelledBy: v.optional(creatorValidator),
			cancelReason: v.optional(v.string()),
			// Day 159 — block_task commitment fields (see schema.ts:293,298).
			blockedOnTaskId: v.optional(v.id("tasks")),
			blockedOnNobodyReason: v.optional(v.string()),
			// T1 — see convex/schema.ts:blockedCause for the full rationale.
			blockedCause: v.optional(
				v.union(
					v.literal("peer_task"),
					v.literal("human"),
					v.literal("authorisation"),
					v.literal("other"),
				),
			),
			completionOutcome: v.optional(
				v.union(v.literal("succeeded"), v.literal("failed")),
			),
			// Task k1798y530ytkgsd7259nj2heb58cszv4 — see convex/schema.ts:
			// reviewArtifactRef for the full rationale.
			reviewArtifactRef: v.optional(v.string()),
			reviewArtifactAttachedBy: v.optional(creatorValidator),
			lastAssignedTo: v.optional(v.string()),
			isReviewTask: v.optional(v.boolean()), // create-time review-ness, immutable (Eta REVISE #1254)
			// R-18 import idempotency key; only OKF-imported rows carry it.
			contentHash: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.taskId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getById — alias of get, exposed for /api/eta/verify-publish-token HTTP action
// (Feature D spec requirement, hook v1.2.0).
// ─────────────────────────────────────────────────────────────────────────────
export const getById = query({
	// Accept a raw string, not `v.id("tasks")`: the v.id() validator runs BEFORE
	// the handler, so a wrong-table ID is rejected with a message Convex redacts
	// in prod (`Server Error`, `error.data` undefined — measured). Narrowing
	// inside the handler via requireId() throws a ConvexError whose payload
	// survives redaction. Same contract as PR #1069 (markAsRead), on a read.
	args: { taskId: v.string() },
	returns: v.union(
		v.object({
			_id: v.id("tasks"),
			_creationTime: v.number(),
			title: v.string(),
			description: v.optional(v.string()),
			project: v.optional(v.string()),
			tags: v.optional(v.array(v.string())),
			assignedTo: assigneeValidator,
			priority: priorityValidator,
			status: statusValidator,
			completionNote: v.optional(v.string()),
			assignedToInstance: v.optional(v.string()),
			claimedByInstance: v.optional(v.string()),
			dependsOn: v.optional(v.array(v.id("tasks"))),
			missionId: v.optional(v.id("missions")),
			estimatedMinutes: v.optional(v.number()),
			actualMinutes: v.optional(v.number()),
			startedAt: v.optional(v.number()),
			completedAt: v.optional(v.number()),
			dueDate: v.optional(v.number()),
			createdBy: creatorValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
			// PR #360 — Beta multi-tenant scope field. Optional so pre-PR #360 docs pass.
			orgId: v.optional(v.string()),
			// Day 130 follow-up #2 — inforgeable automation signal (see schema.ts).
			origin: v.optional(taskOriginValidator),
			// Day 157 — terminal cancelled status (see schema.ts).
			cancelledBy: v.optional(creatorValidator),
			cancelReason: v.optional(v.string()),
			// Day 159 — block_task commitment fields (see schema.ts:293,298).
			blockedOnTaskId: v.optional(v.id("tasks")),
			blockedOnNobodyReason: v.optional(v.string()),
			// T1 — see convex/schema.ts:blockedCause for the full rationale.
			blockedCause: v.optional(
				v.union(
					v.literal("peer_task"),
					v.literal("human"),
					v.literal("authorisation"),
					v.literal("other"),
				),
			),
			completionOutcome: v.optional(
				v.union(v.literal("succeeded"), v.literal("failed")),
			),
			// Task k1798y530ytkgsd7259nj2heb58cszv4 — see convex/schema.ts:
			// reviewArtifactRef for the full rationale.
			reviewArtifactRef: v.optional(v.string()),
			reviewArtifactAttachedBy: v.optional(creatorValidator),
			lastAssignedTo: v.optional(v.string()),
			isReviewTask: v.optional(v.boolean()), // create-time review-ness, immutable (Eta REVISE #1254)
			// R-18 import idempotency key; only OKF-imported rows carry it.
			contentHash: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const taskId = requireId(
			ctx,
			"tasks",
			args.taskId,
			"taskId",
			"Use the full 32-char taskId returned by list_tasks or create_task.",
		);
		// A well-formed tasks ID pointing at a deleted doc stays a null return.
		return await ctx.db.get(taskId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list tasks with optional filters (assignedTo, status, project)
//
// New in v1.1:
//   fields="lite" — compact projection: {_id,_creationTime,title,status,priority,assignedTo,missionId}
//   fields="full" (default) — full doc (current behavior, backward-compatible)
//   status="open"    — expands to ["todo","in_progress","review","blocked"]
//   status="active"  — expands to ["todo","in_progress"]
//   status=["todo","in_progress"] — multi-value array (no alias mixing)
//
// updatedSince/createdBy widened-scan fix (same defect class as #1110 on
// billing): these two filters used to be applied IN-MEMORY after a
// `.take(limit)` that had already bounded the page in creation-descending
// order — so a row updated recently but created outside that page was
// invisible, while the response looked like a complete list. When either
// filter is supplied, the per-branch fetch is widened to
// TASK_LIST_SCAN_CAP + 1 rows BEFORE the filter runs, then re-sliced to
// `limit` afterwards. If even the widened scan hits its cap, we refuse to
// return a silently-incomplete page — see the SCAN_CAP_EXCEEDED throw below.
// ─────────────────────────────────────────────────────────────────────────────

export const TASK_LIST_SCAN_CAP = 2000;

const tasksListArgsValidator = {
	assignedTo: v.optional(assigneeValidator),
	assignedToInstance: v.optional(v.string()),
	status: v.optional(v.union(v.string(), v.array(v.string()))),
	project: v.optional(v.string()),
	limit: v.optional(v.number()),
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
	createdBy: v.optional(creatorValidator),
	updatedSince: v.optional(v.number()),
	// S3.3 B8 — cursor paging anchor. When provided, rows with
	// _creationTime >= createdBefore are filtered out (newest-first
	// forward pagination). Used by MCP list_* cursor layer.
	createdBefore: v.optional(v.number()),
	// PR-E — cron-spam filter. When true, excludes tasks that are
	// auto-generated by the scheduler:
	//   - createdBy matches /^cron-/i  (dash required; "cronus"/"cron" not filtered)
	//   - title    matches /^\/?check-messages$/i  (exact whole-string)
	// Filter is applied in-memory after page-fetch but before cursor anchor +
	// envelope assembly. Trade-off: filtered-out rows do NOT count toward the
	// limit, so the post-filter page may be smaller than `limit`. Acceptable
	// for this use case: cron catalog is small and the filter is narrowly targeted.
	excludeAutoGenerated: v.optional(v.boolean()),
	// Dashboard B1 — priority filter. When provided, only tasks with the given
	// priority are returned (in-memory filter after page-fetch).
	priority: v.optional(priorityValidator),
	// Dashboard B1 — orgId passthrough. Accepted and ignored at the query layer;
	// multi-tenant scoping is handled server-side by withOrgScope (Clerk JWT).
	// Accepting the field prevents ArgumentValidationError when the dashboard
	// passes orgId from useActiveOrg().
	orgId: v.optional(v.string()),
};

interface TasksListArgs {
	assignedTo?: string;
	assignedToInstance?: string;
	status?: string | string[];
	project?: string;
	limit?: number;
	fields?: "lite" | "full";
	createdBy?: string;
	updatedSince?: number;
	createdBefore?: number;
	excludeAutoGenerated?: boolean;
	priority?: "urgent" | "high" | "medium" | "low";
	orgId?: string;
}

// Shared handler body for tasks.list (public, org-scoped) and
// tasks.listForWebhook (internal, master-scoped — SEC-AUDIT Day 156: the
// only genuine no-identity caller was convex/http.ts's GitHub webhook
// handler, itself gated by HMAC signature verification, not by Clerk
// identity). Splitting the caller lets the public surface go fail-closed
// (withOrgScope default) without breaking that internal, structurally
// unreachable-by-clients call site.
async function runTasksList(ctx: QueryCtx, args: TasksListArgs, scope: OrgScope) {
	requireScope(scope, "view-own-tasks");

	const statuses = expandTaskStatuses(args.status);
		const lite = args.fields === "lite";
		// v2.3.3 — auto-clamp limit when fields=full + no explicit limit (overflow protection)
		const explicitLimit = args.limit !== undefined;
		let limit = args.limit ?? 50;
		if (!explicitLimit && !lite) {
			limit = 30;
			console.warn(
				`[tasks.list] auto-clamp: limit=30 applied (fields=full, no explicit limit). Pass fields="lite" or explicit limit to override.`,
			);
		}
		// Capture to local consts so TypeScript narrows inside closures without assertions
		const assignedToInstance = args.assignedToInstance;
		const assignedTo = args.assignedTo;
		const project = args.project;
		const createdBy = args.createdBy;
		const updatedSince = args.updatedSince;
		const priorityFilter = args.priority;
		const before = args.createdBefore;

		// Day 163 (Pi, k171rbm2txe42jxzddyqakbg7n8ch7zr) — `createdBefore` was
		// OMITTED here. On a cursor-only call fetchCap collapsed to `limit`,
		// so the DB fetched only the `limit` NEWEST rows, then the cursor
		// filter below dropped every one of them (they are all >= the
		// cursor anchor by construction) → an empty page while older rows
		// that should have been page 2 were never fetched. Empty read as
		// end-of-list; callers silently truncated. `createdBefore` is now
		// included so pagination widens the same as createdBy/updatedSince,
		// and is loud (SCAN_CAP_EXCEEDED) rather than silent when it can't
		// see far enough. See per-branch index-push below for the unbounded
		// fix on the common single-status paths.
		//
		// Eta REVISE on PR #1194 @147d260 — a second, independent defect on
		// this same line: `needsWideScan` also has to widen whenever a
		// multi-status (or no-status) filter will be applied POST-fetch on a
		// branch that queries through a compound index ending in `status`
		// (by_assignee, by_project, by_instance, by_assignee_project,
		// by_instance_project…). With only the equality prefix (e.g.
		// assignedTo) pinned, Convex orders the remaining rows by the
		// index's NEXT field first — `status` — then `_creationTime`, NOT by
		// `_creationTime` alone. A narrow `.take(limit)` on that ordering
		// grabs `limit` rows skewed toward one status bucket, never the
		// `limit` most-recent of the STATUS-FILTERED UNION — reproduced by
		// Eta firsthand: 12 alternating todo/in_progress tasks, cursor walk
		// status=["todo","in_progress"] limit=5 saw 7/12 (page 1 was all
		// "todo"; the 5 true union-newest — mixed todo/in_progress — were
		// never fetched). This is independent of cursor presence — the same
		// wrong 5 rows come back on a plain first call, no cursor involved.
		// Multi-status/no-status branches now always widen; single-status
		// branches are untouched (Eta confirmed `canPushCursorIntoIndex`
		// correct as-is).
		const needsWideScan =
			createdBy !== undefined ||
			updatedSince !== undefined ||
			before !== undefined ||
			statuses === undefined ||
			statuses.length > 1;
		const fetchCap = needsWideScan ? TASK_LIST_SCAN_CAP + 1 : limit;

		// Preferred fix (Pi): push the cursor bound into the index RANGE
		// instead of filtering in-memory. Every Convex index implicitly ends
		// with `_creationTime`, so once all explicit index fields are pinned
		// by equality (single-status branches), `.lt("_creationTime", before)`
		// is a valid additional range clause — unbounded, no SCAN_CAP
		// dependency. Only usable when `updatedSince` is absent (that filter
		// already occupies the one allowed range slot on the assignedTo
		// branch) and exactly one status is pinned (multi-status / no-status
		// branches don't fully consume the index's equality prefix, so the
		// next index field isn't `_creationTime`).
		const canPushCursorIntoIndex =
			before !== undefined &&
			updatedSince === undefined &&
			statuses !== undefined &&
			statuses.length === 1;

		// Helper: apply multi-status in-memory filter on a pre-fetched slice
		type TaskRow = Doc<"tasks">;
		const applyStatusFilter = (rows: TaskRow[]) => {
			if (statuses === undefined) return rows;
			if (statuses.length === 1)
				return rows.filter((r) => r.status === statuses[0]);
			return rows.filter((r) => statuses.includes(r.status));
		};

		let allRows: TaskRow[];
		// Set true only when the assignedTo/assignedTo+status branch below pushed
		// the `updatedSince` bound into the query via a compound index. Drives
		// the SCAN_CAP_EXCEEDED message: "shrink the window" is only offered
		// when it can actually change the candidate count.
		let usedIndexedUpdatedSinceBound = false;

		// ── Guard: mutually-exclusive index-backed filters ────────────────────────
		// assignedToInstance and assignedTo are both index-backed but there is no
		// compound index covering both together (and combining them via post-filter
		// would risk the same silent-narrowing-that-looks-complete failure mode
		// this fix closes). Refuse loudly rather than silently pick one side.
		if (assignedToInstance !== undefined && assignedTo !== undefined) {
			throw new Error(
				`tasks.list: assignedToInstance and assignedTo cannot be combined in a single call ` +
					`(received assignedToInstance="${assignedToInstance}" assignedTo="${assignedTo}"). ` +
					`Call list once per filter, or drop one of the two args.`,
			);
		}

		// Filter by instance + project together — matching compound index,
		// so BOTH filters are applied, never one silently dropped.
		if (assignedToInstance !== undefined && project !== undefined) {
			if (statuses !== undefined && statuses.length === 1) {
				allRows = await ctx.db
					.query("tasks")
					.withIndex("by_instance_project", (q) => {
						const base = q
							.eq("assignedToInstance", assignedToInstance)
							.eq("project", project)
							.eq("status", statuses[0]);
						return canPushCursorIntoIndex
							? base.lt("_creationTime", before as number)
							: base;
					})
					.order("desc")
					.take(canPushCursorIntoIndex ? limit : fetchCap);
			} else {
				const base = await ctx.db
					.query("tasks")
					.withIndex("by_instance_project", (q) =>
						q.eq("assignedToInstance", assignedToInstance).eq("project", project),
					)
					.order("desc")
					.take(fetchCap);
				allRows = applyStatusFilter(base);
			}
		}
		// Filter by instance only — use index for primary key, then filter statuses in-memory
		else if (assignedToInstance !== undefined) {
			if (statuses !== undefined && statuses.length === 1) {
				allRows = await ctx.db
					.query("tasks")
					.withIndex("by_instance", (q) => {
						const base = q
							.eq("assignedToInstance", assignedToInstance)
							.eq("status", statuses[0]);
						return canPushCursorIntoIndex
							? base.lt("_creationTime", before as number)
							: base;
					})
					.order("desc")
					.take(canPushCursorIntoIndex ? limit : fetchCap);
			} else {
				const base = await ctx.db
					.query("tasks")
					.withIndex("by_instance", (q) =>
						q.eq("assignedToInstance", assignedToInstance),
					)
					.order("desc")
					.take(fetchCap);
				allRows = applyStatusFilter(base);
			}
		}
		// Filter by assignee + project together — matching compound index,
		// so BOTH filters are applied, never one silently dropped.
		else if (assignedTo !== undefined && project !== undefined) {
			if (statuses !== undefined && statuses.length === 1) {
				allRows = await ctx.db
					.query("tasks")
					.withIndex("by_assignee_project", (q) => {
						const base = q
							.eq("assignedTo", assignedTo)
							.eq("project", project)
							.eq("status", statuses[0]);
						return canPushCursorIntoIndex
							? base.lt("_creationTime", before as number)
							: base;
					})
					.order("desc")
					.take(canPushCursorIntoIndex ? limit : fetchCap);
			} else {
				const base = await ctx.db
					.query("tasks")
					.withIndex("by_assignee_project", (q) =>
						q.eq("assignedTo", assignedTo).eq("project", project),
					)
					.order("desc")
					.take(fetchCap);
				allRows = applyStatusFilter(base);
			}
		}
		// Filter by assignee only — the two branches measured to blow the
		// widened-scan cap in production. When `updatedSince` is supplied, push
		// the bound into the query via a compound index ending in `updatedAt`
		// (by_assignee_updatedAt / by_assignee_status_updatedAt) instead of
		// fetching a fixed-size window and filtering in-memory: narrowing the
		// window now actually reduces the rows the DB has to examine, and the
		// scan cap applies to the true matching population, not a widened
		// superset. createdBy (unindexed) is still applied in-memory below.
		else if (assignedTo !== undefined) {
			if (updatedSince !== undefined) {
				usedIndexedUpdatedSinceBound = true;
				if (statuses !== undefined && statuses.length === 1) {
					allRows = await ctx.db
						.query("tasks")
						.withIndex("by_assignee_status_updatedAt", (q) =>
							q
								.eq("assignedTo", assignedTo)
								.eq("status", statuses[0])
								.gte("updatedAt", updatedSince),
						)
						.order("desc")
						.take(TASK_LIST_SCAN_CAP + 1);
				} else {
					const base = await ctx.db
						.query("tasks")
						.withIndex("by_assignee_updatedAt", (q) =>
							q.eq("assignedTo", assignedTo).gte("updatedAt", updatedSince),
						)
						.order("desc")
						.take(TASK_LIST_SCAN_CAP + 1);
					allRows = applyStatusFilter(base);
				}
			} else if (statuses !== undefined && statuses.length === 1) {
				allRows = await ctx.db
					.query("tasks")
					.withIndex("by_assignee", (q) => {
						const base = q.eq("assignedTo", assignedTo).eq("status", statuses[0]);
						return canPushCursorIntoIndex
							? base.lt("_creationTime", before as number)
							: base;
					})
					.order("desc")
					.take(canPushCursorIntoIndex ? limit : fetchCap);
			} else {
				const base = await ctx.db
					.query("tasks")
					.withIndex("by_assignee", (q) => q.eq("assignedTo", assignedTo))
					.order("desc")
					.take(fetchCap);
				allRows = applyStatusFilter(base);
			}
		}
		// Filter by project only
		else if (project !== undefined) {
			if (statuses !== undefined && statuses.length === 1) {
				allRows = await ctx.db
					.query("tasks")
					.withIndex("by_project", (q) => {
						const base = q.eq("project", project).eq("status", statuses[0]);
						return canPushCursorIntoIndex
							? base.lt("_creationTime", before as number)
							: base;
					})
					.order("desc")
					.take(canPushCursorIntoIndex ? limit : fetchCap);
			} else {
				const base = await ctx.db
					.query("tasks")
					.withIndex("by_project", (q) => q.eq("project", project))
					.order("desc")
					.take(fetchCap);
				allRows = applyStatusFilter(base);
			}
		}
		// Filter by status only. Not eligible for the index-push above: `by_status`
		// is ["status", "createdAt"], so after pinning `status` by equality the
		// next index field is `createdAt`, not `_creationTime` — Convex only
		// allows a range clause on the field immediately following the pinned
		// equality prefix, so `_creationTime` can't be reached here. Falls back
		// to the widened-scan + loud SCAN_CAP_EXCEEDED path (still correct,
		// just bounded).
		else if (statuses !== undefined) {
			if (statuses.length === 1) {
				allRows = await ctx.db
					.query("tasks")
					.withIndex("by_status", (q) => q.eq("status", statuses[0]))
					.order("desc")
					.take(fetchCap);
			} else {
				// Multi-status without other filter: full table scan bounded by limit.
				// Acceptable for bounded list sizes; no new index required per brief.
				const base = await ctx.db.query("tasks").order("desc").take(fetchCap);
				allRows = applyStatusFilter(base);
			}
		}
		// No filters — return all, newest first
		else {
			allRows = await ctx.db.query("tasks").order("desc").take(fetchCap);
		}

		// Refuse to return a silently-incomplete page: if the widened scan
		// itself hit its cap, there may be matching rows we never looked at.
		// "I couldn't measure" must never render identically to "complete".
		if (needsWideScan && allRows.length > TASK_LIST_SCAN_CAP) {
			// "shrink the updatedSince window" is only offered when it can
			// actually change the candidate count: on the assignedTo (+status)
			// branch the bound is now pushed into the index, so narrowing the
			// window is a real remedy. On every other branch — and whenever
			// createdBy (unindexed) is the trigger — the fetch is still a
			// fixed-size widened scan, so that advice would send the caller
			// chasing a lever that does nothing; it is left out there.
			const windowAdvice = usedIndexedUpdatedSinceBound
				? " or shrink the updatedSince window"
				: "";
			throw new ConvexError(
				`tasks.list: SCAN_CAP_EXCEEDED — widened scan for updatedSince/createdBy/createdBefore hit the cap of ${TASK_LIST_SCAN_CAP} candidate rows before the filter ran. The result would be incomplete and indistinguishable from a full match. Narrow with assignedTo/assignedToInstance/project/status${windowAdvice}.`,
			);
		}

		// v2.3.3 — apply createdBy + updatedSince filters in-memory
		let filtered = allRows;
		if (createdBy !== undefined) {
			filtered = filtered.filter((r) => r.createdBy === createdBy);
		}
		if (updatedSince !== undefined) {
			filtered = filtered.filter((r) => (r.updatedAt ?? 0) >= updatedSince);
		}
		// Day 163 fix — the cursor (createdBefore) filter MUST run BEFORE the
		// re-bound to `limit`, never after. This is idempotent/no-op on the
		// branches above that already pushed the bound into the index (every
		// row is already < before), and is the actual correctness fix on the
		// branches that fell back to the widened scan: applying it after
		// slicing to `limit` was silently discarding the very rows the
		// cursor was supposed to select, independent of the fetchCap defect.
		if (before !== undefined) {
			filtered = filtered.filter((r) => r._creationTime < before);
		}
		// Eta REVISE on PR #1194 @147d260 — widening the fetch (above) was
		// necessary but NOT sufficient. A branch that queries a compound
		// index with only a LEADING field pinned (e.g. by_assignee with
		// `assignedTo` pinned but `status` NOT pinned, for a multi-status or
		// no-status request) returns rows ordered by the index's remaining
		// fields — `status` first, THEN `_creationTime` — not by
		// `_creationTime` alone. Filtering that array down to matching
		// statuses preserves that scrambled order: a plain `.slice(0,
		// limit)` after such a fetch grabs `limit` rows skewed toward
		// whichever status sorts first, never the true `limit` most-recent
		// of the filtered UNION. Re-sorting by `_creationTime` desc here is
		// a no-op (stable) on branches that were already creation-time
		// ordered (single-status index-push, plain table scans) and is the
		// actual fix on the scrambled branches. Sort BEFORE the re-bound so
		// `limit` always yields the N genuinely most-recent survivors.
		filtered = [...filtered].sort((a, b) => b._creationTime - a._creationTime);
		// Re-bound to the requested page size now that every filter AND the
		// creation-time re-sort have run over the full candidate set.
		filtered = filtered.slice(0, limit);
		// PR-E — cron-spam filter: exclude auto-generated tasks when requested.
		// Two signals (OR logic):
		//   1. createdBy starts with "cron-" (dash required — "cronus"/"cron" pass through)
		//   2. title is exactly "/check-messages" or "check-messages" (case-insensitive)
		if (args.excludeAutoGenerated === true) {
			filtered = filtered.filter((r) => {
				const isCronCreator = /^cron-/i.test(r.createdBy ?? "");
				const isSyntheticTitle = /^\/?check-messages$/i.test(r.title ?? "");
				return !isCronCreator && !isSyntheticTitle;
			});
		}
		// Dashboard B1 — priority filter (in-memory, applied after other filters).
		if (priorityFilter !== undefined) {
			filtered = filtered.filter((r) => r.priority === priorityFilter);
		}

	const scoped = filterByOrgScope(filtered, scope);
	if (lite) return scoped.map(projectTaskLite);
	return scoped;
}

export const list = query({
	args: tasksListArgsValidator,
	// Returns: array of full task docs OR array of lite projections.
	// Validator omitted because v.union of full+lite produces overly-strict
	// inferred types that conflict with Doc<"tasks"> field optionality.
	handler: async (ctx, args) => {
		// ── Beta multi-tenant scope gate — fail-closed default (SEC-AUDIT Day
		// 156): no Clerk identity is no longer master. The only legitimate
		// no-identity caller (GitHub webhook, HMAC-verified) uses
		// listForWebhook (internalQuery) below instead.
		const scope = await withOrgScope(ctx);
		return await runTasksList(ctx, args, scope);
	},
});

// Internal-only mirror of `list`, used exclusively by convex/http.ts's
// GitHub webhook handler (HMAC-signature-verified, not Clerk-identity
// gated). `internal.*` functions are never exposed to `api.*` clients — no
// MCP tool, dashboard route, or direct Convex client call can reach this,
// which is the structural (not disciplinary) guard SEC-AUDIT Day 156
// requires for a genuine internal-fleet-only surface.
export const listForWebhook = internalQuery({
	args: tasksListArgsValidator,
	handler: async (ctx, args) => {
		const masterScope: OrgScope = {
			userId: "internal-webhook",
			orgSlug: null,
			allowedOrchestrators: ["*"],
			scopes: [
				"cross-tenant-read",
				"view-own-tasks",
				"view-own-missions",
				"view-stats-aggregated",
				"view-orchestrator-summary",
			],
			isMaster: true,
		};
		return await runTasksList(ctx, args, masterScope);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listPaginated — dashboard-native paginated query (Day 116 B1 fix)
//
// The dashboard TaskBoard calls usePaginatedQuery which injects paginationOpts
// into the args. This dedicated query uses .paginate() and returns the expected
// PaginationResult shape. The dashboard must call api.tasks.listPaginated
// instead of api.tasks.list.
//
// Supported filters (maps to dashboard TaskBoard queryArgs):
//   assignedTo    — index-backed (by_assignee)
//   status        — single enum value; index-backed (by_status or by_assignee+status)
//   priority      — in-memory filter on the page
//   orgId         — accepted and ignored; scoping via withOrgScope (Clerk JWT)
// ─────────────────────────────────────────────────────────────────────────────

export const listPaginated = query({
	args: {
		paginationOpts: paginationOptsValidator,
		assignedTo: v.optional(assigneeValidator),
		status: v.optional(statusValidator),
		priority: v.optional(priorityValidator),
		// orgId is accepted and ignored — multi-tenant scoping via Clerk JWT
		orgId: v.optional(v.string()),
	},
	returns: v.object({
		page: v.array(taskFullValidator),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx);
		requireScope(scope, "view-own-tasks");

		type TaskRow = Doc<"tasks">;

		// Select the most specific index available for the paginated scan.
		let baseQuery;
		if (args.assignedTo !== undefined && args.status !== undefined) {
			const assignedTo = args.assignedTo;
			const status = args.status;
			baseQuery = ctx.db
				.query("tasks")
				.withIndex("by_assignee", (q) =>
					q.eq("assignedTo", assignedTo).eq("status", status),
				)
				.order("desc");
		} else if (args.assignedTo !== undefined) {
			const assignedTo = args.assignedTo;
			baseQuery = ctx.db
				.query("tasks")
				.withIndex("by_assignee", (q) => q.eq("assignedTo", assignedTo))
				.order("desc");
		} else if (args.status !== undefined) {
			const status = args.status;
			baseQuery = ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.order("desc");
		} else {
			baseQuery = ctx.db.query("tasks").order("desc");
		}

		const paginatedResult = await baseQuery.paginate(args.paginationOpts);

		// Apply in-memory priority filter on the page (no index for priority alone).
		let page: TaskRow[] = paginatedResult.page;
		if (args.priority !== undefined) {
			const priority = args.priority;
			page = page.filter((r) => r.priority === priority);
		}

		// Apply org scope filtering.
		const scopedPage = filterByOrgScope(page, scope);

		return {
			page: scopedPage,
			isDone: paginatedResult.isDone,
			continueCursor: paginatedResult.continueCursor,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of any mutable task field
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
		title: v.optional(v.string()),
		description: v.optional(v.string()),
		project: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		assignedTo: v.optional(assigneeValidator),
		priority: v.optional(priorityValidator),
		status: v.optional(statusValidator),
		missionId: v.optional(v.id("missions")),
		estimatedMinutes: v.optional(v.number()),
		actualMinutes: v.optional(v.number()),
		startedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		dueDate: v.optional(v.number()),
		dependsOn: v.optional(v.array(v.id("tasks"))),
		completionNote: v.optional(v.string()),
		assignedToInstance: v.optional(v.string()),
		// Mandatory reason when status is being set to "cancelled" (Day 157).
		cancelReason: v.optional(v.string()),
		// [P-T5] THE LOCK — see requireAgentCredentialMatch. When presented,
		// `callerOrchestrator` (the asserted actor) must equal the resolved
		// agent identity; no-op if omitted.
		agentCredentialSecret: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("tasks:update", …) at mcp-server/src/tools.ts:4586,4950,5022 (imperative), never a subscribing pre-org client shell; the AUTH_REQUIRED/RBAC_DENIED throw is an R-16 refusal the MCP layer catches, not an uncaught Server Error.
		const { taskId, callerOrchestrator, cancelReason, agentCredentialSecret, ...fields } = args;
		await requireAuthenticatedCaller(
			ctx,
			callerOrchestrator,
			agentCredentialSecret,
		);
		const task = await ctx.db.get(taskId);
		if (task === null) {
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${taskId} not found — ${JSON.stringify({ taskId })}`,
			);
		}
		assertTaskCallerAuthorized(task, callerOrchestrator, taskId);

		// Build patch object with only provided fields
		const patch: Record<string, any> = { updatedAt: Date.now() };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}

		// Reviewer-reclaim (k17e1ar4s7pspb0rs74ms25hmd8dhv01) — whenever
		// assignedTo CHANGES, capture the OLD (pre-change) value into
		// lastAssignedTo in the SAME patch. This is the field
		// assertTaskCallerAuthorized's reclaim branch reads; it is written
		// unconditionally on every reassignment (review task or not) so the
		// gate can decide review-tasks-only scoping at read time.
		if (patch.assignedTo !== undefined && patch.assignedTo !== task.assignedTo) {
			patch.lastAssignedTo = task.assignedTo;
		}

		// Day 159 — the anonymous-block gate must live at the STATUS boundary,
		// not the verb. `blockTask` refuses an anonymous block, but `update`
		// accepts `status: statusValidator` (which includes "blocked") with no
		// verification — a second, ungated door to the exact defect blockTask
		// exists to close. Refuse here and redirect to block_task.
		if (patch.status === "blocked") {
			throw new ConvexError(
				`BLOCK_VIA_UPDATE_REFUSED: setting status="blocked" through update_task is refused — a block must name the task charged to lift it. Use block_task with blockedOnTaskId=<live task owned by someone else>, or a "# blocked-on-nobody: <reason>" marker for a genuinely ownerless obstacle — ${JSON.stringify({ taskId })}`,
			);
		}

		// T1 — the same ungated-door defect, terminal side. `update` accepts
		// `status: statusValidator` (which now includes "failed") with no
		// verification — a second door to exactly the "closer picks between
		// finished and failed" defect `failTask` exists to close (Pi: "a
		// closer who can pick between finished and failed will pick finished
		// — that is what an enum with two plausible values does to anyone in
		// a hurry"). Refuse here and redirect to fail_task, the same shape as
		// BLOCK_VIA_UPDATE_REFUSED above.
		if (patch.status === "failed") {
			throw new ConvexError(
				`FAILED_VIA_UPDATE_REFUSED: setting status="failed" through update_task is refused — recording a failure requires fail_task with a failureNote describing how the work ended. Use fail_task, or complete_task if the work in fact succeeded — ${JSON.stringify({ taskId })}`,
			);
		}

		// Day 157 — cancelled is a terminal status, settable only by the task's
		// CREATOR (stricter than assertTaskCallerAuthorized above, which also
		// allows the assignee), and requires a non-empty reason. Mirrors the
		// deleteTask RBAC (convex/tasks.ts deleteTask) but never deletes data.
		if (patch.status === "cancelled") {
			// MAJOR #4 (convex-reviewer REVISE) — a task already closed as "done"
			// carries a billable completedAt/actualMinutes. Flipping it to
			// cancelled would silently erode billingSummaryByProject while
			// keeping the stale timestamps. Done is a terminal state; it cannot
			// be re-terminated as cancelled.
			if (task.status === "done") {
				throw new ConvexError(
					`CANNOT_CANCEL_DONE: task ${taskId} is already done — a completed task cannot be cancelled — ${JSON.stringify({ taskId })}`,
				);
			}
			if (
				callerOrchestrator !== "system" &&
				task.createdBy !== callerOrchestrator
			) {
				throw new ConvexError(
					`RBAC_DENIED: Only ${task.createdBy} (creator) or system can cancel task ${taskId} — ${JSON.stringify({ caller: callerOrchestrator, creator: task.createdBy, taskId })}`,
				);
			}
			if (!cancelReason || cancelReason.trim() === "") {
				throw new ConvexError(
					`CANCEL_REASON_REQUIRED: cancelReason is required to cancel task ${taskId} — ${JSON.stringify({ taskId })}`,
				);
			}
			patch.cancelledBy = callerOrchestrator;
			patch.cancelReason = cancelReason;
		} else if (cancelReason !== undefined) {
			// MINOR #6 (convex-reviewer REVISE) — cancelReason must never be
			// silently dropped. If the task is already cancelled and this call
			// isn't changing status away from it, persist the updated reason.
			// Otherwise (task isn't cancelled and this call isn't cancelling
			// it), refuse rather than accept-and-discard the field.
			if (task.status === "cancelled") {
				patch.cancelReason = cancelReason;
			} else {
				throw new ConvexError(
					`CANCEL_REASON_NOT_APPLICABLE: cancelReason was provided but task ${taskId} is not being cancelled and is not already cancelled (status="${task.status}") — pass status="cancelled" to cancel, or omit cancelReason — ${JSON.stringify({ taskId, status: task.status })}`,
				);
			}
		}

		// Day 130 closure gate — `update` is a second path that can also
		// transition status to "done" (e.g. generic MCP update_task call).
		// Gate it the same way as `complete` so billable-project closures
		// can't bypass the machine-timestamp requirement via this path.
		if (patch.status === "done") {
			const now = Date.now();
			const { actualMinutes } = await enforceClosureGate(
				ctx,
				task,
				patch.completionNote ?? task.completionNote,
				now,
			);
			if (patch.completedAt === undefined) {
				patch.completedAt = now;
			}
			if (actualMinutes !== undefined && patch.actualMinutes === undefined) {
				patch.actualMinutes = actualMinutes;
			}
			// T1 — hardcoded, not read from args: `update` has no
			// `completionOutcome` arg, so there is nothing for a caller to
			// pick here either. Keeps every "done" row consistent with
			// `complete`, which does the same.
			patch.completionOutcome = "succeeded";
		}

		await ctx.db.patch(taskId, patch);

		if (patch.status === "done") {
			await unblockWaitersOn(ctx, taskId, patch.completedAt ?? Date.now());
		}

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// attachReviewArtifact — task k1798y530ytkgsd7259nj2heb58cszv4. ONE narrow
// server-side permission, deliberately carved OUT of `update`'s ownership
// gate rather than added to it: the AUTHOR of an artifact (e.g. a PR) may
// attach that artifact's REFERENCE to an existing review task it neither
// created nor owns — without gaining any other write on the task.
//
// `update` is unchanged: every other field (assignee, status, criteria,
// cancel) still routes through assertTaskCallerAuthorized, so the same
// non-owner caller attempting a reassign/rewrite/close via `update` is
// refused exactly as before this mutation existed. This mutation touches
// ONLY reviewArtifactRef and reviewArtifactAttachedBy — no other field is
// writable through it.
//
// Two refusals, both consulted INSIDE the mutation (never a post-hoc filter):
//   - callerOrchestrator omitted → RBAC_DENIED, same shape as
//     assertTaskCallerAuthorized (omission refuses, never bypasses).
//   - a ref already attached by a DIFFERENT orchestrator →
//     REVIEW_ARTIFACT_ALREADY_ATTACHED (first-writer wins; a caller who is
//     not the original attacher attaches nothing over it). The SAME
//     orchestrator re-attaching (e.g. an updated PR URL) is allowed.
// ─────────────────────────────────────────────────────────────────────────────

export const attachReviewArtifact = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
		artifactRef: v.string(),
		// [P-T5] THE LOCK — see requireAgentCredentialMatch. When presented,
		// `callerOrchestrator` (the asserted actor, also written verbatim to
		// `reviewArtifactAttachedBy`) must equal the resolved agent identity;
		// no-op if omitted.
		agentCredentialSecret: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// CORE-A: the tenth public door — closes k17675gzd2bwtnvgp0qzmtx35h8csg23
		// / PR #1211, matching the gate #1213 applied to the other nine.
		// write-contract: no mcp-server/src/tools.ts wiring exists for
		// "tasks:attachReviewArtifact" (grepped, none found) — its only current
		// callers are convex-test's direct t.mutation(api.tasks.attachReviewArtifact, …)
		// in convex/__tests__/. This repo has no subscribing pre-org client shell
		// (no React render path); the RBAC_DENIED/AUTH_REQUIRED throw is reachable
		// only via an imperative SDK/test call, never an ordinary render.
		await requireAuthenticatedCaller(
			ctx,
			args.callerOrchestrator,
			args.agentCredentialSecret,
		);
		if (args.callerOrchestrator === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: callerOrchestrator is required to attach a review artifact — omitting it is refused, not exempted — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}
		if (args.artifactRef.trim() === "") {
			throw new ConvexError(
				`ARTIFACT_REF_REQUIRED: artifactRef must be a non-empty reference (e.g. a PR URL) — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}
		const task = await ctx.db.get(args.taskId);
		if (task === null) {
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${args.taskId} not found — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}

		// Deliberately NOT assertTaskCallerAuthorized — this is the narrow
		// permission the mutation exists to grant: ANY orchestrator may attach
		// a review artifact reference, even when neither creator nor assignee.
		if (
			task.reviewArtifactRef !== undefined &&
			task.reviewArtifactAttachedBy !== undefined &&
			task.reviewArtifactAttachedBy !== args.callerOrchestrator
		) {
			throw new ConvexError(
				`REVIEW_ARTIFACT_ALREADY_ATTACHED: task ${args.taskId} already carries a review artifact attached by ${task.reviewArtifactAttachedBy} — ${args.callerOrchestrator} may not overwrite it. Ask ${task.reviewArtifactAttachedBy} to update it, or attach on a different task — ${JSON.stringify({ taskId: args.taskId, attachedBy: task.reviewArtifactAttachedBy, caller: args.callerOrchestrator })}`,
			);
		}

		await ctx.db.patch(args.taskId, {
			reviewArtifactRef: args.artifactRef,
			reviewArtifactAttachedBy: args.callerOrchestrator,
			updatedAt: Date.now(),
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// unblockWaitersOn — reciprocal half of the block_task commitment (Day 159).
// When `closedTaskId` reaches a TERMINAL state, every task that named it via
// blockedOnTaskId is notified. `outcome` distinguishes the two terminals
// that can trigger this (T1, Eta REVISE on PR #1208 @ def85c45):
//
//   "succeeded" — the ORIGINAL behaviour, unchanged: the waiter is swept
//   back to "todo" (the precondition it was waiting on now holds, so an
//   autonomous pick is safe) and blockedOnTaskId is cleared (the pointer
//   to a resolved prerequisite has no further use). Message says "is now
//   done" — true for this path only.
//
//   "failed" — the blocker did NOT resolve. Three things Eta's review
//   named as wrong in the first cut are the three things this branch
//   refuses to do: (1) it does NOT reset status to "todo" — no autonomous
//   pick may treat the failed prerequisite as though it held; (2) it does
//   NOT erase blockedOnTaskId — the pointer to the failed prerequisite is
//   the only way to find it, and is needed in the SAME transaction that
//   creates the reason to look for it; (3) the notification NAMES the
//   failure, never "is now done". The waiter stays "blocked", now
//   pointing at a task everyone can see is "failed" — visible, not
//   silently made ready, and left for a human/orchestrator to re-route.
//
// Called from `complete`/`update` (outcome "succeeded") and `failTask`
// (outcome "failed") — the three terminal-closing paths (Day 130
// closure-gate comment on `update` below covers the first two).
// ─────────────────────────────────────────────────────────────────────────────

async function unblockWaitersOn(
	ctx: MutationCtx,
	closedTaskId: import("./_generated/dataModel").Id<"tasks">,
	now: number,
	outcome: CompletionOutcome = "succeeded",
): Promise<void> {
	const closedTask = await ctx.db.get(closedTaskId);
	const waiters = await ctx.db
		.query("tasks")
		.withIndex("by_blockedOnTaskId", (q) => q.eq("blockedOnTaskId", closedTaskId))
		.collect();

	for (const waiter of waiters) {
		if (waiter.status !== "blocked") continue;

		let content: string;

		if (outcome === "succeeded") {
			await ctx.db.patch(waiter._id, {
				status: "todo",
				blockedOnTaskId: undefined,
				updatedAt: now,
			});

			content =
				`UNBLOCKED: task ${waiter._id} ("${waiter.title}") is unblocked — ` +
				`${closedTaskId} ("${closedTask?.title ?? "unknown"}") is now done. Status reset to todo — ${JSON.stringify(
					{ taskId: waiter._id, unblockedBy: closedTaskId },
				)}`;
		} else {
			// "failed" — deliberately no db.patch of waiter.status/blockedOnTaskId:
			// the waiter stays "blocked", still pointing at closedTaskId, so
			// nothing treats the failed prerequisite as resolved.
			content =
				`BLOCKER_FAILED: task ${waiter._id} ("${waiter.title}") is still blocked — ` +
				`${closedTaskId} ("${closedTask?.title ?? "unknown"}") FAILED, not done. ` +
				`The prerequisite did not resolve; this task needs re-routing (a new blockedOnTaskId, ` +
				`a "# blocked-on-nobody:" reason, or manual unblocking) — it will NOT auto-unblock — ${JSON.stringify(
					{ taskId: waiter._id, failedBlocker: closedTaskId },
				)}`;
		}

		const messageId = await ctx.db.insert("messages", {
			from: "system",
			channel: waiter.assignedTo,
			content,
			createdAt: now,
		});
		await ctx.db.insert("messageReceipts", {
			messageId,
			recipient: waiter.assignedTo,
			readAt: undefined,
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// blockTask — server-side gate for the "who is charged to unblock me" defect
// (Day 159). A block note is a journal; a task in the responder's queue is a
// commitment. Extends the same layer/refusal shape as the complete_task
// closure gate: this refusal lives on the server, so it holds for every
// station without distribution.
//
// Two accepted shapes, ANONYMOUS blocking forbidden in both:
//   1. blockedOnTaskId set — cited task must (a) exist, (b) be neither done
//      nor cancelled, (c) be assigned to someone OTHER than this task's own
//      assignee (you don't wait on yourself).
//   2. blockedOnTaskId omitted — an obstacle nobody in the fleet owns
//      (operator decision, third-party outage). REQUIRES an explicit
//      "# blocked-on-nobody: <reason>" marker in `reason`; the reason is
//      stored in blockedOnNobodyReason.
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_ON_NOBODY_MARKER = /#\s*blocked-on-nobody:\s*(.+)/is;

// T1 — the structured cause discriminator (see convex/schema.ts:blockedCause
// for the full rationale). Kept as its own union so `deriveBlockedWaitingOn`
// below has a single, exported type to derive from.
const blockedCauseValidator = v.union(
	v.literal("peer_task"),
	v.literal("human"),
	v.literal("authorisation"),
	v.literal("other"),
);
export type BlockedCause = "peer_task" | "human" | "authorisation" | "other";

// deriveBlockedWaitingOn — PURE function, {status, blockedCause} -> the
// waiting-on state. This is the derivation itself: no caller ever writes
// "human" or "authorisation" as a status; they write `blockedCause` (what
// is being waited on) via blockTask, and this function is the only place
// that turns that into a presentation label. A task not in "blocked"
// carries no waiting-on state regardless of a stale blockedCause value.
export function deriveBlockedWaitingOn(task: {
	status: string;
	blockedCause?: BlockedCause;
}): BlockedCause | null {
	if (task.status !== "blocked") return null;
	return task.blockedCause ?? "other";
}

export const blockTask = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
		reason: v.optional(v.string()),
		blockedOnTaskId: v.optional(v.id("tasks")),
		// T1 — optional (not required): old MCP callers redeploy independently
		// of Convex (.claude/rules/railway-mcp-redeploy.md) and do not yet send
		// this arg. Omission defaults to "other" below, never rejected.
		blockedCause: v.optional(blockedCauseValidator),
		// [P-T5] THE LOCK — see requireAgentCredentialMatch. When presented,
		// `callerOrchestrator` (the asserted actor) must equal the resolved
		// agent identity; no-op if omitted.
		agentCredentialSecret: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireAuthenticatedCaller(
			ctx,
			args.callerOrchestrator,
			args.agentCredentialSecret,
		);
		const task = await ctx.db.get(args.taskId);
		if (task === null) {
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${args.taskId} not found — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}
		assertTaskCallerAuthorized(task, args.callerOrchestrator, args.taskId);

		// Eta rider on PR #1208 @ def85c45 — cheap, one-directional consistency
		// check: blockedCause="peer_task" literally means "waiting on a peer
		// task", so it is meaningless without one cited. NOT the reverse
		// (blockedOnTaskId set does NOT require blockedCause="peer_task" — a
		// cited task can legitimately be an authorisation gate, e.g. a review
		// awaiting merge; that asymmetry is intentional, already covered by
		// the "blockedOnTaskId form also accepts a structured cause" test).
		if (args.blockedCause === "peer_task" && args.blockedOnTaskId === undefined) {
			throw new ConvexError(
				`BLOCKED_CAUSE_PEER_TASK_REQUIRES_LINK: blockedCause="peer_task" names a peer task as the cause, but no blockedOnTaskId was cited — either cite the peer task via blockedOnTaskId, or pick "human"/"authorisation"/"other" for an obstacle nobody owns — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}

		const patch: Record<string, unknown> = {
			status: "blocked",
			updatedAt: Date.now(),
			blockedOnTaskId: undefined,
			blockedOnNobodyReason: undefined,
			blockedCause: args.blockedCause ?? "other",
		};

		if (args.blockedOnTaskId !== undefined) {
			const blocker = await ctx.db.get(args.blockedOnTaskId);
			if (blocker === null) {
				throw new ConvexError(
					`BLOCKED_ON_TASK_NOT_FOUND: cited task ${args.blockedOnTaskId} does not exist — cite a real, live task ID, or omit blockedOnTaskId and mark the reason with "# blocked-on-nobody: <reason>" if no one owns this obstacle — ${JSON.stringify({ taskId: args.taskId, blockedOnTaskId: args.blockedOnTaskId })}`,
				);
			}
			if (blocker.status === "done" || blocker.status === "cancelled") {
				throw new ConvexError(
					`BLOCKED_ON_TASK_CLOSED: cited task ${args.blockedOnTaskId} is already "${blocker.status}" — a closed request blocks no one. Cite a live task, or complete it and let the reciprocal unblock fire — ${JSON.stringify({ taskId: args.taskId, blockedOnTaskId: args.blockedOnTaskId, blockerStatus: blocker.status })}`,
				);
			}
			if (blocker.assignedTo === task.assignedTo) {
				throw new ConvexError(
					`BLOCKED_ON_OWN_TASK: cited task ${args.blockedOnTaskId} is assigned to ${blocker.assignedTo}, the same assignee as ${args.taskId} — you cannot block on your own task. Cite a task owned by someone else, or omit blockedOnTaskId and mark the reason with "# blocked-on-nobody: <reason>" — ${JSON.stringify({ taskId: args.taskId, blockedOnTaskId: args.blockedOnTaskId, assignedTo: task.assignedTo })}`,
				);
			}
			patch.blockedOnTaskId = args.blockedOnTaskId;
			if (args.reason) patch.completionNote = args.reason;
		} else {
			const reason = args.reason ?? "";
			const marker = reason.match(BLOCKED_ON_NOBODY_MARKER);
			if (!marker || marker[1].trim() === "") {
				throw new ConvexError(
					`BLOCKED_LINK_REQUIRED: block_task requires EITHER blockedOnTaskId citing a live task assigned to someone else, OR an explicit "# blocked-on-nobody: <reason>" marker in reason (for an obstacle nobody in the fleet owns — operator decision, third-party outage). Anonymous blocking is refused, never blocking itself — ${JSON.stringify({ taskId: args.taskId })}`,
				);
			}
			patch.blockedOnNobodyReason = reason;
			patch.completionNote = reason;
		}

		await ctx.db.patch(args.taskId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listUnlinkedBlocked — migration inventory query (Day 159). Lists tasks
// ALREADY in status="blocked" carrying neither blockedOnTaskId nor
// blockedOnNobodyReason — pre-existing rows from before this gate shipped.
// Read-only: never mutates. This is the invisible-debt inventory Pi's audit
// asked for.
// ─────────────────────────────────────────────────────────────────────────────

export const listUnlinkedBlocked = query({
	args: {},
	returns: v.array(
		v.object({
			taskId: v.id("tasks"),
			title: v.string(),
			assignedTo: v.string(),
			createdBy: v.string(),
			updatedAt: v.number(),
		}),
	),
	handler: async (ctx) => {
		const blocked = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", "blocked"))
			.collect();
		return blocked
			.filter((t) => t.blockedOnTaskId === undefined && t.blockedOnNobodyReason === undefined)
			.map((t) => ({
				taskId: t._id,
				title: t.title,
				assignedTo: t.assignedTo,
				createdBy: t.createdBy,
				updatedAt: t.updatedAt,
			}));
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// complete — shortcut: sets status=done, updatedAt=now
// ─────────────────────────────────────────────────────────────────────────────

export const complete = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
		completionNote: v.optional(v.string()),
		// [P-T5] THE LOCK — see requireAgentCredentialMatch. When presented,
		// `callerOrchestrator` (the asserted actor) must equal the resolved
		// agent identity; no-op if omitted.
		agentCredentialSecret: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireAuthenticatedCaller(
			ctx,
			args.callerOrchestrator,
			args.agentCredentialSecret,
		);
		const task = await ctx.db.get(args.taskId);
		if (task === null) {
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${args.taskId} not found — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}
		assertTaskCallerAuthorized(task, args.callerOrchestrator, args.taskId);

		if (!args.completionNote || args.completionNote.trim() === "") {
			throw new ConvexError(
				`COMPLETION_NOTE_REQUIRED: completionNote is required for task ${args.taskId}. Describe what was actually done (≥40 chars with verifiable proof token) — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}

		const now = Date.now();

		// Day 130 closure gate — billable-project tasks must carry a
		// machine-recorded startedAt (or an explicit structured override)
		// before they can close. Billing derives actualMinutes from
		// startedAt→completedAt, never a hand-typed time line.
		const { actualMinutes } = await enforceClosureGate(
			ctx,
			task,
			args.completionNote,
			now,
		);

		// T1 — hardcoded "succeeded", never read from args: `complete` has no
		// outcome arg for a caller to set. status is DERIVED from that
		// hardcoded outcome via deriveTerminalStatus, not written as an
		// independent literal.
		const outcome: CompletionOutcome = "succeeded";
		const patch: Record<string, any> = {
			status: deriveTerminalStatus(outcome),
			completionOutcome: outcome,
			completedAt: now,
			updatedAt: now,
		};

		if (args.completionNote !== undefined) {
			patch.completionNote = args.completionNote;
		}

		if (actualMinutes !== undefined) {
			patch.actualMinutes = actualMinutes;
		}

		await ctx.db.patch(args.taskId, patch);

		await unblockWaitersOn(ctx, args.taskId, now);

		// Auto-link: if task title contains #NNN, update the corresponding issue
		const issueMatch = task.title.match(/#(\d+)/);
		if (issueMatch) {
			const issueNumber = parseInt(issueMatch[1], 10);
			// Find repo from project via githubRepoMapping
			if (task.project) {
				const mappings = await ctx.db.query("githubRepoMapping").collect();
				const mapping = mappings.find((m) => m.project === task.project);
				if (mapping) {
					// Find the issue
					const issue = await ctx.db
						.query("issues")
						.withIndex("by_repo_number", (q) =>
							q.eq("repo", mapping.repo).eq("issueNumber", issueNumber),
						)
						.unique();
					if (issue) {
						// Link the task
						const existingTaskIds = issue.linkedTaskIds || [];
						if (!existingTaskIds.includes(args.taskId as string)) {
							await ctx.db.patch(issue._id, {
								linkedTaskIds: [...existingTaskIds, args.taskId as string],
							});
						}
						// Check if completionNote mentions fix/fixed/commit SHA
						const note = args.completionNote || "";
						const hasFix =
							/\bfix(ed)?\b/i.test(note) || /\b[0-9a-f]{7,40}\b/.test(note);
						if (hasFix) {
							// Extract commit SHA if present
							const shaMatch = note.match(/\b([0-9a-f]{7,40})\b/);
							await ctx.db.patch(issue._id, {
								status: "fixed",
								fixedBy: task.assignedTo,
								fixedAt: Date.now(),
								...(shaMatch
									? {
											fixCommits: [...(issue.fixCommits || []), shaMatch[1]],
										}
									: {}),
							});
						}
					}
				}
			}
		}

		// IRP auto-comments: post a GitHub comment when key IRP steps are completed.
		// IRP task titles follow the pattern "[#NNN] TN — <step name>".
		const irpStepMatch = task.title.match(/\[#(\d+)\] T(\d+)/);
		if (irpStepMatch && task.project) {
			const irpIssueNumber = parseInt(irpStepMatch[1], 10);
			const stepNumber = parseInt(irpStepMatch[2], 10);

			// Extract issue author stored in task description by the webhook
			const authorMatch = task.description?.match(/Issue author: @(\S+)/);
			const author = authorMatch ? authorMatch[1] : null;
			const authorMention = author ? `@${author} ` : "";

			const allMappings = await ctx.db.query("githubRepoMapping").take(100);
			const repoMapping = allMappings.find((m) => m.project === task.project);

			if (repoMapping) {
				const dateStr = new Date().toISOString().split("T")[0];
				const orch = task.assignedTo;
				const orchCapitalized = orch.charAt(0).toUpperCase() + orch.slice(1);
				const signature = `Orchestrator: ${orchCapitalized} | ${dateStr}`;
				let commentBody: string | null = null;

				if (stepNumber === 6) {
					commentBody = `${authorMention}Bug reproduced in test suite. Root cause identified. Fix in progress.\n\n${signature}`;
				} else if (stepNumber === 8) {
					commentBody = `${authorMention}Fix ready. All tests pass (including new regression test). Awaiting review and deploy.\n\n${signature}`;
				} else if (stepNumber === 11) {
					commentBody = `${authorMention}Fixed and deployed to production. Regression test added to prevent recurrence. Closing.\n\n${signature}`;
				}

				if (commentBody !== null) {
					await ctx.scheduler.runAfter(0, internal.githubComments.postComment, {
						repo: repoMapping.repo,
						issueNumber: irpIssueNumber,
						body: commentBody,
					});
				}

				// IRP auto-store fixPattern when the Fix step (T7) is completed
				if (stepNumber === 7 && args.completionNote) {
					const note = args.completionNote;

					// Parse structured completionNote: "Root cause: ... Fix: ... Files: ..."
					const rootCauseMatch = note.match(
						/Root cause:\s*(.+?)(?=\s*Fix:|$)/is,
					);
					const fixMatch = note.match(/Fix:\s*(.+?)(?=\s*Files:|$)/is);
					const filesMatch = note.match(/Files:\s*(.+?)$/is);

					if (rootCauseMatch) {
						// Extract a clean symptom from the task title: "[#282] T7 — Fix" -> "Fix #282"
						const issueTitle = `Issue #${irpIssueNumber}: ${task.title.replace(/^\[#\d+\] T\d+ — /, "")}`;
						const rootCause = rootCauseMatch[1].trim();
						const validatedFix = fixMatch ? fixMatch[1].trim() : undefined;

						// Use assignedTo directly — creatorValidator is now v.string() (issue #132)
						const fixPatternCreatedBy: string = task.assignedTo;

						const patternId = await ctx.db.insert("fixPatterns", {
							symptom: issueTitle,
							rootCause,
							validatedFix,
							files: filesMatch
								? filesMatch[1]
										.trim()
										.split(",")
										.map((f) => f.trim())
										.filter((f) => f.length > 0)
								: undefined,
							tags: task.tags ?? [],
							stack: [],
							sourceProject: task.project,
							linkedIssueIds: [`#${irpIssueNumber}`],
							createdBy: fixPatternCreatedBy,
							severity: "major" as const,
							createdAt: Date.now(),
							updatedAt: Date.now(),
						});

						// Schedule RAG embedding — matches fixPatterns.create behaviour
						const ragText = `Symptom: ${issueTitle}\nRoot cause: ${rootCause}${validatedFix ? `\nValidated fix: ${validatedFix}` : ""}`;
						await ctx.scheduler.runAfter(
							0,
							internal.ragSync.addFixPatternRagEntry,
							{
								patternId,
								content: ragText,
								sourceProject: task.project,
							},
						);
					}
				}
			}
		}

		// Auto-complete mission: if this task belongs to a mission, check if all tasks are done
		if (task.missionId) {
			const missionTasks = await ctx.db
				.query("tasks")
				.withIndex("by_mission", (q) => q.eq("missionId", task.missionId!))
				.collect();
			const allDone = missionTasks.every(
				(t) =>
					t._id.toString() === args.taskId.toString() || t.status === "done",
			);
			if (allDone) {
				const mission = await ctx.db.get(task.missionId);
				if (mission && mission.status !== "complete") {
					await ctx.db.patch(task.missionId, {
						status: "complete",
						updatedAt: Date.now(),
					});
				}
			}
		}

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// failTask — T1 (PRD-evevantage-v1 §7.1) — the FAILED terminal, distinct
// from "done" (succeeded) and "cancelled" (retired before/without
// attempting the work). Mirrors `blockTask`: a dedicated, purpose-named
// verb rather than a raw status/outcome value a caller can pick between
// two plausible options. `update` refuses status="failed"
// (FAILED_VIA_UPDATE_REFUSED) the same way it refuses status="blocked" —
// this is the only door. `completionOutcome` is hardcoded "failed" here,
// never read from args; `status` is DERIVED from it via
// deriveTerminalStatus. failureNote carries the same evidence discipline
// as `complete`'s completionNote (non-empty, describes how the work
// ended) and is stored in the shared `completionNote` field — reuse, not
// a parallel note field.
// ─────────────────────────────────────────────────────────────────────────────

export const failTask = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
		failureNote: v.string(),
		// [P-T5] THE LOCK — see requireAgentCredentialMatch. When presented,
		// `callerOrchestrator` (the asserted actor) must equal the resolved
		// agent identity; no-op if omitted.
		agentCredentialSecret: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireAuthenticatedCaller(
			ctx,
			args.callerOrchestrator,
			args.agentCredentialSecret,
		);
		const task = await ctx.db.get(args.taskId);
		if (task === null) {
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${args.taskId} not found — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}
		assertTaskCallerAuthorized(task, args.callerOrchestrator, args.taskId);

		if (!args.failureNote || args.failureNote.trim() === "") {
			throw new ConvexError(
				`FAILURE_NOTE_REQUIRED: failureNote is required for task ${args.taskId}. Describe how the work ended in failure — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}

		// A closed task cannot be re-terminated — same rule complete/cancel
		// already carry (CANNOT_CANCEL_DONE); a task already "done" or
		// "cancelled" is not eligible to be re-recorded as "failed" after
		// the fact (that reclassification-after-close question is the
		// extended migration decision, answered in README/CHANGELOG, not a
		// live mutation path).
		if (
			task.status === "done" ||
			task.status === "cancelled" ||
			task.status === "failed"
		) {
			throw new ConvexError(
				`CANNOT_FAIL_CLOSED_TASK: task ${args.taskId} is already "${task.status}" — a closed task cannot be re-terminated as failed — ${JSON.stringify({ taskId: args.taskId, status: task.status })}`,
			);
		}

		const now = Date.now();

		// T1 — hardcoded "failed", never read from args: `failTask` has no
		// outcome arg for a caller to set. status is DERIVED from that
		// hardcoded outcome via deriveTerminalStatus, not written as an
		// independent literal.
		const outcome: CompletionOutcome = "failed";
		const patch: Record<string, any> = {
			status: deriveTerminalStatus(outcome),
			completionOutcome: outcome,
			completionNote: args.failureNote,
			completedAt: now,
			updatedAt: now,
		};

		await ctx.db.patch(args.taskId, patch);

		// Eta REVISE on PR #1208 @ def85c45 — a failed blocker does NOT
		// silently ready its waiters (they stay "blocked", blockedOnTaskId
		// intact) and the notification NAMES the failure — see
		// unblockWaitersOn's outcome="failed" branch above for the full
		// reasoning. This is not the success-path sweep; it is the visible,
		// non-auto-unblocking notification a failed prerequisite requires.
		await unblockWaitersOn(ctx, args.taskId, now, outcome);

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// start — sets status=in_progress, startedAt=now, updatedAt=now
// ─────────────────────────────────────────────────────────────────────────────

export const start = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
		// [P-T5] THE LOCK — see requireAgentCredentialMatch. When presented,
		// `callerOrchestrator` (the asserted actor) must equal the resolved
		// agent identity; no-op if omitted.
		agentCredentialSecret: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireAuthenticatedCaller(
			ctx,
			args.callerOrchestrator,
			args.agentCredentialSecret,
		);
		const task = await ctx.db.get(args.taskId);
		if (task === null) {
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${args.taskId} not found — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}
		assertTaskCallerAuthorized(task, args.callerOrchestrator, args.taskId);

		// Block if any dependsOn tasks are not yet done.
		if (task.dependsOn && task.dependsOn.length > 0) {
			const depDocs = await Promise.all(
				task.dependsOn.map((depId) => ctx.db.get(depId)),
			);
			const blockers = depDocs
				.filter((d): d is NonNullable<typeof d> => d !== null && d.status !== "done")
				.map((d) => ({ taskId: d._id, title: d.title, status: d.status }));
			if (blockers.length > 0) {
				throw new ConvexError(
					`DEPENDENCY_NOT_DONE: Cannot start task ${args.taskId} — ${blockers.length} dependency(ies) not yet done — ${JSON.stringify({ taskId: args.taskId, blockers })}`,
				);
			}
		}

		// Block if caller has a different unclosed in_progress task IN THE SAME
		// `project` (repo/stream) as the task being started. Day 156
		// (mission vp-concurrent-active-tasks-per-stream-v1, T1) — relaxed from
		// "one in_progress task per orchestrator" (unbounded) to "one
		// in_progress task per orchestrator PER DISTINCT project". Tasks with
		// `project === undefined` are treated as one shared "default" stream
		// (conservative default — preserves pre-relaxation behavior for
		// un-projected tasks; only projected tasks gain concurrency).
		// Skip for "system" — it is never an assignee and has no task queue.
		if (args.callerOrchestrator && args.callerOrchestrator !== "system") {
			const callerOrc = args.callerOrchestrator;
			const taskProject = task.project;
			const inProgressTasks = await ctx.db
				.query("tasks")
				.withIndex("by_assignee_project", (q) =>
					q
						.eq("assignedTo", callerOrc)
						.eq("project", taskProject)
						.eq("status", "in_progress"),
				)
				.take(2);

			const conflict = inProgressTasks.find(
				(t) => t._id !== args.taskId,
			);
			if (conflict !== undefined) {
				throw new ConvexError(
					`TASK_START_BLOCKED: Cannot start task ${args.taskId} — caller ${callerOrc} has an unclosed in_progress task "${conflict.title}" in project ${JSON.stringify(taskProject ?? null)}. Call complete_task with completionNote first — ${JSON.stringify({ currentInProgressTaskId: conflict._id, currentInProgressTitle: conflict.title, attemptedTaskId: args.taskId, project: taskProject ?? null })}`,
				);
			}
		}

		const now = Date.now();
		await ctx.db.patch(args.taskId, {
			status: "in_progress",
			startedAt: now,
			updatedAt: now,
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// checkout — atomically claim a task (only if status=todo)
// ─────────────────────────────────────────────────────────────────────────────

export const checkout = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: creatorValidator,
		callerInstance: v.optional(v.string()),
		// [P-T5] THE LOCK — see requireAgentCredentialMatch. When presented,
		// `callerOrchestrator` (the asserted actor) must equal the resolved
		// agent identity; no-op if omitted.
		agentCredentialSecret: v.optional(v.string()),
	},
	returns: v.object({ claimed: v.boolean(), reason: v.optional(v.string()) }),
	handler: async (ctx, args) => {
		await requireAuthenticatedCaller(
			ctx,
			args.callerOrchestrator,
			args.agentCredentialSecret,
		);
		const task = await ctx.db.get(args.taskId);
		if (!task) {
			return { claimed: false, reason: "Task not found" };
		}
		if (task.status !== "todo") {
			return {
				claimed: false,
				reason: `Task already ${task.status}${task.claimedByInstance ? ` by ${task.claimedByInstance}` : ""}`,
			};
		}
		await ctx.db.patch(args.taskId, {
			status: "in_progress",
			claimedByInstance: args.callerInstance,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
		return { claimed: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteTask — hard delete, owner-only (createdBy must match caller)
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTask = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
		// [P-T5] THE LOCK — see requireAgentCredentialMatch. When presented,
		// `callerOrchestrator` (the asserted actor) must equal the resolved
		// agent identity; no-op if omitted.
		agentCredentialSecret: v.optional(v.string()),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("tasks:deleteTask", …) at mcp-server/src/tools.ts:4861 (imperative), never a subscribing pre-org client shell; the AUTH_REQUIRED/RBAC_DENIED throw is an R-16 refusal the MCP layer catches, not an uncaught Server Error.
		await requireAuthenticatedCaller(
			ctx,
			args.callerOrchestrator,
			args.agentCredentialSecret,
		);
		const task = await ctx.db.get(args.taskId);
		if (!task)
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${args.taskId} not found — ${JSON.stringify({ taskId: args.taskId })}`,
			);

		if (args.callerOrchestrator === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: callerOrchestrator is required to delete task ${args.taskId} — omitting it is refused, not exempted — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}
		if (
			args.callerOrchestrator !== "system" &&
			task.createdBy !== args.callerOrchestrator
		) {
			throw new ConvexError(
				`RBAC_DENIED: Only ${task.createdBy} (creator) or system can delete task ${args.taskId} — ${JSON.stringify({ caller: args.callerOrchestrator, creator: task.createdBy, taskId: args.taskId })}`,
			);
		}

		await ctx.db.delete(args.taskId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByMission — list tasks filtered by missionId
//
// New in v1.1 (same pattern as `list`):
//   fields="lite" — compact projection: {_id,_creationTime,title,status,priority,assignedTo,missionId}
//   fields="full" (default) — full doc (backward-compatible)
//   status="open"    — expands to ["todo","in_progress","review","blocked"]
//   status="active"  — expands to ["todo","in_progress"]
//   status=["todo","in_progress"] — multi-value array (no alias mixing)
// ─────────────────────────────────────────────────────────────────────────────

export const listByMission = query({
	args: {
		missionId: v.id("missions"),
		status: v.optional(v.union(v.string(), v.array(v.string()))),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		createdBy: v.optional(creatorValidator),
		updatedSince: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	// Returns validator omitted because union of full+lite produces overly strict types vs Doc<"tasks"> optionality
	handler: async (ctx, args) => {
		const statuses = expandTaskStatuses(args.status);
		const lite = args.fields === "lite";
		const missionId = args.missionId;
		const createdBy = args.createdBy;
		const updatedSince = args.updatedSince;
		// v2.3.3 — auto-clamp limit when fields=full + no explicit limit
		const explicitLimit = args.limit !== undefined;
		let limit = args.limit ?? 50;
		if (!explicitLimit && !lite) {
			limit = 30;
			console.warn(
				`[tasks.listByMission] auto-clamp: limit=30 applied (fields=full, no explicit limit).`,
			);
		}

		// Day 163 (Pi, k171rbm2txe42jxzddyqakbg7n8ch7zr) — same defect and same
		// fix as `runTasksList` above: `createdBefore` was omitted from
		// `needsWideScan`, so a cursor-only call fetched only `limit` rows and
		// then filtered them all out. Included here too.
		const before = args.createdBefore;
		// Eta REVISE on PR #1194 @147d260 — same multi-status/no-status
		// widen-gap as `runTasksList` above: `by_mission` is
		// ["missionId","status"], so with only `missionId` pinned the
		// remaining rows are ordered by `status` first, then
		// `_creationTime` — not pure creation-time order. A narrow
		// `.take(limit)` on a multi-status (or no-status) request grabs
		// `limit` rows skewed to one status bucket, not the union's
		// most-recent. Always widen for those; single-status is unaffected
		// (untouched, per Eta's confirmation on the assignee/index-push path).
		const needsWideScan =
			createdBy !== undefined ||
			updatedSince !== undefined ||
			before !== undefined ||
			statuses === undefined ||
			statuses.length > 1;
		const fetchCap = needsWideScan ? TASK_LIST_SCAN_CAP + 1 : limit;
		// Preferred fix — push the cursor bound into the `by_mission` index
		// range (["missionId","status"], `_creationTime` implicit last field)
		// when a single status is pinned and updatedSince doesn't already
		// occupy the range slot. Unbounded, no SCAN_CAP dependency.
		const canPushCursorIntoIndex =
			before !== undefined &&
			updatedSince === undefined &&
			statuses !== undefined &&
			statuses.length === 1;

		type TaskRow = Doc<"tasks">;
		const applyStatusFilter = (rows: TaskRow[]) => {
			if (statuses === undefined) return rows;
			if (statuses.length === 1)
				return rows.filter((r) => r.status === statuses[0]);
			return rows.filter((r) => statuses.includes(r.status));
		};

		let allRows: TaskRow[];

		if (statuses !== undefined && statuses.length === 1) {
			allRows = await ctx.db
				.query("tasks")
				.withIndex("by_mission", (q) => {
					const base = q.eq("missionId", missionId).eq("status", statuses[0]);
					return canPushCursorIntoIndex
						? base.lt("_creationTime", before as number)
						: base;
				})
				.order("desc")
				.take(canPushCursorIntoIndex ? limit : fetchCap);
		} else {
			const base = await ctx.db
				.query("tasks")
				.withIndex("by_mission", (q) => q.eq("missionId", missionId))
				.order("desc")
				.take(fetchCap);
			allRows = applyStatusFilter(base);
		}

		// Refuse a silently-incomplete page — see `list` above for rationale.
		// Unlike `list`, this branch (missionId) was not measured to exceed the
		// cap in production, so no index was added here — the fetch is still a
		// fixed-size widened scan and "shrink the updatedSince window" would be
		// a false remedy (narrowing the window doesn't change what got fetched).
		// Left out of the message on purpose.
		if (needsWideScan && allRows.length > TASK_LIST_SCAN_CAP) {
			throw new ConvexError(
				`tasks.listByMission: SCAN_CAP_EXCEEDED — widened scan for updatedSince/createdBy/createdBefore hit the cap of ${TASK_LIST_SCAN_CAP} candidate rows before the filter ran. The result would be incomplete and indistinguishable from a full match. Narrow with status.`,
			);
		}

		// v2.3.3 — apply createdBy + updatedSince in-memory
		let filtered = allRows;
		if (createdBy !== undefined) {
			filtered = filtered.filter((r) => r.createdBy === createdBy);
		}
		if (updatedSince !== undefined) {
			filtered = filtered.filter((r) => (r.updatedAt ?? 0) >= updatedSince);
		}
		// Day 163 fix — cursor filter MUST run BEFORE the re-bound to `limit`
		// (same ordering bug as `runTasksList`). No-op on the index-pushed
		// branch above; the actual fix on the wide-scan fallback branch.
		if (before !== undefined) {
			filtered = filtered.filter((r) => r._creationTime < before);
		}
		// Eta REVISE on PR #1194 @147d260 — same re-sort fix as
		// `runTasksList`: the multi-status/no-status branch above fetches
		// through `by_mission` with only `missionId` pinned, so the returned
		// array is ordered by `status` first, then `_creationTime` — not
		// creation-time alone. No-op on the single-status index-push branch.
		filtered = [...filtered].sort((a, b) => b._creationTime - a._creationTime);
		// Re-bound to the requested page size now that every filter AND the
		// creation-time re-sort — including the cursor — has run over the
		// full candidate set.
		filtered = filtered.slice(0, limit);

		if (lite) return filtered.map(projectTaskLite);
		return filtered;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listOverdue — fetch tasks that are past their due date
// ─────────────────────────────────────────────────────────────────────────────

export const listOverdue = query({
	args: {
		assignedTo: v.optional(assigneeValidator),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const limit = args.limit ?? 50;

		let tasks = await ctx.db
			.query("tasks")
			.filter((q) =>
				q.and(
					q.neq(q.field("status"), "done"),
					// Day 157 — a cancelled task is a terminal, non-actionable state;
					// it must never surface as "overdue" (MAJOR #2, convex-reviewer).
					q.neq(q.field("status"), "cancelled"),
					q.neq(q.field("dueDate"), undefined),
					q.lt(q.field("dueDate"), now),
				),
			)
			.take(limit);

		if (args.assignedTo) {
			tasks = tasks.filter((t) => t.assignedTo === args.assignedTo);
		}

		return tasks;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// DEPLOY TASK TITLE PATTERN
// "[Deploy] PR #<prNumber> merged — deploy <repo> to prod"
// ─────────────────────────────────────────────────────────────────────────────
const DEPLOY_TITLE_RE =
	/^\[Deploy\] PR #(\d+) merged — deploy ([\w-]+) to prod$/;

/**
 * Parse a deploy task title into (prNumber, repo) tuple.
 * Returns null if the title does not match the expected pattern.
 */
function parseDeployTitle(
	title: string,
): { prNumber: number; repo: string } | null {
	const m = DEPLOY_TITLE_RE.exec(title);
	if (!m) return null;
	return { prNumber: parseInt(m[1], 10), repo: m[2] };
}

// ─────────────────────────────────────────────────────────────────────────────
// createDeployTaskWithDedup — Fix 1 + Fix 3
//
// Fix 1 (pre-create dedup): if an open deploy task already exists for the same
//   (repo, prNumber) tuple, skip creating a new one and return the existing ID.
//
// Fix 3 (post-create supersede): after creating a new deploy task, mark every
//   other older open deploy task for the same (repo, prNumber) as "done" with
//   completionNote "[SUPERSEDED-BY-k<newId>] <originalTitle>\nfriction_observed:
//   superseded-by-newer-deploy-task".
//
// Called from convex/http.ts GitHub webhook handler (PR merged event).
// ─────────────────────────────────────────────────────────────────────────────
export const createDeployTaskWithDedup = internalMutation({
	args: {
		title: v.string(),
		description: v.optional(v.string()),
		project: v.optional(v.string()),
		assignedTo: assigneeValidator,
		priority: priorityValidator,
		createdBy: creatorValidator,
		tags: v.optional(v.array(v.string())),
		// Day 98 (k173yr5n1) Mechanism (a) — PR merge timestamp (Unix ms).
		// If githubRepoMapping.lastDeployedAt > prMergedAt, the PR was shipped
		// via a bundled deploy that completed AFTER it merged; no per-PR Deploy
		// task is created and null is returned. Omit to disable the dedup
		// (preserves pre-Day 98 behavior for callers not yet plumbing mergedAt).
		prMergedAt: v.optional(v.number()),
	},
	returns: v.union(v.id("tasks"), v.null()),
	handler: async (ctx, args) => {
		const parsed = parseDeployTitle(args.title);
		if (!parsed) {
			// Unexpected title format — fall through to plain create with no dedup.
			const now = Date.now();
			// Strip Day 98 arg (not a task column).
			const { prMergedAt: _ignored, ...taskArgs } = args;
			return await ctx.db.insert("tasks", {
				...taskArgs,
				status: "todo" as const,
				createdAt: now,
				updatedAt: now,
			});
		}

		const { prNumber, repo } = parsed;

		// ── Day 98 Mechanism (a): bundled-deploy dedup by timestamp ───────────
		// If we have prMergedAt AND the repo has a lastDeployedAt newer than
		// the PR merge, this PR was shipped as part of a bundled deploy chain
		// (e.g. C5/Day93 release that bundled #683 + #684 + #685). No new task.
		//
		// Day 98 F1 — the slug captured by DEPLOY_TITLE_RE is the project name
		// (e.g. "vantage-memory") because http.ts builds titles from
		// `mapping.project`. Production githubRepoMapping rows are keyed by
		// full path (`repo: "vantageos-agency/vantage-peers"`), so the prior
		// withIndex by_repo lookup never matched — `lastDeployedAt` was
		// effectively unreadable here. Fix: scan + filter by `project` field.
		// Scan is O(rows) which is fine — there are ≲ 50 mappings fleet-wide.
		if (args.prMergedAt !== undefined) {
			const allMappings = await ctx.db.query("githubRepoMapping").collect();
			// Bug 5 tiebreaker: among all rows sharing the same project, pick the one
			// with lastDeployedAt > 0 (most-recent wins). Fallback: newest _creationTime.
			const projectMappings = allMappings.filter((m) => m.project === repo);
			const withDeploy = projectMappings.filter(
				(m) => m.lastDeployedAt !== undefined && m.lastDeployedAt > 0,
			);
			const mapping =
				withDeploy.length > 0
					? withDeploy.reduce((a, b) =>
							(a.lastDeployedAt ?? 0) >= (b.lastDeployedAt ?? 0) ? a : b,
						)
					: projectMappings.length > 0
						? projectMappings.reduce((a, b) =>
								a._creationTime >= b._creationTime ? a : b,
							)
						: null;
			if (
				mapping &&
				mapping.lastDeployedAt !== undefined &&
				mapping.lastDeployedAt > args.prMergedAt
			) {
				return null;
			}
		}

		// ── Fix 1: pre-create dedup ───────────────────────────────────────────
		// Scan open tasks with "by_status" index for statuses that are not done,
		// then filter in memory for matching (repo, prNumber) in title.
		// We check the four open statuses to keep the query bounded.
		const OPEN_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;

		const existing: Doc<"tasks">[] = [];
		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.collect();
			for (const t of batch) {
				const p = parseDeployTitle(t.title);
				if (p && p.prNumber === prNumber && p.repo === repo) {
					existing.push(t);
				}
			}
		}

		if (existing.length > 0) {
			// At least one open deploy task for the same (repo, prNumber) exists.
			// Skip creating a duplicate — return the most-recently-created one.
			const newest = existing.reduce((a, b) =>
				a.createdAt > b.createdAt ? a : b,
			);
			return newest._id;
		}

		// ── Create the new deploy task ────────────────────────────────────────
		const now = Date.now();
		// Strip Day 98 arg (not a task column).
		const { prMergedAt: _ignoredMergedAt, ...taskArgs } = args;
		const newId = await ctx.db.insert("tasks", {
			...taskArgs,
			status: "todo" as const,
			createdAt: now,
			updatedAt: now,
		});

		// ── Fix 3: post-create supersede ─────────────────────────────────────
		// Find any open deploy tasks for (repo, prNumber) created before newId.
		// (There should be none due to Fix 1, but defend against race conditions.)
		const toSupersede: Doc<"tasks">[] = [];
		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.collect();
			for (const t of batch) {
				if (t._id === newId) continue;
				const p = parseDeployTitle(t.title);
				if (p && p.prNumber === prNumber && p.repo === repo) {
					toSupersede.push(t);
				}
			}
		}

		for (const stale of toSupersede) {
			await ctx.db.patch(stale._id, {
				status: "done" as const,
				completionOutcome: "succeeded" as const,
				completedAt: now,
				updatedAt: now,
				completionNote: `[SUPERSEDED-BY-k${newId}] ${stale.title}\nfriction_observed: superseded-by-newer-deploy-task`,
			});
		}

		return newId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 98 (k173yr5n1) Mechanism (c2) — auto-resolver extension for Deploy tasks
//
// Cron entry: sweeps open `[Deploy] PR #N` tasks. For each, parses the title
// to extract (repo, prNumber), then looks up the repo's lastDeployedAt in
// githubRepoMapping. If lastDeployedAt > task.createdAt, the PR was shipped
// via a bundled deploy after the task was created — close it with an
// evidence-bound completionNote citing the deploy SHA + timestamp.
//
// Pair with Mechanism (a): (a) prevents NEW per-PR Deploy tasks from
// spawning when a deploy already covered the PR. (c2) catches the residual
// ones already created before the orchestrator called recordDeployment.
//
// Bounded by OPEN_STATUSES + same status-index pattern as Fix 1/3 dedup.
// ─────────────────────────────────────────────────────────────────────────────
export const resolveStaleDeployTasks = internalMutation({
	args: {},
	returns: v.object({
		scanned: v.number(),
		closed: v.number(),
		skipped: v.number(),
	}),
	handler: async (ctx) => {
		const OPEN_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;
		let scanned = 0;
		let closed = 0;
		let skipped = 0;

		// Cache repoMapping lookups within a single cron tick.
		const repoCache = new Map<
			string,
			{ lastDeployedAt: number | undefined; lastDeployedSHA: string | undefined } | null
		>();

		// Day 98 F1 — fleet-wide mapping snapshot indexed by project. Same key-
		// mismatch root cause as (a): DEPLOY_TITLE_RE captures project slug, but
		// githubRepoMapping rows key on full repo path. Single snapshot per tick
		// is O(N) where N is mapping count (≲ 50 fleet-wide); per-task lookup
		// becomes a Map.get.
		const allMappings = await ctx.db.query("githubRepoMapping").collect();
		// Bug 5 tiebreaker: group all rows by project, then pick the best one per project.
		// Preference: row with lastDeployedAt > 0 (most-recent wins); fallback: newest _creationTime.
		const projectGroups = new Map<string, (typeof allMappings)[number][]>();
		for (const m of allMappings) {
			const group = projectGroups.get(m.project);
			if (group) {
				group.push(m);
			} else {
				projectGroups.set(m.project, [m]);
			}
		}
		const mappingsByProject = new Map<string, (typeof allMappings)[number]>();
		for (const [project, group] of projectGroups) {
			const withDeploy = group.filter(
				(m) => m.lastDeployedAt !== undefined && m.lastDeployedAt > 0,
			);
			const winner =
				withDeploy.length > 0
					? withDeploy.reduce((a, b) =>
							(a.lastDeployedAt ?? 0) >= (b.lastDeployedAt ?? 0) ? a : b,
						)
					: group.reduce((a, b) =>
							a._creationTime >= b._creationTime ? a : b,
						);
			mappingsByProject.set(project, winner);
		}

		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.collect();
			for (const t of batch) {
				const parsed = parseDeployTitle(t.title);
				if (!parsed) continue;
				scanned++;

				let mapping = repoCache.get(parsed.repo);
				if (mapping === undefined) {
					const row = mappingsByProject.get(parsed.repo) ?? null;
					mapping = row
						? {
								lastDeployedAt: row.lastDeployedAt,
								lastDeployedSHA: row.lastDeployedSHA,
							}
						: null;
					repoCache.set(parsed.repo, mapping);
				}

				if (
					!mapping ||
					mapping.lastDeployedAt === undefined ||
					mapping.lastDeployedAt <= t.createdAt
				) {
					skipped++;
					continue;
				}

				const sha = mapping.lastDeployedSHA ?? "unknown-sha";
				const at = new Date(mapping.lastDeployedAt).toISOString();
				const now = Date.now();
				await ctx.db.patch(t._id, {
					status: "done" as const,
					completionOutcome: "succeeded" as const,
					completedAt: now,
					updatedAt: now,
					completionNote: `Auto-resolved by Day 98 Mechanism (c2) — repo ${parsed.repo} deployed at ${sha} on ${at} (after task createdAt ${new Date(t.createdAt).toISOString()}). PR #${parsed.prNumber} shipped via bundled deploy chain.\nfriction_observed: per-PR Deploy task accumulated before Mechanism (a) was live — cron sweep closes residue.`,
				});
				closed++;
			}
		}

		console.log(
			`[Mechanism c2] resolveStaleDeployTasks scanned=${scanned} closed=${closed} skipped=${skipped}`,
		);
		return { scanned, closed, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// bulkComplete — PR-F bulk close matching tasks (cron-spam cleanup)
//
// Safety: dryRun defaults to true — callers must explicitly pass dryRun=false
// to mutate. When dryRun=true returns {count, sampleIds} preview without
// touching any task. When dryRun=false, closes all matched tasks and returns
// {count, sampleIds, bulkRunId, executedAt}.
//
// Cron detection signals (same as PR-E excludeAutoGenerated):
//   1. createdBy matches /^cron-/i  (dash required)
//   2. title    matches /^\/?check-messages$/i  (exact whole-string)
//
// RBAC: when callerOrchestrator is provided and is not "system", every matched
// task must have createdBy === callerOrchestrator OR assignedTo === callerOrchestrator.
// If any matched task violates this, throws RBAC_DENIED.
// ─────────────────────────────────────────────────────────────────────────────

/** Day 1 = 2026-03-06 UTC (project epoch). */
const PROJECT_EPOCH_MS = Date.UTC(2026, 2, 6); // month is 0-indexed

function computeDayNumber(nowMs: number): number {
	return Math.floor((nowMs - PROJECT_EPOCH_MS) / 86_400_000) + 1;
}

function randomHex(bytes: number): string {
	const chars = "0123456789abcdef";
	let result = "";
	for (let i = 0; i < bytes * 2; i++) {
		result += chars[Math.floor(Math.random() * chars.length)];
	}
	return result;
}

function renderTemplate(
	template: string,
	vars: { day: number; bulkRunId: string; executedAt: number },
): string {
	return template
		.replace(/\{\{day\}\}/g, String(vars.day))
		.replace(/\{\{bulkRunId\}\}/g, vars.bulkRunId)
		.replace(/\{\{executedAt\}\}/g, String(vars.executedAt));
}

/** Hard cap to prevent blast radius beyond a realistic cron-spam batch. */
const BULK_COMPLETE_HARD_CAP = 500;

/**
 * Day 163 (Pi, k171rbm2txe42jxzddyqakbg7n8ch7zr) — bulkComplete's live path
 * used to REFUSE outright once matched > cap ("Narrow your filter and
 * retry"), even when both filter fields were already at their narrowest
 * (autoGeneratedOnly + assignedTo both set). That instruction had no
 * followable next step. Fixed two ways:
 *   1. A third filter dimension — `status` — lets a caller narrow the scan
 *      to a single open status instead of all four.
 *   2. The live path now DRAINS in cap-sized batches instead of throwing:
 *      it closes up to BULK_COMPLETE_HARD_CAP matching tasks and reports
 *      `remaining: true` when more exist. Because the scan is over
 *      non-done statuses, closing this batch removes it from the NEXT
 *      call's candidate set automatically — repeated calls with the same
 *      filter terminate the whole pile without any external purge script.
 *   The count is exact when the scan didn't hit the cap, and explicitly
 *   labelled (`cappedAt` + `remaining: true`) when it did — never a bare
 *   scan-stop sentinel presented as a total.
 */
export const bulkComplete = mutation({
	args: {
		filter: v.object({
			autoGeneratedOnly: v.optional(v.boolean()),
			assignedTo: v.optional(v.string()),
			// Day 163 — narrows the scan to a single open status instead of the
			// full todo/in_progress/review/blocked sweep. Counts as a reductive
			// predicate on its own (it directly bounds what the index scan sees).
			status: v.optional(
				v.union(
					v.literal("todo"),
					v.literal("in_progress"),
					v.literal("review"),
					v.literal("blocked"),
				),
			),
		}),
		dryRun: v.optional(v.boolean()),
		completionNoteTemplate: v.optional(v.string()),
		callerOrchestrator: v.optional(v.string()),
		// [P-T5] THE LOCK — see requireAgentCredentialMatch. When presented,
		// `callerOrchestrator` (the asserted actor) must equal the resolved
		// agent identity; no-op if omitted.
		agentCredentialSecret: v.optional(v.string()),
	},
	returns: v.object({
		count: v.number(),
		sampleIds: v.array(v.id("tasks")),
		bulkRunId: v.string(),
		executedAt: v.optional(v.number()),
		cappedAt: v.optional(v.number()),
		// Day 163 — true when the scan stopped at the cap and more matching
		// (non-done) rows may exist beyond it. On the live path this also
		// means: call again with the same filter to drain the remainder,
		// because this batch is now "done" and drops out of the next scan.
		remaining: v.optional(v.boolean()),
	}),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("tasks:bulkComplete", …) at mcp-server/src/tools.ts:4303 (imperative), never a subscribing pre-org client shell; the AUTH_REQUIRED/RBAC_DENIED throw is an R-16 refusal the MCP layer catches, not an uncaught Server Error.
		// SECURITY REMEDIATION (task k1712yrxjr570m6ks81rnhjh5n8cryf0) — required
		// on the dry-run preview path too, not only the live write path: a
		// dry-run still discloses task titles/ids/counts to whoever calls it.
		await requireAuthenticatedCaller(
			ctx,
			args.callerOrchestrator,
			args.agentCredentialSecret,
		);

		// Default dryRun to true (safety).
		const dryRun = args.dryRun !== false;

		// Must-fix #3: dryRun=false requires callerOrchestrator.
		if (!dryRun && !args.callerOrchestrator) {
			throw new ConvexError(
				"BULK_CALLER_REQUIRED: callerOrchestrator must be provided for live (dryRun=false) bulk operations.",
			);
		}

		// Must-fix #1: require at least one reductive predicate before scanning.
		const hasAutoGeneratedOnly = args.filter.autoGeneratedOnly === true;
		const hasAssignedTo =
			args.filter.assignedTo !== undefined && args.filter.assignedTo !== "";
		const hasStatus = args.filter.status !== undefined;
		if (!hasAutoGeneratedOnly && !hasAssignedTo && !hasStatus) {
			throw new ConvexError(
				"BULK_FILTER_TOO_BROAD: at least one reductive predicate required (autoGeneratedOnly, assignedTo, or status).",
			);
		}

		// Iterate non-done tasks via index with early-stop at cap+1.
		// The +1 allows dry-run to accurately report "more than cap" without
		// scanning the entire table. `status` narrows the outer loop itself
		// when supplied, instead of always sweeping all four open statuses.
		const matched: Doc<"tasks">[] = [];
		const statuses = hasStatus
			? ([args.filter.status as NonNullable<typeof args.filter.status>] as const)
			: (["todo", "in_progress", "review", "blocked"] as const);

		outer: for (const status of statuses) {
			const cursor = ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status));
			for await (const task of cursor) {
				const cronMatch =
					hasAutoGeneratedOnly &&
					(/^cron-/i.test(task.createdBy ?? "") ||
						/^\/?check-messages$/i.test(task.title ?? ""));
				const assignedMatch =
					hasAssignedTo && task.assignedTo === args.filter.assignedTo;

				let include: boolean;
				if (hasAutoGeneratedOnly && hasAssignedTo) {
					include = cronMatch && assignedMatch;
				} else if (hasAutoGeneratedOnly) {
					include = cronMatch;
				} else if (hasAssignedTo) {
					include = assignedMatch;
				} else {
					// status-only filter: every row in this status matches.
					include = true;
				}

				if (include) {
					matched.push(task);
					// Collect cap+1 to detect overflow without scanning entire table.
					if (matched.length > BULK_COMPLETE_HARD_CAP) {
						break outer;
					}
				}
			}
		}

		const exceeded = matched.length > BULK_COMPLETE_HARD_CAP;
		// Truncate to cap (the +1 overflow sentinel is not included in results).
		// Day 163 — the live path no longer throws BULK_HARD_CAP_EXCEEDED here;
		// it drains this batch and reports `remaining: true` instead (see the
		// doc comment above the mutation for why repeated calls terminate).
		const cappedResults = matched.slice(0, BULK_COMPLETE_HARD_CAP);

		// RBAC check: when callerOrchestrator is provided and is not "system",
		// every matched task must have createdBy or assignedTo equal to caller.
		// NOT the same class as the update/complete/start/deleteTask bug: this
		// `!== undefined` is only reachable on the READ-ONLY dryRun preview path
		// (any write requires dryRun=false, and BULK_CALLER_REQUIRED above
		// already makes callerOrchestrator mandatory before a write can happen —
		// omission never bypasses a mutation here, class sweep 2026-07-23).
		if (args.callerOrchestrator !== undefined && args.callerOrchestrator !== "system") {
			const caller = args.callerOrchestrator;
			const denied = cappedResults.find(
				(r) => r.createdBy !== caller && r.assignedTo !== caller,
			);
			if (denied !== undefined) {
				throw new ConvexError(
					`RBAC_DENIED: ${caller} is not creator or assignee of task ${denied._id} — bulk close denied`,
				);
			}
		}

		const count = cappedResults.length;
		const sampleIds = cappedResults.slice(0, 10).map((r) => r._id);

		const now = Date.now();
		const bulkRunId = `bulk-${now}-${randomHex(4)}`;

		if (dryRun) {
			return {
				count,
				sampleIds,
				bulkRunId,
				executedAt: undefined as number | undefined,
				...(exceeded
					? { cappedAt: BULK_COMPLETE_HARD_CAP, remaining: true }
					: {}),
			};
		}

		// dryRun=false — mutate.
		const executedAt = now;
		const day = computeDayNumber(now);
		const template =
			args.completionNoteTemplate ??
			"bulk-cleanup: cron-spam day {{day}} runId={{bulkRunId}} executedAt={{executedAt}}";
		const note = renderTemplate(template, { day, bulkRunId, executedAt });

		// Day 130 closure gate — bulkComplete is the SECOND closure path
		// (tasks.complete is the first). Gate every matched task the same
		// way, up front, so a single billable-but-never-started task in the
		// batch aborts the whole bulk operation loudly rather than silently
		// closing it with a false actualMinutes.
		const gateResults = await Promise.all(
			cappedResults.map((task) => enforceClosureGate(ctx, task, note, now)),
		);

		for (let i = 0; i < cappedResults.length; i++) {
			const task = cappedResults[i];
			const { actualMinutes } = gateResults[i];
			await ctx.db.patch(task._id, {
				status: "done" as const,
				completionOutcome: "succeeded" as const,
				completedAt: now,
				updatedAt: now,
				completionNote: note,
				...(actualMinutes !== undefined ? { actualMinutes } : {}),
			});
		}

		return {
			count,
			sampleIds,
			bulkRunId,
			executedAt,
			...(exceeded
				? { cappedAt: BULK_COMPLETE_HARD_CAP, remaining: true }
				: {}),
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// billingSummaryByProject — Day 130 (k17dhcmzqafve1ayzvh833kf558ae019)
// deliverable #6: refacturation base. Sums `actualMinutes` (machine-derived
// startedAt→completedAt, never a hand-typed line) grouped by `project` for
// tasks completed within [startDate, endDate].
//
// Day-131 live-defect fix: the scan is now bounded BY THE INDEX on
// [status, completedAt] (or [status, project, completedAt] when a project
// filter is supplied), so the requested period bounds the QUERY itself —
// not a post-hoc in-memory filter applied after an unrelated fixed-size scan
// of the oldest rows. `truncated: true` now means exactly what it says: the
// PERIOD (optionally + project) itself produced more rows than the cap, not
// "the table has more done tasks somewhere else than the cap allows".
// ─────────────────────────────────────────────────────────────────────────────

const BILLING_SUMMARY_SCAN_CAP = 5000;

export const billingSummaryByProject = query({
	args: {
		startDate: v.number(), // Unix ms, inclusive
		endDate: v.number(), // Unix ms, inclusive
		// Optional — when supplied, pushed into the index-backed query itself
		// (by_status_project_completedAt), never applied as a post-hoc filter
		// over an unfiltered scan (that would reproduce the same "bound applied
		// after the fetch" defect this handler was fixed for).
		project: v.optional(v.string()),
	},
	returns: v.object({
		byProject: v.array(
			v.object({
				project: v.string(),
				totalMinutes: v.number(),
				taskCount: v.number(),
			}),
		),
		unattributedTaskCount: v.number(), // done tasks in range with no project or no actualMinutes
		// Rows excluded because actualMinutes < 0 — an impossible value (e.g.
		// completedAt earlier than startedAt, or a bad write). Never silently
		// summed and never clamped to zero — surfaced here so the caller sees
		// "N rows were unusable" instead of a quietly wrong (or negative) total.
		invalidDurationTaskCount: v.number(),
		truncated: v.boolean(),
	}),
	handler: async (ctx, args) => {
		if (args.endDate < args.startDate) {
			throw new ConvexError(
				`INVALID_RANGE: endDate (${args.endDate}) must be >= startDate (${args.startDate})`,
			);
		}

		const scope = await withOrgScope(ctx);
		requireScope(scope, "view-own-tasks");

		const project = args.project;

		// Index-bounded scan: the period (and project, when supplied) bounds
		// the QUERY, not an in-memory filter applied after the fetch.
		const doneTasks =
			project !== undefined
				? await ctx.db
						.query("tasks")
						.withIndex("by_status_project_completedAt", (q) =>
							q
								.eq("status", "done")
								.eq("project", project)
								.gte("completedAt", args.startDate)
								.lte("completedAt", args.endDate),
						)
						.take(BILLING_SUMMARY_SCAN_CAP + 1)
				: await ctx.db
						.query("tasks")
						.withIndex("by_status_completedAt", (q) =>
							q
								.eq("status", "done")
								.gte("completedAt", args.startDate)
								.lte("completedAt", args.endDate),
						)
						.take(BILLING_SUMMARY_SCAN_CAP + 1);

		const truncated = doneTasks.length > BILLING_SUMMARY_SCAN_CAP;
		const capped = doneTasks.slice(0, BILLING_SUMMARY_SCAN_CAP);
		const scoped = filterByOrgScope(capped, scope);

		const totals = new Map<string, { totalMinutes: number; taskCount: number }>();
		let unattributedTaskCount = 0;
		let invalidDurationTaskCount = 0;

		for (const task of scoped) {
			if (task.project === undefined || task.actualMinutes === undefined) {
				unattributedTaskCount++;
				continue;
			}
			if (task.actualMinutes < 0) {
				invalidDurationTaskCount++;
				continue;
			}
			const existing = totals.get(task.project) ?? {
				totalMinutes: 0,
				taskCount: 0,
			};
			existing.totalMinutes += task.actualMinutes;
			existing.taskCount += 1;
			totals.set(task.project, existing);
		}

		const byProject = Array.from(totals.entries())
			.map(([proj, agg]) => ({ project: proj, ...agg }))
			.sort((a, b) => b.totalMinutes - a.totalMinutes);

		return { byProject, unattributedTaskCount, invalidDurationTaskCount, truncated };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// taskDurationDistribution — feat/duration-distribution-instrument.
// billingSummaryByProject excludes NEGATIVE actualMinutes (a sign check) but
// has no view on aberrant POSITIVE values: a single task can carry 74904 or
// 64734 minutes (weeks of wall-clock) straight into an invoice. This query
// measures the distribution so an aberration threshold can be DERIVED from
// real data — it corrects nothing, it never mutates, never estimates.
//
// Same index-bounded-scan discipline as billingSummaryByProject: the period
// (and project, when supplied) bounds the QUERY via by_status_completedAt /
// by_status_project_completedAt — never a post-hoc filter over an unrelated
// fixed-size scan.
// ─────────────────────────────────────────────────────────────────────────────

const DURATION_DISTRIBUTION_SCAN_CAP = 5000;

// count === 0 must never render as "a flat distribution" (all-zero
// percentiles read exactly like "every task took 0 minutes", which is a
// false measurement, not an absence of one). This sentinel is the explicit
// "could not measure" value — the caller must branch on `count === 0` rather
// than read the percentiles as data.
const NO_DATA_SENTINEL = -1;

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return NO_DATA_SENTINEL;
	if (sorted.length === 1) return sorted[0];
	const rank = (p / 100) * (sorted.length - 1);
	const lower = Math.floor(rank);
	const upper = Math.ceil(rank);
	if (lower === upper) return sorted[lower];
	const weight = rank - lower;
	return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

export const taskDurationDistribution = query({
	args: {
		from: v.optional(v.number()), // Unix ms, inclusive
		to: v.optional(v.number()), // Unix ms, inclusive
		project: v.optional(v.string()),
	},
	returns: v.object({
		count: v.number(),
		percentiles: v.object({
			p50: v.number(),
			p75: v.number(),
			p90: v.number(),
			p95: v.number(),
			p99: v.number(),
			max: v.number(),
		}),
		negativeCount: v.number(),
		withProjectCount: v.number(),
		withoutProjectCount: v.number(),
		truncated: v.boolean(),
	}),
	handler: async (ctx, args) => {
		if (args.from !== undefined && args.to !== undefined && args.to < args.from) {
			throw new ConvexError(
				`INVALID_RANGE: to (${args.to}) must be >= from (${args.from})`,
			);
		}

		const scope = await withOrgScope(ctx);
		requireScope(scope, "view-own-tasks");

		const project = args.project;
		const from = args.from ?? -Infinity;
		const to = args.to ?? Infinity;

		// Index-bounded scan: the period (and project, when supplied) bounds
		// the QUERY, not an in-memory filter applied after the fetch.
		const doneTasks =
			project !== undefined
				? await ctx.db
						.query("tasks")
						.withIndex("by_status_project_completedAt", (q) =>
							q.eq("status", "done").eq("project", project).gte("completedAt", from).lte("completedAt", to),
						)
						.take(DURATION_DISTRIBUTION_SCAN_CAP + 1)
				: await ctx.db
						.query("tasks")
						.withIndex("by_status_completedAt", (q) =>
							q.eq("status", "done").gte("completedAt", from).lte("completedAt", to),
						)
						.take(DURATION_DISTRIBUTION_SCAN_CAP + 1);

		const truncated = doneTasks.length > DURATION_DISTRIBUTION_SCAN_CAP;
		const capped = doneTasks.slice(0, DURATION_DISTRIBUTION_SCAN_CAP);
		const scoped = filterByOrgScope(capped, scope);

		let negativeCount = 0;
		let withProjectCount = 0;
		let withoutProjectCount = 0;
		const durations: number[] = [];

		for (const task of scoped) {
			if (task.actualMinutes === undefined) continue;
			if (task.actualMinutes < 0) {
				negativeCount++;
				continue;
			}
			if (task.project === undefined) {
				withoutProjectCount++;
			} else {
				withProjectCount++;
			}
			durations.push(task.actualMinutes);
		}

		durations.sort((a, b) => a - b);
		const count = durations.length;

		// count === 0: no positive-duration rows measured in the period. The
		// sentinel makes this explicit rather than silently reporting zeros
		// that would read as "every task took 0 minutes" — a false measurement
		// distinct from "we could not measure".
		const percentiles =
			count === 0
				? {
						p50: NO_DATA_SENTINEL,
						p75: NO_DATA_SENTINEL,
						p90: NO_DATA_SENTINEL,
						p95: NO_DATA_SENTINEL,
						p99: NO_DATA_SENTINEL,
						max: NO_DATA_SENTINEL,
					}
				: {
						p50: percentile(durations, 50),
						p75: percentile(durations, 75),
						p90: percentile(durations, 90),
						p95: percentile(durations, 95),
						p99: percentile(durations, 99),
						max: durations[durations.length - 1],
					};

		return {
			count,
			percentiles,
			negativeCount,
			withProjectCount,
			withoutProjectCount,
			truncated,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r).
// BM25 keyword search over task titles via Convex native .searchIndex().
//
// Backed by the `search_title` searchIndex declared in schema.ts. Filter fields
// (assignedTo, status, project, missionId) are pushed into the index so the
// scoped + filtered query stays sub-linear at fleet scale (~2 - 30k tasks).

export const searchTasksByKeyword = query({
	args: {
		query: v.string(),
		assignedTo: v.optional(assigneeValidator),
		status: v.optional(
			v.union(
				v.literal("todo"),
				v.literal("in_progress"),
				v.literal("review"),
				v.literal("blocked"),
				v.literal("done"),
			),
		),
		project: v.optional(v.string()),
		missionId: v.optional(v.id("missions")),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
	},
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx);
		requireScope(scope, "view-own-tasks");

		const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
		const lite = args.fields === "lite";

		const results = await ctx.db
			.query("tasks")
			.withSearchIndex("search_title", (q) => {
				let qb = q.search("title", args.query);
				if (args.assignedTo !== undefined) {
					qb = qb.eq("assignedTo", args.assignedTo);
				}
				if (args.status !== undefined) {
					qb = qb.eq("status", args.status);
				}
				if (args.project !== undefined) {
					qb = qb.eq("project", args.project);
				}
				if (args.missionId !== undefined) {
					qb = qb.eq("missionId", args.missionId);
				}
				if (!scope.isMaster && scope.orgSlug !== null) {
					qb = qb.eq("orgId", scope.orgSlug);
				}
				return qb;
			})
			.take(limit);

		const filtered = filterByOrgScope(results, scope);

		if (!lite) return filtered;
		return filtered.map((t) => ({
			_id: t._id,
			title: t.title,
			status: t.status,
			priority: t.priority,
			assignedTo: t.assignedTo,
			missionId: t.missionId,
		}));
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW TASK LIFECYCLE — Day 127 (repo /root/coding/vantage-memory)
//
// Measured bug: on a real Eta queue of 28 "[Review]" todo tasks, ~20 were dead
// (their PR already MERGED, task never closed) and 6 were strict duplicates
// (PR #1073 x4 — 1 opened + 3 pushes; #1075/#1076/#1078/#1071/#250 x2 each).
//
// Title pattern created by convex/http.ts on pull_request opened/synchronize:
//   "[Review] <repoFullName> PR #<prNumber>: <prTitle>"
//
// This mirrors the createDeployTaskWithDedup mechanism (Fix 1 pre-create
// dedup) but with a DIFFERENT resolution on repeat events: rather than
// superseding (create-new + mark-old-done), a repeat synchronize UPDATES the
// existing open review task in place (new title/description/tags) — a review
// task represents "please review the current state of PR #N", not a series
// of independent events, so there is nothing to supersede, only to refresh.
// ─────────────────────────────────────────────────────────────────────────────

// repoFullName may contain "/" (e.g. "org/repo"); prTitle may contain
// arbitrary text including ":" — greedy `.+` naturally backtracks to the
// rightmost " PR #<digits>: " split point, which matches how the title was
// built (repoFullName is always the first token group, with no user-supplied
// wildcards ahead of " PR #").
const REVIEW_TITLE_RE = /^\[Review\] (.+) PR #(\d+): ([\s\S]*)$/;

/**
 * Parse a "[Review] <repoFullName> PR #<prNumber>: <prTitle>" task title.
 * Returns null if the title does not match the expected pattern.
 */
function parseReviewTitle(
	title: string,
): { repoFullName: string; prNumber: number; prTitle: string } | null {
	const m = REVIEW_TITLE_RE.exec(title);
	if (!m) return null;
	return { repoFullName: m[1], prNumber: parseInt(m[2], 10), prTitle: m[3] };
}

const REVIEW_OPEN_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;

/**
 * Find all currently-open "[Review]" tasks matching a (repoFullName,
 * prNumber) tuple. Scans the by_status index per open status (bounded to 4
 * scans), then filters in memory by parsing the title — same pattern as
 * createDeployTaskWithDedup's Fix 1/Fix 3 scans.
 */
async function findOpenReviewTasks(
	ctx: MutationCtx,
	repoFullName: string,
	prNumber: number,
): Promise<Doc<"tasks">[]> {
	const matches: Doc<"tasks">[] = [];
	for (const status of REVIEW_OPEN_STATUSES) {
		const batch = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", status))
			.collect();
		for (const t of batch) {
			const p = parseReviewTitle(t.title);
			if (p && p.repoFullName === repoFullName && p.prNumber === prNumber) {
				matches.push(t);
			}
		}
	}
	return matches;
}

/**
 * createOrUpdateReviewTask — dedup key is (repoFullName, prNumber), NOT
 * prNumber alone (fixes cross-repo collisions on shared PR numbers).
 *
 * - No open review task for this tuple -> insert a new one.
 * - An open review task already exists -> UPDATE it in place (new title,
 *   description, tags, updatedAt) instead of creating a duplicate. This is
 *   what makes repeated `synchronize` events on the same PR collapse to a
 *   single row.
 */
export const createOrUpdateReviewTask = internalMutation({
	args: {
		repoFullName: v.string(),
		prNumber: v.number(),
		prTitle: v.string(),
		description: v.optional(v.string()),
		assignedTo: assigneeValidator,
		project: v.optional(v.string()),
		priority: priorityValidator,
		createdBy: creatorValidator,
		tags: v.optional(v.array(v.string())),
	},
	returns: v.id("tasks"),
	handler: async (ctx, args) => {
		const title = `[Review] ${args.repoFullName} PR #${args.prNumber}: ${args.prTitle}`;
		const now = Date.now();

		const existing = await findOpenReviewTasks(
			ctx,
			args.repoFullName,
			args.prNumber,
		);

		if (existing.length > 0) {
			// Update the most-recently-created open review task in place.
			const target = existing.reduce((a, b) =>
				a.createdAt > b.createdAt ? a : b,
			);
			// NOTE (Eta REVISE #1254): title/tags are re-patched here but `isReviewTask`
			// is DELIBERATELY NOT re-stamped — review-ness is fixed at create and must
			// not change afterwards (that immutability is the whole point of the field).
			// Do NOT "fix" this by recomputing isReviewTask on update: it would reopen the
			// forgery from inside the automation.
			await ctx.db.patch(target._id, {
				title,
				description: args.description,
				tags: args.tags,
				priority: args.priority,
				updatedAt: now,
			});
			return target._id;
		}

		return await ctx.db.insert("tasks", {
			title,
			description: args.description,
			project: args.project,
			assignedTo: args.assignedTo,
			priority: args.priority,
			status: "todo" as const,
			createdBy: args.createdBy,
			tags: args.tags,
			// Stamp review-ness at CREATE from the automation-built title (Eta REVISE
			// #1254): this internalMutation is the PR-sync path that makes EVERY review
			// task in a reviewer's real queue — its "[Review] <repo> PR #<n>: …" title makes
			// computeIsReviewTask true, so the reviewer-reclaim branch fires for them.
			isReviewTask: computeIsReviewTask(title, args.tags),
			createdAt: now,
			updatedAt: now,
			// Day 130 follow-up #2 — the inforgeable automation signal. This
			// internalMutation is the ONLY code path that writes `origin`;
			// it is unreachable from the public MCP surface (webhook-only).
			origin: "automation" as const,
		});
	},
});

/**
 * closeReviewTasksForPr — closes every OPEN "[Review]" task matching
 * (repoFullName, prNumber). Called from convex/http.ts on `pull_request`
 * `closed`, REGARDLESS of whether the PR was merged: once the PR is closed,
 * there is nothing left to review either way (merged -> covered by the
 * separate Deploy-task flow; closed-without-merge -> review is moot).
 *
 * Keyed on the ROW's title-embedded PR link (repoFullName + prNumber),
 * NEVER on `createdBy`/`origin` — findOpenReviewTasks matches ANY row whose
 * title parses to this (repoFullName, prNumber) tuple, regardless of which
 * code path inserted it. This is what makes the close idempotent: rows
 * already "done" are excluded by findOpenReviewTasks (it only scans
 * REVIEW_OPEN_STATUSES), so a webhook delivered twice for the same PR finds
 * zero matches on the second pass and changes nothing (delta zero) — and a
 * row a human already closed by hand stays closed for the same reason.
 *
 * `mergeCommitSha` (optional) is appended to the completion note so the
 * merge commit is carried on the row without adding a new schema field.
 */
export const closeReviewTasksForPr = internalMutation({
	args: {
		repoFullName: v.string(),
		prNumber: v.number(),
		completionNote: v.string(),
		mergeCommitSha: v.optional(v.string()),
	},
	returns: v.object({ closed: v.number() }),
	handler: async (ctx, args) => {
		const now = Date.now();
		const matches = await findOpenReviewTasks(
			ctx,
			args.repoFullName,
			args.prNumber,
		);

		const note = args.mergeCommitSha
			? `${args.completionNote} (merge commit ${args.mergeCommitSha})`
			: args.completionNote;

		for (const t of matches) {
			await ctx.db.patch(t._id, {
				status: "done" as const,
				completionOutcome: "succeeded" as const,
				completedAt: now,
				updatedAt: now,
				completionNote: note,
			});
		}

		return { closed: matches.length };
	},
});

/**
 * listReviewBacklogByLineage — backlog-sweep support query (task
 * k17bh19d6zzf73417j6a9623nn8dh8ek). Scans every OPEN review-tagged row and
 * splits it by lineage:
 *   - "automation": title parses as "[Review] <repo> PR #<n>: …"
 *     (createOrUpdateReviewTask's format) — carries a reliable PR link and
 *     CAN be closed by closeReviewTasksForPr once the PR's terminal state is
 *     known.
 *   - "bootstrap": isReviewTask (tags include "review" or a "[review]"
 *     title) but the title does NOT parse to a (repoFullName, prNumber)
 *     tuple — e.g. the IRP mission-template "Code Review" step
 *     (missionTemplates.ts), whose title is "[#<issueNumber>] T<i> — Code
 *     Review" and links only to a GitHub ISSUE (via missionId), never to a
 *     PR. These rows carry NO reliable PR link at all — a PR-terminal-state
 *     sweep cannot key on a link that does not exist for them. Their actual
 *     closer is `issueClosedSweepDb.cascadeCloseMission`, triggered when the
 *     linked GH ISSUE (not PR) closes.
 */
export const listReviewBacklogByLineage = internalQuery({
	args: {},
	returns: v.object({
		automation: v.array(
			v.object({
				_id: v.id("tasks"),
				title: v.string(),
				repoFullName: v.string(),
				prNumber: v.number(),
			}),
		),
		bootstrapNoPrLink: v.array(
			v.object({
				_id: v.id("tasks"),
				title: v.string(),
			}),
		),
	}),
	handler: async (ctx) => {
		const automation: { _id: Id<"tasks">; title: string; repoFullName: string; prNumber: number }[] = [];
		const bootstrapNoPrLink: { _id: Id<"tasks">; title: string }[] = [];

		for (const status of REVIEW_OPEN_STATUSES) {
			const batch = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.collect();
			for (const t of batch) {
				const parsed = parseReviewTitle(t.title);
				if (parsed) {
					automation.push({
						_id: t._id,
						title: t.title,
						repoFullName: parsed.repoFullName,
						prNumber: parsed.prNumber,
					});
					continue;
				}
				if (isReviewTask(t) || t.tags?.includes("review")) {
					bootstrapNoPrLink.push({ _id: t._id, title: t.title });
				}
			}
		}

		return { automation, bootstrapNoPrLink };
	},
});
