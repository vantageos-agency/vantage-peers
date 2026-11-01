import { v, ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./lib/functions";
import type { Doc } from "./_generated/dataModel";
// convex-strict-mode-doc-type-import-needed-when-refactoring-list-query-from-early-return-to-accumulator-post-filter
import { memoryTypeValidator, creatorValidator } from "./schema";
import {
  type OrgScope,
  requireResolvedCaller,
  verifiedActorValidator,
  withOrgScope,
} from "./lib/auth";
import {
  agentIdOfLabel,
  findWritableProfile,
  newProfileOwner,
  PROFILE_CANDIDATE_CAP,
  type ProfileAgent,
  resolveProfileAgent,
  resolveVerifiedProfileAgent,
  visibleProfiles,
} from "./lib/profileActors";
import { isNamespaceAllowedForScope } from "./memories";

// ─────────────────────────────────────────────────────────────────────────────
// WHO MAY WRITE, AND WHICH ROW IS WHOSE (module M10d).
//
// A profile belongs to an AGENT: `profiles.agentId` is an `agents` row `_id`, and
// the profile's organisation is the organisation of that agent row. The name on
// a profile (`orchestratorId`) is a label two organisations may both carry; it
// selects no row of another organisation and authorises nothing.
//
// A write is accepted from exactly two callers:
//   - the agent itself, proven by `verifiedActor` (forwarded by the fleet service
//     account, which verified it; no secret is ever an argument). It writes
//     ITS row, found by its agent ID; a same-named agent of another organisation
//     has another ID and so another row.
//   - the fleet master with no acting agent (its existing grant, unchanged): the
//     fleet's own orchestrator registry, found by instance / label as before.
// Anyone else, including a verified member of an organisation, is refused
// (defect class: .claude/rules/authority-attached-to-anonymous-object.md).
// ─────────────────────────────────────────────────────────────────────────────
function requireFleetMaster(
  scope: OrgScope,
  actor: ProfileAgent | undefined,
  action: string,
  namesAnotherAgent = false,
): void {
  if ((!scope.isMaster && actor === undefined) || namesAnotherAgent) {
    throw new ConvexError(
      `RBAC_DENIED: caller may not ${action} — profiles are fleet-internal, master-only unless the call proves the agent that owns the profile — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: namesAnotherAgent ? "profile-of-another-agent" : "not-profile-owner" })}`,
    );
  }
}

// The caller of a write: the proven agent, or the fleet master. Refuses the rest.
async function writerOf(
  ctx: Parameters<typeof withOrgScope>[0],
  proof: Parameters<typeof resolveProfileAgent>[2],
  action: string,
  door: string,
  target?: string,
): Promise<{ scope: OrgScope; actor: ProfileAgent | undefined }> {
  const scope = await withOrgScope(ctx);
  const actor = await resolveProfileAgent(ctx, scope, proof, door);
  // A seat acting for its org (`__actingOrg`, task k179y0wpsd6fv7055f4p2w6b358hdrxe)
  // writes its OWN profile: a call whose target names another agent (by ID, in
  // the proven agent's org) is refused, never redirected onto the caller's row.
  const namesAnotherAgent =
    scope.serviceTransport === true &&
    actor !== undefined &&
    target !== undefined &&
    (await agentIdOfLabel(ctx, actor.agent.orgSlug, target)) !== actor.agent._id;
  requireFleetMaster(scope, actor, action, namesAnotherAgent);
  return { scope, actor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared return validators
// ─────────────────────────────────────────────────────────────────────────────

const profileDocValidator = v.object({
  _id: v.id("profiles"),
  _creationTime: v.number(),
  orchestratorId: v.string(),
  instanceId: v.optional(v.string()),
  agentId: v.optional(v.id("agents")),
  name: v.string(),
  static: v.object({
    role: v.string(),
    workspace: v.string(),
    capabilities: v.array(v.string()),
  }),
  dynamic: v.object({
    currentTask: v.optional(v.string()),
    endOfDayIndex: v.optional(v.string()),
    lastSeen: v.number(),
    sessionCount: v.number(),
  }),
});

const memorySnippetValidator = v.object({
  _id: v.id("memories"),
  type: memoryTypeValidator,
  content: v.string(),
  createdBy: creatorValidator,
  createdAt: v.number(),
});

// ─────────────────────────────────────────────────────────────────────────────
// findProfileForCaller — the ONE profile lookup both reads share.
//
//   - the fleet master with no acting agent: the legacy lookup, unchanged (the
//     fleet's own registry, by instance or by label);
//   - any other caller (an acting agent, an ordinary member): the label is
//     resolved to an agent ID WITHIN THE CALLER'S OWN ORGANISATION and the row is
//     read by that ID; whatever the lookup returned is then judged by stored ID
//     (`visibleProfiles`), so a same-named row of another organisation, and a row
//     with no agent, are never served.
// ─────────────────────────────────────────────────────────────────────────────
async function findProfileForCaller(
  ctx: QueryCtx,
  scope: OrgScope,
  actor: ProfileAgent | undefined,
  args: { orchestratorId?: string; instanceId?: string },
  door: string,
): Promise<Doc<"profiles"> | null> {
  const fleetRead = actor === undefined && scope.isMaster;
  // ONE row is returned, so no candidate page is read: the matching rows are
  // streamed and the first the caller may see ends the read (the fleet master's
  // first row, unjudged). At most PROFILE_CANDIDATE_CAP rows are looked at.
  const firstServed = async (
    rows: AsyncIterable<Doc<"profiles">>,
  ): Promise<Doc<"profiles"> | null> => {
    let seen = 0;
    for await (const row of rows) {
      if (fleetRead) return row;
      const visible = await visibleProfiles(ctx, scope, actor, [row], door);
      if (visible.length > 0) return visible[0];
      seen += 1;
      if (seen >= PROFILE_CANDIDATE_CAP) break;
    }
    return null;
  };
  if (args.instanceId !== undefined) {
    return await firstServed(
      ctx.db
        .query("profiles")
        .withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId!)),
    );
  }
  if (args.orchestratorId === undefined) return null;
  if (fleetRead) {
    // Returns first match — for role-level lookup when only one instance exists
    return await ctx.db
      .query("profiles")
      .withIndex("by_orchestrator", (q) =>
        q.eq("orchestratorId", args.orchestratorId!),
      )
      .first();
  }
  const orgSlug = actor !== undefined ? actor.agent.orgSlug : scope.orgSlug;
  const agentId =
    orgSlug === null
      ? undefined
      : await agentIdOfLabel(ctx, orgSlug, args.orchestratorId);
  if (agentId === undefined) return null;
  return await firstServed(
    ctx.db
      .query("profiles")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// getProfile — fetch by orchestratorId (role) or instanceId
// ─────────────────────────────────────────────────────────────────────────────

export const getProfile = query({
  args: {
    orchestratorId: v.optional(v.string()),
    instanceId: v.optional(v.string()),
    // The acting agent, forwarded BY ID by the fleet service account that verified
    // it (mcp-server/src/verifiedActor.ts). The read is then judged by that
    // agent's stored organisation ID, never by a name.
    verifiedActor: v.optional(verifiedActorValidator),
  },
  returns: v.union(profileDocValidator, v.null()),
  handler: async (ctx, args) => {
    // GATE — this read took NO identity check: any caller, including one with no
    // credential, read a fleet-internal orchestrator profile by name. `profiles`
    // has no tenant column (see requireFleetMaster), so the only per-caller
    // predicate is the org's own orchestrator roster
    // (`allowedOrchestrators`, the same roster the MCP `get_profile` filter
    // narrows on): a member is served a profile only for an orchestrator on its
    // roster; the master is served all.
    // REFUSAL SHAPE — a RAISE. isolation-contract: no reactive subscriber.
    //   grep -rn "profiles\.getProfile\b" app components hooks lib (dashboard) -> 0
    // Its only consumer is the MCP `get_profile` tool (one-shot `convex.query`).
    const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
    requireResolvedCaller(scope, "profiles:getProfile", {
      alsoRefusePreOrg: true,
    });

    // ROSTER FIRST, THEN LOOKUP. The roster predicate is on the REQUESTED
    // orchestrator, so it can run before the read: a non-roster member is
    // refused whether or not a profile row exists. Checking after the lookup
    // made the answer depend on existence (refusal if a row exists, success
    // `null` if not) — an existence oracle on orchestrators outside the org.
    // `instanceId` lookups carry no orchestrator name up front, so they are
    // checked against the fetched row (an absent row is then an absence for an
    // instance id, which names no roster entry to leak). The roster only NARROWS:
    // WHICH row is served is decided by stored agent ID (findProfileForCaller).
    const requireOnRoster = (orchestratorId: string): void => {
      if (scope.isMaster || scope.allowedOrchestrators.includes(orchestratorId)) {
        return;
      }
      throw new ConvexError(
        `RBAC_DENIED: "profiles:getProfile" refuses a caller whose organisation roster does not include orchestrator "${orchestratorId}" — ${JSON.stringify(
          {
            registration: "profiles:getProfile",
            orgSlug: scope.orgSlug,
            reason: "not-on-roster",
          },
        )}`,
      );
    };

    const actor = await resolveVerifiedProfileAgent(
      ctx,
      scope,
      args.verifiedActor,
      "profiles:getProfile",
    );
    if (args.instanceId === undefined && args.orchestratorId !== undefined) {
      requireOnRoster(args.orchestratorId);
    }
    const profile = await findProfileForCaller(
      ctx,
      scope,
      actor,
      args,
      "profiles:getProfile",
    );
    if (args.instanceId !== undefined && profile !== null) {
      requireOnRoster(profile.orchestratorId);
    }
    return profile;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// upsertProfile — create or update a profile by instanceId (or orchestratorId)
// ─────────────────────────────────────────────────────────────────────────────

export const upsertProfile = mutation({
  args: {
    orchestratorId: v.string(),
    instanceId: v.optional(v.string()),
    name: v.optional(v.string()),
    static: v.optional(v.object({
      role: v.string(),
      workspace: v.string(),
      capabilities: v.array(v.string()),
    })),
    dynamic: v.optional(v.object({
      currentTask: v.optional(v.string()),
      endOfDayIndex: v.optional(v.string()),
      lastSeen: v.number(),
      sessionCount: v.number(),
    })),
    // The acting agent: ONE proof per call. A profile is written only by the agent
    // that owns it (see the block above requireFleetMaster).
    verifiedActor: v.optional(verifiedActorValidator),
  },
  returns: v.id("profiles"),
  handler: async (ctx, args) => {
  	// write-contract: MCP-transport-only — issued via mcp-server client.mutation("profiles:upsertProfile", …) at mcp-server/src/tools.ts:2843 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
    const { actor } = await writerOf(
      ctx,
      { verifiedActor: args.verifiedActor },
      `upsert profile for orchestrator ${args.orchestratorId}`,
      "profiles:upsertProfile",
      args.orchestratorId,
    );
    const existing = await findWritableProfile(
      ctx,
      actor,
      { orchestratorId: args.orchestratorId, instanceId: args.instanceId },
      true,
    );

    if (existing !== null) {
      const patch: Record<string, unknown> = {};
      if (args.instanceId !== undefined) patch.instanceId = args.instanceId;
      if (args.name !== undefined) patch.name = args.name;
      if (args.static !== undefined) patch.static = args.static;
      if (args.dynamic !== undefined) patch.dynamic = args.dynamic;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    const owner = await newProfileOwner(ctx, actor, args.orchestratorId);
    return await ctx.db.insert("profiles", {
      ...owner,
      instanceId: args.instanceId,
      name: args.name ?? "Unknown",
      static: args.static ?? { role: "", workspace: "", capabilities: [] },
      dynamic: args.dynamic ?? { lastSeen: Date.now(), sessionCount: 0 },
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// updateDynamic — patch only the dynamic section (called on session start/end)
// Supports both instanceId and orchestratorId lookup.
// ─────────────────────────────────────────────────────────────────────────────

export const updateDynamic = mutation({
  args: {
    orchestratorId: v.string(),
    instanceId: v.optional(v.string()),
    currentTask: v.optional(v.string()),
    // Durable end-of-day index — written only when explicitly passed,
    // independent of `currentTask` (mission k574p02m DEFECT 1 fix).
    endOfDayIndex: v.optional(v.string()),
    // Optional: defaults to Date.now() server-side if omitted (fixes #261)
    lastSeen: v.optional(v.number()),
    sessionCountDelta: v.optional(v.number()),
    // The acting agent: ONE proof per call (see upsertProfile).
    verifiedActor: v.optional(verifiedActorValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
  	// write-contract: MCP-transport-only — issued via mcp-server client.mutation("profiles:updateDynamic", …) at mcp-server/src/tools.ts:3536 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
    const { actor } = await writerOf(
      ctx,
      { verifiedActor: args.verifiedActor },
      `update dynamic profile for orchestrator ${args.orchestratorId}`,
      "profiles:updateDynamic",
      args.orchestratorId,
    );
    const lastSeen = args.lastSeen ?? Date.now();

    const profile = await findWritableProfile(
      ctx,
      actor,
      { orchestratorId: args.orchestratorId, instanceId: args.instanceId },
      false,
    );

    if (profile === null) {
      // Auto-create profile if it doesn't exist
      const owner = await newProfileOwner(ctx, actor, args.orchestratorId);
      await ctx.db.insert("profiles", {
        ...owner,
        instanceId: args.instanceId,
        name: args.instanceId ?? args.orchestratorId,
        static: {
          role: args.orchestratorId,
          workspace: "",
          capabilities: [],
        },
        dynamic: {
          currentTask: args.currentTask,
          // Durable index is explicit-only: written only when the caller
          // passes `endOfDayIndex` (close-day). Never seeded from
          // `currentTask` — that would freeze the index to an arbitrary
          // live status. Undefined here means "no index yet" — the honest
          // state until close-day writes it (mission k574p02m fix).
          endOfDayIndex: args.endOfDayIndex,
          lastSeen,
          sessionCount: 1,
        },
      });
      return null;
    }

    await ctx.db.patch(profile._id, {
      dynamic: {
        currentTask: args.currentTask ?? profile.dynamic.currentTask,
        // Explicit arg always wins. Otherwise, preserve the existing
        // durable index untouched — live-status writes (which never pass
        // `endOfDayIndex`) must never seed or clobber it from `currentTask`.
        // If no index has ever been written, this stays undefined — the
        // honest "no index yet" state until close-day writes it explicitly
        // (mission k574p02m DEFECT 1 fix — see
        // profiles.summaryIndexClobber.test.ts).
        endOfDayIndex:
          args.endOfDayIndex !== undefined
            ? args.endOfDayIndex
            : profile.dynamic.endOfDayIndex,
        lastSeen,
        sessionCount:
          profile.dynamic.sessionCount + (args.sessionCountDelta ?? 0),
      },
    });

    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// getProfileWithMemories — profile + recent typed memories in one query
// returns-projection: memory snippet card for the profile view — full memory doc (namespace/instanceId/relations/isLatest/ttl/episode/updatedAt) fetched via memories.get when a snippet is opened
// ─────────────────────────────────────────────────────────────────────────────
export const getProfileWithMemories = query({
  args: {
    orchestratorId: v.string(),
    instanceId: v.optional(v.string()),
    namespace: v.string(),
    memoryLimit: v.optional(v.number()),
    // The acting agent, forwarded by ID (see getProfile).
    verifiedActor: v.optional(verifiedActorValidator),
  },
  returns: v.object({
    profile: v.union(profileDocValidator, v.null()),
    memories: v.array(memorySnippetValidator),
  }),
  handler: async (ctx, args) => {
    // Fail-closed multi-tenant fix (defect class: authority attached to an
    // anonymously-registered object — .claude/rules/authority-attached-to-
    // anonymous-object.md). This query took NO identity check: it reads the
    // `memories` table by a CALLER-SUPPLIED namespace, so a caller with no
    // credential at all could read any tenant's memories straight off the
    // public Convex deployment URL — the same hole measured on
    // memoriesScoped:listMemoriesScoped, reached through a different door.
    //
    // REFUSAL SHAPE — typed empty, not a throw: reactively-subscribed public
    // READ (see the note on episodes.ts::listEpisodes). The `profile` half is
    // also withheld: `profiles` carries no tenant field (see
    // requireFleetMaster above), so a refused caller gets `null` rather than a
    // fleet-internal orchestrator row. Reuses withOrgScope +
    // isNamespaceAllowedForScope — the SAME mechanism memories.ts::listMemories
    // uses, never a second identity layer.
    const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
    if (!isNamespaceAllowedForScope(scope, args.namespace)) {
      return { profile: null, memories: [] };
    }

    const limit = args.memoryLimit ?? 20;

    // The profile half is judged by stored agent ID like getProfile: a row of
    // another organisation's same-named agent, or a row with no agent, is `null`.
    const actor = await resolveVerifiedProfileAgent(
      ctx,
      scope,
      args.verifiedActor,
      "profiles:getProfileWithMemories",
    );
    let profile = await findProfileForCaller(
      ctx,
      scope,
      actor,
      { instanceId: args.instanceId },
      "profiles:getProfileWithMemories",
    );
    if (profile === null) {
      profile = await findProfileForCaller(
        ctx,
        scope,
        actor,
        { orchestratorId: args.orchestratorId },
        "profiles:getProfileWithMemories",
      );
    }

    const allMemories = await ctx.db
      .query("memories")
      .withIndex("by_namespace", (q) =>
        q.eq("namespace", args.namespace).eq("isLatest", true),
      )
      .order("desc")
      .take(limit);

    const memories = allMemories.map((m) => ({
      _id: m._id,
      type: m.type,
      content: m.content,
      createdBy: m.createdBy,
      createdAt: m.createdAt,
    }));

    return { profile, memories };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// listProfiles — list all profiles (all instances)
// ─────────────────────────────────────────────────────────────────────────────

// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
// convex/missions.ts MISSION_LIST_SCAN_CAP, convex/briefingNotes.ts
// BRIEFING_NOTES_LIST_SCAN_CAP). When paginating via `createdBefore`, the
// post-take filter only finds rows older than the cursor if the FETCH is
// wide enough to include them — mission k574p02m DEFECT 2 fix.
export const PROFILES_LIST_SCAN_CAP = 2000;

export const listProfiles = query({
  args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
    orchestratorId: v.optional(v.string()),
    // S3.3 B8 follow-up batch 3 FINAL — cursor paging rollout.
    limit: v.optional(v.number()),
    createdBefore: v.optional(v.number()),
    // The acting agent, forwarded by ID: the master's list is then narrowed to the
    // profiles of that agent's own organisation (judged by stored ID).
    verifiedActor: v.optional(verifiedActorValidator),
  },
  // A bare array is what the fleet master is served (rows, or a genuine
  // absence). An ORDINARY member of an active org is served the typed refusal
  // envelope instead — see the REFUSAL SHAPE note below.
  returns: v.union(
    v.array(profileDocValidator),
    v.object({ refused: v.literal(true), items: v.array(profileDocValidator) }),
  ),
  handler: async (ctx, args) => {
    // Fail-closed READ counterpart of this file's own master-only WRITE gate
    // (`requireFleetMaster` above). Measured against LIVE production at commit
    // bd8c60e9: this query returned 50 rows to a caller presenting NO
    // CREDENTIAL AT ALL, straight off the public deployment URL — it consulted
    // no identity whatsoever. `profiles` carries no orgId/tenant column (see
    // requireFleetMaster's rationale), so there is no tenant to scope to and
    // the read must admit exactly what the write admits: master, nobody else.
    // An ORDINARY member of an active org is refused here too, deliberately —
    // pinned by publicRegistrationResolvesCaller.test.ts's third deny pole, so
    // "is anyone signed in" can never pass for authority.
    // REFUSAL SHAPE — typed empty, never a throw: this is a reactively-
    // subscribed public READ and a throw crashes the subscriber's render
    // (R-50/R-51), which is exactly what `refuseWithoutThrow` exists for.
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
    // (orchestrators-grid.tsx:53, measured by grep in vantage-peers-dashboard,
    // origin/main), so NO refused caller may be RAISED at except the anonymous
    // one: `alsoRefusePreOrg` is NOT passed.
    //
    // THREE refused populations, and the third was RE-DECIDED (task
    // k1749w7ecx2yffr1hbhjpk8v858fbrf1) rather than inherited from R-50:
    //   anonymous            -> RAISES (no mounted render exists to crash).
    //   signed-in, no org    -> `{ refused: true, items: [] }`. Its shell IS
    //     mounted and IS subscribed, so a throw would crash the render (R-50's
    //     reasoning holds). But R-50 justified a bare `[]`, and a bare `[]` is
    //     byte-identical to "no profiles exist". The envelope is render-safe for
    //     the same reason it is for a member: orchestrators-grid.tsx:56
    //     normalises `Array.isArray(r) ? r : (r.items ?? [])`, so it renders
    //     empty AND says it was refused.
    //   ordinary org member  -> `{ refused: true, items: [] }`, same shape.
    // The fleet master alone is served the bare array.
    const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
    requireResolvedCaller(scope, "profiles:listProfiles");
    if (!scope.isMaster) {
      return { refused: true as const, items: [] };
    }

    const actor = await resolveVerifiedProfileAgent(
      ctx,
      scope,
      args.verifiedActor,
      "profiles:listProfiles",
    );

    const take = args.limit ?? 50;
    // Widen the fetch whenever a cursor is present, so the post-take
    // `createdBefore` filter has candidate rows older than the anchor to
    // find (mirrors tasks.ts `needsWideScan` / `fetchCap`). An acting agent's
    // list is filtered by stored ID AFTER the read, so it is wide too.
    const needsWideScan = args.createdBefore !== undefined || actor !== undefined;
    const fetchCap = needsWideScan ? PROFILES_LIST_SCAN_CAP + 1 : take;
    let rows: Doc<"profiles">[];
    if (args.orchestratorId !== undefined) {
      rows = await ctx.db
        .query("profiles")
        .withIndex("by_orchestrator", (q) =>
          q.eq("orchestratorId", args.orchestratorId!),
        )
        .order("desc")
        .take(fetchCap);
    } else {
      rows = await ctx.db.query("profiles").order("desc").take(fetchCap);
    }
    // S3.3 B8 follow-up — post-take createdBefore filter mirrors briefingNotes
    // pattern (convex/briefingNotes.ts:96-134, GREEN of PR #635). Profiles use
    // `_creationTime` as the cursor anchor.
    if (actor !== undefined) {
      rows = await visibleProfiles(ctx, scope, actor, rows, "profiles:listProfiles");
    }
    if (args.createdBefore !== undefined) {
      const before = args.createdBefore;
      rows = rows.filter((r) => r._creationTime < before);
    }
    return rows.slice(0, take);
  },
});
