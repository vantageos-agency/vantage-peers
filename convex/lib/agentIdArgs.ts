import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	assigneeNotInOrgRefusal,
	requireAssigneeAgentActive,
} from "./actingPrincipal";
import { requireId } from "./ids";

// ─────────────────────────────────────────────────────────────────────────────
// agentIdArgs — an agent named BY ID on a door that used to take only a name
// (identity-zero slice 2b, task k1778c2hvae8e8vz9f5bbbbbb98g62hw).
//
// It decides NOTHING about identity. The ID is read BY ID and judged by
// @vantageos/cloud-identity through `requireAssigneeAgentActive` (the row exists,
// is ACTIVE, is stamped with this organisation, in an active organisation); a
// refusal is the package's, said in this backend's `RBAC_DENIED` shape naming the
// door. This module adds only what the package cannot know: the argument
// is a string that must be an `agents` ID (a name or another table's ID is a typed
// validation error, never a lookup).
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/**
 * resolveAgentIdArg — the `agents` row an ID argument names, in `orgSlug`.
 *
 * `orgSlug` is the organisation the write lives in (the row's own org, the
 * verified caller's org, or the operator org for a fleet row): the caller derives
 * it from the VERIFIED scope, never from an argument. An agent of another
 * organisation, an unknown ID and an inactive agent are all refused by the
 * package with a coded error.
 */
export async function resolveAgentIdArg(
	ctx: Ctx,
	args: {
		orgSlug: string | undefined | null;
		agentId: string;
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
		throw assigneeNotInOrgRefusal(args.agentId, undefined, args.door);
	}
	await requireAssigneeAgentActive(ctx, id, args.orgSlug, args.door);
	const row = await ctx.db.get(id);
	if (row === null) {
		// The package just resolved this row; absent here means it vanished mid-call.
		throw assigneeNotInOrgRefusal(args.agentId, args.orgSlug, args.door);
	}
	return row;
}
