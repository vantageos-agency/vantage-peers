import { ConvexError, v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { lookupOrgMapping } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// getByClerkSlug — the HTTP-layer accessor onto client_org_mapping.
//
// Backs mcp-server/src/auth.ts's Path B (the Clerk-JWT-as-bearer branch,
// bearerAuthMiddleware case 2.5). That branch verifies the caller's Clerk
// session JWT itself (JWKS, issuer, audience) BEFORE any Convex round-trip —
// there is no `ctx.auth.getUserIdentity()` for Convex to resolve on this
// path, so `withOrgScope` cannot be reused directly. This query exposes the
// SAME join (`lookupOrgMapping`, convex/lib/auth.ts) that withOrgScope calls,
// so the client_org_mapping join logic is never duplicated (task
// k17bf7bsfrm255x4pr5r96q5g58cw691 deliverable 1).
//
// `orgSlug` here is the verified `org_id` claim lifted from a Clerk JWT that
// the CALLER (mcp-server) has already cryptographically verified against
// Clerk's JWKS — it is not an attacker-controlled free-form string reaching
// this query from an unauthenticated request. This query itself performs no
// further authentication; it is a pure data accessor keyed on that
// already-verified claim, exactly mirroring the trust boundary
// `orgRoster:getForAccessToken` establishes for the token-hash path.
//
// Returns null when no row exists for `orgSlug`, or `isActive: false` when
// the row exists but the org has been disabled. The caller (auth.ts) MUST
// treat BOTH as a refusal — a populated default is never synthesized here.
// ─────────────────────────────────────────────────────────────────────────────
export const getByClerkSlug = query({
	args: { orgSlug: v.string() },
	returns: v.union(
		v.object({
			allowedOrchestrators: v.array(v.string()),
			scopes: v.array(v.string()),
			isActive: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await lookupOrgMapping(ctx, args.orgSlug);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// setOrgKind — the ONE instrument for marking a client_org_mapping row as the
// operator's own organisation ("operator") vs a customer ("client"). Run
// once per row in production via `npx convex run clientOrgMapping:setOrgKind
// '{"clerkOrgSlug":"...","orgKind":"operator"}'` — never wired to any MCP
// tool or client-facing surface (internalMutation).
//
// Looked up by the `by_clerk_slug` index with `.unique()` — throws if the
// slug is ambiguous (more than one row), same discipline as the rest of this
// module's index reads. Patches ONLY `orgKind`; isActive, allowedOrchestrators
// and scopes are untouched, so this instrument can never silently widen or
// narrow a row's live auth grant while marking its kind.
// ─────────────────────────────────────────────────────────────────────────────
export const setOrgKind = internalMutation({
	args: {
		clerkOrgSlug: v.string(),
		orgKind: v.union(v.literal("operator"), v.literal("client")),
	},
	returns: v.object({
		clerkOrgSlug: v.string(),
		previous: v.union(v.literal("operator"), v.literal("client"), v.null()),
		current: v.union(v.literal("operator"), v.literal("client")),
	}),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", args.clerkOrgSlug))
			.unique();

		if (!row) {
			throw new ConvexError(
				`ORG_MAPPING_NOT_FOUND: no client_org_mapping row for clerkOrgSlug "${args.clerkOrgSlug}"`,
			);
		}

		const previous = row.orgKind ?? null;
		await ctx.db.patch(row._id, { orgKind: args.orgKind });

		return {
			clerkOrgSlug: args.clerkOrgSlug,
			previous,
			current: args.orgKind,
		};
	},
});
