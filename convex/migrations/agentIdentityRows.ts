/**
 * Agent identity by row — rollout backfills for two optional fields.
 *
 *   agents.normalizedName           (the per-org uniqueness key)
 *   agent_credentials.agentId       (the credential's identity: the agents row)
 *
 * INTERNAL ONLY — never client-facing, never run automatically. Operator-run,
 * cursor-paged, DRY-RUN FIRST (same shape as memberScopesMigration.ts):
 *
 *   npx convex run migrations/agentIdentityRows:backfillAgentNormalizedNames \
 *     '{"dryRun":true,"cursor":null}'
 *   npx convex run migrations/agentIdentityRows:backfillCredentialAgentIds \
 *     '{"dryRun":true,"cursor":null}'
 *   npx convex run migrations/agentIdentityRows:bindSeatProfileAgentIds \
 *     '{"dryRun":true,"cursor":null}'
 *   npx convex run migrations/agentIdentityRows:backfillSeatTokenAgentIds \
 *     '{"dryRun":true,"cursor":null}'
 *   npx convex run migrations/agentIdentityRows:backfillProfileAgentIdLists \
 *     '{"dryRun":true,"cursor":null}'
 *   npx convex run migrations/agentIdentityRows:backfillTokenAgentIdLists \
 *     '{"dryRun":true,"cursor":null}'
 *
 * ORDER for the seat tokens (operator ruling 2026-10-13, "identify by id, not by
 * name"): bindSeatProfileAgentIds FIRST (it binds the agent ID onto every seat
 * profile whose single label resolved before the label branch was deleted), then
 * backfillSeatTokenAgentIds, then backfillProfileAgentIdLists, then
 * backfillTokenAgentIdLists. A seat profile that is still unbound after the first
 * one refuses to mint (SEAT_PROFILE_UNBOUND): read its `unbound` report.
 *
 * Repeat each with `cursor` = the returned `continueCursor` until `isDone`.
 * Run the names backfill first; the two are independent but the report of the
 * first tells the operator which agents collide before any credential is tied.
 *
 * Guarantees (both):
 *  - IDEMPOTENT: a row already carrying the field is counted, never rewritten.
 *  - REFUSES, NEVER GUESSES: a row that cannot be resolved to exactly one
 *    agent is COUNTED (`missingAgent` / `ambiguous` / `collisions`) and left
 *    untouched, so an operator reads the count instead of finding a wrong id.
 *  - dryRun writes nothing and reports what a real run would do.
 *  - Bounded: at most `batchSize` (default 100, max 200) rows per call.
 */
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import {
	isOneAgentSeatShape,
	liveProfileAgentIds,
	resolveSeatAgent,
	sameOrgStamp,
	seatBindingRefusal,
} from "../lib/seatAgent";

const DEFAULT_BATCH = 100;
const MAX_BATCH = 200;
/**
 * Most agents of one org the clash check reads (R-31). An org with more is
 * not guessed at: the row is COUNTED as a collision and left untouched, the
 * same refuse-never-guess outcome as a real clash.
 */
export const AGENT_ROSTER_SCAN_CAP = 500;

function checkBatch(batchSize: number): void {
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
		throw new Error(
			`batchSize = ${batchSize} is out of expected range 1-${MAX_BATCH}.`,
		);
	}
}

