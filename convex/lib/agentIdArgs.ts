import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { requireAssigneeAgentActive } from "./actingPrincipal";
import { requireId } from "./ids";

// ─────────────────────────────────────────────────────────────────────────────
// agentIdArgs — an agent named BY ID on a door that used to take only a name
// (identity-zero slice 2b, task k1778c2hvae8e8vz9f5bbbbbb98g62hw).
//
// It decides NOTHING about identity. The ID is read BY ID and judged by
// @vantageos/cloud-identity through `requireAssigneeAgentActive` (the row exists,
// is ACTIVE, is stamped with this organisation, in an active organisation); a
// refusal is the package's, said in this backend's `RBAC_DENIED` shape naming the
// door. This module adds only the two things the package cannot know: the
// argument is a string that must be an `agents` ID (a name or another table's ID
// is a typed validation error, never a lookup), and an ID given beside a name must
// name the SAME agent (`AGENT_IDENTITY_MISMATCH`, nothing written, because the
// caller's mutation throws before its first write).
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/**
 * resolveAgentIdArg — the `agents` row an ID argument names, in `orgSlug`.
 *
 * `orgSlug` is the organisation the write lives in (the row's own org, the
 * verified caller's org, or the operator org for a fleet row): the caller derives
 * it from the VERIFIED scope, never from an argument. `assertedName` is the name
 * the same call carries, if any; when it names a different agent the call is
 * refused. An agent of another organisation, an unknown ID and an inactive agent
 * are all refused by the package with a coded error.
 */
export async function resolveAgentIdArg(
	ctx: Ctx,
	args: {
		orgSlug: string | undefined | null;
		agentId: string;
		assertedName: string | undefined;
		field: string;
		door: string;
	},
): Promise<Doc<"agents">> {
	const id = requireId(
		ctx,
		"agents",
		args.agentId,
		args.field,
		`${args.door} takes an agent ID as returned by list_peers \`agentId\`; a name is never matched here.`,
	);
	if (args.orgSlug === undefined || args.orgSlug === null) {
		throw new ConvexError(
			`RBAC_DENIED: ${args.field} "${args.agentId}" cannot be resolved: no organisation to resolve it in — ${JSON.stringify({ reason: "no-organisation", door: args.door, field: args.field })}`,
		);
	}
	await requireAssigneeAgentActive(ctx, id, args.orgSlug, args.door);
	const row = await ctx.db.get(id);
	if (row === null) {
		// The package just resolved this row; absent here means it vanished mid-call.
		throw new ConvexError(
			`RBAC_DENIED: ${args.field} "${args.agentId}" names no agent — ${JSON.stringify({ reason: "agent-id-unknown", door: args.door, field: args.field })}`,
		);
	}
	if (
		args.assertedName !== undefined &&
		normalizeOrchestratorId(args.assertedName) !==
			normalizeOrchestratorId(row.name)
	) {
		throw new ConvexError(
			`AGENT_IDENTITY_MISMATCH: ${args.field} "${args.agentId}" is agent "${row.name}" but the call also names "${args.assertedName}" — an ID and a name must name the same agent — ${JSON.stringify({ door: args.door, field: args.field, agentId: args.agentId, resolvedAgentName: row.name, assertedName: args.assertedName })}`,
		);
	}
	return row;
}
