import { publicAction, publicMutation, publicQuery } from "./publicBuilders";

// ─────────────────────────────────────────────────────────────────────────────
// The PUBLIC function builders of this backend (task k179y0wpsd6fv7055f4p2w6b358hdrxe).
//
// Every public query, mutation and action is defined with these, never with the
// bare builders of `_generated/server` (pinned by
// convex/__tests__/actingOrgBuilders.test.ts). Each declares the reserved
// `__actingOrg` argument, strips it, and hands the handler a ctx whose `auth`
// carries it (convex/lib/actingOrg.ts, convex/lib/publicBuilders.ts). Nothing is
// decided here: `withOrgScope` and `fleetStandingOf` read it, on the fleet
// service-account branch only.
//
// Declared as plain consts under the bare names so a module's `query({...})`
// resolves, for every static reader, to a symbol of this module.
// ─────────────────────────────────────────────────────────────────────────────

export const query = publicQuery;
export const mutation = publicMutation;
export const action = publicAction;
