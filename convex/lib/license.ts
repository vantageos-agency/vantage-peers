/**
 * License enforcement middleware for VantagePeers open-core.
 *
 * requireActiveLicense(ctx, licenseKey) — call at the top of write mutations
 * to enforce that the caller holds a valid, non-expired license.
 *
 * Read-only queries (list_*, get_*) are intentionally NOT gated — only
 * write/mutate operations require a license.
 *
 * Error messages are bilingual (FR + EN) with a Gumroad renewal URL so
 * self-hosted customers immediately know how to resolve the issue.
 *
 * Affected functions:
 *   - messages:sendMessage
 *   - tasks:create
 *   - briefingNotes:create
 *   - memories:storeMemory
 */

import type { MutationCtx } from "../_generated/server";

const RENEWAL_URL = "https://gumroad.com/l/vantage-peers-self-host";

const LICENSE_ERROR_MESSAGE =
	`Licence expirée ou invalide — veuillez renouveler sur ${RENEWAL_URL}\n` +
	`License expired or invalid — please renew at ${RENEWAL_URL}`;

/** SHA-256 hex digest of a UTF-8 string (Convex V8 SubtleCrypto). */
async function sha256Hex(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Asserts that the provided licenseKey corresponds to an active, non-expired
 * license in the DB. Throws a bilingual error with the Gumroad renewal URL if:
 *   - licenseKey is undefined / empty
 *   - the key hash is not found in the licenses table
 *   - the license status is "revoked" or "expired"
 *   - the license expiresAt has passed (real-time check, regardless of status field)
 *
 * On success, returns silently (no return value needed by callers).
 *
 * Usage:
 *   await requireActiveLicense(ctx, args.licenseKey);
 */
export async function requireActiveLicense(
	ctx: MutationCtx,
	licenseKey: string | undefined,
): Promise<void> {
	if (!licenseKey) {
		throw new Error(LICENSE_ERROR_MESSAGE);
	}

	const keyHash = await sha256Hex(licenseKey);

	const license = await ctx.db
		.query("licenses")
		.withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
		.unique();

	if (!license) {
		throw new Error(LICENSE_ERROR_MESSAGE);
	}

	if (license.status === "revoked" || license.status === "expired") {
		throw new Error(LICENSE_ERROR_MESSAGE);
	}

	const now = Date.now();
	if (license.expiresAt <= now) {
		throw new Error(LICENSE_ERROR_MESSAGE);
	}
}
