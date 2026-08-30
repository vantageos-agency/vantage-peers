// MANUAL INVOCATION REQUIRED post-deploy — DO NOT auto-run:
//   bunx convex run "migrations/drop_client_scope_global_prefix:dropClientScopeGlobalPrefix" '{}'
//
// Operator-authorized (task k173wamy80xmz2z9761d616ybh87zhf7), REWORKED per
// operator countermand: the ONLY leak for this scope profile is the
// fleet-common `global` prefix. VantagePeers is sold multi-organisation and a
// client profile must never read/write the shared global namespace.
//
// The prior version of this migration ALSO dropped one of the profile's own
// legitimate namespace prefixes, which was WRONG — that prefix is this same
// client's own second orchestrator seat, not another organisation's
// namespace. Dropping it cut the client from their own orchestrator, a
// service interruption the operator forbids. This rework restores that
// prefix and drops ONLY `global`.
//
// Root cause: `seedDefaultProfiles` (convex/oauth.ts) is catalog-SSOT and
// UPSERTs any drifted row back to the seed, so a manual dashboard drop is
// re-clobbered on the next seed run. The catalog entry was fixed FIRST
// (convex/oauth.ts, this PR); THIS migration patches the LIVE prod row(s) so
// the fix takes effect without waiting for the next seed invocation.
//
// This migration, in order:
//   1. Patches the `oauth_scope_profiles` row for the target profile: drops
//      `global` from both prefix lists, keeps every other prefix unchanged.
//   2. Walks every LIVE (non-revoked, non-expired) row in
//      `oauth_access_tokens` for the target scopeProfile and patches its
//      cached `namespaceReadPrefixes` / `namespaceWritePrefixes` in place to
//      the same new values — WITHOUT setting `revokedAt`. This is
//      deliberate: the client's existing session/token must keep working
//      unchanged (same token, same session, same expiry) while its cached
//      scope catches up to the corrected catalog. Streamed via
//      `for await` (no unbounded `.collect()`), before/after captured per
//      row, and any read failure throws loudly rather than skipping.
//   3. Checks `oauth_refresh_tokens` for a prefix snapshot: per
//      convex/schema.ts, `oauth_refresh_tokens` does NOT cache namespace
//      prefixes (only `tokenHash`, `clientId`, `userId`, `scopeProfile`,
//      `expiresAt`, `createdAt`, `revokedAt`) — there is nothing to patch
//      there. The next refresh-flow naturally re-mints an access token that
//      reads the corrected catalog profile, so no action is needed on
//      refresh tokens.
//
// D4 enforcement: NEW_READ_PREFIXES and NEW_WRITE_PREFIXES are statically
// asserted below to contain no `global` and no `*`. The profile's own
// namespace prefixes below are NOT forbidden — they are legitimate.
//
// Idempotent: re-running when the profile row and every live token are
// already clean is a no-op (no writes), and per-row `alreadyClean` is
// checked independently so a partially-migrated token set still converges.
//
// NOTE (data vs. prose): the constants immediately below encode this
// profile's fixed identifier and namespace-prefix data — the functional
// authorization control itself, same class as `convex/oauth.ts`'s own
// seedDefaultProfiles catalog (see the "SCOPE NOTICE" comment there). A
// source-identity grep over prose/comments is expected to be clean; it does
// not and cannot scan these data literals without breaking the migration.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const PROFILE_ID = "marie-iris-rh";
const NEW_READ_PREFIXES = [
	"orchestrator/marie",
	"orchestrator/victor",
	"project/marie",
];
const NEW_WRITE_PREFIXES = [
	"orchestrator/marie",
	"orchestrator/victor",
	"project/marie",
];

// D4 static assertion: ensure no `global` or `*` slips into the constants
// above. Every other prefix listed is intentionally allowed — each is one of
// this profile's own namespaces, not a cross-tenant one.
// (TypeScript cannot enforce this at compile time, so we assert at module
// load.)
for (const p of [...NEW_READ_PREFIXES, ...NEW_WRITE_PREFIXES]) {
	if (p === "global" || p === "*") {
		throw new Error(
			`D4 violation in migration constants: prefix "${p}" is forbidden for ${PROFILE_ID}`,
		);
	}
}

