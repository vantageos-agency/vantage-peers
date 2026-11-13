import { createHmac } from "node:crypto";

/** The one header that carries the client address to the MCP. */
export const EDGE_CLIENT_HEADER = "x-vp-edge-client";

/**
 * `<ip>|<unix seconds>|<hex HMAC-SHA256 of "v1|<ip>|<seconds>">`.
 * The version tag is inside the signed text so a future format cannot be
 * confused with this one.
 */
export function signEdgeClient(
	secret: string,
	ip: string,
	nowMs: number,
): string {
	const ts = Math.floor(nowMs / 1000);
	const mac = createHmac("sha256", secret)
		.update(`v1|${ip}|${ts}`)
		.digest("hex");
	return `${ip}|${ts}|${mac}`;
}
