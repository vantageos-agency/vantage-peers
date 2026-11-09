// fleetWriteStamp -- the fleet's unstamped rows: a NUMBERS-ONLY count, a backfill that
// gives them the operator organisation's permanent ID, and its reverse path. Task
// k176x68sj2jkwx46nshvtt40e18ht1xh.
//
// Why. A row written through the fleet-master seat used to carry no organisation, so
// `erase:eraseRow` refused it `target-unstamped` and the system could not take it back.
// New master writes are stamped (convex/lib/operatorOrg.ts `fleetWriteClerkOrgId`); this
// module does the same for the rows written before that change.
//
// WHAT IS STAMPED. Only `clerkOrgId`, the permanent ID, set to the ID of the ONE active
// `orgKind: "operator"` mapping (derived, never typed). The slug column is not touched:
// a slug is a label, and the master write path does not write one either.
//
// IDENTIFICATION RULE (what makes an unstamped row the fleet's). The row has NO stamp of
// any kind (no `clerkOrgId`; no slug on the tables that carry one -- a slug-only row is
// the business of migrations/backfill_org_clerk_id and is only counted here), and its
// author is an agent of the operator organisation and of no other:
//   1. the author BY ID (`createdById`; `ownerId` on businessUnits), when present, is the
//      `_id` of an agents row whose permanent org ID is the operator's (the package's
//      `sameOrg`, by ID, never by slug). An ID that is not such a row (a client agent, an
//      agent row with no org ID, a "user:<subject>" person, a dangling ID) is NOT the
//      fleet's, whatever the label says: an ID outranks a label;
//   2. with no author ID, the label (`createdBy`; `orchestratorId` on businessUnits),
//      normalised, names exactly ONE agents row in the whole deployment and it is the
//      operator org's. A label shared with any other agents row (a client org's, or one
//      with no org ID) is ambiguous and left alone;
//   3. a memory filed in a `team/` namespace is left alone: the namespace names an org.
// Every other row is left as it is and counted `unattributed`. Nothing is guessed.
//
// REVERSIBILITY. The only transition `run` makes is `clerkOrgId`: absent -> <operator ID>,
// on a row that had no stamp. `run` returns the IDs it stamped (`stampedIds`, bounded by
// the page size); `revert` takes those IDs and sets `clerkOrgId` back to absent on each
// row that STILL carries exactly the operator ID, leaving a row changed since untouched
// and counted `changedSince`. No content, no other column, and no other row is ever
// written, so the reverse is exact. Dry run is the default of both.
//
// SHAPE. Internal (deployment admin only; no per-caller check by design), caller-walked,
// one page of one table per call, bounded reads and writes.
//
//   bash .claude/scripts/convex-prod.sh run migrations/fleetWriteStamp:count '{"table":"memories"}'
//   bash .claude/scripts/convex-prod.sh run migrations/fleetWriteStamp:run '{"table":"memories"}'
//   -> repeat with {"cursor": <nextCursor>} until isDone; add "dryRun": false to write.
//   bash .claude/scripts/convex-prod.sh run migrations/fleetWriteStamp:revert '{"table":"memories","ids":[...],"dryRun":false}'

import { sameOrg } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { isHumanActorName } from "../lib/humanActor";
import { findOperatorOrg } from "../lib/operatorOrg";

export const FLEET_STAMP_TABLES = [
	"memories",
	"missions",
	"tasks",
	"recurringTasks",
	"briefingNotes",
	"diary",
	"businessUnits",
] as const;
export type FleetStampTable = (typeof FLEET_STAMP_TABLES)[number];

type Columns = { label: string; id: string; slug: string | null };
const COLUMNS: Record<FleetStampTable, Columns> = {
	memories: { label: "createdBy", id: "createdById", slug: null },
	missions: { label: "createdBy", id: "createdById", slug: "orgId" },
	tasks: { label: "createdBy", id: "createdById", slug: "orgId" },
	recurringTasks: { label: "createdBy", id: "createdById", slug: "orgId" },
	briefingNotes: { label: "createdBy", id: "createdById", slug: "orgId" },
	diary: { label: "createdBy", id: "createdById", slug: "orgId" },
	businessUnits: { label: "orchestratorId", id: "ownerId", slug: "orgId" },
};