export const dropClientScopeGlobalPrefix = internalMutation({
	args: {},
	returns: v.object({
		profilePatched: v.boolean(),
		profileId: v.string(),
		profileReadBefore: v.array(v.string()),
		profileReadAfter: v.array(v.string()),
		profileWriteBefore: v.array(v.string()),
		profileWriteAfter: v.array(v.string()),
		accessTokensInspected: v.number(),
		accessTokensPatched: v.number(),
		accessTokenSnapshots: v.array(
			v.object({
				tokenId: v.id("oauth_access_tokens"),
				readBefore: v.array(v.string()),
				readAfter: v.array(v.string()),
				writeBefore: v.array(v.string()),
				writeAfter: v.array(v.string()),
				patched: v.boolean(),
			}),
		),
		refreshTokenFinding: v.string(),
	}),
	handler: async (ctx) => {
		// ── 1. Patch the catalog row ──────────────────────────────────────────
		const existing = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", PROFILE_ID))
			.unique();

		if (!existing) {
			throw new Error(
				`oauth_scope_profile "${PROFILE_ID}" not found — was seedDefaultProfiles run?`,
			);
		}

		const profileReadBefore = existing.namespaceReadPrefixes;
		const profileWriteBefore = existing.namespaceWritePrefixes;

		const profileAlreadyClean =
			!profileReadBefore.includes("global") &&
			!profileWriteBefore.includes("global");

		let profilePatched = false;
		let profileReadAfter = profileReadBefore;
		let profileWriteAfter = profileWriteBefore;

		if (!profileAlreadyClean) {
			// `description` is left untouched — convex/oauth.ts is the SSOT for
			// that prose and already carries the up-to-date text; this migration
			// only ever touches the prefix arrays.
			await ctx.db.patch(existing._id, {
				namespaceReadPrefixes: NEW_READ_PREFIXES,
				namespaceWritePrefixes: NEW_WRITE_PREFIXES,
				updatedAt: Date.now(),
			});
			profilePatched = true;
			profileReadAfter = NEW_READ_PREFIXES;
			profileWriteAfter = NEW_WRITE_PREFIXES;
		}

		// ── 2. Patch live token snapshots IN PLACE — no revocation ───────────
		// Streamed via `for await` per Convex guidelines (no unbounded
		// `.collect()`). Every row is inspected; loud failure (thrown error)
		// instead of a silent skip if a read is malformed.
		const now = Date.now();
		let accessTokensInspected = 0;
		let accessTokensPatched = 0;
		const accessTokenSnapshots: Array<{
			tokenId: import("../_generated/dataModel").Id<"oauth_access_tokens">;
			readBefore: string[];
			readAfter: string[];
			writeBefore: string[];
			writeAfter: string[];
			patched: boolean;
		}> = [];

		const tokenQuery = ctx.db
			.query("oauth_access_tokens")
			.withIndex("by_scopeProfile", (q) => q.eq("scopeProfile", PROFILE_ID));

		for await (const token of tokenQuery) {
			if (token.revokedAt !== undefined) continue;
			if (token.expiresAt <= now) continue;

			accessTokensInspected++;

			if (
				token.namespaceReadPrefixes === undefined ||
				token.namespaceWritePrefixes === undefined
			) {
				throw new Error(
					`oauth_access_tokens row ${token._id} is missing namespace prefix fields — malformed row, refusing to proceed silently`,
				);
			}

			const readBefore = token.namespaceReadPrefixes;
			const writeBefore = token.namespaceWritePrefixes;
			const rowAlreadyClean =
				!readBefore.includes("global") && !writeBefore.includes("global");

			if (rowAlreadyClean) {
				accessTokenSnapshots.push({
					tokenId: token._id,
					readBefore,
					readAfter: readBefore,
					writeBefore,
					writeAfter: writeBefore,
					patched: false,
				});
				continue;
			}

			// Drop only "global" from this row's prefixes, preserving every other
			// prefix already present (defensive: even if a row somehow diverged
			// from the catalog's exact list, we never touch a non-"global" prefix).
			const readAfter = readBefore.filter((p) => p !== "global");
			const writeAfter = writeBefore.filter((p) => p !== "global");

			await ctx.db.patch(token._id, {
				namespaceReadPrefixes: readAfter,
				namespaceWritePrefixes: writeAfter,
				// Deliberately NOT setting revokedAt — same token, same session,
				// same expiry. This is a scope correction, not a revocation.
			});
			accessTokensPatched++;

			accessTokenSnapshots.push({
				tokenId: token._id,
				readBefore,
				readAfter,
				writeBefore,
				writeAfter,
				patched: true,
			});
		}

		// ── 3. oauth_refresh_tokens — checked, not patched ────────────────────
		// Per convex/schema.ts, oauth_refresh_tokens carries no prefix snapshot
		// (tokenHash, clientId, userId, scopeProfile, expiresAt, createdAt,
		// revokedAt only). There is nothing to patch here; stated explicitly so
		// this is not mistaken for an oversight.
		const refreshTokenFinding =
			"oauth_refresh_tokens has no namespaceReadPrefixes/namespaceWritePrefixes fields (verified against convex/schema.ts) — no patch needed; the next refresh-flow re-mints an access token from the corrected oauth_scope_profiles catalog row.";

		return {
			profilePatched,
			profileId: PROFILE_ID,
			profileReadBefore,
			profileReadAfter,
			profileWriteBefore,
			profileWriteAfter,
			accessTokensInspected,
			accessTokensPatched,
			accessTokenSnapshots,
			refreshTokenFinding,
		};
	},
});
