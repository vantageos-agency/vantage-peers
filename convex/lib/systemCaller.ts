import type { OrgScope } from "./auth";

// isFleetSystemCaller — the ONLY way the word "system" carries authority.
//
// `callerOrchestrator` is an ARGUMENT on the public mutations: a
// caller-supplied string, exactly the forgery class convex/schema.ts documents
// for `createdBy` ("can be forged (e.g. createdBy: \"system\")"). Typing the
// seven letters used to authorise the caller on ANY row it could reach — on
// tasks, across every organisation; on briefing notes, business units, diary
// entries, messages, missions and mandates, past the ownership compare.
//
// A fleet-internal caller now proves itself through the VERIFIED scope
// (master: the by-id service-account carve-out in withOrgScope), never by
// typing its own name. A caller with an ordinary org scope who types "system"
// is just a caller asserting a name it has not earned.
//
// One identity layer: every site that reads the word calls THIS predicate.
// A per-file variant is how a boundary drifts.
export function isFleetSystemCaller(
	callerScope: OrgScope,
	callerOrchestrator: string | undefined,
): boolean {
	return callerScope.isMaster && callerOrchestrator === "system";
}
