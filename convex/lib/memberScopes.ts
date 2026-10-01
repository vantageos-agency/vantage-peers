/**
 * DEFAULT_MEMBER_SCOPES — the scope set a newly provisioned organisation's
 * mapping receives when `oauth:provisionOrganization` is called without an
 * explicit `scopes` argument.
 *
 * Derived by enumerating every `requireScope(` / `scopes.includes(` call in
 * convex/ (grep -rn "requireScope(\|scopes.includes" convex --include=*.ts):
 *
 *   view-own-tasks     INCLUDED. Gates tasks.ts / messages.ts / briefingNotes.ts
 *                      reads, every one of which then narrows rows through
 *                      filterByOrgScope / isRowVisibleToScope (tenant gate on
 *                      `orgId` + roster). It reveals only the caller's OWN org.
 *   view-own-missions  INCLUDED. Gates missions:list (missions.ts), which
 *                      narrows through filterByOrgScope. Own org only. Without
 *                      it a member of a fresh org is refused its own missions.
 *   view-orchestrator-summary
 *                      EXCLUDED. No handler gates on it today (it appears only
 *                      in the master literals and schema comments), so granting
 *                      it buys nothing now and would silently pre-authorise
 *                      whatever gate is attached to it later. Least privilege.
 *   view-stats-aggregated
 *                      EXCLUDED. Gates dashboard/stats aggregates that scan
 *                      fleet-wide tables (mandates, receipts, profiles); a
 *                      fleet-wide aggregate is never a member default.
 *   cross-tenant-read  EXCLUDED. By definition reads other tenants' data.
 *
 * Immutable on purpose: callers must copy before storing.
 */
export const DEFAULT_MEMBER_SCOPES: readonly string[] = Object.freeze([
	"view-own-tasks",
	"view-own-missions",
]);
