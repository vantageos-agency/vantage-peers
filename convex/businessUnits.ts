import { v, ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireId } from "./lib/ids";
import { withOrgScope, type OrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Org-scope orchestrator enforcement (same defect class as convex/diary.ts's
// / convex/messages.ts's isOrchestratorAllowedForScope — see
// .claude/rules/authority-attached-to-anonymous-object.md). `create` used to
// insert whatever `orchestratorId` the caller supplied with NO identity/scope
// check at all; `update` authorized solely on a client-supplied
// `callerOrchestrator` STRING ARGUMENT (an assertion, never a verified
// identity) — a caller could claim the literal string "system" and rewrite
// or reassign ANY organisation's business unit; `remove` performed no check
// whatsoever. A direct call to the public Convex deployment (bypassing the
// MCP server's guardFrom/guardMasterOnly layer, which is not a defence for
// this class) could create a BU under any org, reassign one across orgs, or
// delete any org's BU. Master scope (the recognized service-account
// identity the MCP server always presents, or the legacy no-identity opt-in)
// retains unrestricted access — preserves existing MCP-server behaviour
// unchanged. A Clerk-org-scoped caller may only write a BU whose
// `orchestratorId` is in its own client_org_mapping row's
// allowedOrchestrators.
// ─────────────────────────────────────────────────────────────────────────────

function isOrchestratorAllowedForScope(
	scope: OrgScope,
	orchestratorId: string,
): boolean {
	if (scope.isMaster) return true;
	if (scope.orgSlug === null) return false;
	return scope.allowedOrchestrators.includes(orchestratorId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const buStatusValidator = v.union(
	v.literal("idea"),
	v.literal("building"),
	v.literal("live"),
	v.literal("revenue"),
);

const revenueProjectionsValidator = v.object({
	y1: v.number(),
	y2: v.number(),
	y3: v.number(),
});

const coreTeamValidator = v.object({
	agents: v.array(v.string()),
	skills: v.array(v.string()),
	hooks: v.array(v.string()),
	plugins: v.array(v.string()),
});

// Full BU object shape — used in query returns
const buObject = v.object({
	_id: v.id("businessUnits"),
	_creationTime: v.number(),
	name: v.string(),
	description: v.string(),
	purpose: v.string(),
	domain: v.optional(v.string()),
	orchestratorId: v.string(),
	status: buStatusValidator,
	businessModel: v.string(),
	targetCustomers: v.string(),
	services: v.array(v.string()),
	pricing: v.string(),
	revenueProjections: revenueProjectionsValidator,
	coreTeam: coreTeamValidator,
	coreProcesses: v.array(v.string()),
	dependencies: v.array(v.string()),
	kpis: v.array(v.string()),
	managementFee: v.number(),
	createdAt: v.number(),
	updatedAt: v.number(),
});

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new business unit
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		name: v.string(),
		description: v.string(),
		purpose: v.string(),
		domain: v.optional(v.string()),
		orchestratorId: v.string(),
		status: buStatusValidator,
		businessModel: v.string(),
		targetCustomers: v.string(),
		services: v.array(v.string()),
		pricing: v.string(),
		revenueProjections: revenueProjectionsValidator,
		coreTeam: coreTeamValidator,
		coreProcesses: v.array(v.string()),
		dependencies: v.array(v.string()),
		kpis: v.array(v.string()),
		managementFee: v.optional(v.number()),
	},
	returns: v.id("businessUnits"),
	handler: async (ctx, args) => {
		// Fail-closed multi-tenant fix (defect class: authority attached to
		// an anonymously-registered object — see
		// .claude/rules/authority-attached-to-anonymous-object.md). withOrgScope
		// is called WITHOUT allowNoIdentityMaster — the MCP server always
		// presents a real Clerk identity (the caller's own org JWT or its
		// service-account token), so the fail-closed default here never
		// breaks that live path.
		const scope = await withOrgScope(ctx);
		if (!isOrchestratorAllowedForScope(scope, args.orchestratorId)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not create a business unit for orchestrator "${args.orchestratorId}" — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		const now = Date.now();
		return await ctx.db.insert("businessUnits", {
			name: args.name,
			description: args.description,
			purpose: args.purpose,
			domain: args.domain,
			orchestratorId: args.orchestratorId,
			status: args.status,
			businessModel: args.businessModel,
			targetCustomers: args.targetCustomers,
			services: args.services,
			pricing: args.pricing,
			revenueProjections: args.revenueProjections,
			coreTeam: args.coreTeam,
			coreProcesses: args.coreProcesses,
			dependencies: args.dependencies,
			kpis: args.kpis,
			managementFee: args.managementFee ?? 10,
			createdAt: now,
			updatedAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of BU fields
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		buId: v.id("businessUnits"),
		// RBAC: caller identity claiming ownership — DISTINCT from the
		// `orchestratorId` field below, which is the new lead-orchestrator
		// VALUE being written. Cross-tenant fix (S0 campaign
		// k17b9z5yjgd8301r6dfawefpzs8b3a03): the MCP layer previously reused
		// `orchestratorId` as both the caller's claimed identity AND the
		// write payload, and only checked that claim against the caller's own
		// OAuth allowlist — never against the TARGET row's actual owner. A
		// caller could claim its own identity and still rewrite anyone's BU.
		// Authorization must be derived from the row being targeted
		// (bu.orchestratorId), never from a value the caller supplies.
		callerOrchestrator: v.string(),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		purpose: v.optional(v.string()),
		domain: v.optional(v.string()),
		orchestratorId: v.optional(v.string()),
		status: v.optional(buStatusValidator),
		businessModel: v.optional(v.string()),
		targetCustomers: v.optional(v.string()),
		services: v.optional(v.array(v.string())),
		pricing: v.optional(v.string()),
		revenueProjections: v.optional(revenueProjectionsValidator),
		coreTeam: v.optional(coreTeamValidator),
		coreProcesses: v.optional(v.array(v.string())),
		dependencies: v.optional(v.array(v.string())),
		kpis: v.optional(v.array(v.string())),
		managementFee: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("businessUnits:update", …) at mcp-server/src/tools.ts:7746 (imperative), never a subscribing pre-org client shell; the RBAC_DENIED throw is an R-16 refusal the MCP layer catches, not an uncaught Server Error.
		//
		// Fail-closed multi-tenant fix (same defect class as `create` above,
		// and the sibling fix in convex/diary.ts): `callerOrchestrator` used
		// to be trusted as a bare STRING ASSERTION with no identity behind
		// it — any caller could type the literal "system" (or the target
		// row's own orchestratorId) and rewrite, or cross-tenant-reassign,
		// any organisation's business unit. withOrgScope resolves the
		// VERIFIED identity BEFORE ctx.db.get (mirrors convex-reviewer
		// REVISE on the diary/messages siblings) so a non-existent buId
		// cannot be distinguished from an existing-but-foreign one by an
		// unauthenticated caller.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update business unit ${args.buId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const bu = await ctx.db.get(args.buId);
		if (bu === null) {
			throw new Error(`Business unit ${args.buId} not found`);
		}

		// The TARGET ROW's current owner must be within the caller's scope —
		// authorization is derived from bu.orchestratorId (what is actually
		// being written to), never from the caller-supplied
		// `callerOrchestrator` claim alone.
		if (!isOrchestratorAllowedForScope(scope, bu.orchestratorId)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update business unit ${args.buId} (orchestrator "${bu.orchestratorId}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		// A reassignment (new `orchestratorId` in the patch) must ALSO land
		// within the caller's own scope — otherwise an org-scoped caller
		// could hand its own BU off to an orchestrator it does not own.
		if (
			args.orchestratorId !== undefined &&
			!isOrchestratorAllowedForScope(scope, args.orchestratorId)
		) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not reassign business unit ${args.buId} to orchestrator "${args.orchestratorId}" — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		// Legacy ownership-string check, kept for backward behaviour — now
		// harmless as a standalone bypass since the scope gate above already
		// proved the caller's org covers bu.orchestratorId.
		if (
			args.callerOrchestrator !== "system" &&
			bu.orchestratorId !== args.callerOrchestrator
		) {
			throw new Error(
				`RBAC_DENIED: ${args.callerOrchestrator} is not the owning orchestrator (${bu.orchestratorId}) of business unit ${args.buId}`,
			);
		}

		const { buId, callerOrchestrator, ...fields } = args;

		// Build patch object with only provided fields
		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}

		await ctx.db.patch(buId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// remove — delete a business unit by ID
// ─────────────────────────────────────────────────────────────────────────────

export const remove = mutation({
	args: { buId: v.id("businessUnits") },
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		// Fail-closed multi-tenant fix — `remove` used to perform NO
		// identity/scope check whatsoever: any caller holding the deployment
		// URL could permanently delete any organisation's business unit.
		// The MCP server's own `delete_bu` tool already restricts this
		// action to master (guardMasterOnly, mcp-server/src/tools.ts) — that
		// transport-layer gate is not a defence for this class (see
		// .claude/rules/authority-attached-to-anonymous-object.md), so the
		// SAME restriction is now enforced at the Convex boundary via the
		// caller's verified identity. withOrgScope is called WITHOUT
		// allowNoIdentityMaster — the MCP server always presents its
		// service-account identity on this path (isMaster=true), so this
		// never breaks the live "delete_bu" caller.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster) {
			throw new ConvexError(
				`RBAC_DENIED: business unit deletion is master-scope only — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		const bu = await ctx.db.get(args.buId);
		if (!bu) throw new Error("Business unit not found");
		await ctx.db.delete(args.buId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single BU by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	// Accept a raw string, not `v.id("businessUnits")`: the v.id() validator
	// runs BEFORE the handler, so a wrong-table ID is rejected with a message
	// Convex redacts in prod (`Server Error`, `error.data` undefined —
	// measured). Narrowing inside the handler via requireId() throws a
	// ConvexError whose payload survives redaction. Same contract as PR #1072
	// (tasks.getById).
	args: { buId: v.string() },
	returns: v.union(buObject, v.null()),
	handler: async (ctx, args) => {
		const buId = requireId(
			ctx,
			"businessUnits",
			args.buId,
			"buId",
			"Use the full 32-char buId returned by businessUnits.list or businessUnits.create.",
		);
		return await ctx.db.get(buId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list BUs with optional filters, newest first
// PR-A envelope safety: { items, nextCursor } envelope, limit default 20,
// cap 200, fields=lite|full projection, cursor-based paging.
// ─────────────────────────────────────────────────────────────────────────────

// returns-projection: list-view card summary, full BU fetched via businessUnits.get
const liteValidator = v.object({
	_id: v.id("businessUnits"),
	_creationTime: v.number(),
	name: v.string(),
	status: buStatusValidator,
	orchestratorId: v.string(),
});

interface CursorPayload {
	time: number;
	id: string;
}

function encodeCursor(time: number, id: string): string {
	return btoa(JSON.stringify({ time, id }));
}

function decodeCursor(cursor: string | undefined): CursorPayload | undefined {
	if (!cursor) return undefined;
	try {
		const raw = atob(cursor);
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"time" in parsed &&
			"id" in parsed &&
			typeof (parsed as Record<string, unknown>).time === "number" &&
			typeof (parsed as Record<string, unknown>).id === "string"
		) {
			return {
				time: (parsed as Record<string, unknown>).time as number,
				id: (parsed as Record<string, unknown>).id as string,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export const BUSINESS_UNITS_LIST_SCAN_CAP = 2000;

// returns-projection: fields="lite" returns a list-view card summary (liteValidator), not the full BU document
export const list = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		orchestratorId: v.optional(v.string()),
		status: v.optional(buStatusValidator),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
		// back-compat: keep createdBefore accepted; cursor takes precedence when both passed
		createdBefore: v.optional(v.number()),
	},
	returns: v.object({
		items: v.union(v.array(buObject), v.array(liteValidator)),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const DEFAULT_LIMIT = 20;
		const CAP = 200;
		const fields = args.fields ?? "full";
		const requested = args.limit ?? DEFAULT_LIMIT;
		const limit = Math.max(1, Math.min(requested, CAP));

		// Decode cursor payload; fall back to createdBefore legacy anchor
		const cursorPayload = decodeCursor(args.cursor);

		// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
		// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m).
		// mission k574p02m DEFECT 2, lot 2 — the previous `limit * 4 + 10` fixed
		// multiplier is a FALLIBLE buffer: `.take(fetchLimit)` always re-reads
		// only the TOP `fetchLimit` rows of the WHOLE ordering (not an offset
		// continuation), so once the cursor anchor's true position exceeds this
		// fixed window the anchor is never found, every row is filtered out,
		// and the page comes back empty before the true end. Widen the fetch to
		// the same scan cap the other carriers use instead of a multiplier that
		// degrades with page depth.
		// mission k574p02m lot 2 — Eta REVISE: widen on EITHER cursor source.
		// The legacy `createdBefore` back-compat path also filters after
		// `.take(fetchLimit)`, so it must widen too or it undershoots deep
		// pages the same way the cursor path used to.
		const wide = cursorPayload !== undefined || args.createdBefore !== undefined;
		const fetchLimit = wide ? BUSINESS_UNITS_LIST_SCAN_CAP + 1 : limit + 1;

		let rows: Doc<"businessUnits">[];
		if (args.orchestratorId !== undefined && args.status === undefined) {
			rows = await ctx.db
				.query("businessUnits")
				.withIndex("by_orchestrator", (q) =>
					q.eq("orchestratorId", args.orchestratorId!),
				)
				.order("desc")
				.take(fetchLimit);
		} else if (args.status !== undefined && args.orchestratorId === undefined) {
			rows = await ctx.db
				.query("businessUnits")
				.withIndex("by_status", (q) => q.eq("status", args.status!))
				.order("desc")
				.take(fetchLimit);
		} else if (args.orchestratorId !== undefined && args.status !== undefined) {
			const all = await ctx.db
				.query("businessUnits")
				.withIndex("by_orchestrator", (q) =>
					q.eq("orchestratorId", args.orchestratorId!),
				)
				.order("desc")
				.collect();
			rows = all.filter((r) => r.status === args.status).slice(0, fetchLimit);
		} else {
			rows = await ctx.db
				.query("businessUnits")
				.order("desc")
				.take(fetchLimit);
		}

		// Apply cursor filter: exclude rows at or before the cursor anchor.
		// Cursor encodes { time, id } — exclude rows strictly "before" in desc order:
		//   time > cursor.time → already seen (newer, came before in desc order)
		//   time === cursor.time AND id === cursor.id → the exact last-seen row
		//   time === cursor.time AND id !== cursor.id → same-ms peers, keep them
		// We order desc, so "already seen" = _creationTime >= cursor.time (for the anchor row).
		// Precise rule: skip if (_creationTime > cursor.time) OR (_creationTime === cursor.time AND _id === cursor.id) or older same-ms seen peers.
		// Simplest correct rule for desc ordering: skip all rows up to and including cursor.id.
		if (cursorPayload !== undefined) {
			let pastAnchor = false;
			rows = rows.filter((r) => {
				if (pastAnchor) return true;
				if (r._id === cursorPayload.id) {
					pastAnchor = true;
					return false; // skip the anchor row itself
				}
				return false; // skip rows before anchor (newer in desc order)
			});
		} else if (args.createdBefore !== undefined) {
			// Legacy back-compat: filter by createdBefore timestamp
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}

		// Detect next page
		const hasMore = rows.length > limit;
		const pageRows = rows.slice(0, limit);

		const nextCursor =
			hasMore || (cursorPayload !== undefined && pageRows.length === limit)
				? encodeCursor(
						pageRows[pageRows.length - 1]._creationTime,
						pageRows[pageRows.length - 1]._id,
					)
				: null;

		// Apply projection
		if (fields === "lite") {
			const liteItems = pageRows.map((r) => ({
				_id: r._id,
				_creationTime: r._creationTime,
				name: r.name,
				status: r.status,
				orchestratorId: r.orchestratorId,
			}));
			return { items: liteItems, nextCursor };
		}

		return { items: pageRows, nextCursor };
	},
});
