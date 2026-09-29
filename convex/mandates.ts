import { v, ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireId } from "./lib/ids";
import { creatorValidator } from "./schema";
import { requireResolvedCaller, withOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// requireFleetMaster — mandates.ts's own single authority gate.
//
// `mandates` carries NO orgId/tenant field (see schema.ts:660) — requestedBy/
// fulfilledBy are fleet ORCHESTRATOR names (pi/tau/sigma/alpha…), not client
// organisations. There is no per-tenant row to scope against, so the only
// sound authority boundary is: the caller must be the verified fleet master
// (the real master secret / recognised service-account carve-out —
// convex/lib/auth.ts's withOrgScope). A Clerk-org (tenant client) identity is
// REFUSED here just like an anonymous one — a mandate is a fleet-internal
// commercial object between orchestrators, never a client-facing write
// surface, regardless of what callerOrchestrator string is presented
// (defect class: .claude/rules/authority-attached-to-anonymous-object.md —
// callerOrchestrator is a caller-supplied ASSERTION, never a verified
// identity, and was previously the ONLY check these mutations performed).
// ─────────────────────────────────────────────────────────────────────────────
async function requireFleetMaster(
	ctx: Parameters<typeof withOrgScope>[0],
	action: string,
): Promise<void> {
	const scope = await withOrgScope(ctx);
	if (!scope.isMaster) {
		throw new ConvexError(
			`RBAC_DENIED: caller may not ${action} — mandates are fleet-internal, master-only — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const mandateStatusValidator = v.union(
	v.literal("requested"),
	v.literal("accepted"),
	v.literal("in_progress"),
	v.literal("delivered"),
	v.literal("settled"),
);

// Full mandate object shape — used in query returns
const mandateObject = v.object({
	_id: v.id("mandates"),
	_creationTime: v.number(),
	requestedBy: creatorValidator,
	fulfilledBy: creatorValidator,
	service: v.string(),
	budget: v.number(),
	status: mandateStatusValidator,
	linkedTaskIds: v.optional(v.array(v.id("tasks"))),
	tokensCost: v.optional(v.number()),
	createdAt: v.number(),
	updatedAt: v.number(),
	completedAt: v.optional(v.number()),
	spendingLimits: v.optional(v.object({
		maxPerTransaction: v.number(),
		maxPerPeriod: v.number(),
		periodDays: v.optional(v.number()),
	})),
	approvedCategories: v.optional(v.array(v.string())),
	mandateDocument: v.optional(v.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new mandate
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		requestedBy: creatorValidator,
		fulfilledBy: creatorValidator,
		service: v.string(),
		budget: v.number(),
		spendingLimits: v.optional(v.object({
			maxPerTransaction: v.number(),
			maxPerPeriod: v.number(),
			periodDays: v.optional(v.number()),
		})),
		approvedCategories: v.optional(v.array(v.string())),
		mandateDocument: v.optional(v.string()),
	},
	returns: v.id("mandates"),
	handler: async (ctx, args) => {
		await requireFleetMaster(ctx, "create a mandate");
		const now = Date.now();
		return await ctx.db.insert("mandates", {
			requestedBy: args.requestedBy,
			fulfilledBy: args.fulfilledBy,
			service: args.service,
			budget: args.budget,
			status: "requested",
			createdAt: now,
			updatedAt: now,
			...(args.spendingLimits !== undefined && { spendingLimits: args.spendingLimits }),
			...(args.approvedCategories !== undefined && { approvedCategories: args.approvedCategories }),
			...(args.mandateDocument !== undefined && { mandateDocument: args.mandateDocument }),
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// accept — fulfilledBy confirms they will take on the mandate
// ─────────────────────────────────────────────────────────────────────────────

export const accept = mutation({
	args: {
		mandateId: v.id("mandates"),
		callerOrchestrator: creatorValidator,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireFleetMaster(ctx, `accept mandate ${args.mandateId}`);
		const mandate = await ctx.db.get(args.mandateId);
		if (mandate === null) {
			throw new Error(`Mandate ${args.mandateId} not found`);
		}
		if (args.callerOrchestrator !== "system" && args.callerOrchestrator !== mandate.fulfilledBy) {
			throw new Error(
				`Unauthorized: only ${mandate.fulfilledBy} (fulfilledBy) or system can accept this mandate`,
			);
		}
		await ctx.db.patch(args.mandateId, {
			status: "accepted",
			updatedAt: Date.now(),
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of mandate fields (fulfilledBy only)
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		mandateId: v.id("mandates"),
		callerOrchestrator: creatorValidator,
		status: v.optional(mandateStatusValidator),
		tokensCost: v.optional(v.number()),
		linkedTaskIds: v.optional(v.array(v.id("tasks"))),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireFleetMaster(ctx, `update mandate ${args.mandateId}`);
		const mandate = await ctx.db.get(args.mandateId);
		if (mandate === null) {
			throw new Error(`Mandate ${args.mandateId} not found`);
		}
		if (args.callerOrchestrator !== "system" && args.callerOrchestrator !== mandate.fulfilledBy) {
			throw new Error(
				`Unauthorized: only ${mandate.fulfilledBy} (fulfilledBy) or system can update this mandate`,
			);
		}

		const { mandateId, callerOrchestrator, ...fields } = args;

		// Build patch object with only provided fields
		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}

		await ctx.db.patch(mandateId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// settle — requestedBy confirms delivery and records final cost
// ─────────────────────────────────────────────────────────────────────────────

export const settle = mutation({
	args: {
		mandateId: v.id("mandates"),
		callerOrchestrator: creatorValidator,
		finalCost: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireFleetMaster(ctx, `settle mandate ${args.mandateId}`);
		const mandate = await ctx.db.get(args.mandateId);
		if (mandate === null) {
			throw new Error(`Mandate ${args.mandateId} not found`);
		}
		if (args.callerOrchestrator !== "system" && args.callerOrchestrator !== mandate.requestedBy) {
			throw new Error(
				`Unauthorized: only ${mandate.requestedBy} (requestedBy) or system can settle this mandate`,
			);
		}
		const now = Date.now();
		await ctx.db.patch(args.mandateId, {
			status: "settled",
			tokensCost: args.finalCost,
			completedAt: now,
			updatedAt: now,
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list mandates with optional filters, newest first
// ─────────────────────────────────────────────────────────────────────────────

// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m). When
// paginating via `createdBefore`, the post-take filter only finds rows
// older than the cursor if the FETCH is wide enough to include them —
// mission k574p02m DEFECT 2, lot 2.
export const MANDATES_LIST_SCAN_CAP = 2000;

export const list = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		requestedBy: v.optional(creatorValidator),
		fulfilledBy: v.optional(creatorValidator),
		status: v.optional(mandateStatusValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 1 — cursor paging anchor (forward, newest-first).
		createdBefore: v.optional(v.number()),
	},
	// A bare array is what the fleet master is served (rows, or a genuine
	// absence). An ORDINARY member of an active org is served the typed refusal
	// envelope instead — see the REFUSAL SHAPE note below.
	returns: v.union(
		v.array(mandateObject),
		v.object({ refused: v.literal(true), items: v.array(mandateObject) }),
	),
	handler: async (ctx, args) => {
		// THE DECISION, WRITTEN DOWN BEFORE THE CODE — this is the most sensitive
		// of the fourteen and it must not be closed by reflex.
		//
		// WHAT WAS MEASURED. Against LIVE production at commit bd8c60e9, this
		// query returned 9 mandate rows to a caller with NO CREDENTIAL AT ALL.
		// Each row carries `budget`, `spendingLimits`, `approvedCategories` and
		// `mandateDocument` — SPENDING AUTHORITY between orchestrators. The
		// handler resolved no identity of any kind; its only `throw` (below) is
		// about INDEX COVERAGE for the requestedBy+fulfilledBy combination, not
		// about authorisation, and a refusal about index coverage is not a
		// refusal about authority however loudly it fires.
		//
		// WHO MAY READ IT, AND WHY THAT IS MASTER ONLY. `mandates` carries no
		// orgId/tenant column at all (schema.ts:660) — `requestedBy`/`fulfilledBy`
		// are fleet ORCHESTRATOR names (pi/tau/sigma/alpha…), never client
		// organisations. There is therefore no per-tenant row to scope against,
		// so a roster filter would be a fiction: any org whose roster happened to
		// contain "sigma" would read every mandate sigma ever fulfilled, across
		// every other tenant's commercial relationships. The only sound boundary
		// is the one this file's own WRITES already enforce through
		// `requireFleetMaster` above: the verified fleet master (the real master
		// secret / the recognised by-id service-account carve-out). A Clerk-org
		// tenant identity is refused here exactly as an anonymous one is. That
		// makes the read admit precisely what the write admits — no more, and
		// notably no less, so the fleet's own callers are untouched.
		//
		// REFUSAL SHAPE — typed empty, NOT the throw `requireFleetMaster` uses.
		// This is a reactively-subscribed public READ: a throw crashes the
		// subscribing client's render (R-50/R-51), which is the whole reason
		// `refuseWithoutThrow` exists. The WRITES keep throwing, unchanged.
		//
		// REFUSAL SHAPE, CORRECTED (task k177hpz3cx9bb842tc9201wf118f94sa). The
		// paragraph above reasoned correctly about R-50 and then drew the wrong
		// conclusion for the ANONYMOUS pole. A caller with no credential at all
		// has no mounted render for a throw to crash: the only subscribing
		// consumer of this backend is the vantage-peers-dashboard Next.js app,
		// every route of which sits behind `clerkMiddleware`, so no `useQuery`
		// subscription is ever established without a Clerk session. Returning an
		// empty SUCCESS to that caller is the defect — "you may not" and "there is
		// nothing" come out as identical bytes, and a guard reading this door
		// cannot tell a refusal from an absence. `missions:list` has raised
		// RBAC_DENIED at this same pole in production all along while being
		// reactively subscribed (components/missions/mission-board.tsx:25).
		// See `.claude/rules/refusal-is-distinguishable-from-absence.md`.
		// A dashboard `useQuery` DOES subscribe to this read
		// (mandate-board.tsx:39, measured by grep in vantage-peers-dashboard,
		// origin/main), so NO refused caller may be RAISED at except the anonymous
		// one: `alsoRefusePreOrg` is NOT passed.
		//
		// THREE refused populations, and the third was RE-DECIDED (task
		// k1749w7ecx2yffr1hbhjpk8v858fbrf1) rather than inherited from R-50:
		//   anonymous            → RAISES (no mounted render exists to crash).
		//   signed-in, no org    → `{ refused: true, items: [] }`. Its shell IS
		//     mounted and IS subscribed, so a throw would crash the render — R-50's
		//     reasoning holds. But R-50 justified a bare `[]`, and a bare `[]` is
		//     byte-identical to "no mandates exist". The envelope is render-safe for
		//     the same reason it is for a member: mandate-board.tsx:41 normalises
		//     `Array.isArray(r) ? r : (r.items ?? [])`, so it renders empty AND says
		//     it was refused.
		//   ordinary org member  → `{ refused: true, items: [] }`, same shape.
		// The fleet master alone is served the bare array (rows, or a genuine
		// absence with NO `refused` key).
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "mandates:list");
		if (!scope.isMaster) {
			return { refused: true as const, items: [] };
		}

		const limit = args.limit ?? 50;
		const needsWideScan = args.createdBefore !== undefined;
		const fetchCap = needsWideScan ? MANDATES_LIST_SCAN_CAP + 1 : limit;

		let rows: Doc<"mandates">[];

		// Guard: requestedBy + fulfilledBy together is NOT covered by any
		// compound index. The branches below pick ONE of {requestedBy,
		// fulfilledBy} — silently combining both without a matching index
		// would risk applying only one filter and returning a result silently
		// broader than the question asked. Refuse loudly instead (same class
		// fix as convex/tasks.ts `list`).
		if (args.requestedBy !== undefined && args.fulfilledBy !== undefined) {
			throw new Error(
				`mandates.list: requestedBy and fulfilledBy cannot be combined in a single call ` +
					`(received requestedBy="${args.requestedBy}" fulfilledBy="${args.fulfilledBy}"). ` +
					`Call list once per filter, or drop one of the two args.`,
			);
		}

		if (args.requestedBy !== undefined && args.status !== undefined) {
			rows = await ctx.db
				.query("mandates")
				.withIndex("by_requestedBy", (q) =>
					q.eq("requestedBy", args.requestedBy!).eq("status", args.status!),
				)
				.order("desc")
				.take(fetchCap);
		} else if (args.requestedBy !== undefined) {
			rows = await ctx.db
				.query("mandates")
				.withIndex("by_requestedBy", (q) =>
					q.eq("requestedBy", args.requestedBy!),
				)
				.order("desc")
				.take(fetchCap);
		} else if (args.fulfilledBy !== undefined && args.status !== undefined) {
			rows = await ctx.db
				.query("mandates")
				.withIndex("by_fulfilledBy", (q) =>
					q.eq("fulfilledBy", args.fulfilledBy!).eq("status", args.status!),
				)
				.order("desc")
				.take(fetchCap);
		} else if (args.fulfilledBy !== undefined) {
			rows = await ctx.db
				.query("mandates")
				.withIndex("by_fulfilledBy", (q) =>
					q.eq("fulfilledBy", args.fulfilledBy!),
				)
				.order("desc")
				.take(fetchCap);
		} else if (args.status !== undefined) {
			rows = await ctx.db
				.query("mandates")
				.withIndex("by_status", (q) => q.eq("status", args.status!))
				.order("desc")
				.take(fetchCap);
		} else {
			rows = await ctx.db.query("mandates").order("desc").take(fetchCap);
		}

		// S3.3 B8 follow-up batch 1 — cursor paging anchor: drop rows newer-or-equal to before.
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		return rows.slice(0, limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single mandate by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { mandateId: v.string() },
	returns: v.union(mandateObject, v.null()),
	handler: async (ctx, args) => {
		const mandateId = requireId(
			ctx,
			"mandates",
			args.mandateId,
			"mandateId",
			"Use the full 32-char mandateId returned when the mandate was created or listed.",
		);
		return await ctx.db.get(mandateId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// validateSpending — check if a proposed spend is within mandate limits
// ─────────────────────────────────────────────────────────────────────────────

export const validateSpending = query({
	args: {
		mandateId: v.id("mandates"),
		proposedAmount: v.number(),
	},
	returns: v.object({
		withinLimits: v.boolean(),
		reason: v.optional(v.string()),
		currentSpend: v.number(),
		remainingBudget: v.number(),
		perTransactionLimit: v.optional(v.number()),
		perPeriodLimit: v.optional(v.number()),
	}),
	handler: async (ctx, args) => {
		const mandate = await ctx.db.get(args.mandateId);
		if (!mandate) {
			return { withinLimits: false, reason: "Mandate not found", currentSpend: 0, remainingBudget: 0 };
		}

		const currentSpend = mandate.tokensCost ?? 0;
		const remainingBudget = mandate.budget - currentSpend;

		// Check per-transaction limit first (more specific)
		if (mandate.spendingLimits?.maxPerTransaction && args.proposedAmount > mandate.spendingLimits.maxPerTransaction) {
			return {
				withinLimits: false,
				reason: `Exceeds per-transaction limit: ${args.proposedAmount} > ${mandate.spendingLimits.maxPerTransaction}`,
				currentSpend,
				remainingBudget,
				perTransactionLimit: mandate.spendingLimits.maxPerTransaction,
				perPeriodLimit: mandate.spendingLimits?.maxPerPeriod,
			};
		}

		// Check overall budget
		if (args.proposedAmount > remainingBudget) {
			return {
				withinLimits: false,
				reason: `Exceeds remaining budget: ${args.proposedAmount} > ${remainingBudget} remaining`,
				currentSpend,
				remainingBudget,
				perTransactionLimit: mandate.spendingLimits?.maxPerTransaction,
				perPeriodLimit: mandate.spendingLimits?.maxPerPeriod,
			};
		}

		return {
			withinLimits: true,
			currentSpend,
			remainingBudget: remainingBudget - args.proposedAmount,
			perTransactionLimit: mandate.spendingLimits?.maxPerTransaction,
			perPeriodLimit: mandate.spendingLimits?.maxPerPeriod,
		};
	},
});
