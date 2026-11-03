// authorBackfill -- READ-ONLY coverage (`count`) of the rows written BEFORE the author ID
// was stored, on every table the erase mechanism (convex/lib/eraseRow.ts) covers with an
// author. Task k175zndttv4brzgwj529qgsr1h8hha22.
//
// Why. erase:eraseRow lets an author erase the rows it wrote, judged on the STORED author ID
// (`createdById`, `fromId`). A row written before that column existed has no ID, so it is an
// organisation admin's alone. This instrument says, per table, how many such rows an
// agent label could be tied to exactly one agent of the row's own organisation (what a
// stamp may write) and how many cannot be.
//
// TABLES. Derived from `ERASE_COVERED` (convex/lib/eraseRow.ts): every covered table whose
// policy names BOTH an `authorField` and a `labelField`. Nothing is typed here, so a table
// that gains an author policy is counted the day it does.
//
// CLASSES of a row WITHOUT an author ID (disjoint; they sum to `withoutAuthorId`):
//   personLabelled  the label is a person actor name (`user:<subject>`): the erase rule
//                   already reads it as the author, nothing to stamp;
//   resolvable      the row's org ID plus its label name EXACTLY ONE active agent of that
//                   organisation (candidates from the fleet table of backfill_actor_ids,
//                   each re-read by ID and kept only if active and stamped with the row's
//                   org ID);
//   ambiguous       more than one such active agent carries the label;
//   unresolvable    no such agent, or the row carries no org ID or no label.
// The label is only ever looked up inside the row's OWN organisation (permanent ID, never
// the slug): a label that names an agent of another organisation matches nothing here.
//
// COUNTS ONLY: no row id, no label, no agent id leaves `count`.
//
// SHAPE. Internal (deployment-admin only), one page of one table per call (`table` required,
// as a prod deployment refuses several paginates in one query), cursor pagination.
//
//   bash .claude/scripts/convex-prod.sh run migrations/authorBackfill:count '{"table":"memories"}'
//   -> repeat with {"table":..., "cursor": <continueCursor>} until isDone is true; sum the pages.

import { isPersonActorName } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import type { Id } from "../_generated/dataModel";
import {
	type DatabaseReader,
	internalQuery,
	type QueryCtx,
} from "../_generated/server";
import { ERASE_COVERED, type ErasePolicy } from "../lib/eraseRow";
import { loadResolver, type Resolver } from "./backfill_actor_ids";

export type AuthoredTable = {
	table: string;
	orgField: string;
	authorField: string;
	labelField: string;
};

/** The covered tables that have an author, from the erase policy table. Never empty. */
export function authoredTables(
	covered: Record<string, ErasePolicy> = ERASE_COVERED,
): AuthoredTable[] {
	const out: AuthoredTable[] = [];
	for (const [table, p] of Object.entries(covered)) {
		if (p.authorField !== null && p.labelField !== null) {
			out.push({
				table,
				orgField: p.orgField,
				authorField: p.authorField,
				labelField: p.labelField,
			});
		}
	}
	if (out.length === 0) {
		throw new ConvexError(
			"authorBackfill: the erase policy yields no authored table; refusing to report an empty set as a clean one.",
		);
	}
	return out;
}

export type Verdict =
	| { kind: "hasAuthorId" }
	| { kind: "personLabelled" }
	| { kind: "resolvable"; agentId: Id<"agents"> }
	| { kind: "ambiguous" }
	| { kind: "unresolvable" };

type Row = Record<string, unknown>;

/**
 * The resolution of a run: the fleet's ONE name -> agent table (backfill_actor_ids
 * `loadResolver`, reused, not rewritten) plus a per-page memo. That table is keyed by org
 * SLUG, a renamable label, so no slug is ever believed: every candidate the label yields
 * (in any slug) is re-read BY ID and kept only when the agent row is ACTIVE and carries the
 * very org ID the row carries. Exactly one such agent is resolvable, several are ambiguous,
 * none is unresolvable. An agent row with no org ID can never be matched to a row's org.
 */
export type Resolution = {
	resolver: Resolver;
	memo: Map<string, Verdict>;
};

export async function loadResolution(db: DatabaseReader): Promise<Resolution> {
	return { resolver: await loadResolver(db), memo: new Map() };
}

