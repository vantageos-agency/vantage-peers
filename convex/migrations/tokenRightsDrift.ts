// tokenRightsDrift -- what the request-time rights derivation changes for the LIVE
// access tokens, and the one explicit marker it needs. Task k17dhntq3m2w5x3x1jtdmkkba18hek7m.
//
// Since this delivery `oauth:getAccessTokenByHash` no longer returns the rights copied
// onto a token at mint: it derives them from the live scope profile row (a person
// token: the live organisation mapping), intersected with the copy only for a token
// whose mint narrowed it (`rightsPinned`). Nothing needs re-deriving per token, since
// the derivation runs on every request. These two doors make the effect LISTABLE and
// the one marker REVERSIBLE:
//
//   migrations/tokenRightsDrift:inventory      (read-only, one page per call)
//       per LIVE token: does the derived grant differ from the copy? Counts by
//       class, and the ids of the rows whose grant changes, with what is gained
//       and lost. Pass {"cursor": <nextCursor>} until isDone.
//   migrations/tokenRightsDrift:stampPinned    (dry run by default; dryRun:false writes)
//       legacy operator mints (`clientId` `admin-mint:...`, no marker) get the explicit
//       `rightsPinned: true` they are already READ as, so the rule is data, not a name
//       prefix. Idempotent: a marked row is counted alreadyMarked.
//   migrations/tokenRightsDrift:revertPinned   (rollback by the ids stampPinned returned)
//
// Internal: reachable only with the deployment admin credential. No token hash, secret
// or content is returned: ids, profile names and prefix strings.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { lookupOrgMapping } from "../lib/auth";
import {
	isRightsPinned,
	personTokenRights,
	profileTokenRights,
	type TokenRights,
} from "../lib/tokenRights";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_REVERT_IDS = 200;

