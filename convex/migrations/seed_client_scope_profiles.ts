// MANUAL INVOCATION REQUIRED post-deploy, audit-first. DO NOT auto-run.
//
// Client scope profiles are DATA (rows of `oauth_scope_profiles`), not product
// code. This internal mutation seeds them from an operator-supplied list, so the
// product source never carries a client name. The operator keeps the list in
// their own private config and passes it as the `profiles` argument.
//
//   1. Audit (default, writes nothing, returns the per-profile report):
//        bunx convex run "migrations/seed_client_scope_profiles:seedClientScopeProfiles" \
//          "$(jq -c '{profiles: .}' <private-profiles.json>)"
//   2. Apply the missing rows (still never overwrites a drifted row):
//        ... "$(jq -c '{profiles: ., apply: true}' <private-profiles.json>)"
//   3. Also patch rows that drifted from the supplied list:
//        ... "$(jq -c '{profiles: ., apply: true, overwriteDrift: true}' <private-profiles.json>)"
//
// Idempotent: a row that already equals the supplied profile is reported
// `identical` and never written. Every write appends an `oauth_audit_log` row
// (eventType `seed_client_profile`) with before/after, so the change is traceable.
//
// Guards (a client profile is never allowed to be broader than the contract):
//   - the generic catalog ids (`master`, `client-generic`, `public-readonly`)
//     are owned by `oauth:seedDefaultProfiles` and are refused here;
//   - a `*` or `global` prefix (read or write) or a `*` sender is refused (D4:
//     a client profile never reads or writes the shared namespace);
//   - `selfRegistrable: true` is refused (a client seat is never anonymously
//     self-registrable).

import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";

const GENERIC_CATALOG_IDS: ReadonlySet<string> = new Set([
	"master",
	"client-generic",
	"public-readonly",
]);

const profileInput = v.object({
	profileId: v.string(),
	description: v.string(),
	fromAllowList: v.array(v.string()),
	namespaceReadPrefixes: v.array(v.string()),
	namespaceWritePrefixes: v.array(v.string()),
	clerkOrgSlug: v.optional(v.string()),
	selfRegistrable: v.optional(v.boolean()),
});

const reportRow = v.object({
	profileId: v.string(),
	status: v.union(
		v.literal("missing"),
		v.literal("identical"),
		v.literal("drift"),
	),
	action: v.union(
		v.literal("none"),
		v.literal("would-insert"),
		v.literal("inserted"),
		v.literal("would-patch"),
		v.literal("patched"),
		v.literal("drift-kept"),
	),
	driftedFields: v.array(v.string()),
});