async function resolveInOrg(
	ctx: Pick<QueryCtx, "db">,
	res: Resolution,
	orgId: string,
	label: string,
): Promise<Verdict> {
	const wanted = normalizeOrchestratorId(label);
	const active = new Set<Id<"agents">>();
	for (const byName of res.resolver.agentIds.values()) {
		for (const candidate of byName.get(wanted) ?? []) {
			const agentId = ctx.db.normalizeId("agents", candidate);
			const agent = agentId === null ? null : await ctx.db.get(agentId);
			if (agent !== null && agent.isActive && agent.clerkOrgId === orgId) {
				active.add(agent._id);
			}
		}
	}
	const [only] = [...active];
	if (active.size === 1 && only !== undefined) {
		return { kind: "resolvable", agentId: only };
	}
	return { kind: active.size === 0 ? "unresolvable" : "ambiguous" };
}

/** Judges one row; `res.memo` caches the (org, label) decisions of a page. */
export async function judgeRow(
	ctx: Pick<QueryCtx, "db">,
	t: AuthoredTable,
	row: Row,
	res: Resolution,
): Promise<Verdict> {
	const stored = row[t.authorField];
	if (typeof stored === "string" && stored !== "") return { kind: "hasAuthorId" };
	const label = row[t.labelField];
	if (typeof label !== "string" || label.length === 0) {
		return { kind: "unresolvable" };
	}
	if (isPersonActorName(label)) return { kind: "personLabelled" };
	const org = row[t.orgField];
	if (typeof org !== "string" || org === "") return { kind: "unresolvable" };
	const key = `${org}\u0000${label}`;
	let verdict = res.memo.get(key);
	if (verdict === undefined) {
		verdict = await resolveInOrg(ctx, res, org, label);
		res.memo.set(key, verdict);
	}
	return verdict;
}

export type Tally = {
	examined: number;
	withAuthorId: number;
	withoutAuthorId: number;
	resolvable: number;
	ambiguous: number;
	unresolvable: number;
	personLabelled: number;
};

export const emptyTally = (): Tally => ({
	examined: 0,
	withAuthorId: 0,
	withoutAuthorId: 0,
	resolvable: 0,
	ambiguous: 0,
	unresolvable: 0,
	personLabelled: 0,
});

export function tallyVerdict(tally: Tally, verdict: Verdict): void {
	tally.examined++;
	if (verdict.kind === "hasAuthorId") {
		tally.withAuthorId++;
		return;
	}
	tally.withoutAuthorId++;
	tally[verdict.kind]++;
}

export const tallyValidator = {
	examined: v.number(),
	withAuthorId: v.number(),
	withoutAuthorId: v.number(),
	resolvable: v.number(),
	ambiguous: v.number(),
	unresolvable: v.number(),
	personLabelled: v.number(),
};

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The authored table named by `table`, or a refusal naming the derived set. */
export function requireAuthoredTable(table: string, door: string): AuthoredTable {
	const derived = authoredTables();
	const found = derived.find((d) => d.table === table);
	if (found === undefined) {
		throw new ConvexError(
			`${door}: table = ${table} is not an authored erase table (${derived.map((d) => d.table).join(", ")}).`,
		);
	}
	return found;
}

export function requirePageSize(limit: number | undefined, door: string): number {
	const n = limit ?? DEFAULT_PAGE_SIZE;
	if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
		throw new ConvexError(
			`${door}: limit = ${n} is out of expected range 1-${MAX_PAGE_SIZE}.`,
		);
	}
	return n;
}

export const count = internalQuery({
	args: {
		table: v.string(),
		cursor: v.optional(v.union(v.string(), v.null())),
		limit: v.optional(v.number()),
	},
	returns: v.object({
		table: v.string(),
		...tallyValidator,
		isDone: v.boolean(),
		continueCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const door = "authorBackfill:count";
		const t = requireAuthoredTable(args.table, door);
		const limit = requirePageSize(args.limit, door);
		const page = await ctx.db
			.query(t.table as never)
			.paginate({ cursor: args.cursor ?? null, numItems: limit });
		const tally = emptyTally();
		const res = await loadResolution(ctx.db);
		for (const row of page.page as unknown as Row[]) {
			tallyVerdict(tally, await judgeRow(ctx, t, row, res));
		}
		return {
			table: t.table,
			...tally,
			isDone: page.isDone,
			continueCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
