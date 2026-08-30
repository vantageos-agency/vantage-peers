// MANUAL INVOCATION REQUIRED post-deploy — DO NOT auto-run:
//   bunx convex run "migrations/drop_marie_iris_rh_leak:dropMarieIrisRhLeak" '{}'
//
// Pi ORDER (operator-authorized, task k173wamy80xmz2z9761d616ybh87zhf7):
// the `marie-iris-rh` scope_profile grants read AND write on `global` and
// `orchestrator/victor` — VantagePeers is sold multi-organisation and this
// breaks that promise. Root cause: `seedDefaultProfiles` (convex/oauth.ts)
// is catalog-SSOT and UPSERTs any drifted row back to the seed, so a manual
// dashboard drop is re-clobbered on the next seed run. The catalog entry was
// fixed FIRST (convex/oauth.ts:118 marie-iris-rh block, this PR); THIS
// migration patches the LIVE prod row so the fix takes effect without
// waiting for the next seed invocation.
//
// This migration:
//   1. Drops `global` and `orchestrator/victor` from both prefix lists
//   2. Does NOT rename the profile (the D9 rename to `iris-rh` is tracked in
//      `patch_marie_iris_rh_scope.ts` and is explicitly out of scope here —
//      Pi's order for this leak-fix keeps profileId=marie-iris-rh unchanged)
//   3. Idempotent: re-running when the row is already clean is a no-op read
//
// D4 enforcement: NEW_READ_PREFIXES and NEW_WRITE_PREFIXES are statically
// asserted below to contain no `global`, no `*`, and no `orchestrator/victor`.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const PROFILE_ID = "marie-iris-rh";
const NEW_READ_PREFIXES = ["orchestrator/marie", "project/marie"];
const NEW_WRITE_PREFIXES = ["orchestrator/marie", "project/marie"];

// D4 static assertion: ensure no `global`, `*`, or `orchestrator/victor`
// slips into the constants above. (TypeScript cannot enforce this at compile
// time, so we assert at module load — mirrors patch_marie_iris_rh_scope.ts.)
for (const p of [...NEW_READ_PREFIXES, ...NEW_WRITE_PREFIXES]) {
	if (p === "global" || p === "*" || p === "orchestrator/victor") {
		throw new Error(
			`D4/leak-fix violation in migration constants: prefix "${p}" is forbidden for marie-iris-rh`,
		);
	}
}

export const dropMarieIrisRhLeak = internalMutation({
	args: {},
	returns: v.object({
		patched: v.boolean(),
		profileId: v.string(),
		readBefore: v.array(v.string()),
		readAfter: v.array(v.string()),
		writeBefore: v.array(v.string()),
		writeAfter: v.array(v.string()),
	}),
	handler: async (ctx) => {
		const existing = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", PROFILE_ID))
			.unique();

		if (!existing) {
			throw new Error(
				`oauth_scope_profile "${PROFILE_ID}" not found — was seedDefaultProfiles run?`,
			);
		}

		const readBefore = existing.namespaceReadPrefixes;
		const writeBefore = existing.namespaceWritePrefixes;

		const alreadyClean =
			!readBefore.includes("global") &&
			!readBefore.includes("orchestrator/victor") &&
			!writeBefore.includes("global") &&
			!writeBefore.includes("orchestrator/victor");

		if (alreadyClean) {
			return {
				patched: false,
				profileId: PROFILE_ID,
				readBefore,
				readAfter: readBefore,
				writeBefore,
				writeAfter: writeBefore,
			};
		}

		await ctx.db.patch(existing._id, {
			namespaceReadPrefixes: NEW_READ_PREFIXES,
			namespaceWritePrefixes: NEW_WRITE_PREFIXES,
			description:
				"Marie (the onboarding client) — send_message as 'marie' only; read/write bounded to her own org: orchestrator/marie + project/marie. Leak fix (task k173wamy80xmz2z9761d616ybh87zhf7): dropped `global` and `orchestrator/victor` — a client profile must never read/write another org's orchestrator namespace or the shared global namespace.",
			updatedAt: Date.now(),
		});

		return {
			patched: true,
			profileId: PROFILE_ID,
			readBefore,
			readAfter: NEW_READ_PREFIXES,
			writeBefore,
			writeAfter: NEW_WRITE_PREFIXES,
		};
	},
});
