/**
 * convex/kbShared.ts — runtime-agnostic helpers shared between the KB
 * Node-runtime actions (convex/kb.ts, "use node") and the KB V8-runtime
 * mutations/queries (convex/kbMutations.ts).
 *
 * Convex rule: a "use node" file's public mutations must live in a separate
 * V8-runtime file. `assertOrgArgs` is pure JS (no node:* imports), so it is
 * extracted here to be safely imported from BOTH runtimes without pulling
 * node-only dependencies (node:crypto, pdf-parse) into the V8 bundle.
 *
 * Mission: k571vk3cc265w8777g3z54vnd989w8k1 (kb-upload-url-endpoint-v1).
 * Task:    T2 — generateUploadUrl GREEN.
 *
 * Orchestrator: Sigma — VantagePeers | 2026-07-04
 */

// ─────────────────────────────────────────────────────────────────────────────
// Auth: orgId + namespace are passed as explicit args by the MCP layer.
//
// B4 #915 pattern (auth.ts layer 2.5): the bearer middleware resolves the
// Clerk JWT and mints oauthCtx.namespaceWritePrefixes = ["team/<orgId>"].
// The MCP tool handler (kbIngest.ts) extracts orgId from that prefix and
// passes it here as explicit args — NO ctx.auth call inside the handler.
//
// Why: ConvexHttpClient (server-http.ts:1437) never calls setAuth, so
// ctx.auth.getUserIdentity() is always null over HTTP.  Using ctx.auth here
// produces a green-in-test / dead-in-prod bug (convex-test injects identity
// via withIdentity, the real transport does not).
//
// Defense-in-depth: callers still validate the incoming args and throw
// AUTH_NO_ORG_ID on empty/malformed values — the MCP layer already gates,
// but we do not trust the client.
// ─────────────────────────────────────────────────────────────────────────────

/** Validate explicit orgId + namespace args (defense-in-depth). */
export function assertOrgArgs(orgId: string, namespace: string): void {
	if (!orgId || typeof orgId !== "string" || orgId.trim().length === 0) {
		throw new Error(
			"AUTH_NO_ORG_ID: orgId arg is empty — store_document_chunked requires a team org.",
		);
	}
	const expectedPrefix = `team/${orgId}/`;
	if (!namespace.startsWith("team/")) {
		throw new Error(
			"AUTH_NO_ORG_ID: namespace does not start with team/ — possible cross-tenant injection attempt.",
		);
	}
	// namespace must be team/<orgId>/<docId> — the orgId segment must match
	const parts = namespace.split("/");
	if (parts.length < 3 || parts[1] !== orgId) {
		throw new Error(
			`AUTH_NO_ORG_ID: namespace '${namespace}' does not match orgId '${orgId}'.`,
		);
	}
	void expectedPrefix; // consumed above
}

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION TO THE MODULE HEADER ABOVE (which is left in place as the record
// of what this module used to believe).
//
// The header says: "ConvexHttpClient (server-http.ts:1437) never calls
// setAuth, so ctx.auth.getUserIdentity() is always null over HTTP. Using
// ctx.auth here produces a green-in-test / dead-in-prod bug."
//
// THAT PREMISE IS STALE and it is what made `assertOrgArgs` the ONLY gate on
// the two public KB actions. It was true when written; it stopped being true
// with the P0 fix of 2026-08-07 (see mcp-server/src/authenticatedConvexClient.ts,
// `selectConvexClientForRequest`), after which the MCP server ALWAYS attaches
// an identity — either the caller's own verified Clerk JWT, or its Clerk
// service-account token. `convex/memories.ts` and `convex/episodes.ts` already
// rely on that fact via a fail-closed `withOrgScope(ctx)`.
//
// WHY assertOrgArgs ALONE IS NOT AUTHORITY: it compares `orgId` against
// `namespace` — TWO CALLER-SUPPLIED ARGUMENTS. A caller who sends
// { orgId: "victim", namespace: "team/victim" } satisfies it perfectly. It
// proves the request is internally consistent, never that the caller is who
// it claims. `.claude/rules/authority-attached-to-anonymous-object.md`: the
// authenticated principal's own claims are the ONLY permitted key. So
// assertOrgArgs is kept as a SHAPE validator (it still usefully rejects
// malformed namespaces and path confusion) and the function below adds the
// missing authority join on top of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The verified-principal gate for the KB actions.
 *
 * `scope` MUST come from `internal.authScope.resolveOrgScopeForAction` (which
 * is a thin adapter over `convex/lib/auth.ts`'s `withOrgScope`) — never from
 * anything the caller sent. `claimedOrgId` is the caller-supplied `args.orgId`.
 *
 * NARROW ONLY, NEVER WIDEN (the "narrowing ceiling" language in
 * authority-attached-to-anonymous-object.md): the caller may only ever confirm
 * the org the principal already resolves to. A mismatch is a refusal, not a
 * re-scope.
 *
 * Refuses BY THROW in every branch — both KB call sites are imperative WRITES
 * (an ingest and a soft-delete), and a write refusal must never be softened
 * into a typed empty value.
 */
export function assertScopeAuthorizesOrg(
	scope: { isMaster: boolean; orgSlug: string | null; refused: boolean },
	claimedOrgId: string,
): void {
	// Master (the fleet's own callers, via withOrgScope's named by-id
	// service-account carve-out) keeps acting on any org — unchanged.
	if (scope.isMaster) return;

	if (scope.refused || scope.orgSlug === null) {
		throw new Error(
			"AUTH_NAMESPACE_DENIED: caller has no verified organisation — " +
				"orgId is a caller-supplied argument and is never, by itself, " +
				"authority to act on an organisation.",
		);
	}

	if (scope.orgSlug !== claimedOrgId) {
		throw new Error(
			`AUTH_NAMESPACE_DENIED: caller's verified organisation "${scope.orgSlug}" ` +
				`may not act on claimed org "${claimedOrgId}".`,
		);
	}
}
