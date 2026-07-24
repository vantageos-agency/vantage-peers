// MANUAL INVOCATION REQUIRED post-deploy — DO NOT auto-run:
//   bunx convex run "migrations/patch_marie_iris_rh_scope:patchMarieIrisRhScope" '{}'
//
// SCOPE NOTICE (PR #1120): this FILENAME carries the client slug in
// cleartext. `scripts/source_prose_identity_guard.py` REQUIRED gate scans
// this file's prose (comments/description) and is GREEN, but it
// deliberately excludes repo file paths / this exact invocation line from
// its match surface (class 1 of its declared scope) -- a green guard here
// does NOT mean this file is clean of client identity; the filename itself
// still is one. Open, tracked to close by RENAMING this file:
// k171ksjnczs3k404nte7kk9m0h8b2a8g.
//
// S1.2-mutation (Day 90): remediation of the security leak where the
// onboarding-client scope_profile (see OLD_PROFILE_ID below) retained
// `global` in namespaceReadPrefixes + namespaceWritePrefixes.
//
// This migration:
//   1. Drops `global` from both prefix lists (D4 enforcement)
//   2. Renames profileId from OLD_PROFILE_ID to NEW_PROFILE_ID (D9 workspace naming)
//   3. Sets fromAllowList to ["marie", "victor"]
//   4. Sets NEW_READ_PREFIXES / NEW_WRITE_PREFIXES (no global)
//
// Implementation: direct-patch inline (does NOT call patchScopeProfileEmergency
// because internalMutation cannot call a public mutation; using the same D4
// enforcement logic inline for correctness, with idempotency guard).
//
// D4 enforcement: NEW_READ_PREFIXES and NEW_WRITE_PREFIXES are verified to
// contain no `global` or `*` entries — confirmed statically below.
//
// Idempotent: re-running leaves the row unchanged once profileId=NEW_PROFILE_ID
// and global is absent from both prefix lists.
//
// Previous Day 88 migration added orchestrator/marie; this S1.2 migration
// removes `global` and renames the profile per D9 workspace-level naming.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const OLD_PROFILE_ID = "marie-iris-rh";
const NEW_PROFILE_ID = "iris-rh";
const NEW_FROM_ALLOW_LIST = ["marie", "victor"];
const NEW_READ_PREFIXES = [
	"orchestrator/marie",
	"orchestrator/victor",
	"project/iris-rh",
];
const NEW_WRITE_PREFIXES = ["orchestrator/marie", "project/iris-rh"];

// D4 static assertion: ensure no `global` or `*` slips into the constants above.
// (TypeScript cannot enforce this at compile time, so we assert at module load.)
for (const p of [...NEW_READ_PREFIXES, ...NEW_WRITE_PREFIXES]) {
	if (p === "global" || p === "*") {
		throw new Error(
			`D4 violation in migration constants: prefix "${p}" is forbidden for non-master profiles`,
		);
	}
}

export const patchMarieIrisRhScope = internalMutation({
	args: {},
	returns: v.object({
		patched: v.boolean(),
		previousProfileId: v.string(),
		newProfileId: v.string(),
		readBefore: v.array(v.string()),
		readAfter: v.array(v.string()),
		writeBefore: v.array(v.string()),
		writeAfter: v.array(v.string()),
	}),
	handler: async (ctx) => {
		// Try to find by OLD_PROFILE_ID first (not yet migrated)
		let existing = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", OLD_PROFILE_ID))
			.unique();

		// Idempotency check: already migrated to new name?
		if (!existing) {
			const alreadyMigrated = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", NEW_PROFILE_ID))
				.unique();

			if (alreadyMigrated) {
				// Already migrated — confirm global is absent (idempotent read)
				const alreadyClean =
					!alreadyMigrated.namespaceReadPrefixes.includes("global") &&
					!alreadyMigrated.namespaceWritePrefixes.includes("global");
				if (alreadyClean) {
					return {
						patched: false,
						previousProfileId: NEW_PROFILE_ID,
						newProfileId: NEW_PROFILE_ID,
						readBefore: alreadyMigrated.namespaceReadPrefixes,
						readAfter: alreadyMigrated.namespaceReadPrefixes,
						writeBefore: alreadyMigrated.namespaceWritePrefixes,
						writeAfter: alreadyMigrated.namespaceWritePrefixes,
					};
				}
				// Already renamed but still has global — patch in place
				existing = alreadyMigrated;
			} else {
				throw new Error(
					`oauth_scope_profile "${OLD_PROFILE_ID}" (and "${NEW_PROFILE_ID}") not found — was seedDefaultProfiles run?`,
				);
			}
		}

		const readBefore = existing.namespaceReadPrefixes;
		const writeBefore = existing.namespaceWritePrefixes;

		await ctx.db.patch(existing._id, {
			profileId: NEW_PROFILE_ID,
			fromAllowList: NEW_FROM_ALLOW_LIST,
			namespaceReadPrefixes: NEW_READ_PREFIXES,
			namespaceWritePrefixes: NEW_WRITE_PREFIXES,
			description:
				"The onboarding client — S1.2 Day 90 remediation: dropped `global` (D4 violation), renamed OLD_PROFILE_ID → NEW_PROFILE_ID (D9 workspace naming). fromAllowList and namespace prefixes scoped per NEW_FROM_ALLOW_LIST / NEW_READ_PREFIXES above.",
			updatedAt: Date.now(),
		});

		return {
			patched: true,
			previousProfileId: OLD_PROFILE_ID,
			newProfileId: NEW_PROFILE_ID,
			readBefore,
			readAfter: NEW_READ_PREFIXES,
			writeBefore,
			writeAfter: NEW_WRITE_PREFIXES,
		};
	},
});
