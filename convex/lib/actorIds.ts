// actorIds — name -> stable ID resolution for the R-53 identity-by-ID lane
// (Pi ruling (b)/(f), task k174d95s5qqy8t2r5rdrz3pr3d8fqv82).
//
// THE ID. For an AGENT it is the `agents` row `_id` (as a string); for a PERSON
// it is the stable person principal "user:<verified subject>", which IS the name
// the person is already recorded under (convex/lib/humanActor.ts), so it needs no
// lookup. A name is a LABEL; this module is the only place one becomes an ID.
//
// WITHIN ONE ORG. An agent name is looked up in exactly one organisation: the
// org of the row being written (the caller's verified org, or the operator org
// for a fleet/master row). The same name in another org is a DIFFERENT agent and
// is never matched. A name that resolves to no agents row of that org returns
// undefined: the column is left unset, never guessed.

import type {
	DatabaseReader,
	MutationCtx,
	QueryCtx,
} from "../_generated/server";
import { findAgentByName } from "./agentIdentity";
import { isHumanActorName } from "./humanActor";
import { fleetOperatorSlug } from "./operatorOrg";

export type ActorIdResolver = (
	name: string | undefined,
) => Promise<string | undefined>;

/**
 * The org an ID is resolved in: the row's own stamp, or the operator org when
 * the row is fleet-owned (no stamp). undefined only when the row is fleet-owned
 * and there is not exactly one active operator org (fail closed: no ID).
 */
export async function actorOrgFor(
	db: DatabaseReader,
	orgSlug: string | undefined | null,
): Promise<string | undefined> {
	if (orgSlug !== undefined && orgSlug !== null) return orgSlug;
	return await fleetOperatorSlug(db);
}

/**
 * One name -> ID resolver bound to one org. `orgSlug` undefined/null means the
 * operator org. The org is derived once, not per name.
 */
export function actorIdResolver(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string | undefined | null,
): ActorIdResolver {
	let org: Promise<string | undefined> | undefined;
	return async (name) => {
		if (name === undefined || name.trim() === "") return undefined;
		// A person is its own stable ID: "user:<subject>".
		if (isHumanActorName(name)) return name;
		org ??= actorOrgFor(ctx.db, orgSlug);
		const slug = await org;
		if (slug === undefined) return undefined;
		const row = await findAgentByName(ctx, slug, name);
		return row === null ? undefined : row._id;
	};
}

/**
 * The columns a new task row stamps, from the RESOLVED principal and target
 * rows. Unresolvable names are simply absent (never `undefined`-valued keys).
 */
export async function taskActorIdFields(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string | undefined | null,
	names: { createdBy?: string; assignedTo?: string; lastAssignedTo?: string },
): Promise<{
	createdById?: string;
	assignedToId?: string;
	lastAssignedToId?: string;
}> {
	const resolve = actorIdResolver(ctx, orgSlug);
	const out: {
		createdById?: string;
		assignedToId?: string;
		lastAssignedToId?: string;
	} = {};
	const createdById = await resolve(names.createdBy);
	if (createdById !== undefined) out.createdById = createdById;
	const assignedToId = await resolve(names.assignedTo);
	if (assignedToId !== undefined) out.assignedToId = assignedToId;
	const lastAssignedToId = await resolve(names.lastAssignedTo);
	if (lastAssignedToId !== undefined) out.lastAssignedToId = lastAssignedToId;
	return out;
}
