// TEST FIXTURE ONLY. The fleet service account, as a fleet seat's bearer reaches
// Convex through the MCP: every call to a CONTENT door carries the operator org's
// verified claim (`verifiedOrg`), which `tests/lib/fleetClaim.ts` reads back.
//
// Since batch F1 (backend standard R-54) the content doors (diary, memories,
// memoriesScoped, episodes, the knowledge-base and OKF bundle doors, the durable
// export) refuse a service-account call that carries no verified organisation. A
// test that drives them "as master" used to omit the claim; it presents it here
// instead, and only on the doors that declare it. Any other function is called
// exactly as the underlying client calls it.

import { getFunctionName } from "convex/server";
import { type Runner } from "../fixtures/seedServiceAccount";
import { fleetClaim } from "./fleetClaim";

const CONTENT_MODULES = [
	"diary:",
	"memories:",
	"memoriesScoped:",
	"episodes:",
	"kbMutations:",
	"kb:",
	"okfBundleNode:",
	"okfBundleDurable:",
];

type Caller = (ref: never, args?: Record<string, unknown>) => Promise<unknown>;

type Client = {
	query: Caller;
	mutation: Caller;
	action: Caller;
};

/**
 * `service` is the service-account client (`t.withIdentity({ subject })`); `root` is
 * the test's own `convexTest` instance, read to resolve the operator org's claim.
 */
export function asFleet<S extends Client>(service: S, root: Runner): S {
	const wrap =
		(call: Caller): Caller =>
		async (ref, args) => {
			const name =
				typeof ref === "string" ? (ref as string) : getFunctionName(ref as never);
			const takesClaim = CONTENT_MODULES.some((m) => name.startsWith(m));
			const withClaim = takesClaim
				? { ...(await fleetClaim(root)), ...(args ?? {}) }
				: args;
			return await call.call(service, ref, withClaim);
		};
	return new Proxy(service, {
		get(target, prop, receiver) {
			if (prop === "query" || prop === "mutation" || prop === "action") {
				return wrap(Reflect.get(target, prop, receiver) as Caller);
			}
			const value = Reflect.get(target, prop, receiver) as unknown;
			return typeof value === "function"
				? (value as (...a: unknown[]) => unknown).bind(target)
				: value;
		},
	}) as S;
}
