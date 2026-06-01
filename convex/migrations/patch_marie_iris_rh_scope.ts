// MANUAL INVOCATION REQUIRED post-deploy — DO NOT auto-run:
//   bunx convex run "migrations/patch_marie_iris_rh_scope:patchMarieIrisRhScope" '{}'
//
// Day 88 fix: the seeded `marie-iris-rh` scope profile was missing
// `orchestrator/marie` from both read and write prefixes. Every other
// orchestrator owns their `orchestrator/<name>` namespace by convention, but
// the marie-iris-rh profile only allowed `orchestrator/victor`, `project/marie`,
// and `global`. As a result Marie's MCP connector returned a write Forbidden
// when the LLM (correctly) tried to write_diary / store_memory to
// `orchestrator/marie/...`.
//
// `seedDefaultProfiles` only inserts if the row does not already exist, so the
// updated seed definition does not retroactively patch the prod row. This
// migration explicitly updates the existing oauth_scope_profiles entry where
// profileId="marie-iris-rh".
//
// Idempotent: re-running it leaves the row unchanged once the prefixes are
// present.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const TARGET_PROFILE_ID = "marie-iris-rh";

// New prefix lists — `orchestrator/marie` prepended to the existing lists.
const NEW_READ_PREFIXES = [
	"orchestrator/marie",
	"orchestrator/victor",
	"project/marie",
	"global",
];

const NEW_WRITE_PREFIXES = [
	"orchestrator/marie",
	"orchestrator/victor",
	"project/marie",
	"global",
];

const NEW_DESCRIPTION =
	"Marie (Iris RH) — send_message as 'marie' only; read/write in her own orchestrator namespace + project namespace + global. Day 88 fix: added orchestrator/marie which was missing — every orchestrator owns their orchestrator/<name> namespace by convention.";

export const patchMarieIrisRhScope = internalMutation({
	args: {},
	returns: v.object({
		patched: v.boolean(),
		readBefore: v.array(v.string()),
		readAfter: v.array(v.string()),
		writeBefore: v.array(v.string()),
		writeAfter: v.array(v.string()),
	}),
	handler: async (ctx) => {
		const existing = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", TARGET_PROFILE_ID))
			.unique();

		if (!existing) {
			throw new Error(
				`oauth_scope_profile ${TARGET_PROFILE_ID} not found — was seedDefaultProfiles run?`,
			);
		}

		const readBefore = existing.namespaceReadPrefixes;
		const writeBefore = existing.namespaceWritePrefixes;

		const alreadyPatched =
			readBefore.includes("orchestrator/marie") &&
			writeBefore.includes("orchestrator/marie");

		if (alreadyPatched) {
			return {
				patched: false,
				readBefore,
				readAfter: readBefore,
				writeBefore,
				writeAfter: writeBefore,
			};
		}

		await ctx.db.patch(existing._id, {
			namespaceReadPrefixes: NEW_READ_PREFIXES,
			namespaceWritePrefixes: NEW_WRITE_PREFIXES,
			description: NEW_DESCRIPTION,
			updatedAt: Date.now(),
		});

		return {
			patched: true,
			readBefore,
			readAfter: NEW_READ_PREFIXES,
			writeBefore,
			writeAfter: NEW_WRITE_PREFIXES,
		};
	},
});
