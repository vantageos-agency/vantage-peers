// backfill_seat_memory_org_stamp -- stamps `memories.clerkOrgId` on the rows a client
// SEAT filed in its own `project/<slug>` namespace before #1640, when the MCP
// reached Convex as the fleet service account and Convex stamped such a row from
// its namespace only: a `project/` namespace names no team label, so the row was
// stamped NOTHING and no member read (`memoryVisibleToScope`, which judges the org
// ID alone) serves it back to the seat. Task k1703qfycdce9dj7hc1dn28nsh8hd5qj.
//
// WHAT IS STAMPED. A row is stamped ONLY when ALL hold:
//   - it has no `clerkOrgId` and lives in `project/<slug>` (a sub-namespace too);
//   - the creator (`createdBy`, the seat label the MCP recorded for a master-path
//     write) is an agents row of the organisation `<slug>` names, resolved by the
//     repo's one name resolver (`resolveName`, backfill_actor_ids), and that agent is
//     active and carries its organisation's permanent ID;
//   - that organisation is not the operator's (fleet rows stay fleet rows).
// The stamp is the CREATOR's own organisation ID, never a value derived from the
// namespace. The namespace alone NEVER decides: a row by a fleet agent, by another
// org's agent, by a person ("user:..."), or by a name no agent of the org carries
// is left as it is and counted by reason. Only `clerkOrgId` is written: it is the
// one tenant field the memory read path checks (convex/lib/memoryTenant.ts).
//
// SHAPE. Caller-walked, cursor-paginated, one page per execution, over the
// `by_namespace` range of `project/`. DRY RUN BY DEFAULT (`dryRun: false` writes).
// Idempotent: a stamped row is counted `alreadyFilled` and never rewritten, so a
// second run stamps 0. Batched by `pageSize`.
//
//   migrations/backfill_seat_memory_org_stamp:inventory   (read-only, per org)
//   migrations/backfill_seat_memory_org_stamp:run         (dry run, then dryRun:false)
//   -> pass {"cursor": <nextCursor>} until isDone.
//
// Internal: reachable only with the deployment admin credential, so no per-caller
// auth check exists here by design. No content is ever returned: ids and counts.

import { type OrgRef, sameOrg } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { isHumanActorName } from "../lib/humanActor";
import { fleetOperatorRef } from "../lib/operatorOrg";
import {
	loadResolver,
	type Resolver,
	resolveName,
} from "./backfill_actor_ids";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const SAMPLE_IDS = 3;
const PROJECT_FROM = "project/";
const PROJECT_TO = "project0";

type Skip =
	| "operatorOrg"
	| "orgNotStampable"
	| "notSeat"
	| "creatorNotInOrg"
	| "creatorAmbiguous";

type Verdict = { stamp: string; slug: string } | { skip: Skip; slug: string };

