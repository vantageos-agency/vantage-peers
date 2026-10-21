import type { MutationCtx } from "../_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// nameOnlyCalls — the read-only counter of calls that name an agent by NAME.
//
// Identity-zero slice 2b adds agent-ID arguments beside the name arguments;
// slice 2c refuses names, but only after a full production day with none. This
// counter is the instrument that decides 2c. It is a MEASUREMENT, not a gate:
// recording never changes what a door does, and a door counts only from inside
// a MUTATION (a query cannot write, and is never forced to).
//
// Counted doors (a call is counted when it names the agent by name and carries
// no matching ID):
//   tasks:create:assignedTo        `assignedTo` without `assignedToAgentId`
//   tasks:update:assignedTo        `assignedTo` without `assignedToAgentId`
//   mandates:create:fulfilledBy    `fulfilledBy` without `fulfilledByAgentId`
//   messages:sendMessage:from      `from` without `fromAgentId`
//   messages:sendMessage:channel   a `channel` part that names an agent of the
//                                  message's organisation (broadcast and a
//                                  person have no ID form and are not counted;
//                                  `recipientAgentIds` is the ID path)
// A call a door REFUSES rolls back with the rest of its transaction and is not
// counted. Reads that filter by a name (tasks:listPaginated, mandates:list, ...)
// are queries and are NOT counted.
// ─────────────────────────────────────────────────────────────────────────────

export const NAME_ONLY_DOORS = [
	"tasks:create:assignedTo",
	"tasks:update:assignedTo",
	"mandates:create:fulfilledBy",
	"messages:sendMessage:from",
	"messages:sendMessage:channel",
] as const;
export type NameOnlyDoor = (typeof NAME_ONLY_DOORS)[number];

// Increments spread over this many rows per (door, day), so concurrent writers
// rarely read-modify-write the same document.
export const NAME_ONLY_SHARDS = 8;

/** The UTC day, "YYYY-MM-DD", of a timestamp in milliseconds. */
export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/**
 * recordNameOnlyCall — add one to the (door, today, shard) counter. Writes
 * nothing else and returns nothing; never refuses.
 */
export async function recordNameOnlyCall(
	ctx: MutationCtx,
	door: NameOnlyDoor,
): Promise<void> {
	const day = utcDay(Date.now());
	const shard = Math.floor(Math.random() * NAME_ONLY_SHARDS);
	const row = await ctx.db
		.query("nameOnlyCalls")
		.withIndex("by_door_day_shard", (q) =>
			q.eq("door", door).eq("day", day).eq("shard", shard),
		)
		.unique();
	if (row === null) {
		await ctx.db.insert("nameOnlyCalls", { door, day, shard, count: 1 });
		return;
	}
	await ctx.db.patch(row._id, { count: row.count + 1 });
}
