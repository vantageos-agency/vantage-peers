// backfill_actor_ids — fill the actor/target ID columns of the rows written
// before they existed (R-53 identity-by-ID; Pi ruling (b)/(f), task
// k174d95s5qqy8t2r5rdrz3pr3d8fqv82). EXPAND phase: the name columns stay the
// labels and the authorisation compare; the door lanes move to the IDs later.
//
// COLUMNS (the inventory this migration covers; `run` also returns it):
//   tasks            createdBy      -> createdById
//                    assignedTo     -> assignedToId
//                    lastAssignedTo -> lastAssignedToId
//                    cancelledBy    -> cancelledById
//                    reviewArtifactAttachedBy -> reviewArtifactAttachedById
//   messages         from           -> fromId
//   messageReceipts  recipient      -> recipientId
//
// THE ID. An agent name maps to the `agents` row `_id` (as a string). A person
// ("user:<subject>", the reserved person principal) IS its own stable ID and is
// copied as is. Nothing else produces an ID.
//
// RESOLUTION IS DONE ONCE, WITHIN THE ROW'S OWN ORG. The org is the row's stamp
// (`tasks.orgId`, `messages.tenantId`, `messageReceipts.tenantId`); a row with
// no stamp is fleet-owned (RULING 4) and resolves in the OPERATOR org, derived
// at run time (never a typed slug; zero or 2+ active operator orgs REFUSES the
// run). Within that org a name resolves under normalizeOrchestratorId against
// `agents`:
//   exactly one row  -> its _id
//   no row           -> UNDECIDABLE, reason unknownAgent
//   2+ rows          -> UNDECIDABLE, reason ambiguousAgent
// A name is NEVER looked up in another org: the same name in two orgs is two
// agents, and a row is never given the other org's agent. Undecidable columns
// are LEFT UNSET, counted and listed by row ID.
//
// SHAPE. Caller-walked, cursor-paginated, one page of one table per execution
// (bounded reads and writes). DRY RUN BY DEFAULT. Idempotent: a column that
// already holds an ID is counted `alreadySet` and never rewritten. Run it AFTER
// backfill_org_stamp (so a stamped row resolves in its real org).
//
//   npx convex run migrations/backfill_actor_ids:run '{"table":"messages"}'
//   -> repeat with {"cursor": <nextCursor>} until isDone, then continue with
//      `nextTable`, until nextTable is null. Pass "dryRun": false to write.
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { isHumanActorName } from "../lib/humanActor";
import { findOperatorOrg } from "../lib/operatorOrg";

export const TABLE_ORDER = ["tasks", "messages", "messageReceipts"] as const;
export type ActorTable = (typeof TABLE_ORDER)[number];

// table -> [name column, ID column] pairs this migration fills.
export const INVENTORY: Record<ActorTable, ReadonlyArray<[string, string]>> = {
	tasks: [
		["createdBy", "createdById"],
		["assignedTo", "assignedToId"],
		["lastAssignedTo", "lastAssignedToId"],
		["cancelledBy", "cancelledById"],
		["reviewArtifactAttachedBy", "reviewArtifactAttachedById"],
	],
	messages: [["from", "fromId"]],
	messageReceipts: [["recipient", "recipientId"]],
};

const tableValidator = v.union(
	v.literal("tasks"),
	v.literal("messages"),
	v.literal("messageReceipts"),
);

const DEFAULT_PAGE_SIZE: Record<ActorTable, number> = {
	tasks: 50,
	messages: 100,
	messageReceipts: 100,
};
const MAX_PAGE_SIZE = 500;
const AGENT_READ_CAP = 5000;

type Reason = "unknownAgent" | "ambiguousAgent";

type Resolver = {
	operatorSlug: string;
	// orgSlug -> normalized name -> every agents _id carrying it
	agentIds: Map<string, Map<string, string[]>>;
};

