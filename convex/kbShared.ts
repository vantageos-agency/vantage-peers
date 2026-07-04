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
