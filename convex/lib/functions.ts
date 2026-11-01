import { customAction, customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { action, mutation, query } from "../_generated/server";
import { actingOrgValidator, authCarryingActingOrg } from "./actingOrg";

// ─────────────────────────────────────────────────────────────────────────────
// The PUBLIC function builders of this backend (task k179y0wpsd6fv7055f4p2w6b358hdrxe).
//
// Every public query, mutation and action is defined with these, never with the
// bare builders of `_generated/server` (pinned by
// convex/__tests__/actingOrgBuilders.test.ts). Each one declares the reserved
// `__actingOrg` argument, removes it from the args the handler receives, and
// hands the handler a ctx whose `auth` carries it (convex/lib/actingOrg.ts).
// Nothing is decided here: `withOrgScope` and `fleetStandingOf` read it, on the
// fleet service-account branch only.
//
// Internal functions keep the bare builders: they are unreachable from a
// client, and an action that calls a public function forwards the org itself
// (`actingOrgArgs`).
// ─────────────────────────────────────────────────────────────────────────────

const actingOrgArgs = { __actingOrg: actingOrgValidator };

const publicQuery = customQuery(query, {
	args: actingOrgArgs,
	input: async (ctx, args) => ({
		ctx: { auth: authCarryingActingOrg(ctx.auth, args.__actingOrg) },
		args: {},
	}),
}) as unknown as typeof query;

const publicMutation = customMutation(mutation, {
	args: actingOrgArgs,
	input: async (ctx, args) => ({
		ctx: { auth: authCarryingActingOrg(ctx.auth, args.__actingOrg) },
		args: {},
	}),
}) as unknown as typeof mutation;

const publicAction = customAction(action, {
	args: actingOrgArgs,
	input: async (ctx, args) => ({
		ctx: { auth: authCarryingActingOrg(ctx.auth, args.__actingOrg) },
		args: {},
	}),
}) as unknown as typeof action;

// Exported under the bare builder names, so a module's `query({...})` reads as
// a public registration to every reader (and to backend-doctor's builder map:
// each wrapper's base is the literal public builder).
export { publicAction as action, publicMutation as mutation, publicQuery as query };