function pageSizeOf(raw: number | undefined, door: string): number {
	const pageSize = raw ?? DEFAULT_PAGE_SIZE;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
		throw new ConvexError(
			`${door}: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
		);
	}
	return pageSize;
}

function delta(copy: string[], derived: string[]): { gained: string[]; lost: string[] } {
	return {
		gained: derived.filter((x) => !copy.includes(x)),
		lost: copy.filter((x) => !derived.includes(x)),
	};
}

const changeValidator = v.object({
	id: v.id("oauth_access_tokens"),
	scopeProfile: v.string(),
	kind: v.union(
		v.literal("changes"),
		v.literal("denied"),
	),
	readGained: v.array(v.string()),
	readLost: v.array(v.string()),
	writeGained: v.array(v.string()),
	writeLost: v.array(v.string()),
	fromGained: v.array(v.string()),
	fromLost: v.array(v.string()),
});

export const inventory = internalQuery({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		scanned: v.number(),
		live: v.number(),
		unchanged: v.number(),
		pinned: v.number(),
		changes: v.number(),
		denied: v.number(),
		changed: v.array(changeValidator),
		nextCursor: v.union(v.string(), v.null()),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const page = await ctx.db.query("oauth_access_tokens").paginate({
			cursor: args.cursor ?? null,
			numItems: pageSizeOf(args.pageSize, "tokenRightsDrift:inventory"),
		});
		const now = Date.now();
		let live = 0;
		let unchanged = 0;
		let pinned = 0;
		let denied = 0;
		const changed: Array<typeof changeValidator.type> = [];
		for (const row of page.page) {
			if (row.revokedAt !== undefined || row.expiresAt < now) continue;
			live++;
			let rights: TokenRights | null;
			if (row.principal === "person") {
				const mapping =
					row.clerkOrgId === undefined
						? null
						: await lookupOrgMapping(ctx, { clerkOrgId: row.clerkOrgId });
				rights = mapping !== null && mapping.isActive ? personTokenRights(mapping) : null;
			} else {
				if (isRightsPinned(row)) pinned++;
				const profile = await ctx.db
					.query("oauth_scope_profiles")
					.withIndex("by_profileId", (q) => q.eq("profileId", row.scopeProfile))
					.unique();
				rights = profileTokenRights(row, profile);
			}
			if (rights === null) {
				denied++;
				changed.push({
					id: row._id,
					scopeProfile: row.scopeProfile,
					kind: "denied",
					readGained: [],
					readLost: row.namespaceReadPrefixes,
					writeGained: [],
					writeLost: row.namespaceWritePrefixes,
					fromGained: [],
					fromLost: row.fromAllowList,
				});
				continue;
			}
			const r = delta(row.namespaceReadPrefixes, rights.namespaceReadPrefixes);
			const w = delta(row.namespaceWritePrefixes, rights.namespaceWritePrefixes);
			const f = delta(row.fromAllowList, rights.fromAllowList);
			if (
				r.gained.length + r.lost.length + w.gained.length + w.lost.length + f.gained.length + f.lost.length ===
				0
			) {
				unchanged++;
				continue;
			}
			changed.push({
				id: row._id,
				scopeProfile: row.scopeProfile,
				kind: "changes",
				readGained: r.gained,
				readLost: r.lost,
				writeGained: w.gained,
				writeLost: w.lost,
				fromGained: f.gained,
				fromLost: f.lost,
			});
		}
		return {
			scanned: page.page.length,
			live,
			unchanged,
			pinned,
			changes: changed.filter((c) => c.kind === "changes").length,
			denied,
			changed,
			nextCursor: page.isDone ? null : page.continueCursor,
			isDone: page.isDone,
		};
	},
});

export const stampPinned = internalMutation({
	args: {
		dryRun: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		wouldMark: v.number(),
		marked: v.number(),
		alreadyMarked: v.number(),
		ids: v.array(v.id("oauth_access_tokens")),
		nextCursor: v.union(v.string(), v.null()),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun ?? true;
		const page = await ctx.db.query("oauth_access_tokens").paginate({
			cursor: args.cursor ?? null,
			numItems: pageSizeOf(args.pageSize, "tokenRightsDrift:stampPinned"),
		});
		const ids: Id<"oauth_access_tokens">[] = [];
		let alreadyMarked = 0;
		for (const row of page.page) {
			if (!row.clientId.startsWith("admin-mint:")) continue;
			if (row.rightsPinned !== undefined) {
				alreadyMarked++;
				continue;
			}
			ids.push(row._id);
			if (!dryRun) await ctx.db.patch(row._id, { rightsPinned: true });
		}
		return {
			dryRun,
			scanned: page.page.length,
			wouldMark: dryRun ? ids.length : 0,
			marked: dryRun ? 0 : ids.length,
			alreadyMarked,
			ids,
			nextCursor: page.isDone ? null : page.continueCursor,
			isDone: page.isDone,
		};
	},
});

export const revertPinned = internalMutation({
	args: { ids: v.array(v.id("oauth_access_tokens")), dryRun: v.optional(v.boolean()) },
	returns: v.object({
		dryRun: v.boolean(),
		reverted: v.number(),
		skipped: v.number(),
	}),
	handler: async (ctx, args) => {
		if (args.ids.length > MAX_REVERT_IDS) {
			throw new ConvexError(
				`tokenRightsDrift:revertPinned: ${args.ids.length} ids is out of expected range 0-${MAX_REVERT_IDS}.`,
			);
		}
		const dryRun = args.dryRun ?? true;
		let reverted = 0;
		let skipped = 0;
		for (const id of args.ids) {
			const row: Doc<"oauth_access_tokens"> | null = await ctx.db.get(id);
			// Only a row this migration marked: an admin-mint client with the marker set.
			if (row === null || row.rightsPinned !== true || !row.clientId.startsWith("admin-mint:")) {
				skipped++;
				continue;
			}
			reverted++;
			if (!dryRun) await ctx.db.patch(id, { rightsPinned: undefined });
		}
		return { dryRun, reverted, skipped };
	},
});