async function loadResolver(db: DatabaseReader): Promise<Resolver> {
	const operator = await findOperatorOrg(db);
	if (operator.kind !== "one") {
		throw new ConvexError(
			operator.kind === "overCap"
				? "backfill_actor_ids: active client_org_mapping rows exceed the read cap; refusing to derive the operator org from a truncated read."
				: operator.kind === "unreadable"
					? "backfill_actor_ids: the active client_org_mapping rows could not be read or are malformed; refusing to derive the operator org."
					: `backfill_actor_ids: expected exactly one active operator organisation (orgKind "operator"), found ${operator.kind === "none" ? 0 : operator.count}; refusing the run.`,
		);
	}
	const agents = await db.query("agents").take(AGENT_READ_CAP + 1);
	if (agents.length > AGENT_READ_CAP) {
		throw new ConvexError(
			`backfill_actor_ids: agents holds more than ${AGENT_READ_CAP} rows; refusing to decide from a truncated read.`,
		);
	}
	const agentIds = new Map<string, Map<string, string[]>>();
	for (const a of agents) {
		const byName = agentIds.get(a.orgSlug) ?? new Map<string, string[]>();
		const key = normalizeOrchestratorId(a.name);
		byName.set(key, [...(byName.get(key) ?? []), a._id]);
		agentIds.set(a.orgSlug, byName);
	}
	return { operatorSlug: operator.slug, agentIds };
}

type Verdict = { id: string } | { reason: Reason };

// The ONE name -> ID decision, within ONE org.
function resolveName(
	r: Resolver,
	rowOrg: string | undefined,
	name: string,
): Verdict {
	if (isHumanActorName(name)) return { id: name };
	const org = rowOrg ?? r.operatorSlug;
	const ids = r.agentIds.get(org)?.get(normalizeOrchestratorId(name));
	if (ids === undefined || ids.length === 0) return { reason: "unknownAgent" };
	if (ids.length > 1) return { reason: "ambiguousAgent" };
	return { id: ids[0] };
}

const columnTallyValidator = v.object({
	column: v.string(),
	alreadySet: v.number(),
	toFill: v.number(),
	filled: v.number(),
	unknownAgent: v.number(),
	ambiguousAgent: v.number(),
});

const resultValidator = v.object({
	table: tableValidator,
	dryRun: v.boolean(),
	// The name -> ID pairs this table's page was decided for, printed first.
	inventory: v.array(v.string()),
	examined: v.number(),
	columns: v.array(columnTallyValidator),
	// Row/column pairs left unset on this page (bounded by pageSize x columns).
	undecidable: v.array(
		v.object({
			rowId: v.string(),
			column: v.string(),
			name: v.string(),
			reason: v.union(v.literal("unknownAgent"), v.literal("ambiguousAgent")),
		}),
	),
	isDone: v.boolean(),
	nextCursor: v.union(v.string(), v.null()),
	nextTable: v.union(tableValidator, v.null()),
});

type ColumnTally = {
	column: string;
	alreadySet: number;
	toFill: number;
	filled: number;
	unknownAgent: number;
	ambiguousAgent: number;
};
type Undecidable = {
	rowId: string;
	column: string;
	name: string;
	reason: Reason;
};

type RowView = {
	_id: string;
	org: string | undefined;
	// [name column, ID column, name, current ID] for every pair the row carries.
	pairs: Array<[string, string, string | undefined, string | undefined]>;
};

function viewTask(row: Doc<"tasks">): RowView {
	return {
		_id: row._id,
		org: row.orgId,
		pairs: [
			["createdBy", "createdById", row.createdBy, row.createdById],
			["assignedTo", "assignedToId", row.assignedTo, row.assignedToId],
			[
				"lastAssignedTo",
				"lastAssignedToId",
				row.lastAssignedTo,
				row.lastAssignedToId,
			],
			["cancelledBy", "cancelledById", row.cancelledBy, row.cancelledById],
			[
				"reviewArtifactAttachedBy",
				"reviewArtifactAttachedById",
				row.reviewArtifactAttachedBy,
				row.reviewArtifactAttachedById,
			],
		],
	};
}
function viewMessage(row: Doc<"messages">): RowView {
	return {
		_id: row._id,
		org: row.tenantId,
		pairs: [["from", "fromId", row.from, row.fromId]],
	};
}
function viewReceipt(row: Doc<"messageReceipts">): RowView {
	return {
		_id: row._id,
		org: row.tenantId,
		pairs: [["recipient", "recipientId", row.recipient, row.recipientId]],
	};
}

