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

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	checkActorBinding,
	checkFromAllowed,
	checkNamespaceRead,
	checkNamespaceWrite,
	internalClient,
	isMasterScope,
	isUnattributedClaim,
	type OAuthContext,
	PERSON_ACTOR_PREFIX,
	personActorOf,
	recordUnattributedClaim,
} from "./auth.js";
import { normalizeOrchestratorId } from "./normalizeOrchestratorId.js";

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
			// Absence REFUSES — a missing oauthCtx is never master. Production
			// always carries a context (HTTP via bearerAuthMiddleware, stdio via
			// LOCAL_STDIO_TRUST_CTX), so this fires only for a misconfigured
			// caller, and it fails closed.
			if (!ctx.oauthCtx)
				return mcpError(
					"Forbidden: this tool requires master scope, but the request " +
						"carried no authorization context (absence is never master).",
				);
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
			// No claim made by a master caller: nothing to verify, nothing to
			// refuse. (A claim is handled by bindActingNames + checkActorBinding;
			// feeding String(undefined) to the binder would invent one.)
			if ((from === undefined || from === null) && isMasterScope(ctx.oauthCtx))
				return null;
			const err = checkFromAllowed(ctx.oauthCtx, String(from));
			return err ? mcpError(err) : null;
		}
	}
}

/**
 * Writer-role gate for a PERSON token, applied once in defineTool to every tool
 * that is not declared read-only. A person (signed in through /authorize) holds
 * a verified org role; a viewer may read and may not write. The decision is
 * Convex's existing pair `loadMemberWriterRoles` + `assertMemberMayWrite`
 * (convex/memberWriterRoles.ts), reached through the service-account query
 * `memberWriterRoles:assertPersonMayWrite`. Fail closed: a lookup that fails,
 * an absent role and a missing list all refuse. A seat token (no `principal`)
 * and an EXEMPT tool never reach it. A tool is exempt by DECLARATION, in its own
 * annotations, never by name here and never by role:
 *   - `readOnlyHint: true`  (checked against the handler by
 *     test/tool-annotations-agree-with-handlers.test.ts);
 *   - `ownStateOnly: true`  (Pi ruling): the tool writes only the caller's OWN
 *     state, and an authority of its own bounds whose state that is (mark_as_read:
 *     the receipt-owner check, `messages:markAsRead`). It is not a role
 *     exception; the declaration is a promise that the tool's own door decides
 *     ownership.
 */
async function enforcePersonWriterRole(
	oauthCtx: OAuthContext | undefined,
	toolName: string,
	exempt: boolean,
): Promise<McpTextResult | null> {
	if (exempt || oauthCtx?.principal !== "person") return null;
	if (!oauthCtx.clerkOrgSlug) {
		return mcpError(
			`Forbidden: ${toolName} refused — person token carries no organisation.`,
		);
	}
	try {
		await internalClient().query(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"memberWriterRoles:assertPersonMayWrite" as any,
			{
				orgSlug: oauthCtx.clerkOrgSlug,
				...(oauthCtx.orgRole !== undefined ? { role: oauthCtx.orgRole } : {}),
				door: `mcp:${toolName}`,
			},
		);
		return null;
	} catch (err: unknown) {
		// A ConvexError carries its payload in `.data`; the message is opaque.
		const data = (err as { data?: unknown }).data;
		const message = `${err instanceof Error ? err.message : String(err)} ${
			typeof data === "string" ? data : JSON.stringify(data ?? "")
		}`;
		const denied = message.includes("role-not-writer");
		return mcpError(
			denied
				? `Forbidden: ${toolName} is a write and the organisation role "${oauthCtx.orgRole ?? "none"}" is not a writer role (RBAC_DENIED role-not-writer).`
				: `Forbidden: ${toolName} refused — the writer-role check could not be completed (fail closed).`,
		);
	}
}

