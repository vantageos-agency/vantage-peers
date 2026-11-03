// erase — the doors of the one erase mechanism (convex/lib/eraseRow.ts). Task
// k170t9bg650dyw6hxjj627p9fx8hhpeq.
//
//   erase:eraseRow       client door. The caller is one of three, decided by the proof the
//                        call carries (resolveEraseCaller): a Clerk session, a person
//                        bearer (`verifiedPerson`, the bearer hash) or a seat's verified
//                        agent (`verifiedActor`). An org admin erases any row of its org,
//                        an author the rows it wrote; anyone else is refused RBAC_DENIED.
//   erase:eraseRowFleet  internal. The operator's reach over every org's rows
//                        (`npx convex run`); no client can call it.
//
// The covered tables and what each erase removes are in ERASE_COVERED / eraseTableRow.

import { v } from "convex/values";
import type { PropertyValidators } from "convex/values";
import { internalMutation } from "./_generated/server";
import { mutation } from "./lib/functions";
import { requireResolvedCaller, verifiedActorValidator, withOrgScope } from "./lib/auth";
import {
	ERASE_TABLES,
	performErase,
	resolveEraseCaller,
	type EraseTable,
} from "./lib/eraseRow";
import { verifiedPersonValidator } from "./lib/personPrincipal";

type TableLiteral = ReturnType<typeof v.literal<EraseTable>>;
const tableValidator = v.union(
	...(ERASE_TABLES.map((name) => v.literal(name)) as unknown as [
		TableLiteral,
		TableLiteral,
		...TableLiteral[],
	]),
);

const resultValidator = v.object({
	table: tableValidator,
	rowId: v.string(),
	erased: v.literal(true),
	cascaded: v.record(v.string(), v.number()),
});

const baseArgs = {
	table: tableValidator,
	rowId: v.string(),
} satisfies PropertyValidators;

export const eraseRow = mutation({
	args: {
		...baseArgs,
		// A person signed in through the MCP OAuth flow: the bearer hash, resolved by the
		// door to the token row (subject, org and role are never carried).
		verifiedPerson: v.optional(verifiedPersonValidator),
		// A seat: the agent the transport verified, by its agents-row ID.
		verifiedActor: v.optional(verifiedActorValidator),
	},
	returns: resultValidator,
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("erase:eraseRow", …) in tools.ts erase_row (imperative); 0 dashboard hits for api.erase (measured with grep -rn "api\.erase" in vantage-peers-dashboard); never a subscribing pre-org client shell. Every refusal is the coded RBAC_DENIED the MCP layer relays.
		const door = "erase:eraseRow";
		// A caller that cannot be resolved at all (no credential, signed in without an
		// organisation) is refused by RAISING before any proof is read.
		requireResolvedCaller(await withOrgScope(ctx, { refuseWithoutThrow: true }), door);
		const caller = await resolveEraseCaller(ctx, {
			door,
			verifiedPerson: args.verifiedPerson,
			verifiedActor: args.verifiedActor,
		});
		return await performErase(ctx, {
			table: args.table,
			rowId: args.rowId,
			caller,
			door,
		});
	},
});

export const eraseRowFleet = internalMutation({
	args: baseArgs,
	returns: resultValidator,
	handler: async (ctx, args) =>
		await performErase(ctx, {
			table: args.table,
			rowId: args.rowId,
			caller: { kind: "fleet" },
			door: "erase:eraseRowFleet",
		}),
});
