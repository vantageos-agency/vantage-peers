/**
 * personRefreshConfig - the absolute lifetime of a PERSON refresh-token family.
 *
 * A family (every refresh and access token descending from one consent) cannot
 * be refreshed past N days from its first issuance, however often it rotates:
 * after N days the person signs in again.
 *
 * N is configuration DATA read from the deployment environment
 * (`PERSON_REFRESH_FAMILY_MAX_DAYS`), so it can be tightened without a code
 * change. The default written here is FAIL-CLOSED: it applies when the variable
 * is unset AND when it is unreadable (not a finite, positive number), so a
 * mistyped value shortens nothing and removes no limit. It is identical in every
 * deployment and carries no secret and no per-deployment value
 * (.claude/rules/railway-mcp-redeploy.md, rule 1).
 */

const DAY_MS = 86_400_000;

/** Applies when the variable is unset or unreadable. */
export const DEFAULT_PERSON_REFRESH_FAMILY_MAX_DAYS = 90;

/** The family's absolute lifetime in milliseconds. */
export function personRefreshFamilyMaxMs(): number {
	const raw = process.env.PERSON_REFRESH_FAMILY_MAX_DAYS;
	const days = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
	const usable = Number.isFinite(days) && days > 0 ? days : DEFAULT_PERSON_REFRESH_FAMILY_MAX_DAYS;
	return usable * DAY_MS;
}
