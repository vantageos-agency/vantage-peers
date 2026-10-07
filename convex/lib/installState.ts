// Signed GitHub App install `state`.
//
// `githubOwnerBinding:startBinding` issues `<nonce>.<hmac>`: a random nonce
// signed (HMAC-SHA-256) with the GitHub App's client secret. The setup callback
// (`/github/app/setup`, in the http router) verifies the signature BEFORE it
// makes any call to GitHub, so an unauthenticated visitor cannot make the
// deployment spend an OAuth code exchange or an API call on a forged `state`.
// The signature proves only that this deployment issued the state; whether the
// state is live, unused and which org it belongs to is still decided by the
// stored row.
//
// Web Crypto only (the default runtime): no Node `crypto` import.

const HEX = /^[0-9a-f]+$/;

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || !HEX.test(hex)) return null;
	const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
	return await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		[usage],
	);
}

/** `<nonce>.<hex hmac-sha256(nonce)>`. */
export async function signInstallState(nonce: string, secret: string): Promise<string> {
	const key = await hmacKey(secret, "sign");
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce));
	return `${nonce}.${toHex(new Uint8Array(mac))}`;
}

/** Is `state` a well-formed `<nonce>.<mac>` whose mac verifies under `secret`? */
export async function verifyInstallStateSignature(state: string, secret: string): Promise<boolean> {
	const dot = state.lastIndexOf(".");
	if (dot <= 0) return false;
	const nonce = state.slice(0, dot);
	const mac = fromHex(state.slice(dot + 1));
	if (mac === null) return false;
	const key = await hmacKey(secret, "verify");
	return await crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(nonce));
}