function decide(
	r: Resolver,
	view: RowView,
	tallies: Map<string, ColumnTally>,
	undecidable: Undecidable[],
): Record<string, string> {
	const patch: Record<string, string> = {};
	for (const [nameCol, idCol, name, current] of view.pairs) {
		if (name === undefined) continue; // an optional name that was never set
		const t = tallies.get(idCol);
		if (t === undefined) continue;
		if (current !== undefined) {
			t.alreadySet++;
			continue;
		}
		const verdict = resolveName(r, view.org, name);
		if ("reason" in verdict) {
			t[verdict.reason]++;
			undecidable.push({
				rowId: view._id,
				column: nameCol,
				name,
				reason: verdict.reason,
			});
			continue;
		}
		t.toFill++;
		patch[idCol] = verdict.id;
	}
	return patch;
}

export const run = internalMutation({
	args: {
		table: tableValidator,
		dryRun: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: resultValidator,
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE[args.table];
		if (
			!Number.isInteger(pageSize) ||
			pageSize < 1 ||
			pageSize > MAX_PAGE_SIZE
		) {
			throw new ConvexError(
				`backfill_actor_ids: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const inventory = INVENTORY[args.table].map(([n, i]) => `${args.table}.${n} -> ${i}`);
		// Inventory first, before any row is read.
		console.log(
			`backfill_actor_ids ${dryRun ? "DRY RUN" : "WRITE"} ${args.table}: ${inventory.join("; ")}`,
		);

		const resolver = await loadResolver(ctx.db);
		const tallies = new Map<string, ColumnTally>(
			INVENTORY[args.table].map(([, idCol]) => [
				idCol,
				{
					column: idCol,
					alreadySet: 0,
					toFill: 0,
					filled: 0,
					unknownAgent: 0,
					ambiguousAgent: 0,
				},
			]),
		);
		const undecidable: Undecidable[] = [];
		const opts = { cursor: args.cursor ?? null, numItems: pageSize };
		let examined = 0;
		let isDone: boolean;
		let continueCursor: string;

		if (args.table === "tasks") {
			const page = await ctx.db.query("tasks").paginate(opts);
			for (const row of page.page) {
				examined++;
				const patch = decide(resolver, viewTask(row), tallies, undecidable);
				if (!dryRun && Object.keys(patch).length > 0) {
					await ctx.db.patch("tasks", row._id, patch);
					for (const k of Object.keys(patch)) {
						const t = tallies.get(k);
						if (t) t.filled++;
					}
				}
			}
			({ isDone, continueCursor } = page);
		} else if (args.table === "messages") {
			const page = await ctx.db.query("messages").paginate(opts);
			for (const row of page.page) {
				examined++;
				const patch = decide(resolver, viewMessage(row), tallies, undecidable);
				if (!dryRun && Object.keys(patch).length > 0) {
					await ctx.db.patch("messages", row._id, patch);
					for (const k of Object.keys(patch)) {
						const t = tallies.get(k);
						if (t) t.filled++;
					}
				}
			}
			({ isDone, continueCursor } = page);
		} else {
			const page = await ctx.db.query("messageReceipts").paginate(opts);
			for (const row of page.page) {
				examined++;
				const patch = decide(resolver, viewReceipt(row), tallies, undecidable);
				if (!dryRun && Object.keys(patch).length > 0) {
					await ctx.db.patch("messageReceipts", row._id, patch);
					for (const k of Object.keys(patch)) {
						const t = tallies.get(k);
						if (t) t.filled++;
					}
				}
			}
			({ isDone, continueCursor } = page);
		}

		const idx = TABLE_ORDER.indexOf(args.table);
		return {
			table: args.table,
			dryRun,
			inventory,
			examined,
			columns: [...tallies.values()],
			undecidable,
			isDone,
			nextCursor: isDone ? null : continueCursor,
			nextTable: isDone ? (TABLE_ORDER[idx + 1] ?? null) : args.table,
		};
	},
});
