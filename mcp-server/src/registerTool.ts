/**
 * defineTool — type-enforced tool registration wrapper.
 *
 * Problem this closes (S2, mission vp-multitenant-zero-hole-v1): the raw
 * `server.tool(...)` API lets an author register an MCP tool WITHOUT declaring
 * who may call it. Scope enforcement then lives inside each handler body and
 * depends on the author remembering to add a `guardRead`/`guardWrite`/
 * `guardFrom`/`guardMasterOnly`/`scopeFilterList` call. A forgotten guard is a
 * silent cross-tenant hole.
 *
 * The fix is structural, not by convention: `defineTool` makes the caller
 * authorization a REQUIRED positional argument (`scope`, 3rd position).
 * Omitting it fails `tsc` (see the type-cases in
 * __tests__/registerTool-scope-enforcement.test.ts). There is no permissive
 * default — the "open to everyone" case EXISTS but must be spelled
 * `{ kind: "public", reason: ... }` explicitly and is therefore grep-able /
 * enumerable.
 *
 * This wrapper APPLIES the shared identity layer, it never re-authors it
 * (.claude/rules/one-identity-layer.md). The actual master/namespace/from
 * decisions come from ./auth.ts, which itself delegates to
 * `@vantageos/cloud-identity` (isMasterScope 0.3.0+). `defineTool` only decides
 * WHEN to call those predicates, from the declared `scope`. The positional
 * signature mirrors `server.tool(name, description, schema, annotations?, cb)`
 * with `scope` promoted ahead of `name`, so a migration is a one-line change
 * and every handler body stays byte-identical (behavior-preserving for tools
 * that already guard in-handler — the wrapper's pre-check duplicates a gate the
 * handler still runs).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
	checkFromAllowed,
	checkNamespaceRead,
	checkNamespaceWrite,
	isMasterScope,
	type OAuthContext,
} from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scope declaration — a discriminated union. Every registration MUST pick one.
// There is deliberately NO default member: the type is only satisfiable by
// naming a `kind`. Each `kind` is a distinct grep target so the whole fleet of
// tools is enumerable by authorization posture:
//   grep -oE 'kind: "[a-z]+"' src/tools.ts | sort | uniq -c
// ─────────────────────────────────────────────────────────────────────────────

export type ToolScope =
	/**
	 * Callable by any authenticated identity. NOT a default — must be spelled
	 * out, so a reviewer can enumerate every public tool. `reason` forces the
	 * author to justify the exposure in the source (grep-able audit trail).
	 */
	| { readonly kind: "public"; readonly reason: string }
	/** Only master-scope sessions. Applied here via isMasterScope. */
	| { readonly kind: "master" }
	/**
	 * Read of a single namespace named by `namespaceArg`. The wrapper extracts
	 * that arg and runs checkNamespaceRead BEFORE the handler executes.
	 */
	| { readonly kind: "read"; readonly namespaceArg: string }
	/** Write of a single namespace named by `namespaceArg` (checkNamespaceWrite). */
	| { readonly kind: "write"; readonly namespaceArg: string }
	/** Ownership-gated on a `from`/creator identity named by `fromArg`. */
	| { readonly kind: "from"; readonly fromArg: string }
	/**
	 * The result set is filtered inside the handler with `scopeFilterList` /
	 * `scopeFilterGet` (owner/tenant discrimination the wrapper cannot do because
	 * it needs the post-query rows). The wrapper cannot auto-apply, so `reason`
	 * documents the in-handler enforcement and keeps it enumerable + deliberate.
	 * This is an escape hatch, never a bypass: it still forces a declaration.
	 */
	| { readonly kind: "filtered"; readonly reason: string };

/** All scope kinds — used by tests to prove enumerability / no default leaked. */
export const TOOL_SCOPE_KINDS = [
	"public",
	"master",
	"read",
	"write",
	"from",
	"filtered",
] as const;

export type ToolAuthContext = { readonly oauthCtx?: OAuthContext };

type McpTextResult = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
	[k: string]: unknown;
};

function mcpError(message: string): McpTextResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

// Tool handler as accepted by the MCP SDK — (args, extra) => result.
// biome-ignore lint/suspicious/noExplicitAny: SDK arg/return shapes are wider than we constrain here; enforcement is by scope, not by this type.
type ToolHandler = (args: any, extra: any) => McpTextResult | Promise<any>;

// Loosely-typed annotations pass-through (matches SDK ToolAnnotations).
type ToolAnnotations = Record<string, unknown>;

/**
 * Applies the declared `scope` to `args` using the shared auth predicates.
 * Returns an mcpError result to short-circuit, or null to proceed.
 */
function enforceScope(
	scope: ToolScope,
	ctx: ToolAuthContext,
	args: Record<string, unknown>,
): McpTextResult | null {
	switch (scope.kind) {
		case "public":
			return null;
		case "filtered":
			// Enforced inside the handler (scopeFilterList/scopeFilterGet). The
			// declaration is mandatory; the runtime check lives with the rows.
			return null;
		case "master": {
			if (!ctx.oauthCtx) return null; // legacy bearer path — see auth.ts note
			if (isMasterScope(ctx.oauthCtx)) return null;
			return mcpError(
				`Forbidden: this tool requires master scope (current: ${ctx.oauthCtx.scopeProfile}).`,
			);
		}
		case "read": {
			const ns = args[scope.namespaceArg];
			const err = checkNamespaceRead(
				ctx.oauthCtx,
				ns === undefined ? undefined : String(ns),
			);
			return err ? mcpError(err) : null;
		}
		case "write": {
			const ns = args[scope.namespaceArg];
			const err = checkNamespaceWrite(ctx.oauthCtx, String(ns));
			return err ? mcpError(err) : null;
		}
		case "from": {
			const from = args[scope.fromArg];
			const err = checkFromAllowed(ctx.oauthCtx, String(from));
			return err ? mcpError(err) : null;
		}
	}
}

/**
 * Register a tool through the mandatory-scope wrapper.
 *
 * Positional drop-in for `server.tool(name, description, schema, annotations?,
 * handler)` with `scope` promoted to the 3rd argument (right after `ctx`).
 * `scope` is required by the type — omitting it is a compile error.
 */
export function defineTool(
	server: McpServer,
	ctx: ToolAuthContext,
	scope: ToolScope,
	name: string,
	description: string,
	schema: z.ZodRawShape,
	...rest:
		| [handler: ToolHandler]
		| [annotations: ToolAnnotations, handler: ToolHandler]
): void {
	const handler = rest[rest.length - 1] as ToolHandler;
	const annotations =
		rest.length === 2 ? (rest[0] as ToolAnnotations) : undefined;

	const guardedHandler: ToolHandler = async (args, extra) => {
		const denied = enforceScope(
			scope,
			ctx,
			(args ?? {}) as Record<string, unknown>,
		);
		if (denied) return denied;
		return handler(args, extra);
	};

	// The SDK overload accepts (name, description, schema, annotations?, handler).
	// biome-ignore lint/suspicious/noExplicitAny: SDK overload set is wider than our spec type.
	const tool = server.tool.bind(server) as any;
	if (annotations) {
		tool(name, description, schema, annotations, guardedHandler);
	} else {
		tool(name, description, schema, guardedHandler);
	}
}