/**
 * The acting-name arguments a tool declares: every parameter through which a
 * caller TYPES who is acting. `callerOrchestrator` is one by name; the `from`
 * kind's `fromArg` (createdBy / from / orchestratorId ...) is the same thing
 * under another spelling. Derived from the tool's own declaration, so a tool
 * added tomorrow that declares either is bound without anyone remembering to.
 */
export function actingNameKeys(
	scope: ToolScope,
	schema: z.ZodRawShape,
): string[] {
	const keys = new Set<string>();
	if ("callerOrchestrator" in schema) keys.add("callerOrchestrator");
	if (scope.kind === "from") keys.add(scope.fromArg);
	return [...keys];
}

/**
 * bindActingNames — an acting-name argument is a CLAIM the resolved actor
 * verifies, never an authority (checkActorBinding). Runs BEFORE the tool's
 * scope check and BEFORE the handler, once, for every tool.
 *
 *   - claimed and it disagrees with the actor → refused, nothing dispatched
 *     (AGENT_IDENTITY_MISMATCH, in every mode: a typed name never overrides a
 *     presented credential).
 *   - claimed, no credential presented        → per the cutover switch
 *     (actorCredentialMode): permissive serves it AND records it unattributed;
 *     strict refuses it (AGENT_CREDENTIAL_REQUIRED).
 *   - omitted and an actor is resolved        → DERIVED: the handler (and the
 *     Convex mutation it forwards to) receives the actor's own name.
 *   - omitted and no actor                    → left omitted. No claim was
 *     made; nothing is granted and nothing is defaulted in.
 *
 * The argument therefore can only restate what the credential already grants:
 * it may narrow, it can never widen.
 */
function bindActingNames(
	oauthCtx: OAuthContext | undefined,
	keys: readonly string[],
	args: Record<string, unknown>,
):
	| { denied: McpTextResult }
	| {
			args: Record<string, unknown>;
			unattributed: [key: string, name: string][];
	  } {
	const unattributed: [string, string][] = [];
	let bound = args;
	for (const key of keys) {
		const claimed = args[key];
		if (claimed === undefined || claimed === null) {
			if (oauthCtx?.actor) {
				bound = { ...bound, [key]: oauthCtx.actor.agentName };
			}
			continue;
		}
		const err = checkActorBinding(oauthCtx, String(claimed));
		if (err) return { denied: mcpError(err) };
		// A typed name with no credential behind it (permissive mode only — strict
		// refused above). Collected here, RECORDED by the caller only once the
		// scope check has also passed, so the count is calls actually served on a
		// typed name: exactly what strict mode would start refusing.
		if (isUnattributedClaim(oauthCtx, String(claimed))) {
			unattributed.push([key, String(claimed)]);
		}
	}
	return { args: bound, unattributed };
}

/**
 * bindPersonActingNames — a PERSON (OAuth person token, #1444) acts in its OWN
 * name, "user:<subject>" read from the token row (personActorOf), never from an
 * argument. Task k176ch9tamzab3dnhye94kga1d8fkbhm. Runs only for a person with
 * no agent credential, on a tool that declares acting-name arguments and is not
 * exempt (read-only / own-state). Returns:
 *   - `null`: not this caller, or an acting name names an AGENT: the agent rules
 *     decide unchanged (bindActingNames -> AGENT_CREDENTIAL_REQUIRED without a
 *     credential);
 *   - `{ denied }`: an acting name names ANOTHER user (PERSON_ACTS_AS_ITSELF),
 *     or every name is omitted and the tool has no human door
 *     (PERSON_NO_HUMAN_DOOR, by declaration: `personDoor: true`);
 *   - `{ args }`: the person acts as itself. Its own "user:<subject>", if typed,
 *     is removed: the handler forwards no name, and the token-hash proof
 *     (`verifiedPerson`) instead, from which the Convex door re-reads the person.
 */
