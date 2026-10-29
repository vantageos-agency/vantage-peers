import { hasFleetRead } from "@vantageos/cloud-identity";
import type {
	ExpressionOrValue,
	FilterBuilder,
	NamedTableInfo,
} from "convex/server";
import type { DataModel } from "../_generated/dataModel";
import type { OrgScope } from "./auth";

// ─────────────────────────────────────────────────────────────────────────────
// taskScopeFilter -- the tenant gate and the roster of a task read, as a
// predicate INSIDE the query (backend-standard R-55: a read narrows by every
// caller-dependent predicate before it bounds the result).
//
// `filterByOrgScope` (./auth) drops a row from a window the handler already cut
// with `.take(n)` / `.paginate()`. The window then holds rows the caller may not
// see and drops rows it may: a short or empty page while more of the caller's own
// rows exist. This module states the SAME two controls as a Convex filter, so the
// bound counts only rows the caller may see:
//
//   1. the tenant gate: the row's permanent org ID equals the caller's
//      (`sameOrg` compares IDs, and a row with no ID matches nobody);
//   2. the roster: the row's assignee is one the caller's org admits
//      (`allowedOrchestrators`, exact names, as `filterByOrgScope` reads them).
//
// It decides nothing new and widens nothing: the fleet reads the table as before
// (the package's `hasFleetRead`), and a scope that holds no org ID or no admitted
// name is `none`, which is what `filterByOrgScope` returned for it as well.
// ─────────────────────────────────────────────────────────────────────────────

export type TaskFilterBuilder = FilterBuilder<NamedTableInfo<DataModel, "tasks">>;
export type TaskRowPredicate = (q: TaskFilterBuilder) => ExpressionOrValue<boolean>;

export type TaskScopeReach =
	| { readonly reach: "fleet" }
	| { readonly reach: "none" }
	| { readonly reach: "tenant"; readonly where: TaskRowPredicate };

/** What a task read may reach for `scope`, stated as a query predicate. */
export function taskScopeReach(scope: OrgScope): TaskScopeReach {
	if (hasFleetRead(scope)) return { reach: "fleet" };
	const orgId = scope.orgClerkId;
	const names = scope.allowedOrchestrators.filter((name) => name !== "");
	if (orgId === undefined || orgId === "" || names.length === 0) {
		return { reach: "none" };
	}
	return {
		reach: "tenant",
		where: (q) =>
			q.and(
				q.eq(q.field("clerkOrgId"), orgId),
				q.or(...names.map((name) => q.eq(q.field("assignedTo"), name))),
			),
	};
}

/**
 * The query filter for a read: the scope's reach AND the read's own predicates,
 * or undefined when nothing narrows the read (the fleet, no own predicate).
 * Callers return an empty result before querying when `reach` is `none`.
 */
export function taskRowFilter(
	reach: TaskScopeReach,
	...own: TaskRowPredicate[]
): TaskRowPredicate | undefined {
	const parts: TaskRowPredicate[] = [];
	if (reach.reach === "tenant") parts.push(reach.where);
	parts.push(...own);
	if (parts.length === 0) return undefined;
	return (q) => q.and(...parts.map((part) => part(q)));
}