const tableValidator = v.union(
	v.literal("memories"),
	v.literal("missions"),
	v.literal("tasks"),
	v.literal("recurringTasks"),
	v.literal("briefingNotes"),
	v.literal("diary"),
	v.literal("businessUnits"),
);

// memories carry whole bodies: a smaller default keeps a page inside the read budget.
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const MAX_REVERT_IDS = 500;
const AGENT_READ_CAP = 5000;

type Row = Record<string, unknown> & { _id: string };

type Resolver = {
	operatorOrgId: string;
	/** agents-row _id -> the agent's permanent org ID (absent: the row carries none) */
	orgIdOfAgentId: Map<string, string | undefined>;
	/** normalised name -> the permanent org ID of every agents row carrying it */
	orgIdsByName: Map<string, (string | undefined)[]>;
};

async function loadResolver(db: DatabaseReader, door: string): Promise<Resolver> {
	const operator = await findOperatorOrg(db);
	if (operator.kind !== "one" || operator.clerkOrgId === undefined) {
		throw new ConvexError(
			`${door}: expected exactly one active operator organisation (orgKind "operator") carrying a permanent org ID; found ${operator.kind}${operator.kind === "one" ? " without an ID" : ""}. Refusing the run.`,
		);
	}
	const agents = await db.query("agents").take(AGENT_READ_CAP + 1);
	if (agents.length > AGENT_READ_CAP) {
		throw new ConvexError(
			`${door}: agents holds more than ${AGENT_READ_CAP} rows; refusing to decide from a truncated read.`,
		);
	}
	const orgIdOfAgentId = new Map<string, string | undefined>();
	const orgIdsByName = new Map<string, (string | undefined)[]>();
	for (const a of agents) {
		orgIdOfAgentId.set(a._id, a.clerkOrgId);
		const key = normalizeOrchestratorId(a.name);
		orgIdsByName.set(key, [...(orgIdsByName.get(key) ?? []), a.clerkOrgId]);
	}
	return { operatorOrgId: operator.clerkOrgId, orgIdOfAgentId, orgIdsByName };
}

type Verdict = "stamped" | "slugOnly" | "fleet" | "teamNamespace" | "unattributed";

const str = (x: unknown): string | undefined =>
	typeof x === "string" && x !== "" ? x : undefined;

/** The package's org comparison, by permanent ID: an agent with no ID is nobody's. */
function inOperatorOrg(r: Resolver, agentOrgId: string | undefined): boolean {
	return sameOrg({ id: agentOrgId }, { id: r.operatorOrgId });
}

/** The one decision, shared by the count and the backfill. */
function classify(
	r: Resolver,
	table: FleetStampTable,
	row: Row,
): Verdict {
	const cols = COLUMNS[table];
	if (str(row.clerkOrgId) !== undefined) return "stamped";
	if (cols.slug !== null && str(row[cols.slug]) !== undefined) return "slugOnly";
	if (table === "memories" && (str(row.namespace) ?? "").startsWith("team/")) {
		return "teamNamespace";
	}
	const authorId = str(row[cols.id]);
	if (authorId !== undefined) {
		return inOperatorOrg(r, r.orgIdOfAgentId.get(authorId)) ? "fleet" : "unattributed";
	}
	const label = str(row[cols.label]);
	if (label === undefined || isHumanActorName(label)) return "unattributed";
	const orgIds = r.orgIdsByName.get(normalizeOrchestratorId(label));
	if (orgIds === undefined) return "unattributed";
	// Exactly one agents row carries the label and it is the operator org's. A row
	// of another org, or one with no permanent ID, makes the label ambiguous.
	return orgIds.length === 1 && inOperatorOrg(r, orgIds[0]) ? "fleet" : "unattributed";
}

