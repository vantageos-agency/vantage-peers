/**
 * Single-retry-on-dead-keep-alive-socket for Convex `query()` calls only.
 *
 * Incident (2026-09-08, Railway log 12:36:15 UTC+2): the MCP server's own
 * fetch to Convex died mid-flight with
 *   "The socket connection was closed unexpectedly"
 * on a pooled (kept-alive) HTTP connection Node's undici fetch reused. No
 * MCP server process restart happened (deploy stayed 46d6fdc2) — this is a
 * dead-socket race, not a crash. Two stations (Pi on send_message, Omicron
 * on check_messages) hit it and both succeeded on a manual second attempt,
 * i.e. the underlying connection/backend was fine — only the reused socket
 * was stale.
 *
 * SCOPE DECISION — queries only, never mutations or actions:
 *
 * `node_modules/convex/src/browser/http_client.ts` (v1.42.1) shows every
 * verb (`queryInner`, `mutationInner`, `action`) follows the exact same
 * shape: `await localFetch(...)` (Node's built-in fetch → undici) then
 * `await response.json()`. Nothing in this file — or in the undici fetch
 * contract more broadly — lets a caller distinguish "the dead socket died
 * before a single byte of the request left this process" from "the request
 * was fully written and even processed by Convex before the response socket
 * was torn down." Both surface as the identical
 * "socket connection was closed unexpectedly" message. That is a genuine
 * COULD-NOT-JUDGE from the available evidence, not a hand-wave: undici's
 * connection-pool reuse race is exactly the class of bug where a keep-alive
 * socket can be selected for reuse, start being written to, and be closed by
 * the far end mid-write — after some or all of the request already reached
 * the server's TCP stack.
 *
 * Given that, retrying a MUTATION blindly risks a double-apply (a message
 * sent twice, a task completed twice) with no way to detect it after the
 * fact. A `query()` carries no side effect on Convex — replaying it can
 * return a stale-by-milliseconds read at worst, never a duplicated write.
 * So this module deliberately retries `query()` only. `mutation()` and
 * `action()` are NOT wrapped anywhere in this codebase for this error class;
 * a caller hitting this on a mutation still needs the manual second attempt
 * documented in the incident (unchanged behaviour — not a regression, a
 * scope boundary named up front).
 */

/**
 * Matches the dead-keep-alive-socket error family only — never a generic
 * network or application error. Deliberately narrow: widening this predicate
 * to catch unrelated errors would turn "retry a known-safe race" into
 * "retry everything," which is explicitly out of scope.
 *
 * Covers:
 * - the exact incident message ("The socket connection was closed
 *   unexpectedly", Node's undici fetch when a pooled connection is reused
 *   and torn down by the peer)
 * - undici's own error code for the same condition (`UND_ERR_SOCKET`,
 *   surfaced either directly or via `cause.code`)
 * - the classic Node http.Agent keep-alive equivalents ("socket hang up",
 *   `ECONNRESET`), which manifest as the same dead-pooled-connection race on
 *   older Node HTTP stacks
 */
export function isSocketCloseError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;

	const messages: string[] = [err.message];
	const code: unknown = (err as { code?: unknown }).code;
	if (typeof code === "string") messages.push(code);

	const cause = (err as { cause?: unknown }).cause;
	if (cause instanceof Error) {
		messages.push(cause.message);
		const causeCode: unknown = (cause as { code?: unknown }).code;
		if (typeof causeCode === "string") messages.push(causeCode);
	}

	return messages.some((message) =>
		/socket connection was closed unexpectedly|UND_ERR_SOCKET|socket hang up|ECONNRESET/i.test(
			message,
		),
	);
}

/**
 * Runs `fn` once. If it throws an error matching {@link isSocketCloseError},
 * runs `fn` exactly one more time and returns/throws whatever that second
 * attempt produces — never a loop, never a third attempt. Any other error
 * propagates immediately from the first attempt with no retry.
 */
export async function withSingleRetryOnSocketClose<T>(
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err: unknown) {
		if (!isSocketCloseError(err)) throw err;
		return await fn();
	}
}
