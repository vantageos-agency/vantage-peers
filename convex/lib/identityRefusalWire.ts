import { IdentityRefusalError } from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";

/**
 * Runs a package identity gate and puts its refusal on the wire UNCHANGED.
 *
 * @vantageos/cloud-identity raises `IdentityRefusalError` (a plain Error). Convex
 * reduces a plain Error to an opaque "Server Error", which would drop the code,
 * the reason and the door the refusal carries (refusal-is-distinguishable-from-
 * absence). A `ConvexError` whose data is the package's own message keeps all
 * three in `errorData`. This function decides nothing: the verdict is the
 * package's, and anything that is not a package refusal is rethrown as is.
 */
export function relayIdentityRefusal<T>(gate: () => T): T {
	try {
		return gate();
	} catch (err) {
		throw wireIdentityRefusal(err);
	}
}

/**
 * The wire form of a caught error, for a gate called as a bare statement:
 * a package refusal becomes a `ConvexError` carrying its own message; anything
 * else is returned as is, to be rethrown by the caller.
 */
export function wireIdentityRefusal(err: unknown): unknown {
	return err instanceof IdentityRefusalError ? new ConvexError(err.message) : err;
}