function bindPersonActingNames(
	oauthCtx: OAuthContext | undefined,
	toolName: string,
	keys: readonly string[],
	personDoor: boolean,
	args: Record<string, unknown>,
): { denied: McpTextResult } | { args: Record<string, unknown> } | null {
	const self = personActorOf(oauthCtx);
	if (self === undefined || keys.length === 0) return null;
	let bound = args;
	for (const key of keys) {
		const claimed = args[key];
		if (claimed === undefined || claimed === null) continue;
		const name = normalizeOrchestratorId(String(claimed));
		if (name === normalizeOrchestratorId(self)) {
			bound = { ...bound, [key]: undefined };
			continue;
		}
		if (!name.startsWith(PERSON_ACTOR_PREFIX)) return null;
		return {
			denied: mcpError(
				`PERSON_ACTS_AS_ITSELF: ${toolName} names "${String(claimed)}" in ${key}, but this token acts for ${self} — a person acts only in its own name. Omit ${key} to act as yourself.`,
			),
		};
	}
	if (!personDoor) {
		return {
			denied: mcpError(
				`PERSON_NO_HUMAN_DOOR: ${toolName} has no door through which a person acts in its own name — it needs an agent name and that agent's credential (${keys.join(", ")}).`,
			),
		};
	}
	return { args: bound };
}

/**
 * Wraps a tool's raw zod shape in a STRICT object schema.
 *
 * Root cause fixed here (mission k17at41v7e6re4ht9wbf3cvdah8cepjc, restored
 * after the Day-159 revert of #1189/#1191): the MCP SDK parses
 * `request.params.arguments` against the tool's declared input schema in its
 * default (non-strict) mode BEFORE our handler ever runs
 * (@modelcontextprotocol/server McpServer `validateToolInput` ->
 * `validateStandardSchema`). Zod's default object mode silently STRIPS any key not
 * declared in the shape — an unrecognized parameter from a stale/frozen
 * client tool-list (or a typo) vanishes with zero signal, and the call still
 * returns success. `.strict()` makes zod reject the parse instead, and the
 * SDK surfaces that as a loud `ProtocolError(InvalidParams, ...)` — before our
 * handler, before Convex — naming every unrecognized key by name (zod's
 * `unrecognized_keys` issue lists them verbatim).
 *
 * This does NOT affect legitimate optional params: a declared-but-omitted
 * field (e.g. `endOfDayIndex` missing from a stale client) still parses fine
 * under `.strict()` — strict mode only rejects keys ABSENT from the shape,
 * never keys present-but-undefined.
 */
export function buildStrictInputSchema(
	shape: z.ZodRawShape,
): z.ZodObject<z.ZodRawShape> {
	return z.object(shape).strict();
}

