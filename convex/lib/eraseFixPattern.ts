// eraseFixPattern -- the erase of one fix pattern, under the SAME rule as erase:eraseRow
// (convex/lib/eraseRow.ts `assertMayErase`). Task k176x68sj2jkwx46nshvtt40e18ht1xh.
//
// A fix pattern has no organisation column: it is fleet-owned, so the owning organisation is
// the OPERATOR organisation (the active `orgKind: "operator"` mapping,
// convex/lib/operatorOrg.ts). It also has no author ID (`createdBy` is a display label), and
// the rule for a row with no stored author ID is the one erase:eraseRow states: an admin of
// the owning organisation only. Resolving the label to an agent would decide identity by a
// name, which this backend does not do. The pattern, the attempts that exist only for it and
// its search entry are DELETED.

import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { assertMayErase, type EraseCaller } from "./eraseRow";
import { operatorClerkOrgId } from "./operatorOrg";

const MAX_ATTEMPTS_PER_ERASE = 1000;

export async function performFixPatternErase(
	ctx: MutationCtx,
	args: { rawId: string; caller: EraseCaller; door: string },
): Promise<{ patternId: string; erased: true; cascaded: Record<string, number> }> {
	const { caller, door } = args;
	const id = ctx.db.normalizeId("fixPatterns", args.rawId);
	const pattern = id === null ? null : await ctx.db.get(id);
	const operatorOrgId = await operatorClerkOrgId(ctx.db);
	// The row the shared decision reads: its owning organisation by ID, no author. A
	// missing pattern, or no operator org with an ID, has no organisation and is refused
	// like another org's row (no existence oracle).
	const judged: Record<string, unknown> | null =
		pattern === null || operatorOrgId === undefined
			? null
			: { clerkOrgId: operatorOrgId };
	await assertMayErase(
		ctx,
		caller,
		judged,
		{ orgField: "clerkOrgId", authorField: "createdById", labelField: null },
		door,
	);
	if (id === null || pattern === null) {
		throw new ConvexError(
			`ERASE_ROW_NOT_FOUND: fixPatterns row ${args.rawId} does not exist — ${JSON.stringify({ table: "fixPatterns", door })}`,
		);
	}
	const attempts = await ctx.db
		.query("fixAttempts")
		.withIndex("by_pattern", (q) => q.eq("patternId", id))
		.take(MAX_ATTEMPTS_PER_ERASE + 1);
	if (attempts.length > MAX_ATTEMPTS_PER_ERASE) {
		throw new ConvexError(
			`FIX_PATTERN_ERASE_TOO_LARGE: the pattern holds more than ${MAX_ATTEMPTS_PER_ERASE} attempts; nothing was erased — ${JSON.stringify({ door, cap: MAX_ATTEMPTS_PER_ERASE })}`,
		);
	}
	for (const attempt of attempts) await ctx.db.delete(attempt._id);
	await ctx.db.delete(id);
	await ctx.scheduler.runAfter(0, internal.ragSync.removeFixPatternRagEntry, {
		patternId: id,
	});
	return {
		patternId: id,
		erased: true,
		cascaded: { fixAttempts: attempts.length, searchEntry: 1 },
	};
}
