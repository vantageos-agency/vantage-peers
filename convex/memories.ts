import { hasFleetRead } from "@vantageos/cloud-identity";
import type { OrderedQuery } from "convex/server";
import { v, ConvexError } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { memoryTypeValidator, creatorValidator, relationTypeValidator, severityValidator } from "./schema";
import { authorIdOfLabel, claimedOrgArgs, requireClaimedScope } from "./contentClaims";
import { requireId } from "./lib/ids";
import { isMcpBoundMaster, withOrgScope } from "./lib/auth";
import type { OrgScope } from "./lib/auth";
import {
  memoryAuthorOf,
  memoryStampForWrite,
  memoryVisibleToScope,
  teamLabelOfNamespace,
} from "./lib/memoryTenant";
import { isTeamNamespaceAllowed } from "./lib/teamNamespace";
import type { DataModel, Doc } from "./_generated/dataModel";

// expireMemoriesByTtl scans candidate rows with a ttl set; this is a bounded
// cron batch size, not an expected total-row count, so 500 is a safe ceiling
// for a per-run cleanup pass.
const TTL_EXPIRY_SCAN_CAP = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Org-scope namespace enforcement (Fail-closed multi-tenant fix,
// task k176d9q9h6b33e8y1qgwnnx2x18aa40s).
//
// Master scope (no identity with legacy opt-in, or identity with no Clerk org)
// retains unrestricted access — preserves Alpha/internal behaviour unchanged.
// A Clerk-org-scoped caller may only read namespaces under its own
// "team/<orgSlug>" prefix; anything else is denied (never leaked cross-tenant).
//
// Module M10a (memories by ID scope): the namespace says where a row is filed,
// never whose it is. A row belongs to an organisation by its permanent Clerk org
// ID (`memories.clerkOrgId`), judged by @vantageos/cloud-identity `sameOrg`
// (convex/lib/memoryTenant.ts); the slug in `team/<slug>` only NARROWS where a
// member may write. A member's `createdBy` is the verified caller
// ("user:<subject>"): a claimed different author is refused. Only the
// MCP-bound master (the service account) supplies `createdBy` for the seat it
// authenticated.
// ─────────────────────────────────────────────────────────────────────────────

// The single implementation lives in lib/auth.ts (the OKF export/import gate
// delegates to it; memories.ts cannot be imported from lib/auth.ts without a
// cycle). Re-exported here so existing importers keep working.
export { isNamespaceAllowedForScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// storeMemory
// Creates a memory row, schedules RAG embedding via internal action.
// If the memory has an "updates" relation, marks target(s) as isLatest=false
// and removes their RAG entries so they no longer appear in search.
// ─────────────────────────────────────────────────────────────────────────────

export const storeMemory = mutation({
  args: {
    namespace: v.string(),
    type: memoryTypeValidator,
    content: v.string(),
    // Absent for a person (the MCP forwards none): the verified caller is the
    // author. The service account names the seat it authenticated.
    createdBy: v.optional(creatorValidator),
    // Optional: defaults to [] server-side if omitted (fixes #262)
    relations: v.optional(
      v.array(
        v.object({
          targetId: v.id("memories"),
          type: relationTypeValidator,
        }),
      ),
    ),
    isLatest: v.optional(v.boolean()),
    ttl: v.optional(v.string()),
    episode: v.optional(
      v.object({
        context: v.string(),
        goal: v.string(),
        action: v.string(),
        outcome: v.string(),
        insight: v.string(),
        severity: severityValidator,
      }),
    ),
    ...claimedOrgArgs,
  },
  returns: v.id("memories"),
  handler: async (ctx, args) => {
  	// write-contract: MCP-transport-only — issued via mcp-server client.mutation("memories:storeMemory", …) at mcp-server/src/tools.ts:2015 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
    // Fail-closed multi-tenant fix (defect class: authority attached
    // to an anonymously-registered object — see
    // .claude/rules/authority-attached-to-anonymous-object.md). storeMemory
    // used to write with NO identity/scope check at all; a direct call to
    // the public Convex deployment could write into (and, via an "updates"
    // relation, supersede) any org's namespace. withOrgScope is called
    // WITHOUT allowNoIdentityMaster — the MCP server always presents a real
    // Clerk identity (the caller's own org JWT or its service-account
    // token; see mcp-server/src/authenticatedConvexClient.ts), so the
    // fail-closed default here never breaks that live path.
    const transport = await withOrgScope(ctx);
    // The service account acts only inside the organisation the transport verified
    // for the bearer (`verifiedOrg`); a claimless call is refused (R-54).
    const scope = await requireClaimedScope(
      ctx,
      transport,
      args.verifiedOrg,
      "memories:storeMemory",
    );
    // Namespace ownership is the ONE decision of convex/lib/teamNamespace.ts (the
    // episode doors call it too): `team/<its org ID>`, or the legacy label alias of
    // the same verified org.
    if (!isTeamNamespaceAllowed(scope, args.namespace)) {
      throw new ConvexError(
        `RBAC_DENIED: caller may not write to namespace "${args.namespace}" — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
      );
    }
    // AUTHOR + TENANT STAMP (convex/lib/memoryTenant.ts, shared with the episode
    // doors). The MCP-bound master names the author of the seat it authenticated;
    // any other caller is a person, recorded as its verified subject, and a claimed
    // author that is anyone else is refused before anything is written. A member's
    // row carries its permanent org ID; the master's the ID the namespace names.
    // The seat's author is named by the SERVICE ACCOUNT (the transport), also when
    // it acts inside a claimed client org's member scope.
    const createdBy = memoryAuthorOf(
      scope,
      args.createdBy,
      "memories:storeMemory",
      isMcpBoundMaster(transport),
    );
    const createdById = await authorIdOfLabel(ctx, scope, createdBy);
    const clerkOrgId = await memoryStampForWrite(
      ctx,
      scope,
      args.namespace,
      "memories:storeMemory",
    );

    const now = Date.now();
    const relations = args.relations ?? [];

    // Validate every "updates" relation's TARGET namespace against the
    // caller's scope BEFORE any write happens — a caller may not supersede
    // a memory it could not itself write. Targets are fetched once here and
    // reused below so a missing/renamed target is only ever read twice
    // (this validation pass + the RAG-scheduling read), matching the
    // pre-existing read count for the not-found case.
    const updateTargets = new Map<string, Doc<"memories"> | null>();
    for (const relation of relations) {
      if (relation.type === "updates") {
        const target = await ctx.db.get(relation.targetId);
        updateTargets.set(relation.targetId, target);
        if (target !== null && !memoryVisibleToScope(scope, target)) {
          throw new ConvexError(
            `RBAC_DENIED: caller may not update memory ${relation.targetId} — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: "memory-not-in-caller-org" })}`,
          );
        }
      }
    }

    // 1. Create the memory row
    const memoryId = await ctx.db.insert("memories", {
      namespace: args.namespace,
      type: args.type,
      content: args.content,
      createdBy,
      relations,
      isLatest: true,
      ttl: args.ttl,
      episode: args.episode,
      ...(clerkOrgId === undefined ? {} : { clerkOrgId }),
      ...(createdById === undefined ? {} : { createdById }),
      createdAt: now,
      updatedAt: now,
    });

    // 2. Handle "updates" relations — supersede target memories
    // Re-add the RAG entry with isLatest="false" so it no longer appears in
    // searches filtered to isLatest="true".
    for (const relation of relations) {
      if (relation.type === "updates") {
        const target = updateTargets.get(relation.targetId) ?? null;
        if (target !== null) {
          await ctx.db.patch(relation.targetId, {
            isLatest: false,
            updatedAt: now,
          });

          // Schedule async RAG filter update for the superseded memory
          await ctx.scheduler.runAfter(0, internal.ragSync.markRagEntrySuperseded, {
            memoryId: relation.targetId,
            content: target.content,
            namespace: target.namespace,
            type: target.type,
          });
        }
      }
    }

    // 3. Schedule async RAG embedding + indexing for the new memory
    await ctx.scheduler.runAfter(0, internal.ragSync.addRagEntry, {
      memoryId,
      content: args.content,
      namespace: args.namespace,
      type: args.type,
    });

    return memoryId;
  },
});

// Full memory document shape — used in query returns.
const memoryDocValidator = v.object({
  _id: v.id("memories"),
  _creationTime: v.number(),
  namespace: v.string(),
  type: memoryTypeValidator,
  content: v.string(),
  createdBy: creatorValidator,
  instanceId: v.optional(v.string()),
  relations: v.array(
    v.object({
      targetId: v.id("memories"),
      type: relationTypeValidator,
    }),
  ),
  isLatest: v.boolean(),
  ttl: v.optional(v.string()),
  episode: v.optional(
    v.object({
      context: v.string(),
      goal: v.string(),
      action: v.string(),
      outcome: v.string(),
      insight: v.string(),
      severity: severityValidator,
    }),
  ),
  createdAt: v.number(),
  updatedAt: v.number(),
  // R-18 import idempotency key; only OKF-imported rows carry it.
  contentHash: v.optional(v.string()),
  // M10a: the owning organisation's permanent ID (absent on unstamped rows).
  clerkOrgId: v.optional(v.string()),
  // F1: the author's ID (an agents row ID, or "user:<subject>"); absent until backfilled.
  createdById: v.optional(v.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// getMemory — fetch single memory by ID
// ─────────────────────────────────────────────────────────────────────────────

export const getMemory = query({
  args: {
    memoryId: v.string(),
    // The organisation the MCP transport VERIFIED for a bearer that reaches
    // Convex as the fleet service account. Believed from the service account
    // only; the namespace gate below then runs under that org's member scope,
    // so a foreign memory is never returned to the MCP process
    // (convex/lib/verifiedOrg.ts). A service-account call that carries none is
    // refused (convex/contentClaims.ts).
    ...claimedOrgArgs,
  },
  returns: v.union(memoryDocValidator, v.null()),
  handler: async (ctx, args) => {
    const memoryId = requireId(
      ctx,
      "memories",
      args.memoryId,
      "memoryId",
      "Use the full 32-char memoryId returned by recall or store_memory.",
    );
    // R-50: reactively-subscribed public query — refuseWithoutThrow narrows
    // the signed-in-no-org branch to a typed refused scope; isNamespaceAllowedForScope
    // already renders that as "not allowed" -> null, never a throw. The caller is
    // resolved BEFORE the row is read, so an unclaimed service-account call is
    // refused identically for a live and for a deleted id.
    const transport = await withOrgScope(ctx, { refuseWithoutThrow: true });
    const scope = await requireClaimedScope(
      ctx,
      transport,
      args.verifiedOrg,
      "memories:getMemory",
    );
    const doc = await ctx.db.get(memoryId);
    if (doc === null) return null;
    if (!memoryVisibleToScope(scope, doc)) return null;
    return doc;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// listMemories — list active memories by namespace, with optional type filter
// ─────────────────────────────────────────────────────────────────────────────

// Paginated return shape — compat-first: existing callers reading `.value` work unchanged.
const listMemoriesResultValidator = v.object({
  value: v.array(memoryDocValidator),
  continueCursor: v.union(v.string(), v.null()),
  isDone: v.boolean(),
});

// The page of memories one namespace holds for a scope, as ONE ordered query: every
// predicate that decides which rows belong to the page (the tenant, the type, the
// author, the latest flag) sits in the index range or the query builder, so the
// bound that follows (`.take` / `.paginate`) counts only rows the caller may see.
// A member's range is its own org's rows (`by_namespace_org`: the org's permanent
// ID is an index predicate), the fleet's is the whole namespace.
type MemoryQuery = OrderedQuery<DataModel["memories"]>;

export function memoryPageQuery(
  ctx: QueryCtx,
  scope: Pick<OrgScope, "isMaster" | "fleetWide" | "masterSource" | "orgClerkId">,
  args: {
    namespace: string;
    type: Doc<"memories">["type"] | undefined;
    latestOnly: boolean;
    createdById: string | undefined;
  },
): MemoryQuery {
  const { namespace, type, latestOnly, createdById } = args;
  const fleet = hasFleetRead(scope);
  const tenantId = fleet ? undefined : scope.orgClerkId;
  // Fail closed: a scope that is not the fleet's and carries no org ID owns no
  // range. It is never read as the fleet's (the whole namespace).
  if (!fleet && tenantId === undefined) {
    throw new ConvexError(
      `RBAC_DENIED: the caller's organisation has no permanent org ID to read a namespace by — ${JSON.stringify({ reason: "org-id-missing", door: "memories:memoryPageQuery" })}`,
    );
  }
  let rows: MemoryQuery;
  if (tenantId !== undefined) {
    rows = ctx.db
      .query("memories")
      .withIndex("by_namespace_org", (q) =>
        latestOnly
          ? q.eq("namespace", namespace).eq("clerkOrgId", tenantId).eq("isLatest", true)
          : q.eq("namespace", namespace).eq("clerkOrgId", tenantId),
      )
      .order("desc");
    if (type !== undefined) {
      rows = rows.filter((f) => f.eq(f.field("type"), type));
    }
  } else if (type !== undefined) {
    rows = ctx.db
      .query("memories")
      .withIndex("by_namespace_type", (q) =>
        latestOnly
          ? q.eq("namespace", namespace).eq("type", type).eq("isLatest", true)
          : q.eq("namespace", namespace).eq("type", type),
      )
      .order("desc");
  } else {
    rows = ctx.db
      .query("memories")
      .withIndex("by_namespace", (q) =>
        latestOnly
          ? q.eq("namespace", namespace).eq("isLatest", true)
          : q.eq("namespace", namespace),
      )
      .order("desc");
  }
  if (createdById !== undefined) {
    rows = rows.filter((f) => f.eq(f.field("createdById"), createdById));
  }
  return rows;
}

export const listMemories = query({
  args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
    namespace: v.string(),
    type: v.optional(memoryTypeValidator),
    // A LABEL the caller types. It selects nothing by itself: it is resolved to the
    // author's ID in the caller's own org, and the page is read by that ID.
    createdBy: v.optional(creatorValidator),
    includeSuperseded: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    // Optional Convex pagination — when passed, uses .paginate() for cursor-based pagination.
    // Shape: { numItems: number; cursor: string | null }
    paginationOpts: v.optional(
      v.object({
        numItems: v.number(),
        cursor: v.union(v.string(), v.null()),
      }),
    ),
    ...claimedOrgArgs,
  },
  returns: listMemoriesResultValidator,
  handler: async (ctx, args) => {
    // R-50: reactively-subscribed public query — refuseWithoutThrow narrows
    // the signed-in-no-org branch to a typed refused scope; the pre-existing
    // isNamespaceAllowedForScope guard below already renders that as the
    // typed-empty page, never a throw.
    const transport = await withOrgScope(ctx, { refuseWithoutThrow: true });
    const scope = await requireClaimedScope(
      ctx,
      transport,
      args.verifiedOrg,
      "memories:listMemories",
    );
    // M10a: a row is served by its org ID (the tenant range below), never by the
    // namespace label. A caller with no org ID owns no row, and a member's rows
    // are only ever filed under a `team/<label>` namespace, so any other
    // namespace is the typed-empty page without reading it.
    if (
      !hasFleetRead(scope) &&
      (scope.orgClerkId === undefined || teamLabelOfNamespace(args.namespace) === null)
    ) {
      return { value: [], continueCursor: null, isDone: true };
    }
    // The author filter, by ID: the typed label is resolved in the caller's org. A
    // label that names nobody there matches no row (an empty page, not an error).
    const createdById =
      args.createdBy === undefined
        ? undefined
        : await authorIdOfLabel(ctx, scope, args.createdBy);
    if (args.createdBy !== undefined && createdById === undefined) {
      return { value: [], continueCursor: null, isDone: true };
    }
    const rows = memoryPageQuery(ctx, scope, {
      namespace: args.namespace,
      type: args.type,
      latestOnly: args.includeSuperseded !== true,
      createdById,
    });
    const numItems = args.paginationOpts?.numItems ?? args.limit ?? 50;

    // ── Paginated path (paginationOpts provided) ──────────────────────────────
    if (args.paginationOpts !== undefined) {
      const r = await rows.paginate({
        numItems,
        cursor: args.paginationOpts.cursor,
      });
      return {
        value: r.page,
        continueCursor: r.isDone ? null : r.continueCursor,
        isDone: r.isDone,
      };
    }

    // ── Bounded default path (no paginationOpts) — compat with existing callers ──
    // Returns value + continueCursor=null + isDone=true so new callers don't crash.
    return {
      value: await rows.take(numItems),
      continueCursor: null,
      isDone: true,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// softDeleteMemory — marks a memory as no longer latest (audit-preserving)
// Also removes the RAG entry so it no longer appears in search.
// ─────────────────────────────────────────────────────────────────────────────

export const softDeleteMemory = mutation({
  args: { memoryId: v.string(), ...claimedOrgArgs },
  returns: v.null(),
  handler: async (ctx, args) => {
  	// write-contract: MCP-transport-only — issued via mcp-server client.mutation("memories:softDeleteMemory", …) at mcp-server/src/tools.ts:2075 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
    // The caller is resolved BEFORE the row is read, so an unresolved caller is
    // refused identically for a live and for a deleted id (no existence oracle).
    // withOrgScope is called WITHOUT allowNoIdentityMaster: the MCP server
    // always presents a real Clerk identity on this path.
    // The service account acts only inside a transport-verified organisation
    // (backend standard R-54): a claimless call is refused, the operator
    // organisation's claim keeps the fleet's reach over any memory, and a client
    // organisation's claim confines the call to that organisation's rows
    // (requireClaimedScope); a member never reaches beyond its own org's rows.
    const transport = await withOrgScope(ctx);
    const scope = await requireClaimedScope(
      ctx,
      transport,
      args.verifiedOrg,
      "memories:softDeleteMemory",
    );
    const memoryId = requireId(
      ctx,
      "memories",
      args.memoryId,
      "memoryId",
      "Use the full 32-char memoryId returned by recall or store_memory.",
    );

    const memory = await ctx.db.get(memoryId);
    // The fleet service account is told a missing row is missing
    // (its contract since before M10a); every other caller gets the refusal
    // below, identical for a missing and for a foreign row.
    if (memory === null && hasFleetRead(scope)) {
      throw new Error(`Memory ${memoryId} not found`);
    }
    // A member is answered identically for a missing row and for another org's
    // row (decided by org ID): the refusal never says which.
    if (memory === null || !memoryVisibleToScope(scope, memory)) {
      throw new ConvexError(
        `RBAC_DENIED: caller may not delete memory ${memoryId} — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: "memory-not-in-caller-org" })}`,
      );
    }

    await ctx.db.patch(memoryId, { isLatest: false, updatedAt: Date.now() });

    // Schedule async RAG filter update — marks entry as no longer latest
    await ctx.scheduler.runAfter(0, internal.ragSync.markRagEntrySuperseded, {
      memoryId,
      content: memory.content,
      namespace: memory.namespace,
      type: memory.type,
    });

    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// expireMemoriesByTtl (internal — called by cron)
// ─────────────────────────────────────────────────────────────────────────────

export const expireMemoriesByTtl = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = new Date().toISOString();
    let expired = 0;

    const candidates = await ctx.db
      .query("memories")
      .filter((q) => q.neq(q.field("ttl"), undefined))
      .take(TTL_EXPIRY_SCAN_CAP);

    for (const memory of candidates) {
      if (memory.ttl !== undefined && memory.ttl < now && memory.isLatest) {
        await ctx.db.patch(memory._id, { isLatest: false, updatedAt: Date.now() });

        // Schedule async RAG filter update — marks entry as no longer latest
        await ctx.scheduler.runAfter(0, internal.ragSync.markRagEntrySuperseded, {
          memoryId: memory._id,
          content: memory.content,
          namespace: memory.namespace,
          type: memory.type,
        });

        expired++;
      }
    }

    return expired;
  },
});
