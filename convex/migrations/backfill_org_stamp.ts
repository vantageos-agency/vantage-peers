// backfill_org_stamp — stamp every row that has no tenant with its real org, or
// with FLEET_SCOPE_ORG_ID when the row is fleet-owned, so the
// @vantageos/cloud-identity primitive (which refuses an unstamped target to
// everyone) can be switched on door by door.
//
// REPRESENTATION. The stamp is the org SLUG (`client_org_mapping.clerkOrgSlug`,
// the same string `withOrgScope` puts in `scope.orgSlug` and the doors compare
// with `record.orgId === scope.orgSlug`), never the mapping row's `_id`. The
// fleet stamp is the constant FLEET_SCOPE_ORG_ID (convex/lib/fleetScope.ts).
//
// THE RULES (an org is decided ONLY from ID-linked data; a name is a label):
//   tasks            1. its mission (`missionId`): the mission's stamp, or, if
//                       the mission has none yet, rule A applied to the mission;
//                       a mission that is itself undecidable makes the task
//                       undecidable (parentUnstamped), never guessed from the
//                       task's own name;
//                    2. no mission / dangling mission -> rule A on the task.
//   messageReceipts  its message (`messageId`): the message's `tenantId`, or
//                    rule A on the message; undecidable message -> undecidable.
//   missions, messages, briefingNotes, recurringTasks
//                    rule A.
//   RULE A: the `createdBy` / `from` label resolves, under
//     normalizeOrchestratorId, to EXACTLY ONE `agents` row across ALL
//     organisations (any isActive state). That row's `orgSlug` is looked up in
//     `client_org_mapping`: an active mapping with orgKind "operator" -> FLEET
//     stamp; an active mapping otherwise -> that slug; no/inactive mapping ->
//     undecidable. Zero or 2+ agent rows -> undecidable (unknown / ambiguous).
//   Undecidable rows are LEFT UNSTAMPED and counted. Nothing else stamps them.
//
// SHAPE. Caller-walked, cursor-paginated, one page of one table per execution
// (R-31: bounded reads AND writes). Walk TABLE_ORDER. DRY RUN BY DEFAULT;
// children read their parent's rule, not its stamp, so dry run == real run.
// Idempotent: a row that already has a tenant is counted `alreadyStamped` and is
// never written.
//
//   npx convex run migrations/backfill_org_stamp:run '{"table":"missions"}'
//   -> repeat with {"cursor": <nextCursor>} until isDone, then continue with
//      `nextTable`, until nextTable is null. Pass "dryRun": false to write.
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { FLEET_SCOPE_ORG_ID } from "../lib/fleetScope";

export const TABLE_ORDER = [
	"missions",
	"messages",
	"tasks",
	"messageReceipts",
	"briefingNotes",
	"recurringTasks",
] as const;
export type StampTable = (typeof TABLE_ORDER)[number];

const tableValidator = v.union(
	v.literal("missions"),
	v.literal("messages"),
	v.literal("tasks"),
	v.literal("messageReceipts"),
	v.literal("briefingNotes"),
	v.literal("recurringTasks"),
);

const DEFAULT_PAGE_SIZE: Record<StampTable, number> = {
	missions: 50,
	messages: 50,
	tasks: 50,
	messageReceipts: 100,
	briefingNotes: 20,
	recurringTasks: 100,
};
const MAX_PAGE_SIZE = 500;
const MAPPING_READ_CAP = 1000;
const AGENT_READ_CAP = 5000;

type Reason =
	| "unknownAgent"
	| "ambiguousAgent"
	| "orgUnmapped"
	| "parentUnstamped"
	| "noCreator";

type Verdict =
	| { kind: "org"; orgId: string }
	| { kind: "fleet" }
	| { kind: "undecidable"; reason: Reason };

type Resolver = {
	// clerkOrgSlug -> "operator" | "client", ACTIVE mappings only
	kindBySlug: Map<string, "operator" | "client">;
	// normalized name -> orgSlug of every agents row carrying it
	agentOrgsByName: Map<string, string[]>;
};