function pageSizeOf(n: number | undefined): number {
	if (n === undefined || !Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
	return Math.min(Math.max(Math.floor(n), 1), MAX_PAGE_SIZE);
}

export const count = internalQuery({
	args: {
		table: tableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		table: tableValidator,
		examined: v.number(),
		stamped: v.number(),
		slugOnly: v.number(),
		unstamped: v.number(),
		fleetAttributable: v.number(),
		unattributed: v.number(),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const resolver = await loadResolver(ctx.db, "migrations/fleetWriteStamp:count");
		const page = await ctx.db.query(args.table).paginate({
			numItems: pageSizeOf(args.pageSize),
			cursor: args.cursor ?? null,
		});
		let stamped = 0;
		let slugOnly = 0;
		let fleetAttributable = 0;
		let unattributed = 0;
		for (const row of page.page as unknown as Row[]) {
			const verdict = classify(resolver, args.table, row);
			if (verdict === "stamped") stamped += 1;
			else if (verdict === "slugOnly") slugOnly += 1;
			else if (verdict === "fleet") fleetAttributable += 1;
			else unattributed += 1;
		}
		return {
			table: args.table,
			examined: page.page.length,
			stamped,
			slugOnly,
			unstamped: page.page.length - stamped - slugOnly,
			fleetAttributable,
			unattributed,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});

export const run = internalMutation({
	args: {
		table: tableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
		// Dry run is the default: nothing is written unless `dryRun: false`.
		dryRun: v.optional(v.boolean()),
	},
	returns: v.object({
		table: tableValidator,
		dryRun: v.boolean(),
		examined: v.number(),
		alreadyStamped: v.number(),
		slugOnly: v.number(),
		toStamp: v.number(),
		stamped: v.number(),
		teamNamespace: v.number(),
		unattributed: v.number(),
		/** the rows this call stamped, for `revert` (empty on a dry run) */
		stampedIds: v.array(v.string()),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const resolver = await loadResolver(ctx.db, "migrations/fleetWriteStamp:run");
		const page = await ctx.db.query(args.table).paginate({
			numItems: pageSizeOf(args.pageSize),
			cursor: args.cursor ?? null,
		});
		let alreadyStamped = 0;
		let slugOnly = 0;
		let toStamp = 0;
		let teamNamespace = 0;
		let unattributed = 0;
		const stampedIds: string[] = [];
		for (const row of page.page as unknown as Row[]) {
			const verdict = classify(resolver, args.table, row);
			if (verdict === "stamped") alreadyStamped += 1;
			else if (verdict === "slugOnly") slugOnly += 1;
			else if (verdict === "teamNamespace") teamNamespace += 1;
			else if (verdict === "unattributed") unattributed += 1;
			else {
				toStamp += 1;
				if (!dryRun) {
					await ctx.db.patch(row._id as never, {
						clerkOrgId: resolver.operatorOrgId,
					} as never);
					stampedIds.push(row._id);
				}
			}
		}
		return {
			table: args.table,
			dryRun,
			examined: page.page.length,
			alreadyStamped,
			slugOnly,
			toStamp,
			stamped: stampedIds.length,
			teamNamespace,
			unattributed,
			stampedIds,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});

export const revert = internalMutation({
	args: {
		table: tableValidator,
		ids: v.array(v.string()),
		dryRun: v.optional(v.boolean()),
	},
	returns: v.object({
		table: tableValidator,
		dryRun: v.boolean(),
		requested: v.number(),
		revertible: v.number(),
		reverted: v.number(),
		changedSince: v.number(),
		missing: v.number(),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		if (args.ids.length > MAX_REVERT_IDS) {
			throw new ConvexError(
				`migrations/fleetWriteStamp:revert: at most ${MAX_REVERT_IDS} ids per call (got ${args.ids.length}).`,
			);
		}
		const resolver = await loadResolver(ctx.db, "migrations/fleetWriteStamp:revert");
		let revertible = 0;
		let reverted = 0;
		let changedSince = 0;
		let missing = 0;
		for (const raw of args.ids) {
			const id = ctx.db.normalizeId(args.table, raw);
			const row = id === null ? null : ((await ctx.db.get(id)) as Row | null);
			if (row === null) {
				missing += 1;
				continue;
			}
			// Only a row that still carries exactly the stamp `run` wrote is restored.
			if (row.clerkOrgId !== resolver.operatorOrgId) {
				changedSince += 1;
				continue;
			}
			revertible += 1;
			if (!dryRun) {
				await ctx.db.patch(row._id as never, { clerkOrgId: undefined } as never);
				reverted += 1;
			}
		}
		return {
			table: args.table,
			dryRun,
			requested: args.ids.length,
			revertible,
			reverted,
			changedSince,
			missing,
		};
	},
});
