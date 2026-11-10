import {
	passesScopeFilter as packagePassesScopeFilter,
	scopeFilterGet as packageScopeFilterGet,
	scopeFilterList as packageScopeFilterList,
} from "@vantageos/cloud-identity";
import { normalizeOrchestratorId } from "./normalizeOrchestratorId.js";

// ─────────────────────────────────────────────────────────────────────────────
// rosterScopeFilter -- the package post-query scope filters, fed a roster that
// holds each name in BOTH forms (task k1726h1v7hqdbk818bn8s1rgdx8hy0ts).
//
// Every label a door stores (assignedTo, createdBy, participants) is
// `normalizeOrchestratorId`-ed, while a token's `fromAllowList` holds the agent's
// exact stored name ("Ada"). The package compares by exact string, so a client-org
// person acting as such an agent was shown "not found" for rows Convex had served
// it. The exact name stays in the list (a legacy row stored as typed still
// matches) and its normalised form is added; "*" is unchanged. Nothing outside
// the caller's own roster is admitted: only the case/NFC spelling of a name it
// already holds.
// ─────────────────────────────────────────────────────────────────────────────

type WithAllowList = { fromAllowList?: string[] };

function withBothForms<C extends WithAllowList>(ctx: C): C {
	if (!Array.isArray(ctx.fromAllowList)) return ctx;
	const names = new Set<string>();
	for (const name of ctx.fromAllowList) {
		names.add(name);
		if (name !== "*") names.add(normalizeOrchestratorId(name));
	}
	return { ...ctx, fromAllowList: [...names] };
}

export const passesScopeFilter = ((ctx, row, grantFields) =>
	packagePassesScopeFilter(
		withBothForms(ctx),
		row,
		grantFields,
	)) as typeof packagePassesScopeFilter;

export const scopeFilterList = ((ctx, rows, grantFields) =>
	packageScopeFilterList(
		withBothForms(ctx),
		rows,
		grantFields,
	)) as typeof packageScopeFilterList;

export const scopeFilterGet = ((ctx, row, grantFields) =>
	packageScopeFilterGet(
		withBothForms(ctx),
		row,
		grantFields,
	)) as typeof packageScopeFilterGet;
