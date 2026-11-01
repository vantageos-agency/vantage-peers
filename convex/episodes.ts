import { hasFleetRead } from "@vantageos/cloud-identity";
import { v, ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./lib/functions";
import { internal } from "./_generated/api";
import { creatorValidator, severityValidator, relationTypeValidator } from "./schema";
import { requireResolvedCaller, withOrgScope } from "./lib/auth";
import { memoryAuthorOf, memoryStampForWrite, memoryVisibleToScope } from "./lib/memoryTenant";
import { isMemoryNamespaceAllowed } from "./lib/seatNamespace";
import { memberNamespaceRoots } from "./lib/teamNamespace";

// ─────────────────────────────────────────────────────────────────────────────
// storeEpisode
// Creates a memory with type="episode" + full episode metadata.
// Episodic memory is the "other half" Mem0 doesn't solve:
//   - context + goal + action + outcome = what happened (episodic)
//   - insight = what was learned (procedural)
// ─────────────────────────────────────────────────────────────────────────────

export const storeEpisode = mutation({
  args: {
    namespace: v.string(),
    // Absent for a person (the MCP forwards none): the verified caller is the
    // author. The service account names the seat it authenticated.
    createdBy: v.optional(creatorValidator),
    // The 5 episode fields (mandatory for type="episode")
    context: v.string(),
    goal: v.string(),
    action: v.string(),
    outcome: v.string(),
    insight: v.string(),
    severity: severityValidator,
    // Optional relations to related memories
    relations: v.optional(
      v.array(
        v.object({
          targetId: v.id("memories"),
          type: relationTypeValidator,
        }),
      ),
    ),
    ttl: v.optional(v.string()),
  },
  returns: v.id("memories"),
  handler: async (ctx, args) => {
  	// write-contract: MCP-transport-only — issued via mcp-server client.mutation("episodes:storeEpisode", …) at mcp-server/src/tools.ts:2390 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
    // Fail-closed multi-tenant fix (defect class: authority attached
    // to an anonymously-registered object — see
    // .claude/rules/authority-attached-to-anonymous-object.md). storeEpisode
    // used to write into the memories table with NO identity/scope check at
    // all; a direct call to the public Convex deployment could write into
    // (and thus read back via listEpisodes/getCriticalInsights) any org's
    // namespace. withOrgScope is called WITHOUT allowNoIdentityMaster — the
    // MCP server always presents a real Clerk identity (the caller's own
    // org JWT or its service-account token; see
    // mcp-server/src/authenticatedConvexClient.ts), so the fail-closed
    // default here never breaks that live path. Reuses
    // the namespace gate of convex/lib/teamNamespace.ts: a member owns
    // `team/<its verified org ID>` (and the legacy label alias of that same org).
    const scope = await withOrgScope(ctx);
    if (!isMemoryNamespaceAllowed(scope, args.namespace)) {
      throw new ConvexError(
        `RBAC_DENIED: caller may not write to namespace "${args.namespace}" — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
      );
    }
    // AUTHOR + TENANT STAMP. An episode is a row of the memories table, so it is
    // authored and stamped exactly as storeMemory does it (convex/lib/memoryTenant.ts):
    // a member's author is the verified caller ("user:<subject>") and a claimed
    // other author is refused; the service account (the MCP server) supplies the
    // author of the seat it authenticated. The row carries the org's permanent ID,
    // so the memory doors and the episode doors judge it identically.
    const createdBy = memoryAuthorOf(
      scope,
      args.createdBy,
      "episodes:storeEpisode",
      hasFleetRead(scope) || scope.serviceTransport === true,
    );
    const clerkOrgId = await memoryStampForWrite(
      ctx,
      scope,
      args.namespace,
      "episodes:storeEpisode",
    );

    const now = Date.now();

    // Build the searchable content from all episode fields
    const content = [
      `Context: ${args.context}`,
      `Goal: ${args.goal}`,
      `Action: ${args.action}`,
      `Outcome: ${args.outcome}`,
      `Insight: ${args.insight}`,
    ].join(" | ");

    const memoryId = await ctx.db.insert("memories", {
      namespace: args.namespace,
      type: "episode",
      content,
      createdBy,
      relations: args.relations ?? [],
      isLatest: true,
      ttl: args.ttl,
      episode: {
        context: args.context,
        goal: args.goal,
        action: args.action,
        outcome: args.outcome,
        insight: args.insight,
        severity: args.severity,
      },
      ...(clerkOrgId === undefined ? {} : { clerkOrgId }),
      createdAt: now,
      updatedAt: now,
    });

    // Schedule async RAG embedding + indexing
    await ctx.scheduler.runAfter(0, internal.ragSync.addRagEntry, {
      memoryId,
      content,
      namespace: args.namespace,
      type: "episode",
    });

    return memoryId;
  },
});

// Rows examined by one bounded episode read. A read that has to look at more rows
// than this to fill its page is refused loudly: a silently short page would be
// indistinguishable from "that is all there is".
const EPISODE_SCAN_CAP = 16000;

type EpisodeRow = Doc<"memories"> & { episode: NonNullable<Doc<"memories">["episode"]> };

/** Up to `limit` newest episodes of ONE namespace that satisfy `keep`, read through the index. */
async function takeEpisodes(
  ctx: QueryCtx,
  namespace: string,
  limit: number,
  keep: (row: Doc<"memories">) => boolean,
  door: string,
): Promise<EpisodeRow[]> {
  const out: EpisodeRow[] = [];
  if (limit <= 0) return out;
  let examined = 0;
  for await (const row of ctx.db
    .query("memories")
    .withIndex("by_namespace_type", (q) =>
      q.eq("namespace", namespace).eq("type", "episode").eq("isLatest", true),
    )
    .order("desc")) {
    if (++examined > EPISODE_SCAN_CAP) {
      throw new ConvexError(
        `${door}: SCAN_CAP_EXCEEDED — more than ${EPISODE_SCAN_CAP} episodes had to be examined to fill the page, so the list cannot be assembled completely.`,
      );
    }
    if (row.episode !== undefined && keep(row)) {
      out.push(row as EpisodeRow);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// listEpisodes — list episodes for a namespace, ordered newest first
// returns-projection: episode list view — omits type/instanceId/relations/ttl/updatedAt, non-episode housekeeping fields
// ─────────────────────────────────────────────────────────────────────────────
export const listEpisodes = query({
  args: {
    namespace: v.string(),
    severity: v.optional(severityValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("memories"),
      _creationTime: v.number(),
      namespace: v.string(),
      createdBy: creatorValidator,
      content: v.string(),
      isLatest: v.boolean(),
      createdAt: v.number(),
      episode: v.object({
        context: v.string(),
        goal: v.string(),
        action: v.string(),
        outcome: v.string(),
        insight: v.string(),
        severity: severityValidator,
      }),
    }),
  ),
  handler: async (ctx, args) => {
    // Fail-closed multi-tenant fix (defect class: authority attached to an
    // anonymously-registered object — .claude/rules/authority-attached-to-
    // anonymous-object.md). listEpisodes took NO identity check at all: a
    // direct POST to the public Convex deployment URL returned any org's
    // episode rows to a caller with no credential whatsoever. The MCP tool
    // layer cannot defend this — a public Convex function is reachable at the
    // deployment URL directly (standing precedent: oauth.getScopeProfile).
    //
    // REFUSAL SHAPE — typed empty, not a throw: this is a reactively
    // subscribed public READ with no call site to catch a throw, so throwing
    // would crash the subscriber's render. `refuseWithoutThrow` narrows the
    // signed-in-with-no-org branch to a typed refused scope, and the
    // isNamespaceAllowedForScope gate renders both that and the anonymous
    // scope as the empty page. Reuses the EXACT mechanism its sibling
    // memories.ts::listMemories already uses — no second identity layer.
    const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
    if (!isMemoryNamespaceAllowed(scope, args.namespace)) {
      return [];
    }

    const limit = args.limit ?? 20;

    // One namespace, read through its (namespace, type, isLatest) index, newest
    // first, and stopped at `limit` matches: bounded by the page asked for and by
    // EPISODE_SCAN_CAP rows examined, never a collect of the whole range.
    const episodes = await takeEpisodes(
      ctx,
      args.namespace,
      limit,
      (e) =>
        memoryVisibleToScope(scope, e) &&
        (args.severity === undefined || e.episode?.severity === args.severity),
      "episodes.listEpisodes",
    );

    return episodes
      .map((e) => ({
        _id: e._id,
        _creationTime: e._creationTime,
        namespace: e.namespace,
        createdBy: e.createdBy,
        content: e.content,
        isLatest: e.isLatest,
        createdAt: e.createdAt,
        episode: e.episode!,
      }));
  },
});

// An org member's critical episodes, read from the index ranges of its OWN
// namespaces only: each owned root (`team/<org ID>`, plus the legacy label alias
// of that same org) is read exactly, then every distinct sub-namespace under it
// is found by skipping forward through `by_namespace` (bounds from
// `memberNamespaceRoots`). Each namespace is then read through the
// (namespace, type, isLatest) index, newest first, stopped at `limit`. A tenant
// holding more distinct namespaces than TENANT_NAMESPACE_WALK_CAP is refused
// loudly rather than answered with a silently incomplete list.
const TENANT_NAMESPACE_WALK_CAP = 500;

// Rows the master's fleet-wide scan may examine to find its page of critical ones.
const FLEET_SCAN_CAP = 16000;

const isCritical = (e: Doc<"memories">) => e.episode?.severity === "critical";

// The fleet's critical episodes: every namespace, newest first, stopped at
// `limit` critical rows and capped on rows examined (FLEET_SCAN_CAP).
async function readFleetCritical(
  ctx: QueryCtx,
  scope: Parameters<typeof requireResolvedCaller>[0],
  limit: number,
): Promise<EpisodeRow[]> {
  // The unbounded-by-namespace scan is master-only by construction: any other
  // scope is refused RBAC_DENIED (naming this door) before a row is read.
  requireResolvedCaller(scope, "episodes:getCriticalInsights", { masterOnly: true });
  const episodes: EpisodeRow[] = [];
  let examined = 0;
  for await (const row of ctx.db
    .query("memories")
    .withIndex("by_type", (q) => q.eq("type", "episode").eq("isLatest", true))
    .order("desc")) {
    if (++examined > FLEET_SCAN_CAP) {
      throw new ConvexError(
        `episodes.getCriticalInsights: SCAN_CAP_EXCEEDED — more than ${FLEET_SCAN_CAP} episodes had to be examined to find ${limit} critical ones.`,
      );
    }
    if (row.episode !== undefined && isCritical(row)) {
      episodes.push(row as EpisodeRow);
      if (episodes.length >= limit) break;
    }
  }
  return episodes;
}

async function readTenantCritical(
  ctx: QueryCtx,
  scope: Parameters<typeof memberNamespaceRoots>[0] &
    Parameters<typeof memoryVisibleToScope>[0],
  limit: number,
): Promise<EpisodeRow[]> {
  const door = "episodes.getCriticalInsights";
  // The namespace roots say WHERE to read; the org stamp says whose a row is
  // (the same predicate as the memory doors), so a freed label reused by another
  // org, and an unstamped legacy row, are never served.
  const keep = (e: Doc<"memories">) => isCritical(e) && memoryVisibleToScope(scope, e);
  const rows: EpisodeRow[] = [];
  let walked = 0;
  for (const root of memberNamespaceRoots(scope)) {
    rows.push(...(await takeEpisodes(ctx, root.exact, limit, keep, door)));
    let from = root.from;
    for (;;) {
      if (walked++ >= TENANT_NAMESPACE_WALK_CAP) {
        throw new ConvexError(
          `${door}: SCAN_CAP_EXCEEDED — your organisation holds more than ${TENANT_NAMESPACE_WALK_CAP} distinct namespaces, so the list cannot be assembled completely. The result would be incomplete and indistinguishable from a full match.`,
        );
      }
      const next = await ctx.db
        .query("memories")
        .withIndex("by_namespace", (q) =>
          q.gte("namespace", from).lt("namespace", root.to),
        )
        .first();
      if (next === null) break;
      rows.push(...(await takeEpisodes(ctx, next.namespace, limit, keep, door)));
      // The smallest string strictly greater than `next.namespace`.
      from = `${next.namespace}\u0000`;
    }
  }
  return rows.sort((a, b) => b._creationTime - a._creationTime);
}

// ─────────────────────────────────────────────────────────────────────────────
// getCriticalInsights — returns all critical-severity episodes across namespaces
// Used for cross-orchestrator learning: Pi/Tau/Phi share critical lessons.
// returns-projection: cross-namespace digest — flattens insight/context out of episode, omits the rest of the memory document
// ─────────────────────────────────────────────────────────────────────────────
export const getCriticalInsights = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      _id: v.id("memories"),
      namespace: v.string(),
      createdBy: creatorValidator,
      insight: v.string(),
      context: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    // Fail-closed multi-tenant fix — CONFIRMED OPEN in production: a POST to
    // the public deployment URL with no Authorization header returned real
    // rows. This query takes NO namespace argument at all: it is
    // cross-namespace BY DESIGN (built for cross-orchestrator learning), so
    // an unauthenticated caller drained EVERY tenant's critical insights in
    // one call — the widest of the two measured leaks.
    //
    // There is no caller-supplied namespace to compare, so the scope decides
    // WHICH index ranges are read (below). Master (the fleet's own callers, via
    // withOrgScope's by-id service-account carve-out) keeps reading every
    // namespace. An anonymous or no-org caller owns no namespace root, so it
    // reads nothing: the typed empty array, never a throw (reactive subscriber,
    // same reasoning as listEpisodes above).
    const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });

    const limit = args.limit ?? 30;

    // The tenant predicate is applied INSIDE the read (R-11), never as a filter
    // after an unscoped one. The fleet-wide scan (every tenant's rows) is for the
    // master alone; an org member reads only the index ranges of its OWN
    // namespaces, so a foreign episode is never read at all. Both reads stop at
    // `limit` critical rows (newest first) and are capped on rows examined.
    // The master/member split is the package's `hasFleetRead`. The fleet-wide
    // scan itself refuses any non-master scope (readFleetCritical), so the
    // member path cannot reach it even if this branch were wrong.
    const episodes = hasFleetRead(scope)
      ? await readFleetCritical(ctx, scope, limit)
      : await readTenantCritical(ctx, scope, limit);

    return episodes
      .slice(0, limit)
      .map((e) => ({
        _id: e._id,
        namespace: e.namespace,
        createdBy: e.createdBy,
        insight: e.episode!.insight,
        context: e.episode!.context,
        createdAt: e.createdAt,
      }));
  },
});

// Day 100 — Phase 2 get_by_id surface fix (task k172735brsw6bc3j2dkkkfxqrx88kkjq):
// Episodes are stored as memories with an `episode` metadata field (no separate
// "episodes" table — see convex/schema.ts:139+). The Phase 2a `episodes:getById`
// query was invalid (table does not exist) and broke `convex deploy` typecheck.
// Use the existing `memories:getMemory` from the MCP `get_memory` tool to fetch
// episode rows by their memory document ID. No new episodes-side query needed.
