// seat_profile_agent_namespace -- one-shot update of the EXISTING seat scope
// profiles after a seat's orchestrator namespace became `orchestrator/<agent ID>`
// (task k1701vj2gxbacdjqr1avpxx7en8hdw2q, Pi ruling on #1652).
//
// Convex admits a seat to `orchestrator/<its verified agents-row ID>` only. The MCP
// checks the typed namespace against the seat's scope-profile prefixes BEFORE the
// call reaches Convex, so a profile that lists only `orchestrator/<name>` has the
// new namespace refused at the MCP. This appends `orchestrator/<agentId>` to the
// read and write prefixes of each client-bound seat profile.
//
// A PROFILE IS UPDATED ONLY WHEN ALL HOLD:
//   - it is bound to a client org (`clerkOrgSlug` set) that is not the operator's;
//   - its `fromAllowList` holds exactly ONE entry and it is not a wildcard;
//   - that entry resolves, by the repo's one name resolver (`resolveName`,
//     backfill_actor_ids) in the profile's OWN org, to exactly ONE agents row that
//     is active.
// Anything else is skipped and counted by reason; nothing is guessed. The old
// `orchestrator/<name>` prefix is left in place (an append, never a removal).
//
// SHAPE. Caller-walked, cursor-paginated, DRY RUN BY DEFAULT (`dryRun: false`
// writes). Idempotent: a profile that already lists the prefix is `alreadyDone`.
// Every write appends an `oauth_audit_log` row with before/after. Tokens already
// minted snapshot their prefixes at issue time: a seat picks the new prefix up at
// its next token mint or refresh.
//
//   migrations/seat_profile_agent_namespace:run                    (dry run)
//   migrations/seat_profile_agent_namespace:run {"dryRun": false}
//   -> pass {"cursor": <nextCursor>} until isDone.
//
// Internal: reachable only with the deployment admin credential.

import { sameOrg } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { fleetOperatorRef } from "../lib/operatorOrg";
import { loadResolver, resolveName } from "./backfill_actor_ids";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const SAMPLE_PROFILES = 3;

type Skip =
	| "notClientBound"
	| "operatorOrg"
	| "notExactlyOneSeat"
	| "noAgentInOrg"
	| "ambiguousAgent"
	| "agentNotUsable";

const skipValidator = v.object({
	notClientBound: v.number(),
	operatorOrg: v.number(),
	notExactlyOneSeat: v.number(),
	noAgentInOrg: v.number(),
	ambiguousAgent: v.number(),
	agentNotUsable: v.number(),
});

export const run = internalMutation({
	args: {
		dryRun: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		examined: v.number(),
		alreadyDone: v.number(),
		toUpdate: v.number(),
		updated: v.number(),
		skipped: skipValidator,
		orgs: v.array(
			v.object({
				slug: v.string(),
				toUpdate: v.number(),
				updated: v.number(),
				sampleProfileIds: v.array(v.string()),
			}),
		),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
		if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
			throw new ConvexError(
				`seat_profile_agent_namespace: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const resolver = await loadResolver(ctx.db);
		const operator = await fleetOperatorRef(ctx.db);
		const page = await ctx.db
			.query("oauth_scope_profiles")
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		const skipped = {
			notClientBound: 0,
			operatorOrg: 0,
			notExactlyOneSeat: 0,
			noAgentInOrg: 0,
			ambiguousAgent: 0,
			agentNotUsable: 0,
		};
		const bySlug = new Map<
			string,
			{ slug: string; toUpdate: number; updated: number; sampleProfileIds: string[] }
		>();
		let alreadyDone = 0;
		let toUpdate = 0;
		let updated = 0;
		const now = Date.now();
		for (const profile of page.page) {
			const slug = profile.clerkOrgSlug ?? "";
			const [seat] = profile.fromAllowList;
			if (profile.clerkOrgSlug === undefined) {
				skipped.notClientBound++;
				continue;
			}
			if (profile.fromAllowList.length !== 1 || seat === undefined || seat === "*") {
				skipped.notExactlyOneSeat++;
				continue;
			}
			const found = resolveName(resolver, slug, seat);
			if ("reason" in found) {
				if (found.reason === "ambiguousAgent") skipped.ambiguousAgent++;
				else skipped.noAgentInOrg++;
				continue;
			}
			const agentRowId = ctx.db.normalizeId("agents", found.id);
			const agent = agentRowId === null ? null : await ctx.db.get(agentRowId);
			if (agent === null || !agent.isActive || agent.clerkOrgId === undefined) {
				skipped.agentNotUsable++;
				continue;
			}
			if (operator === undefined || sameOrg({ id: agent.clerkOrgId }, operator)) {
				skipped.operatorOrg++;
				continue;
			}
			const verdict = { agentId: agent._id, slug };
			const prefix = `orchestrator/${verdict.agentId}`;
			const hasRead = profile.namespaceReadPrefixes.includes(prefix);
			const hasWrite = profile.namespaceWritePrefixes.includes(prefix);
			if (hasRead && hasWrite) {
				alreadyDone++;
				continue;
			}
			toUpdate++;
			const entry = bySlug.get(verdict.slug) ?? {
				slug: verdict.slug,
				toUpdate: 0,
				updated: 0,
				sampleProfileIds: [],
			};
			entry.toUpdate++;
			if (entry.sampleProfileIds.length < SAMPLE_PROFILES) {
				entry.sampleProfileIds.push(profile.profileId);
			}
			if (!dryRun) {
				const read = hasRead ? profile.namespaceReadPrefixes : [...profile.namespaceReadPrefixes, prefix];
				const write = hasWrite ? profile.namespaceWritePrefixes : [...profile.namespaceWritePrefixes, prefix];
				await ctx.db.patch(profile._id, {
					namespaceReadPrefixes: read,
					namespaceWritePrefixes: write,
					updatedAt: now,
				});
				await ctx.db.insert("oauth_audit_log", {
					eventType: "seat_profile_agent_namespace",
					actorTokenHash: "internal:migrations/seat_profile_agent_namespace",
					targetProfileId: profile.profileId,
					previousState: {
						profileId: profile.profileId,
						fromAllowList: profile.fromAllowList,
						namespaceReadPrefixes: profile.namespaceReadPrefixes,
						namespaceWritePrefixes: profile.namespaceWritePrefixes,
					},
					newState: {
						profileId: profile.profileId,
						fromAllowList: profile.fromAllowList,
						namespaceReadPrefixes: read,
						namespaceWritePrefixes: write,
					},
					reason: `seat_profile_agent_namespace: appended ${prefix}`,
					cascadeRevokedCount: 0,
					clientsRetargeted: 0,
					createdAt: now,
				});
				updated++;
				entry.updated++;
			}
			bySlug.set(verdict.slug, entry);
		}
		console.log(
			`seat_profile_agent_namespace ${dryRun ? "DRY RUN" : "WRITE"}: examined=${page.page.length} alreadyDone=${alreadyDone} toUpdate=${toUpdate} updated=${updated}`,
		);
		return {
			dryRun,
			examined: page.page.length,
			alreadyDone,
			toUpdate,
			updated,
			skipped,
			orgs: [...bySlug.values()],
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