async function loadResolver(db: DatabaseReader): Promise<Resolver> {
	const mappings = await db
		.query("client_org_mapping")
		.take(MAPPING_READ_CAP + 1);
	if (mappings.length > MAPPING_READ_CAP) {
		throw new ConvexError(
			`backfill_org_stamp: client_org_mapping holds more than ${MAPPING_READ_CAP} rows; refusing to decide from a truncated read.`,
		);
	}
	const kindBySlug = new Map<string, "operator" | "client">();
	for (const m of mappings) {
		if (m.isActive) {
			kindBySlug.set(
				m.clerkOrgSlug,
				m.orgKind === "operator" ? "operator" : "client",
			);
		}
	}
	const agents = await db.query("agents").take(AGENT_READ_CAP + 1);
	if (agents.length > AGENT_READ_CAP) {
		throw new ConvexError(
			`backfill_org_stamp: agents holds more than ${AGENT_READ_CAP} rows; refusing to decide from a truncated read.`,
		);
	}
	const agentOrgsByName = new Map<string, string[]>();
	for (const a of agents) {
		const key = a.normalizedName ?? normalizeOrchestratorId(a.name);
		const list = agentOrgsByName.get(key) ?? [];
		list.push(a.orgSlug);
		agentOrgsByName.set(key, list);
	}
	return { kindBySlug, agentOrgsByName };
}

// RULE A.
function byAgent(r: Resolver, label: string | undefined): Verdict {
	if (label === undefined || label.trim() === "") {
		return { kind: "undecidable", reason: "noCreator" };
	}
	const orgs = r.agentOrgsByName.get(normalizeOrchestratorId(label));
	if (orgs === undefined || orgs.length === 0) {
		return { kind: "undecidable", reason: "unknownAgent" };
	}
	if (orgs.length > 1) {
		return { kind: "undecidable", reason: "ambiguousAgent" };
	}
	const kind = r.kindBySlug.get(orgs[0]);
	if (kind === undefined) {
		return { kind: "undecidable", reason: "orgUnmapped" };
	}
	return kind === "operator"
		? { kind: "fleet" }
		: { kind: "org", orgId: orgs[0] };
}

// A parent's existing stamp is inherited verbatim. A parent with no stamp yet is
// decided by its OWN rule (rule A), so a dry run and a real run agree whatever
// order the tables were walked in; a parent that is itself undecidable makes the
// child undecidable (parentUnstamped).
function byParent(stamp: string | undefined, parentOwn: Verdict): Verdict {
	if (stamp !== undefined) {
		return stamp === FLEET_SCOPE_ORG_ID
			? { kind: "fleet" }
			: { kind: "org", orgId: stamp };
	}
	return parentOwn.kind === "undecidable"
		? { kind: "undecidable", reason: "parentUnstamped" }
		: parentOwn;
}

const stampOf = (verdict: Verdict): string | null =>
	verdict.kind === "org"
		? verdict.orgId
		: verdict.kind === "fleet"
			? FLEET_SCOPE_ORG_ID
			: null;

const reasonCountsValidator = v.object({
	unknownAgent: v.number(),
	ambiguousAgent: v.number(),
	orgUnmapped: v.number(),
	parentUnstamped: v.number(),
	noCreator: v.number(),
});

const resultValidator = v.object({
	table: tableValidator,
	dryRun: v.boolean(),
	examined: v.number(),
	alreadyStamped: v.number(),
	toStampOrg: v.number(),
	toStampFleet: v.number(),
	undecidable: v.number(),
	undecidableByReason: reasonCountsValidator,
	// Row ids left unstamped on this page (bounded by pageSize).
	undecidableIds: v.array(v.string()),
	stamped: v.number(),
	isDone: v.boolean(),
	nextCursor: v.union(v.string(), v.null()),
	// The table to walk next (the same table while not done), or null after the last one.
	nextTable: v.union(tableValidator, v.null()),
});

type Tally = {
	examined: number;
	alreadyStamped: number;
	toStampOrg: number;
	toStampFleet: number;
	stamped: number;
	undecidableByReason: Record<Reason, number>;
	undecidableIds: string[];
};

// The ONE decision point. A row that already carries a tenant yields null and is
// therefore never written.
function settle(
	tally: Tally,
	id: string,
	current: string | undefined,
	verdict: Verdict,
): string | null {
	tally.examined++;
	if (current !== undefined) {
		tally.alreadyStamped++;
		return null;
	}
	if (verdict.kind === "undecidable") {
		tally.undecidableByReason[verdict.reason]++;
		tally.undecidableIds.push(id);
		return null;
	}
	if (verdict.kind === "fleet") tally.toStampFleet++;
	else tally.toStampOrg++;
	return stampOf(verdict);
}

type PageEnd = { isDone: boolean; nextCursor: string | null };

