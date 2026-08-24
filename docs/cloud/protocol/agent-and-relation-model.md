# The agent entity, and the parent-child relation

VantagePeers Cloud only. This is the shipped protocol layer, not a plan — every name, field, and index below is derived from the code cited next to it. Read on `origin/main` at `a9d441c` (`git rev-parse HEAD`).

## Why this table exists

Before this table, `mcp__vantage-peers__list_peers` rows carried `id`/`instanceId`/`name`/`role`/`workspace`/`currentTask`/`lastSeen`/`sessionCount` and no organisation field — org membership rode on the calling token, never on the agent itself. `convex/agents.ts` is the missing organisation carrier (comment, `convex/agents.ts:7-19`): a CREATE, not an extension of any existing shape. Governing cap: `analysis/le-cap/le-cap.md @ e3c1ffd6` §6 VP.2 (corrected).

## The `agents` table — what an agent entity carries

Source: `convex/schema.ts:1320-1333`.

```
agents: defineTable({
	orgSlug: v.string(),                    // client_org_mapping.clerkOrgSlug — the org that owns this agent
	name: v.string(),                       // agent's declared name, unique within its org (see by_org_name)
	description: v.optional(v.string()),
	address: v.optional(v.string()),        // write-back target used AFTER an agent deploys
	outboundAuthRef: v.optional(v.string()),// opaque reference to an outbound-auth credential; never the raw credential
	isActive: v.boolean(),
	createdAt: v.number(),
})
	.index("by_org", ["orgSlug"])
	.index("by_org_name", ["orgSlug", "name"])
```

`address` is not known at registration time — it is populated later, after the agent has actually deployed (Eve `host` prints the address; the emitter writes it back here). `outboundAuthRef` never carries a raw credential, only a reference to one.

## Queries and mutations — verified exported names

Source: `convex/agents.ts` (`grep -n "^export const" convex/agents.ts`):

```
export const registerAgent = mutation(...)     // convex/agents.ts:56
export const setAgentAddress = mutation(...)   // convex/agents.ts:100
export const getAgent = query(...)             // convex/agents.ts:135
export const listAgentsByOrg = query(...)      // convex/agents.ts:155
```

- `registerAgent` — creates or updates an agent row in the caller's own org, gated by `requireOrgAdmin`. Idempotent on `(orgSlug, name)`: a second call with the same pair updates `description`/`outboundAuthRef`/`isActive` instead of duplicating (`convex/agents.ts:41-92`).
- `setAgentAddress` — the write-back path used after an agent deploys; the emitter (parent-child edge layer) reads this address as the source for a parent's remote-agent declaration. Same `requireOrgAdmin` gate. Refuses with `AGENT_NOT_FOUND` if no row exists for `(orgSlug, name)` (`convex/agents.ts:94-128`).
- `getAgent` — org-scoped lookup by `(orgSlug, name)` (`convex/agents.ts:130-148`).
- `listAgentsByOrg` — org-scoped listing via the `by_org` index (`convex/agents.ts:150-166`).

## The `agent_relations` table — the parent-child edge, many-to-many

The parent-child edge is deliberately **not** modeled inside `agents` — it attaches on top of it, in a separate layer, because "a declared subagent inherits nothing from the root's authored slots" (comment citing `docs-subagents.md`, `convex/agents.ts:17-19`).

Source: `convex/schema.ts:1346-1354`.

```
agent_relations: defineTable({
	orgSlug: v.string(),
	parentName: v.string(),  // agents.name of the parent in this org
	childName: v.string(),   // agents.name of the child in this org
	createdAt: v.number(),
})
	.index("by_org", ["orgSlug"])
	.index("by_parent", ["orgSlug", "parentName"])
	.index("by_child", ["orgSlug", "childName"])
```

**Many-to-many, deliberately** (`convex/agentRelations.ts:19-22`): a child shared by two parents is TWO ROWS in `agent_relations`, never a parent field on the child row — a parent field would cap a child at exactly one parent and could not represent the shared-child case the cap calls out.

## Queries and mutations — verified exported names

Source: `convex/agentRelations.ts` (`grep -n "^export const" convex/agentRelations.ts`):

```
export const linkChild = mutation(...)     // convex/agentRelations.ts:59
export const unlinkChild = mutation(...)   // convex/agentRelations.ts:95
export const childrenOf = query(...)       // convex/agentRelations.ts:125
export const parentsOf = query(...)        // convex/agentRelations.ts:145
export const graphByOrg = query(...)       // convex/agentRelations.ts:167
```

- `linkChild` — records a parent→child edge, org-admin gated, idempotent on `(orgSlug, parentName, childName)` — never checks or enforces a single-parent constraint (`convex/agentRelations.ts:48-88`).
- `unlinkChild` — removes the edge; no-op (returns `null`) if it does not exist (`convex/agentRelations.ts:90-118`).
- `childrenOf` — all children of `parentName`, via the `by_parent` index (`convex/agentRelations.ts:120-138`).
- `parentsOf` — all parents of `childName`, via the `by_child` index — proves the shared-child case: a child linked from two parents returns both rows (`convex/agentRelations.ts:140-158`).
- `graphByOrg` — the whole org's graph as `{ nodes, edges }`. Nodes are the distinct set of names appearing as either a parent or a child across the org's edges — an agent registered in `agents` but never linked does not appear (this is the edge graph, not the agent roster) (`convex/agentRelations.ts:160-193`).

## How an org reads its own graph, and nobody else's

Every mutation and query in both files calls `requireOrgAdmin(ctx, args.orgSlug)` before touching the database (`convex/agents.ts:21-27`, `convex/agentRelations.ts:24-31`). `requireOrgAdmin` verifies the caller's own org — derived from the authenticated identity, never from a caller-supplied claim — equals `args.orgSlug`; a caller from org B passing org A's slug is refused (`RBAC_DENIED`), never silently emptied. There is no master carve-out on any of these calls — an org-admin identity of the target org is required every time. This is the same gate `client_org_mapping`-backed `provisionOrganization` uses, reused rather than duplicated. See `.claude/rules/authority-attached-to-anonymous-object.md` for the general doctrine this instance follows: authority is bound to the verified principal, never a caller-supplied value.
