import { hasFleetRead, sameOrg } from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { OrgScope, RosterNameKind } from "./auth";
import { orgRefOfRow, orgRefOfScope } from "./authOrgMapping";
import { agentListedOnRoster, rosterOf } from "./rosterIds";

// ─────────────────────────────────────────────────────────────────────────────
// scopeRosterIds — the ROSTER leg of a row read, decided by agent ID.
//
// `filterByOrgScope` / `isRowVisibleToScope` (convex/lib/auth.ts) judge a row
// in two steps: the tenant gate (the row is the caller's organisation) and the
// roster (the row's pilot / assignee is on the organisation's roster). Their
// roster step compares NAMES (`pilot ?? assignedTo` against
// `scope.allowedOrchestrators`) and stays only until the doors that call them
// migrate. These are their ID replacements, for rows that carry the agent's ID
// (`pilotId` on a mission, `assignedToId` on a task):
//
//   - the tenant gate is the package's `sameOrg` (permanent org ID, a label
//     never matches, an unstamped row matches nothing);
//   - the roster is `scope.allowedAgentIds`, judged by the package
//     (`assertPrincipalListed` through lib/rosterIds.ts): the agent is read BY
//     ID, must be active and stamped with the caller's organisation, and its ID
//     must be a byte-equal entry of the org's stored roster. No name is read,
//     no wildcard exists, and an absent roster admits nothing.
//
// They are async because the package reads the agent row. The fleet read
// (`hasFleetRead`: the service account, the internal opt-in, the operator
// human on a read) sees every row, exactly as the name path does.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/** A row the roster leg can judge by ID. */
export type RosterIdRow = {
	orgId?: string;
	clerkOrgId?: string;
	/** A mission's pilot, by agent ID. */
	pilotId?: string;
	/** A task's assignee, by agent ID. */
	assignedToId?: string;
};

const agentIdOf = (row: RosterIdRow): string | undefined =>
	row.pilotId ?? row.assignedToId;

/**
 * Is the agent `agentId` an entry of the caller's own organisation roster
 * (`allowedAgentIds`)? Judged by the package (`assertPrincipalListed` through
 * lib/rosterIds.ts): the agent is read BY ID, must be active and stamped with
 * the caller's organisation, and be a byte-equal entry; no wildcard, refused by
 * default. A scope with no verified organisation lists nobody.
 */
export async function isAgentIdOnScopeRoster(
	ctx: Ctx,
	scope: OrgScope,
	agentId: string,
	door: string,
): Promise<boolean> {
	if (scope.orgSlug === null) return false;
	const verdict = await agentListedOnRoster(
		ctx,
		{ agentId, agentOrgId: scope.orgSlug },
		rosterOf(scope.orgSlug, scope.allowedAgentIds),
		door,
	);
	return verdict.ok;
}

/**
 * The agent a write names as its sender, actor or assignee must be on the
 * caller's own organisation roster, BY ID. The ID counterpart of
 * `requireOrchestratorOnRoster` (lib/auth.ts), with the same carve-outs and the
 * same refusal: the fleet read and a scope with no organisation are not held
 * to an organisation roster (the master is bound at the MCP layer, an
 * unresolved caller is refused by the tenant derivation in the delivery core);
 * every other caller is refused `RBAC_DENIED`, `reason: "<kind>-not-on-roster"`,
 * naming the door.
 */
export async function requireAgentIdOnScopeRoster(
	ctx: Ctx,
	scope: OrgScope,
	agentId: string,
	registration: string,
	kind: RosterNameKind = "sender",
): Promise<void> {
	if (hasFleetRead(scope) || scope.orgSlug === null) return;
	if (await isAgentIdOnScopeRoster(ctx, scope, agentId, registration)) return;
	throw new ConvexError(
		`RBAC_DENIED: ${kind} ${agentId} is not an agent on the roster of org "${scope.orgSlug}" — ${JSON.stringify({ reason: `${kind}-not-on-roster`, door: registration, agentId, orgSlug: scope.orgSlug })}`,
	);
}

/**
 * Is a SINGLE row visible to this scope, judged by ID? The ID counterpart of
 * `isRowVisibleToScope`: fleet read sees it; no verified organisation never;
 * another organisation's (or an unstamped) row never; then the row's agent must
 * be an entry of the caller's own ID roster. A row naming no agent is not
 * visible to an organisation member.
 */
export async function isRowVisibleToScopeById(
	ctx: Ctx,
	scope: OrgScope,
	row: RosterIdRow,
	door: string,
): Promise<boolean> {
	if (hasFleetRead(scope)) return true;
	if (scope.orgSlug === null) return false;
	if (!sameOrg(orgRefOfRow(row), orgRefOfScope(scope))) return false;
	const agentId = agentIdOf(row);
	if (agentId === undefined) return false;
	return await isAgentIdOnScopeRoster(ctx, scope, agentId, door);
}

/**
 * The records this scope may see, judged by ID. The ID counterpart of
 * `filterByOrgScope`: both the tenant gate and the roster leg must hold, and
 * each distinct agent is judged once however many records name it.
 */
export async function filterByOrgScopeById<T extends RosterIdRow>(
	ctx: Ctx,
	records: readonly T[],
	scope: OrgScope,
	door: string,
): Promise<T[]> {
	if (hasFleetRead(scope)) return [...records];
	if (scope.orgSlug === null) return [];
	const orgSlug = scope.orgSlug;
	const caller = orgRefOfScope(scope);
	const roster = rosterOf(orgSlug, scope.allowedAgentIds);
	const judged = new Map<string, boolean>();
	const out: T[] = [];
	for (const record of records) {
		if (!sameOrg(orgRefOfRow(record), caller)) continue;
		const agentId = agentIdOf(record);
		if (agentId === undefined) continue;
		let listed = judged.get(agentId);
		if (listed === undefined) {
			const verdict = await agentListedOnRoster(
				ctx,
				{ agentId, agentOrgId: orgSlug },
				roster,
				door,
			);
			listed = verdict.ok;
			judged.set(agentId, listed);
		}
		if (listed) out.push(record);
	}
	return out;
}
