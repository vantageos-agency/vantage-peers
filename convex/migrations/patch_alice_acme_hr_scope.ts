// MANUAL INVOCATION REQUIRED post-deploy — DO NOT auto-run:
//   bunx convex run "migrations/patch_alice_acme_hr_scope:patchAliceAcmeHrScope" '{}'
//
// S1.2-mutation (Day 90): remediation of the security leak where scope_profile
// `alice-acme-hr` retained `global` in namespaceReadPrefixes + namespaceWritePrefixes.
//
// This migration:
//   1. Drops `global` from both prefix lists (D4 enforcement)
//   2. Renames profileId from `alice-acme-hr` to `acme-hr` (D9 workspace naming)
//   3. Sets fromAllowList to ["alice", "victor"]
//   4. Sets NEW_READ_PREFIXES / NEW_WRITE_PREFIXES (no global)
//
// Implementation: direct-patch inline (does NOT call patchScopeProfileEmergency
// because internalMutation cannot call a public mutation; using the same D4
// enforcement logic inline for correctness, with idempotency guard).
//
// D4 enforcement: NEW_READ_PREFIXES and NEW_WRITE_PREFIXES are verified to
// contain no `global` or `*` entries — confirmed statically below.
//
// Idempotent: re-running leaves the row unchanged once profileId="acme-hr"
// and global is absent from both prefix lists.
//
// Previous Day 88 migration added orchestrator/alice; this S1.2 migration
// removes `global` and renames the profile per D9 workspace-level naming.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const OLD_PROFILE_ID = "alice-acme-hr";
const NEW_PROFILE_ID = "acme-hr";
const NEW_FROM_ALLOW_LIST = ["alice", "victor"];
const NEW_READ_PREFIXES = [
	"orchestrator/alice",
	"orchestrator/victor",
	"project/acme-hr",
];
const NEW_WRITE_PREFIXES = ["orchestrator/alice", "project/acme-hr"];

// D4 static assertion: ensure no `global` or `*` slips into the constants above.
// (TypeScript cannot enforce this at compile time, so we assert at module load.)
for (const p of [...NEW_READ_PREFIXES, ...NEW_WRITE_PREFIXES]) {
	if (p === "global" || p === "*") {
		throw new Error(
			`D4 violation in migration constants: prefix "${p}" is forbidden for non-master profiles`,
		);
	}
}

export const patchAliceAcmeHrScope = internalMutation({
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
				"Alice (Acme HR) — S1.2 Day 90 remediation: dropped `global` (D4 violation), renamed alice-acme-hr → acme-hr (D9 workspace naming). fromAllowList=[alice,victor], namespaces scoped to orchestrator/alice + orchestrator/victor + project/acme-hr.",
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