// allow-local-identity: one-off backfill that WRITES the per-org uniqueness key of an agent's display label (normalizedName) and refuses on a clash; it admits no caller and selects no row for any caller
export const backfillAgentNormalizedNames = internalMutation({
	args: {
		dryRun: v.boolean(),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		updated: v.number(),
		alreadySet: v.number(),
		collisions: v.number(),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? DEFAULT_BATCH;
		checkBatch(batchSize);
		const page = await ctx.db
			.query("agents")
			.paginate({ numItems: batchSize, cursor: args.cursor });

		let updated = 0;
		let alreadySet = 0;
		let collisions = 0;
		for (const row of page.page) {
			const normalized = normalizeOrchestratorId(row.name);
			if (row.normalizedName === normalized) {
				alreadySet += 1;
				continue;
			}
			// Two rows of one org that normalise equal: neither is patched. Which
			// of the two "owns" the name is an operator decision, not a guess.
			const roster = await ctx.db
				.query("agents")
				.withIndex("by_org", (q) => q.eq("orgSlug", row.orgSlug))
				.take(AGENT_ROSTER_SCAN_CAP + 1);
			const clash =
				roster.length > AGENT_ROSTER_SCAN_CAP ||
				roster.some(
				(other) =>
					other._id !== row._id &&
					normalizeOrchestratorId(other.name) === normalized,
				);
			if (clash) {
				collisions += 1;
				continue;
			}
			updated += 1;
			if (!args.dryRun) {
				await ctx.db.patch(row._id, { normalizedName: normalized });
			}
		}
		return {
			dryRun: args.dryRun,
			scanned: page.page.length,
			updated,
			alreadySet,
			collisions,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

// allow-local-identity: one-off backfill that turns the label a legacy credential row recorded at mint into the agent ID, once, inside the row's own org; it admits no caller and every later decision follows the ID it writes
export const backfillCredentialAgentIds = internalMutation({
	args: {
		dryRun: v.boolean(),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		updated: v.number(),
		alreadySet: v.number(),
		missingAgent: v.number(),
		ambiguous: v.number(),
		// The rows this run could NOT decide, BY ID, so an operator acts on named
		// rows (revoke, re-mint, or fix the agent) instead of reading a count.
		missingAgentIds: v.array(v.id("agent_credentials")),
		ambiguousIds: v.array(v.id("agent_credentials")),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? DEFAULT_BATCH;
		checkBatch(batchSize);
		const page = await ctx.db
			.query("agent_credentials")
			.paginate({ numItems: batchSize, cursor: args.cursor });

		let updated = 0;
		let alreadySet = 0;
		let missingAgent = 0;
		let ambiguous = 0;
		const missingAgentIds: Id<"agent_credentials">[] = [];
		const ambiguousIds: Id<"agent_credentials">[] = [];
		for (const row of page.page) {
			if (row.agentId !== undefined) {
				alreadySet += 1;
				continue;
			}
			// The label recorded at mint time, exact: two candidates is ambiguous,
			// none is missing. Neither is patched.
			const candidates = await ctx.db
				.query("agents")
				.withIndex("by_org_name", (q) =>
					q.eq("orgSlug", row.orgSlug).eq("name", row.agentName),
				)
				.take(2);
			if (candidates.length === 0) {
				missingAgent += 1;
				missingAgentIds.push(row._id);
				continue;
			}
			if (candidates.length > 1) {
				ambiguous += 1;
				ambiguousIds.push(row._id);
				continue;
			}
			updated += 1;
			if (!args.dryRun) {
				await ctx.db.patch(row._id, { agentId: candidates[0]._id });
			}
		}
		return {
			dryRun: args.dryRun,
			scanned: page.page.length,
			updated,
			alreadySet,
			missingAgent,
			ambiguous,
			missingAgentIds,
			ambiguousIds,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

/**
 * Stamps `agentId` / `agentOrgId` on seat access tokens minted before the stamp
 * existed (oauth_access_tokens). Same shape and guarantees as the credential
 * backfill above: dry-run first, cursor-paged, idempotent, REFUSES NEVER GUESSES.
 * The agent is resolved by the same rule as at mint (convex/lib/seatAgent.ts:
 * the profile's single agent, in the profile's own org). A live (unrevoked,
 * unexpired) row that resolves to none is an org-level seat: it is COUNTED and
 * LISTED BY ID in `undecidableIds`, never patched. Revoked and expired rows are
 * skipped (`skipped`): they no longer authenticate.
 *
 *   npx convex run migrations/agentIdentityRows:backfillSeatTokenAgentIds \
 *     '{"dryRun":true,"cursor":null}'
 */
export const backfillSeatTokenAgentIds = internalMutation({
	args: {
		dryRun: v.boolean(),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		updated: v.number(),
		alreadySet: v.number(),
		skipped: v.number(),
		undecidable: v.number(),
		undecidableIds: v.array(v.id("oauth_access_tokens")),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? DEFAULT_BATCH;
		checkBatch(batchSize);
		const page = await ctx.db
			.query("oauth_access_tokens")
			.paginate({ numItems: batchSize, cursor: args.cursor });
		const now = Date.now();

		let updated = 0;
		let alreadySet = 0;
		let skipped = 0;
		const undecidableIds: Id<"oauth_access_tokens">[] = [];
		for (const row of page.page) {
			if (row.agentId !== undefined) {
				alreadySet += 1;
				continue;
			}
			if (
				row.revokedAt !== undefined ||
				row.expiresAt < now ||
				row.principal !== undefined
			) {
				skipped += 1;
				continue;
			}
			const agent = await resolveSeatAgent(ctx, row);
			if (!agent) {
				undecidableIds.push(row._id);
				continue;
			}
			updated += 1;
			if (!args.dryRun) {
				await ctx.db.patch(row._id, {
					agentId: agent._id,
					agentOrgId: agent.orgSlug,
				});
			}
		}
		return {
			dryRun: args.dryRun,
			scanned: page.page.length,
			updated,
			alreadySet,
			skipped,
			undecidable: undecidableIds.length,
			undecidableIds,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});


// ─────────────────────────────────────────────────────────────────────────────
// Seat profiles bound by agent ID (operator ruling 2026-10-13)
// ─────────────────────────────────────────────────────────────────────────────

type LabelResolution =
	| { kind: "agent"; agent: Doc<"agents"> }
	| { kind: "not-found" }
	| { kind: "ambiguous" }
	| { kind: "inactive" }
	| { kind: "other-org" };

/**
 * The agent a stored display label names INSIDE ONE organisation, or why none.
 * Used by the migrations only: this is the single place where a stored label is
 * turned into an agent ID, once, and the ID is what is written. The label is read
 * from the profile row (never from a caller), the lookup is confined to the
 * profile's own organisation, and the agent's org is confirmed by org ID through
 * @vantageos/cloud-identity `sameOrg`; a same-named agent of another org is never
 * a candidate. Two candidates are ambiguous, never picked between.
 */
// allow-local-identity: the one place a stored display label becomes an agent ID, once, inside the profile's own org, for the migrations in this file; it admits no caller and every later decision follows the ID it returns
async function resolveLabelInProfileOrg(
	ctx: MutationCtx,
	profile: Doc<"oauth_scope_profiles">,
	label: string,
): Promise<LabelResolution> {
	const orgSlug = profile.clerkOrgSlug;
	if (orgSlug === undefined) return { kind: "not-found" };
	const normalized = normalizeOrchestratorId(label);
	const byNormalized = await ctx.db
		.query("agents")
		.withIndex("by_org_normalized_name", (q) =>
			q.eq("orgSlug", orgSlug).eq("normalizedName", normalized),
		)
		.take(3);
	const byExact =
		byNormalized.length > 0
			? []
			: await ctx.db
					.query("agents")
					.withIndex("by_org_name", (q) =>
						q.eq("orgSlug", orgSlug).eq("name", label),
					)
					.take(3);
	// The index is a shortcut, the label is the truth: a stale normalizedName
	// must not name the wrong agent.
	const candidates = [...byNormalized, ...byExact].filter(
		(row) => normalizeOrchestratorId(row.name) === normalized,
	);
	if (candidates.length === 0) return { kind: "not-found" };
	if (candidates.length > 1) return { kind: "ambiguous" };
	const agent = candidates[0];
	if (!agent.isActive) return { kind: "inactive" };
	const sameOrg = await sameOrgStamp(
		ctx,
		{ id: agent.clerkOrgId, label: agent.orgSlug },
		{ id: profile.clerkOrgId, label: profile.clerkOrgSlug },
	);
	return sameOrg ? { kind: "agent", agent } : { kind: "other-org" };
}

const bindReason = v.union(
	v.literal("profile-id-mismatch"),
	v.literal("agent-not-found"),
	v.literal("agent-ambiguous"),
	v.literal("agent-inactive"),
	v.literal("agent-other-org"),
);

/**
 * Binds `agentId` (and `fromAllowListAgentIds`) onto every ONE-AGENT SEAT
 * profile whose single label resolved to its agent before the label branch of
 * resolveSeatAgent was deleted, so no currently-working seat breaks.
 *
 * "Resolved before" is exactly the deleted rule: the profile's single allowlisted
 * label, inside the profile's own organisation, with the profile id following
 * `<agent>-<org>` (compared in normalised form), naming one ACTIVE agent of that
 * organisation. Anything else is NOT bound and is listed in `unbound` with the
 * reason, for the operator to bind by hand (oauth:bindScopeProfileAgent) or to
 * fix. A profile that is not a one-agent seat (several entries, none, the
 * wildcard, no organisation) is `notSeat`: it is org-level by data and needs no
 * agent.
 *
 * Same shape and guarantees as the sibling backfills: dry-run first,
 * cursor-paged, IDEMPOTENT (a profile that already carries an `agentId` is
 * counted, never rewritten), REFUSES NEVER GUESSES.
 */
// allow-local-identity: one-off migration that turns the single label a seat profile stored into the agent ID, once, inside the profile's own org; it admits no caller and every later decision follows the ID it writes
export const bindSeatProfileAgentIds = internalMutation({
	args: {
		dryRun: v.boolean(),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		updated: v.number(),
		alreadyBound: v.number(),
		notSeat: v.number(),
		unbound: v.array(v.object({ profileId: v.string(), reason: bindReason })),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? DEFAULT_BATCH;
		checkBatch(batchSize);
		const page = await ctx.db
			.query("oauth_scope_profiles")
			.paginate({ numItems: batchSize, cursor: args.cursor });

		let updated = 0;
		let alreadyBound = 0;
		let notSeat = 0;
		const unbound: Array<{
			profileId: string;
			reason:
				| "profile-id-mismatch"
				| "agent-not-found"
				| "agent-ambiguous"
				| "agent-inactive"
				| "agent-other-org";
		}> = [];
		for (const profile of page.page) {
			if (profile.agentId !== undefined) {
				alreadyBound += 1;
				continue;
			}
			if (!isOneAgentSeatShape(profile)) {
				notSeat += 1;
				continue;
			}
			const label = profile.fromAllowList[0];
			const orgSlug = profile.clerkOrgSlug;
			// The id convention `<agent>-<org>` the deleted label branch required.
			if (
				orgSlug === undefined ||
				normalizeOrchestratorId(profile.profileId) !==
					normalizeOrchestratorId(`${label}-${orgSlug}`)
			) {
				unbound.push({ profileId: profile.profileId, reason: "profile-id-mismatch" });
				continue;
			}
			const found = await resolveLabelInProfileOrg(ctx, profile, label);
			if (found.kind !== "agent") {
				unbound.push({
					profileId: profile.profileId,
					reason:
						found.kind === "not-found"
							? "agent-not-found"
							: found.kind === "ambiguous"
								? "agent-ambiguous"
								: found.kind === "inactive"
									? "agent-inactive"
									: "agent-other-org",
				});
				continue;
			}
			// The same refusal oauth:bindScopeProfileAgent applies (one-agent seat,
			// active agent, same organisation by ID).
			const refusal = await seatBindingRefusal(ctx, profile, found.agent);
			if (refusal !== null) {
				unbound.push({
					profileId: profile.profileId,
					reason: refusal === "AGENT_INACTIVE" ? "agent-inactive" : "agent-other-org",
				});
				continue;
			}
			updated += 1;
			if (!args.dryRun) {
				await ctx.db.patch(profile._id, {
					agentId: found.agent._id,
					fromAllowListAgentIds: [found.agent._id],
					updatedAt: Date.now(),
				});
			}
		}
		return {
			dryRun: args.dryRun,
			scanned: page.page.length,
			updated,
			alreadyBound,
			notSeat,
			unbound,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

/**
 * Fills `fromAllowListAgentIds` on org-bound scope profiles: the IDs of the
 * agents their display labels name, each resolved INSIDE THE PROFILE'S OWN ORG.
 * A profile is listed only when EVERY label resolves to one active agent of that
 * org; one label that does not (missing, ambiguous, retired, another org's) leaves
 * the profile unlisted and is reported in `unresolved` with the labels that
 * failed, so a half-resolved list is never written. A bound seat is listed as its
 * bound agent. A wildcard, an empty list and a profile with no organisation name
 * no agent (`notListed`). Dry-run first, cursor-paged, IDEMPOTENT.
 */
// allow-local-identity: one-off migration that reads the labels a profile stored to turn them into agent IDs, once, inside the profile's own org; it admits no caller and every later decision follows the IDs it writes
export const backfillProfileAgentIdLists = internalMutation({
	args: {
		dryRun: v.boolean(),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		updated: v.number(),
		alreadySet: v.number(),
		notListed: v.number(),
		unresolved: v.array(
			v.object({ profileId: v.string(), labels: v.array(v.string()) }),
		),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? DEFAULT_BATCH;
		checkBatch(batchSize);
		const page = await ctx.db
			.query("oauth_scope_profiles")
			.paginate({ numItems: batchSize, cursor: args.cursor });

		let updated = 0;
		let alreadySet = 0;
		let notListed = 0;
		const unresolved: Array<{ profileId: string; labels: string[] }> = [];
		for (const profile of page.page) {
			if (profile.fromAllowListAgentIds !== undefined) {
				alreadySet += 1;
				continue;
			}
			const hasOrg =
				profile.clerkOrgSlug !== undefined || profile.clerkOrgId !== undefined;
			const labels = profile.fromAllowList;
			if (!hasOrg || labels.length === 0 || labels.some((l) => l.trim() === "*")) {
				notListed += 1;
				continue;
			}
			const ids: Id<"agents">[] = [];
			const failed: string[] = [];
			if (profile.agentId !== undefined) {
				const bound = await ctx.db.get(profile.agentId);
				const inOrg =
					bound !== null &&
					bound.isActive &&
					(await sameOrgStamp(
						ctx,
						{ id: bound.clerkOrgId, label: bound.orgSlug },
						{ id: profile.clerkOrgId, label: profile.clerkOrgSlug },
					));
				if (inOrg && bound !== null) ids.push(bound._id);
				else failed.push(...labels);
			} else {
				for (const label of labels) {
					const found = await resolveLabelInProfileOrg(ctx, profile, label);
					if (found.kind === "agent") {
						if (!ids.includes(found.agent._id)) ids.push(found.agent._id);
					} else {
						failed.push(label);
					}
				}
			}
			if (failed.length > 0) {
				unresolved.push({ profileId: profile.profileId, labels: failed });
				continue;
			}
			updated += 1;
			if (!args.dryRun) {
				await ctx.db.patch(profile._id, {
					fromAllowListAgentIds: ids,
					updatedAt: Date.now(),
				});
			}
		}
		return {
			dryRun: args.dryRun,
			scanned: page.page.length,
			updated,
			alreadySet,
			notListed,
			unresolved,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

/**
 * Copies a scope profile's agent IDs onto its LIVE access tokens that carry none
 * (oauth_access_tokens.fromAllowListAgentIds), as a mint would have stamped them.
 * The IDs are the profile's, re-read live (an inactive agent or another org's is
 * dropped), and are copied only when the token's own org is the profile's org.
 * Revoked, expired and person tokens are `skipped`; a token whose profile lists
 * no IDs yet is `noProfileIds`; a token whose org is not its profile's is
 * `orgMismatch`. Dry-run first, cursor-paged, IDEMPOTENT.
 */
export const backfillTokenAgentIdLists = internalMutation({
	args: {
		dryRun: v.boolean(),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		updated: v.number(),
		alreadySet: v.number(),
		skipped: v.number(),
		noProfileIds: v.number(),
		orgMismatch: v.number(),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? DEFAULT_BATCH;
		checkBatch(batchSize);
		const page = await ctx.db
			.query("oauth_access_tokens")
			.paginate({ numItems: batchSize, cursor: args.cursor });
		const now = Date.now();

		let updated = 0;
		let alreadySet = 0;
		let skipped = 0;
		let noProfileIds = 0;
		let orgMismatch = 0;
		for (const row of page.page) {
			if (row.fromAllowListAgentIds !== undefined) {
				alreadySet += 1;
				continue;
			}
			if (
				row.revokedAt !== undefined ||
				row.expiresAt < now ||
				row.principal !== undefined
			) {
				skipped += 1;
				continue;
			}
			const profile = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", row.scopeProfile))
				.unique();
			if (profile === null || profile.fromAllowListAgentIds === undefined) {
				noProfileIds += 1;
				continue;
			}
			const sameOrg = await sameOrgStamp(
				ctx,
				{ id: profile.clerkOrgId, label: profile.clerkOrgSlug },
				{ id: row.clerkOrgId, label: row.clerkOrgSlug },
			);
			if (!sameOrg) {
				orgMismatch += 1;
				continue;
			}
			const ids = await liveProfileAgentIds(ctx, profile);
			if (ids === undefined) {
				noProfileIds += 1;
				continue;
			}
			updated += 1;
			if (!args.dryRun) {
				await ctx.db.patch(row._id, { fromAllowListAgentIds: ids });
			}
		}
		return {
			dryRun: args.dryRun,
			scanned: page.page.length,
			updated,
			alreadySet,
			skipped,
			noProfileIds,
			orgMismatch,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});
