/**
 * A cursor on a whole-list protocol method is refused with -32602 Invalid
 * params. VantagePeers Cloud (HTTP /mcp) and the stdio entry. Task
 * k171rk9evy8yy48tfx765zqwk18hwdvh (mcp-doctor C11).
 *
 * MCP 2025-06-18, utilities/pagination, "Error Handling": "Invalid cursors
 * SHOULD result in an error with code -32602 (Invalid params)."
 *
 * The SDK serves tools/list, resources/list and resources/templates/list
 * whole: it never returns a nextCursor for them, so this server has never
 * issued a cursor for those methods, and any cursor a client sends there is
 * invalid by construction. The SDK ignores it and answers the full list, which
 * a client cannot tell from a real page. This guard refuses it instead.
 *
 * Mechanism: McpServer installs those handlers lazily, through the public
 * `server.server.setRequestHandler`, on the first registerTool /
 * registerResource. The guard wraps that method on this one instance, so each
 * of the three handlers checks the cursor before the SDK's own handler runs.
 * It must run before the first registration; called later it throws, so a
 * wrong order fails loudly instead of leaving a method unguarded. If the SDK
 * ever starts issuing cursors for these methods, this guard must go.
 */

import {
	type McpServer,
	ProtocolError,
	ProtocolErrorCode,
} from "@modelcontextprotocol/server";

/** The protocol list methods this server serves whole, never paged. */
export const WHOLE_LIST_METHODS: ReadonlySet<string> = new Set([
	"tools/list",
	"resources/list",
	"resources/templates/list",
]);

type LooseSetRequestHandler = (
	method: string,
	schemasOrHandler: unknown,
	maybeHandler?: unknown,
) => void;
type ListRequest = { params?: { cursor?: unknown } };
type ListHandler = (request: ListRequest, ctx: unknown) => unknown;

const guarded = new WeakSet<object>();

/** Install the guard on `server`. Idempotent; a no-op on a test double with no protocol server. */
export function refuseUnissuedListCursors(server: McpServer): void {
	const inner = (server as Partial<McpServer>).server;
	if (inner === undefined || typeof inner.setRequestHandler !== "function") {
		return;
	}
	if (guarded.has(inner)) return;
	for (const method of WHOLE_LIST_METHODS) {
		try {
			inner.assertCanSetRequestHandler(method);
		} catch {
			throw new Error(
				`refuseUnissuedListCursors: ${method} already has a handler; install the guard before the first registration`,
			);
		}
	}
	// The overload set of setRequestHandler cannot be re-declared generically;
	// the wrapper forwards every argument unchanged, so the loose signature
	// below narrows nothing the SDK checks.
	const original = inner.setRequestHandler.bind(
		inner,
	) as unknown as LooseSetRequestHandler;
	const patched: LooseSetRequestHandler = (
		method,
		schemasOrHandler,
		maybeHandler,
	) => {
		if (
			WHOLE_LIST_METHODS.has(method) &&
			typeof schemasOrHandler === "function"
		) {
			const handler = schemasOrHandler as ListHandler;
			const checked: ListHandler = (request, ctx) => {
				if (request.params?.cursor !== undefined) {
					throw new ProtocolError(
						ProtocolErrorCode.InvalidParams,
						`Invalid cursor: ${method} is not paginated on this server and never issues a cursor; request it without one.`,
					);
				}
				return handler(request, ctx);
			};
			original(method, checked);
			return;
		}
		original(method, schemasOrHandler, maybeHandler);
	};
	(
		inner as unknown as { setRequestHandler: LooseSetRequestHandler }
	).setRequestHandler = patched;
	guarded.add(inner);
}