/**
 * Register a tool through the mandatory-scope wrapper.
 *
 * Positional drop-in for `server.tool(name, description, schema, annotations?,
 * handler)` with `scope` promoted to the 3rd argument (right after `ctx`).
 * `scope` is required by the type — omitting it is a compile error.
 *
 * REGISTRATION PATH (Day-159 incident fix, see buildStrictInputSchema doc
 * above): the deprecated `server.tool(name, description, schema, ...)`
 * legacy overload distinguishes "a raw params shape was passed" from "an
 * already-built Zod schema instance was passed" via
 * `isZodRawShapeCompat(firstArg)` — and a `.strict()` ZodObject FAILS that
 * check (it IS a schema instance, not a raw shape record), so the SDK
 * mis-parses it as `ToolAnnotations` and throws
 * `Tool <name> expected a Zod schema or ToolAnnotations, but received an
 * unrecognized object` at registration time — the server cannot boot. The
 * config-object `server.registerTool(name, config, cb)` API accepts
 * `config.inputSchema` as a full schema instance. Since the move to
 * @modelcontextprotocol/server 2.x the positional `.tool()` overload no longer
 * exists at all and `registerTool` takes a Standard Schema object (a zod >= 4.2
 * object qualifies). Handing the strict schema to `registerTool` therefore
 * boots AND gets the strict validation applied by the SDK's own
 * `validateToolInput` before our handler runs.
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
	const declaredAnnotations =
		rest.length === 2 ? (rest[0] as ToolAnnotations) : undefined;
	// `outputSchema` rides in the annotations object at the call site (so every
	// tool keeps the one `defineTool(...)` registration shape) and is lifted here
	// into the SDK config. The SDK then REQUIRES the handler to return
	// `structuredContent` matching it. It is never forwarded as an annotation.
	// `ownStateOnly` is likewise a server-side declaration (read by the
	// person-token gate), never advertised to a client as a hint.
	// `personDoor` too: the tool's Convex door admits a person acting in its own
	// name (bindPersonActingNames), a server-side declaration, never a hint.
	const { outputSchema, ownStateOnly, personDoor, ...annotations } =
		(declaredAnnotations ?? {}) as {
			outputSchema?: z.ZodRawShape | z.ZodObject<z.ZodRawShape>;
			ownStateOnly?: boolean;
			personDoor?: boolean;
		} & ToolAnnotations;

	const actingKeys = actingNameKeys(scope, schema);

	const guardedHandler: ToolHandler = async (args, extra) => {
		// First, before any argument is read: a person whose role may not write
		// is refused on every non-read-only tool.
		const exempt = annotations.readOnlyHint === true || ownStateOnly === true;
		const roleDenied = await enforcePersonWriterRole(
			ctx.oauthCtx,
			name,
			exempt,
		);
		if (roleDenied) return roleDenied;
		// A person acting in its own name: no acting name reaches the handler, so
		// the `from` kind's name check has nothing to check; every other declared
		// scope still applies.
		const person = exempt
			? null
			: bindPersonActingNames(
					ctx.oauthCtx,
					name,
					actingKeys,
					personDoor === true,
					(args ?? {}) as Record<string, unknown>,
				);
		if (person && "denied" in person) return person.denied;
		if (person) {
			if (scope.kind !== "from") {
				const denied = enforceScope(scope, ctx, person.args);
				if (denied) return denied;
			}
			return handler(person.args, extra);
		}
		const bound = bindActingNames(
			ctx.oauthCtx,
			actingKeys,
			(args ?? {}) as Record<string, unknown>,
		);
		if ("denied" in bound) return bound.denied;
		const denied = enforceScope(scope, ctx, bound.args);
		if (denied) return denied;
		if (ctx.oauthCtx) {
			for (const [key, claimed] of bound.unattributed) {
				recordUnattributedClaim(ctx.oauthCtx, name, key, claimed);
			}
		}
		return handler(bound.args, extra);
	};

	// STRICT wrap: reject any arg key not in `schema` instead of silently
	// stripping it (see buildStrictInputSchema doc comment above).
	const strictSchema = buildStrictInputSchema(schema);

	// Registered via the config-object API (not the deprecated positional
	// `server.tool(...)` overload) — that overload's raw-shape/annotations
	// disambiguation cannot accept an already-built strict ZodObject without
	// throwing at boot. See defineTool doc comment above.
	// biome-ignore lint/suspicious/noExplicitAny: SDK overload set is wider than our spec type.
	const registerTool = server.registerTool.bind(server) as any;
	registerTool(
		name,
		{
			description,
			inputSchema: strictSchema,
			annotations: declaredAnnotations === undefined ? undefined : annotations,
			// @modelcontextprotocol/server 2.x takes a Standard Schema object for
			// outputSchema (raw shapes are not auto-wrapped there): wrap one here.
			...(outputSchema !== undefined
				? {
						outputSchema:
							outputSchema instanceof z.ZodType
								? outputSchema
								: z.object(outputSchema),
					}
				: {}),
		},
		guardedHandler,
	);
}
