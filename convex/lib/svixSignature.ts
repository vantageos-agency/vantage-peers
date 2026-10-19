// Svix webhook signature verification (Clerk signs its webhooks with Svix).
//
// Web Crypto only, so no dependency is added: `svix` is not in package.json and
// the whole scheme is one HMAC. A delivery carries `svix-id`, `svix-timestamp`
// (seconds) and `svix-signature` (space-separated `v1,<base64>` candidates, more
// than one during a secret rotation). The signed content is
// `${id}.${timestamp}.${rawBody}`, the key is the base64 part of `whsec_<base64>`.

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SvixRefusal =
	| "secret-malformed"
	| "missing-header"
	| "timestamp-invalid"
	| "timestamp-out-of-tolerance"
	| "signature-mismatch";

export type SvixVerdict = { ok: true } | { ok: false; reason: SvixRefusal };

function base64ToBytes(b64: string): Uint8Array | null {
	try {
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

/** Constant-time equality over equal-length byte arrays; unequal length is false. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export async function verifySvixSignature(args: {
	secret: string;
	id: string | null;
	timestamp: string | null;
	signatureHeader: string | null;
	body: string;
	nowMs: number;
}): Promise<SvixVerdict> {
	const { secret, id, timestamp, signatureHeader, body, nowMs } = args;
	if (!secret.startsWith("whsec_")) {
		return { ok: false, reason: "secret-malformed" };
	}
	const keyBytes = base64ToBytes(secret.slice("whsec_".length));
	if (keyBytes === null || keyBytes.length === 0) {
		return { ok: false, reason: "secret-malformed" };
	}
	if (!id || !timestamp || !signatureHeader) {
		return { ok: false, reason: "missing-header" };
	}
	if (!/^\d{1,12}$/.test(timestamp)) {
		return { ok: false, reason: "timestamp-invalid" };
	}
	const skew = Math.abs(nowMs / 1000 - Number(timestamp));
	if (skew > SVIX_TOLERANCE_SECONDS) {
		return { ok: false, reason: "timestamp-out-of-tolerance" };
	}

	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const expected = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(`${id}.${timestamp}.${body}`),
		),
	);

	// Every candidate is compared (no early exit on a match) so the time taken
	// does not depend on which candidate, if any, was right.
	let matched = false;
	for (const candidate of signatureHeader.split(" ")) {
		const [version, sig] = candidate.split(",");
		if (version !== "v1" || !sig) continue;
		const bytes = base64ToBytes(sig);
		if (bytes !== null && timingSafeEqual(expected, bytes)) matched = true;
	}
	return matched ? { ok: true } : { ok: false, reason: "signature-mismatch" };
}
