// ─────────────────────────────────────────────────────────────────────────────
// operatorOrg - the operator organisation's slug, as Convex stores it.
//
// The fleet's own stations call every claim-bound door for the OPERATOR
// organisation (backend standard R-54, see operatorClaim.ts). Which organisation
// that is, is stored data: the active `client_org_mapping` row whose kind is
// "operator", found by `findOperatorOrg` of @vantageos/cloud-identity and served by
// the service-account-only door `clientOrgMapping:getOperatorOrg`. This module
// asks that door; it holds and compares no slug of its own.
//
// It is asked ONCE per transport context (the master bearer's request context,
// the stdio trust context), where the context is built, so that the claim the
// wrapper forwards (operatorClaim.ts) is a field of the verified oauthContext and
// never an argument.
//
// Fail closed. A door that answers null (none, several or an unreadable store of
// operator rows), an error, a timeout or a malformed answer yields `undefined`,
// and the context then carries NO operator claim, so every claim-bound door
// refuses its call. Only a success is remembered for a few minutes, so a rename of
// the operator organisation is picked up without a restart; a failure is
// remembered for a few seconds only, so an unreachable Convex is not asked again
// before every request.
// ─────────────────────────────────────────────────────────────────────────────

type QueryClient = {
	query: (name: never, args: never, ...rest: never[]) => Promise<unknown>;
};

const OPERATOR_ORG_TTL_MS = 5 * 60 * 1000;
const OPERATOR_ORG_FAILURE_TTL_MS = 15 * 1000;
const OPERATOR_ORG_TIMEOUT_MS = 5 * 1000;

let remembered: { orgSlug: string | undefined; at: number } | undefined;

/** Forget the remembered answer (tests, and a deployment switch). */
export function forgetOperatorOrg(): void {
	remembered = undefined;
}

export async function resolveOperatorOrgSlug(
	client: QueryClient,
	now: number = Date.now(),
): Promise<string | undefined> {
	if (remembered !== undefined) {
		const ttl =
			remembered.orgSlug === undefined
				? OPERATOR_ORG_FAILURE_TTL_MS
				: OPERATOR_ORG_TTL_MS;
		if (now - remembered.at < ttl) return remembered.orgSlug;
	}
	const orgSlug = await askOperatorOrg(client);
	remembered = { orgSlug, at: now };
	return orgSlug;
}

async function askOperatorOrg(client: QueryClient): Promise<string | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const answer = await Promise.race([
			(
				client.query as unknown as (
					name: string,
					args: Record<string, never>,
				) => Promise<unknown>
			)("clientOrgMapping:getOperatorOrg", {}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("operator organisation lookup timed out")),
					OPERATOR_ORG_TIMEOUT_MS,
				);
			}),
		]);
		if (
			typeof answer === "object" &&
			answer !== null &&
			typeof (answer as { orgSlug?: unknown }).orgSlug === "string" &&
			(answer as { orgSlug: string }).orgSlug !== ""
		) {
			return (answer as { orgSlug: string }).orgSlug;
		}
		return undefined;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(
			"[auth] operator organisation lookup failed; the master bearer forwards no claim:",
			message,
		);
		return undefined;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
