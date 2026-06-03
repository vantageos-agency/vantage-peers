/**
 * Constant-time comparison helper for hex-encoded hash strings.
 *
 * Ported from `convex/oauth.ts:23-45` (Day 47 master-token gate) to close
 * Eta F1 MAJOR on PR #621 (S1.5 D6+D7): the `presentedHash !== client.clientSecretHash`
 * checks at `mcp-server/server-http.ts` L577-580 (authorization_code grant) and
 * L692 (refresh_token grant) were non-constant-time, leaking a timing oracle on
 * confidential client authentication (RFC 6749 §6).
 *
 * Algorithm is **identical** to the Convex helper:
 *   1. TextEncoder → bytes.
 *   2. Length mismatch → still run a dummy HMAC over equal-length input to
 *      avoid a branch-timing leak, then return false.
 *   3. Equal length → XOR-accumulate diff, return diff === 0.
 *
 * Web Crypto (`crypto.subtle`) is used (not the Node `crypto.timingSafeEqual`
 * variant) for two reasons:
 *   - Parity with the Convex implementation — same algorithm, same surface.
 *   - sha256Hex outputs are 64-char hex strings so length is normally equal,
 *     but defensively we handle mismatch (e.g. empty string fallback when
 *     `clientSecretHash` is undefined on a malformed row).
 */
export declare function timingSafeEqual(a: string, b: string): Promise<boolean>;
