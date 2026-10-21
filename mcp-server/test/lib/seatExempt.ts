/**
 * Is a typed name admitted to a credential-less context in STRICT mode by the
 * seat exemption (a master-scope admission does not count)? In strict mode that is exactly the seat-as-itself exemption (the
 * package's `seat` / `seat-unresolved` rows); there is no other way in. The
 * local predicate this replaces (`isSeatActingAsItself`) is deleted: the
 * decision is `decideActingClaim`'s, reached through `actingClaimDecision`.
 */
import { actingClaimDecision, type OAuthContext } from "../../src/auth.js";

export function seatExempt(ctx: OAuthContext, claimedName: string): boolean {
	const d = actingClaimDecision(ctx, claimedName, "strict");
	// A master-scope context is admitted by its own row, not by this exemption.
	return d.ok && d.via !== "master-scope";
}