async function walk(
	ctx: MutationCtx,
	table: StampTable,
	cursor: string | null,
	pageSize: number,
	dryRun: boolean,
	resolver: Resolver,
	tally: Tally,
): Promise<PageEnd> {
	const opts = { cursor, numItems: pageSize };
	const commit = async <T extends StampTable>(
		t: T,
		id: Id<T>,
		field: "orgId" | "tenantId",
		stamp: string | null,
	): Promise<void> => {
		if (stamp === null || dryRun) return;
		await ctx.db.patch(t, id, { [field]: stamp } as never);
		tally.stamped++;
	};

	if (table === "missions") {
		const page = await ctx.db.query("missions").paginate(opts);
		for (const row of page.page) {
			const s = settle(
				tally,
				row._id,
				row.orgId,
				byAgent(resolver, row.createdBy),
			);
			await commit("missions", row._id, "orgId", s);
		}
		return { isDone: page.isDone, nextCursor: page.continueCursor };
	}
	if (table === "messages") {
		const page = await ctx.db.query("messages").paginate(opts);
		for (const row of page.page) {
			const s = settle(
				tally,
				row._id,
				row.tenantId,
				byAgent(resolver, row.from),
			);
			await commit("messages", row._id, "tenantId", s);
		}
		return { isDone: page.isDone, nextCursor: page.continueCursor };
	}
	if (table === "tasks") {
		const page = await ctx.db.query("tasks").paginate(opts);
		for (const row of page.page) {
			const parent =
				row.missionId === undefined ? null : await ctx.db.get(row.missionId);
			const verdict =
				parent === null
					? byAgent(resolver, row.createdBy)
					: byParent(parent.orgId, byAgent(resolver, parent.createdBy));
			const s = settle(tally, row._id, row.orgId, verdict);
			await commit("tasks", row._id, "orgId", s);
		}
		return { isDone: page.isDone, nextCursor: page.continueCursor };
	}
	if (table === "messageReceipts") {
		const page = await ctx.db.query("messageReceipts").paginate(opts);
		for (const row of page.page) {
			const parent = await ctx.db.get(row.messageId);
			const verdict: Verdict =
				parent === null
					? { kind: "undecidable", reason: "parentUnstamped" }
					: byParent(parent.tenantId, byAgent(resolver, parent.from));
			const s = settle(tally, row._id, row.tenantId, verdict);
			await commit("messageReceipts", row._id, "tenantId", s);
		}
		return { isDone: page.isDone, nextCursor: page.continueCursor };
	}
	if (table === "briefingNotes") {
		const page = await ctx.db.query("briefingNotes").paginate(opts);
		for (const row of page.page) {
			const s = settle(
				tally,
				row._id,
				row.orgId,
				byAgent(resolver, row.createdBy),
			);
			await commit("briefingNotes", row._id, "orgId", s);
		}
		return { isDone: page.isDone, nextCursor: page.continueCursor };
	}
	const page = await ctx.db.query("recurringTasks").paginate(opts);
	for (const row of page.page) {
		const s = settle(
			tally,
			row._id,
			row.orgId,
			byAgent(resolver, row.createdBy),
		);
		await commit("recurringTasks", row._id, "orgId", s);
	}
	return { isDone: page.isDone, nextCursor: page.continueCursor };
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
				`backfill_org_stamp: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const resolver = await loadResolver(ctx.db);
		const tally: Tally = {
			examined: 0,
			alreadyStamped: 0,
			toStampOrg: 0,
			toStampFleet: 0,
			stamped: 0,
			undecidableByReason: {
				unknownAgent: 0,
				ambiguousAgent: 0,
				orgUnmapped: 0,
				parentUnstamped: 0,
				noCreator: 0,
			},
			undecidableIds: [],
		};
		const { isDone, nextCursor } = await walk(
			ctx,
			args.table,
			args.cursor ?? null,
			pageSize,
			dryRun,
			resolver,
			tally,
		);
		const idx = TABLE_ORDER.indexOf(args.table);
		return {
			table: args.table,
			dryRun,
			examined: tally.examined,
			alreadyStamped: tally.alreadyStamped,
			toStampOrg: tally.toStampOrg,
			toStampFleet: tally.toStampFleet,
			undecidable: tally.undecidableIds.length,
			undecidableByReason: tally.undecidableByReason,
			undecidableIds: tally.undecidableIds,
			stamped: tally.stamped,
			isDone,
			nextCursor: isDone ? null : nextCursor,
			nextTable: isDone ? (TABLE_ORDER[idx + 1] ?? null) : args.table,
		};
	},
});