function pageSizeOf(raw: number | undefined, door: string): number {
	const pageSize = raw ?? DEFAULT_PAGE_SIZE;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
		throw new ConvexError(
			`${door}: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
		);
	}
	return pageSize;
}

function slugOf(namespace: string): string {
	return namespace.split("/")[1] ?? "";
}

async function verdictOf(
	ctx: { db: DatabaseReader },
	row: Doc<"memories">,
	resolver: Resolver,
	operator: OrgRef | undefined,
): Promise<Verdict> {
	const slug = slugOf(row.namespace);
	if (isHumanActorName(row.createdBy)) return { skip: "notSeat", slug };
	const creator = resolveName(resolver, slug, row.createdBy);
	if ("reason" in creator) {
		return {
			skip: creator.reason === "ambiguousAgent" ? "creatorAmbiguous" : "creatorNotInOrg",
			slug,
		};
	}
	const agentId = ctx.db.normalizeId("agents", creator.id);
	const agent = agentId === null ? null : await ctx.db.get(agentId);
	if (agent === null || !agent.isActive || agent.clerkOrgId === undefined) {
		return { skip: "orgNotStampable", slug };
	}
	if (operator === undefined || sameOrg({ id: agent.clerkOrgId }, operator)) {
		return { skip: "operatorOrg", slug };
	}
	return { stamp: agent.clerkOrgId, slug };
}

const skipCountsValidator = v.object({
	operatorOrg: v.number(),
	orgNotStampable: v.number(),
	notSeat: v.number(),
	creatorNotInOrg: v.number(),
	creatorAmbiguous: v.number(),
});

const emptySkips = () => ({
	operatorOrg: 0,
	orgNotStampable: 0,
	notSeat: 0,
	creatorNotInOrg: 0,
	creatorAmbiguous: 0,
});

// READ-ONLY. Per organisation slug, for one page of the `project/` range: the
// unstamped rows (count, three sample ids) and how many of them the backfill would
// stamp. Sum the pages. No content, no creator labels.
export const inventory = internalQuery({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		examined: v.number(),
		alreadyStamped: v.number(),
		orgs: v.array(
			v.object({
				slug: v.string(),
				unstamped: v.number(),
				wouldStamp: v.number(),
				sampleIds: v.array(v.id("memories")),
			}),
		),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const pageSize = pageSizeOf(args.pageSize, "backfill_seat_memory_org_stamp:inventory");
		const resolver = await loadResolver(ctx.db);
		const operator = await fleetOperatorRef(ctx.db);
		const page = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.gte("namespace", PROJECT_FROM).lt("namespace", PROJECT_TO),
			)
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });
		let alreadyStamped = 0;
		const bySlug = new Map<
			string,
			{ slug: string; unstamped: number; wouldStamp: number; sampleIds: Doc<"memories">["_id"][] }
		>();
		for (const row of page.page) {
			if (row.clerkOrgId !== undefined) {
				alreadyStamped++;
				continue;
			}
			const verdict = await verdictOf(ctx, row, resolver, operator);
			const entry = bySlug.get(verdict.slug) ?? {
				slug: verdict.slug,
				unstamped: 0,
				wouldStamp: 0,
				sampleIds: [],
			};
			entry.unstamped++;
			if ("stamp" in verdict) entry.wouldStamp++;
			if (entry.sampleIds.length < SAMPLE_IDS) entry.sampleIds.push(row._id);
			bySlug.set(verdict.slug, entry);
		}
		return {
			examined: page.page.length,
			alreadyStamped,
			orgs: [...bySlug.values()],
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
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
		alreadyFilled: v.number(),
		toFill: v.number(),
		filled: v.number(),
		skipped: skipCountsValidator,
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const pageSize = pageSizeOf(args.pageSize, "backfill_seat_memory_org_stamp:run");
		const resolver = await loadResolver(ctx.db);
		const operator = await fleetOperatorRef(ctx.db);
		const page = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.gte("namespace", PROJECT_FROM).lt("namespace", PROJECT_TO),
			)
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		let alreadyFilled = 0;
		let toFill = 0;
		let filled = 0;
		const skipped = emptySkips();
		for (const row of page.page) {
			if (row.clerkOrgId !== undefined) {
				alreadyFilled++;
				continue;
			}
			const verdict = await verdictOf(ctx, row, resolver, operator);
			if ("skip" in verdict) {
				skipped[verdict.skip]++;
				continue;
			}
			toFill++;
			if (!dryRun) {
				await ctx.db.patch(row._id, { clerkOrgId: verdict.stamp });
				filled++;
			}
		}
		console.log(
			`backfill_seat_memory_org_stamp ${dryRun ? "DRY RUN" : "WRITE"}: examined=${page.page.length} alreadyFilled=${alreadyFilled} toFill=${toFill} filled=${filled}`,
		);
		return {
			dryRun,
			examined: page.page.length,
			alreadyFilled,
			toFill,
			filled,
			skipped,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