const sameList = (a: string[], b: string[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

export const seedClientScopeProfiles = internalMutation({
	args: {
		profiles: v.array(profileInput),
		apply: v.optional(v.boolean()),
		overwriteDrift: v.optional(v.boolean()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		report: v.array(reportRow),
	}),
	handler: async (ctx, args) => {
		const apply = args.apply === true;
		const overwriteDrift = args.overwriteDrift === true;

		// ── Validate the whole list BEFORE any write (all-or-nothing) ────────
		const seen = new Set<string>();
		for (const p of args.profiles) {
			if (p.profileId.trim() === "") {
				throw new ConvexError("seedClientScopeProfiles: empty profileId");
			}
			if (seen.has(p.profileId)) {
				throw new ConvexError(
					`seedClientScopeProfiles: duplicate profileId "${p.profileId}"`,
				);
			}
			seen.add(p.profileId);
			if (GENERIC_CATALOG_IDS.has(p.profileId)) {
				throw new ConvexError(
					`seedClientScopeProfiles: "${p.profileId}" is a generic catalog profile owned by oauth:seedDefaultProfiles`,
				);
			}
			if (p.selfRegistrable === true) {
				throw new ConvexError(
					`seedClientScopeProfiles: "${p.profileId}" must not be selfRegistrable`,
				);
			}
			for (const prefix of [
				...p.namespaceReadPrefixes,
				...p.namespaceWritePrefixes,
			]) {
				if (prefix === "*" || prefix === "global") {
					throw new ConvexError(
						`AUTH_NAMESPACE_DENIED: seedClientScopeProfiles: D4 violation, prefix "${prefix}" is forbidden for client profile "${p.profileId}"`,
					);
				}
			}
			if (p.fromAllowList.includes("*")) {
				throw new ConvexError(
					`AUTH_SENDER_WILDCARD_DENIED: seedClientScopeProfiles: wildcard sender is forbidden for client profile "${p.profileId}"`,
				);
			}
		}

		const now = Date.now();
		const report: Array<{
			profileId: string;
			status: "missing" | "identical" | "drift";
			action:
				| "none"
				| "would-insert"
				| "inserted"
				| "would-patch"
				| "patched"
				| "drift-kept";
			driftedFields: string[];
		}> = [];

		for (const p of args.profiles) {
			const existing = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", p.profileId))
				.unique();

			if (!existing) {
				if (apply) {
					await ctx.db.insert("oauth_scope_profiles", {
						profileId: p.profileId,
						description: p.description,
						fromAllowList: p.fromAllowList,
						namespaceReadPrefixes: p.namespaceReadPrefixes,
						namespaceWritePrefixes: p.namespaceWritePrefixes,
						...(p.clerkOrgSlug !== undefined
							? { clerkOrgSlug: p.clerkOrgSlug }
							: {}),
						createdAt: now,
						updatedAt: now,
					});
					await ctx.db.insert("oauth_audit_log", {
						eventType: "seed_client_profile",
						actorTokenHash: "internal:migrations/seed_client_scope_profiles",
						targetProfileId: p.profileId,
						previousState: {
							profileId: p.profileId,
							fromAllowList: [],
							namespaceReadPrefixes: [],
							namespaceWritePrefixes: [],
						},
						newState: {
							profileId: p.profileId,
							fromAllowList: p.fromAllowList,
							namespaceReadPrefixes: p.namespaceReadPrefixes,
							namespaceWritePrefixes: p.namespaceWritePrefixes,
						},
						reason: "seedClientScopeProfiles: row inserted from operator data",
						cascadeRevokedCount: 0,
						clientsRetargeted: 0,
						createdAt: now,
					});
				}
				report.push({
					profileId: p.profileId,
					status: "missing",
					action: apply ? "inserted" : "would-insert",
					driftedFields: [],
				});
				continue;
			}

			const driftedFields: string[] = [];
			if (existing.description !== p.description) {
				driftedFields.push("description");
			}
			if (!sameList(existing.fromAllowList, p.fromAllowList)) {
				driftedFields.push("fromAllowList");
			}
			if (!sameList(existing.namespaceReadPrefixes, p.namespaceReadPrefixes)) {
				driftedFields.push("namespaceReadPrefixes");
			}
			if (
				!sameList(existing.namespaceWritePrefixes, p.namespaceWritePrefixes)
			) {
				driftedFields.push("namespaceWritePrefixes");
			}

			if (driftedFields.length === 0) {
				report.push({
					profileId: p.profileId,
					status: "identical",
					action: "none",
					driftedFields,
				});
				continue;
			}

			if (!(apply && overwriteDrift)) {
				report.push({
					profileId: p.profileId,
					status: "drift",
					action: apply ? "drift-kept" : "would-patch",
					driftedFields,
				});
				continue;
			}

			await ctx.db.patch(existing._id, {
				description: p.description,
				fromAllowList: p.fromAllowList,
				namespaceReadPrefixes: p.namespaceReadPrefixes,
				namespaceWritePrefixes: p.namespaceWritePrefixes,
				updatedAt: now,
			});
			await ctx.db.insert("oauth_audit_log", {
				eventType: "seed_client_profile",
				actorTokenHash: "internal:migrations/seed_client_scope_profiles",
				targetProfileId: p.profileId,
				previousState: {
					profileId: existing.profileId,
					fromAllowList: existing.fromAllowList,
					namespaceReadPrefixes: existing.namespaceReadPrefixes,
					namespaceWritePrefixes: existing.namespaceWritePrefixes,
				},
				newState: {
					profileId: p.profileId,
					fromAllowList: p.fromAllowList,
					namespaceReadPrefixes: p.namespaceReadPrefixes,
					namespaceWritePrefixes: p.namespaceWritePrefixes,
				},
				reason: `seedClientScopeProfiles: drift patched (${driftedFields.join(",")})`,
				cascadeRevokedCount: 0,
				clientsRetargeted: 0,
				createdAt: now,
			});
			report.push({
				profileId: p.profileId,
				status: "drift",
				action: "patched",
				driftedFields,
			});
		}

		return { dryRun: !apply, report };
	},
});
