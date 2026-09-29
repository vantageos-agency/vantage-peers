// ─────────────────────────────────────────────────────────────────────────────
// backfillOrgIds — audit-first, PAGINATED tenant backfill for rows written
// before the create-time `orgId` stamp landed.
//
// THIS FILE REPLACES `populateOrgIds.ts`, which was deleted rather than
// repaired. That file:
//   - performed ZERO writes (`grep -cE 'ctx\.db\.(patch|insert|delete|replace)'`
//     returned 0) while its header claimed it "explicitly sets orgId = null on
//     all rows that have no orgId";
//   - counted rows whose `orgId` was undefined and returned that count in a
//     field named `tasksPatched`, so an operator who ran it received a number
//     shaped like work that had not happened;
//   - encoded, in its own comment, the doctrine that IS the defect: "absence of
//     orgId is the canonical master signal". An unstamped row reading as a
//     MASTER row is the same fail-open shape as a resolver returning `null` on a
//     null identity where `null` is the master sentinel.
//
// That premise is now inverted at the authorization layer: `isRowVisibleToScope`
// derives master-ness from the CALLER's verified scope (leg 1) and grants an
// org caller nothing on account of a row's missing `orgId`. See
// `convex/lib/auth.ts`.
//
// WHY THIS FILE WAS REWRITTEN AGAIN (R-31). Its first form read all four
// tables in ONE execution (`take(5000 + 1)` each). Against production the dry
// run died — "Too many bytes read in a single function execution (limit:
// 16777216 bytes)" — because `briefingNotes` rows are documents, so it could
// neither measure nor apply, and the only live customer kept seeing none of its
// own history. R-31: a bulk operation over an unbounded set batches BOTH its
// reads and its writes and reschedules itself; the read budget and the write
// budget are distinct and both bind. This file is now that: one page of one
// table per execution, a cursor carried across executions, and a self-
// reschedule until the corpus is done.
//
// WHAT THIS FILE DOES DIFFERENTLY FROM THE ORIGINAL
//   - DRY-RUN BY DEFAULT. `apply` defaults to false; nothing is written unless
//     a caller passes `apply: true` deliberately.
//   - It AUDITS before it acts, and its report distinguishes rows EXAMINED from
//     rows STAMPED from rows whose owner COULD NOT BE DERIVED. A field named
//     for an action counts that action and nothing else.
//   - It NEVER GUESSES. Tenancy is read only from evidence that already exists
//     on the row's own parent. A row with no such evidence is REPORTED, not
//     assigned. A backfill that assigns a tenant by inference manufactures a
//     boundary that looks measured, which is worse than the gap it hides.
//   - It REFUSES rather than degrading. A pass that cannot complete throws; no
//     `catch` exists in this file. A refused pass rolls back whole (no partial
//     stamps, no successor) and the chain ends FAILED. The report can only
//     carry a total (`finalCounts`) once a terminal `finish` job has succeeded;
//     until then a count lives in `countsSoFar` and the status says it is
//     partial. "Five zeros" is not a state this file can produce.
//
// THE ONLY DERIVATION RULE, and why it is derivation rather than inference:
//   A task carrying a `missionId` inherits its mission's `orgId`. The task is a
//   child of exactly one mission and the product has always created the two
//   together, so the parent's stated tenant IS the child's tenant — nothing is
//   being guessed from a name, a date, or a roster.
//
// WHAT IS DELIBERATELY NOT DERIVED:
//   `assignedTo` / `pilot` / `createdBy` are orchestrator NAMES. Mapping a name
//   back to an org through `client_org_mapping.allowedOrchestrators` is exactly
//   the string-membership test that WAS the isolation hole — two orgs can share
//   the name "eta". Using it here would re-manufacture the boundary this work
//   removes, and would silently misattribute one tenant's rows to another.
//   Orphan rows are therefore left UNSTAMPED and counted, never assigned.
//
// AN UNSTAMPED ROW AFTER THIS RUNS is readable by master only. That is a
// deliberate, stated disposition: master-owned fleet rows are already correct
// as unstamped, and a genuinely org-owned orphan is withheld from its org until
// an operator supplies the missing ownership out of band. Withholding is
// recoverable; misattribution is not.
//
// OPERATING IT (internal functions — `convex run`, under a deployment admin
// credential; none is reachable from a client):
//   1. `migrations/backfillOrgIds:run`     {}                 dry run (default)
//   2. `migrations/backfillOrgIds:status`  {}                 poll until
//        `complete: true`; read `finalCounts`, never `countsSoFar`, as a total
//   3. `migrations/backfillOrgIds:run`     {"apply": true}    only after reading 2
//   4. `migrations/backfillOrgIds:status`  {}                 same
//   If a pass REFUSED, `status` says `failed` and where. Fix the cause (or pass
//   a smaller `readRows`) and call `migrations/backfillOrgIds:resume`.
//
// OPERATIONAL NOTE: this migration has NOT been run against production by its
// author. It is handed over. Run the dry run first and read the counts.
// ─────────────────────────────────────────────────────────────────────────────

import type { DocumentByName, SystemDataModel } from "convex/server";
import type { Infer } from "convex/values";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";

// ── Budgets ─────────────────────────────────────────────────────────────────
// TWO DISTINCT BUDGETS, and both bind. They are measured in different units and
// enforced at different places; neither stands in for the other.
//
//   READ  — bytes (and rows) a single pass may read. Bytes is the unit that
//           killed the original: 5000 `briefingNotes` documents exceeded
//           Convex's 16 MiB read ceiling long before the row cap was reached.
//           Enforced twice: `maximumBytesRead` on the paginated read (half the
//           budget), and an explicit meter over the page PLUS every parent
//           mission fetched. A pass that meters over budget REFUSES.
//   WRITE — `ctx.db.patch` calls a single pass may make. Only `tasks` is ever
//           written, so a `tasks` page is sized `min(readRows, writeBudget)`: a
//           page is the only source of writes, and this keeps a pass from being
//           handed more stampable rows than it may write. An explicit guard
//           REFUSES a patch beyond the budget.
//
// All three are overridable per run (bounded and validated — never clamped), so
// a fixture can force many pages without a million-row corpus and an operator
// can shrink a pass that refused.
const DEFAULT_READ_ROWS = 200;
const DEFAULT_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_WRITE_BUDGET = 100;
const MIN_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 12 * 1024 * 1024;
const MAX_READ_ROWS = 1000;
const MAX_WRITE_BUDGET = 1000;
// Newest scheduled-function rows inspected when locating the chain's tip.
const CHAIN_SCAN_ROWS = 100;

const TABLE_ORDER = [
	"missions",
	"tasks",
	"briefingNotes",
	"recurringTasks",
] as const;
type TableName = (typeof TABLE_ORDER)[number];

const tableNameValidator = v.union(
	v.literal("missions"),
	v.literal("tasks"),
	v.literal("briefingNotes"),
	v.literal("recurringTasks"),
);

// ── Counts ──────────────────────────────────────────────────────────────────
// One uniform shape for every table; a field that cannot occur on a table stays
// 0. The five dispositions a row can have, plus the action counter:
//   derivable         unstamped task whose parent mission states a tenant
//   parentUnstamped   unstamped task whose parent is unstamped OR no longer
//                     exists (a dangling parent supplies no tenant either)
//   orphan            unstamped row with no parent to inherit from at all (a
//                     task without a mission; any unstamped note or schedule)
//   alreadyStamped    row that carried an `orgId` before this run
//   unstampedMission  unstamped mission (nothing on the row states its tenant)
//   examined          rows read. examined = the five above, summed.
//   stamped           writes that HAPPENED. 0 in a dry run, where `derivable`
//                     is the projection.
const tableCountsValidator = v.object({
	examined: v.number(),
	alreadyStamped: v.number(),
	derivable: v.number(),
	stamped: v.number(),
	parentUnstamped: v.number(),
	orphan: v.number(),
	unstampedMission: v.number(),
});
type TableCounts = Infer<typeof tableCountsValidator>;

const countsValidator = v.object({
	missions: tableCountsValidator,
	tasks: tableCountsValidator,
	briefingNotes: tableCountsValidator,
	recurringTasks: tableCountsValidator,
});
type Counts = Infer<typeof countsValidator>;

const reportValidator = v.object({
	perTable: countsValidator,
	totals: tableCountsValidator,
});

const COUNT_KEYS = [
	"examined",
	"alreadyStamped",
	"derivable",
	"stamped",
	"parentUnstamped",
	"orphan",
	"unstampedMission",
] as const;

const zeroCounts = (): TableCounts => ({
	examined: 0,
	alreadyStamped: 0,
	derivable: 0,
	stamped: 0,
	parentUnstamped: 0,
	orphan: 0,
	unstampedMission: 0,
});

const addCounts = (a: TableCounts, b: TableCounts): TableCounts => ({
	examined: a.examined + b.examined,
	alreadyStamped: a.alreadyStamped + b.alreadyStamped,
	derivable: a.derivable + b.derivable,
	stamped: a.stamped + b.stamped,
	parentUnstamped: a.parentUnstamped + b.parentUnstamped,
	orphan: a.orphan + b.orphan,
	unstampedMission: a.unstampedMission + b.unstampedMission,
});

const reportOf = (counts: Counts): Infer<typeof reportValidator> => ({
	perTable: counts,
	totals: TABLE_ORDER.reduce(
		(sum, table) => addCounts(sum, counts[table]),
		zeroCounts(),
	),
});

// ── Chain state ─────────────────────────────────────────────────────────────
// WHERE PROGRESS LIVES, and why. The whole run state — table, cursor, the counts
// accumulated so far, the budgets — is the ARGUMENT of the next scheduled pass.
// Convex commits a mutation's writes and the functions it schedules
// atomically, so a pass's stamps and the record of where the next pass starts
// can never disagree: a pass that commits has both, a pass that throws has
// neither. That is what makes a resume neither redo nor skip a page. It needs no
// table — and a new table would be a schema change on a live production
// deployment, with the schema-mirror rule for `schema.ts` attached.
//
// THE COST, stated rather than hidden: progress is readable through
// `_scheduled_functions`, which Convex retains for a limited time, and which
// `locateTip` finds by scanning the newest CHAIN_SCAN_ROWS jobs. If the chain
// is not in that window `status` answers `not_found` (never a count) and `run`'s
// concurrent-chain guard cannot see it. A table-backed run row would remove both
// limits; it is a schema decision, so it is proposed, not taken.
const budgetsValidator = v.object({
	readRows: v.number(),
	readBytes: v.number(),
	writeBudget: v.number(),
});
type Budgets = Infer<typeof budgetsValidator>;

const stateValidator = v.object({
	apply: v.boolean(),
	table: tableNameValidator,
	cursor: v.union(v.string(), v.null()),
	counts: countsValidator,
	budgets: budgetsValidator,
	passes: v.number(),
	maxWritesInPass: v.number(),
	maxBytesReadInPass: v.number(),
});
type ChainState = Infer<typeof stateValidator>;

const isRecord = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x);

// `_scheduled_functions.args` is untyped (`any[]`). Narrow it by shape before
// trusting a single number out of it; anything that does not parse is REFUSED
// by the caller rather than read as zeros.
function parseState(raw: unknown): ChainState | null {
	if (!isRecord(raw)) return null;
	const { apply, table, cursor, counts, budgets } = raw;
	if (typeof apply !== "boolean") return null;
	if (!TABLE_ORDER.includes(table as TableName)) return null;
	if (cursor !== null && typeof cursor !== "string") return null;
	for (const key of ["passes", "maxWritesInPass", "maxBytesReadInPass"]) {
		if (typeof raw[key] !== "number") return null;
	}
	if (!isRecord(budgets)) return null;
	for (const key of ["readRows", "readBytes", "writeBudget"]) {
		if (typeof budgets[key] !== "number") return null;
	}
	if (!isRecord(counts)) return null;
	for (const t of TABLE_ORDER) {
		const row = counts[t];
		if (!isRecord(row)) return null;
		for (const key of COUNT_KEYS) {
			if (typeof row[key] !== "number") return null;
		}
	}
	return raw as ChainState;
}

// ── Locating the chain ──────────────────────────────────────────────────────
const CHAIN_FN = /(^|\/)backfillOrgIds(\.js)?:(pass|finish)$/;
const FINISH_FN = /:finish$/;

type ChainJob = DocumentByName<SystemDataModel, "_scheduled_functions">;

async function locateTip(
	db: DatabaseReader,
): Promise<{ job: ChainJob | null; scanned: number }> {
	const recent = await db.system
		.query("_scheduled_functions")
		.order("desc")
		.take(CHAIN_SCAN_ROWS);
	const job = recent.find((j) => CHAIN_FN.test(j.name)) ?? null;
	return { job, scanned: recent.length };
}

const isLive = (job: ChainJob): boolean =>
	job.state.kind === "pending" || job.state.kind === "inProgress";

// ── Refusals ────────────────────────────────────────────────────────────────
// A pass that cannot complete THROWS. There is deliberately no `catch` in this
// file: the original failure ("Too many bytes read") was the GOOD direction — it
// refused rather than returning five zeros. Every path below that cannot finish
// keeps that property, and the transaction rolls back.
const refuse = (code: string, detail: string): never => {
	throw new Error(`${code}: ${detail}`);
};

const encoder = new TextEncoder();
const approxBytes = (doc: unknown): number =>
	encoder.encode(JSON.stringify(doc)).length;

function resolveBudgets(
	base: Budgets,
	overrides: {
		readRows?: number | undefined;
		readBytes?: number | undefined;
		writeBudget?: number | undefined;
	},
): Budgets {
	const merged: Budgets = {
		readRows: overrides.readRows ?? base.readRows,
		readBytes: overrides.readBytes ?? base.readBytes,
		writeBudget: overrides.writeBudget ?? base.writeBudget,
	};
	const checks: [string, number, number, number][] = [
		["readRows", merged.readRows, 1, MAX_READ_ROWS],
		["readBytes", merged.readBytes, MIN_READ_BYTES, MAX_READ_BYTES],
		["writeBudget", merged.writeBudget, 1, MAX_WRITE_BUDGET],
	];
	for (const [name, value, min, max] of checks) {
		if (!Number.isInteger(value) || value < min || value > max) {
			refuse(
				"BACKFILL_ARGS_INVALID",
				`${name} = ${value} is out of expected range ${min}-${max}.`,
			);
		}
	}
	return merged;
}

const DEFAULT_BUDGETS: Budgets = {
	readRows: DEFAULT_READ_ROWS,
	readBytes: DEFAULT_READ_BYTES,
	writeBudget: DEFAULT_WRITE_BUDGET,
};

// The ONE place a pass is scheduled, so that "the chain continues" is a single
// call.
async function schedulePass(
	ctx: Pick<MutationCtx, "scheduler">,
	state: ChainState,
): Promise<Id<"_scheduled_functions">> {
	return await ctx.scheduler.runAfter(
		0,
		internal.migrations.backfillOrgIds.pass,
		{ state },
	);
}

// ── One page of one table ───────────────────────────────────────────────────
type PageOutcome = {
	delta: TableCounts;
	writes: number;
	bytesRead: number;
	isDone: boolean;
	continueCursor: string;
};

const noProgress = (table: TableName, cursor: string | null): never =>
	refuse(
		"BACKFILL_NO_FORWARD_PROGRESS",
		`table ${table} returned an empty page that is not the last one (cursor ${cursor}). Refusing to loop.`,
	);

async function processPage(
	ctx: MutationCtx,
	state: ChainState,
): Promise<PageOutcome> {
	const { apply, table, cursor, budgets } = state;
	const delta = zeroCounts();
	let writes = 0;
	let bytesRead = 0;

	// READ budget: a page is at most `readRows` rows and half `readBytes`.
	// `tasks` pages are further capped by the WRITE budget (see above).
	const numItems =
		table === "tasks"
			? Math.min(budgets.readRows, budgets.writeBudget)
			: budgets.readRows;
	const pageOpts = {
		numItems,
		cursor,
		maximumBytesRead: Math.floor(budgets.readBytes / 2),
	};

	const meter = (doc: unknown): void => {
		bytesRead += approxBytes(doc);
		if (bytesRead > budgets.readBytes) {
			refuse(
				"BACKFILL_READ_BUDGET_EXCEEDED",
				`table ${table}, cursor ${cursor}: this pass read ~${bytesRead} bytes against a budget of ${budgets.readBytes}. Nothing from this pass was written. Resume with a smaller readRows.`,
			);
		}
	};

	if (table === "tasks") {
		const result = await ctx.db.query("tasks").paginate(pageOpts);
		if (result.page.length === 0 && !result.isDone) noProgress(table, cursor);
		// The ONE derivation: a task inherits its parent mission's stated
		// tenant. Parents are cached per pass; each distinct parent is a read
		// and is metered.
		const parentOrg = new Map<Id<"missions">, string | null>();
		for (const task of result.page) {
			meter(task);
			delta.examined++;
			if (task.orgId !== undefined) {
				delta.alreadyStamped++;
				continue;
			}
			if (task.missionId === undefined) {
				// No parent, therefore no evidence. Orchestrator names are NOT
				// consulted — see the header.
				delta.orphan++;
				continue;
			}
			let org = parentOrg.get(task.missionId);
			if (org === undefined) {
				const mission = await ctx.db.get(task.missionId);
				if (mission !== null) meter(mission);
				// Dangling and unstamped parents both supply no tenant.
				org = mission?.orgId ?? null;
				parentOrg.set(task.missionId, org);
			}
			if (org === null) {
				delta.parentUnstamped++;
				continue;
			}
			delta.derivable++;
			if (apply) {
				if (writes >= budgets.writeBudget) {
					refuse(
						"BACKFILL_WRITE_BUDGET_EXCEEDED",
						`table tasks, cursor ${cursor}: patch number ${writes + 1} against a write budget of ${budgets.writeBudget}. Nothing from this pass was written.`,
					);
				}
				await ctx.db.patch(task._id, { orgId: org });
				delta.stamped++;
				writes++;
			}
		}
		return {
			delta,
			writes,
			bytesRead,
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	}

	// The three report-only tables. Missions, briefing notes and recurring
	// schedules have no parent row that states a tenant, and their
	// `assignedTo`/`createdBy`/`participants` are orchestrator NAMES, which are
	// not evidence of tenancy. Counted, never assigned. recurringTasks stays in
	// the report because each unstamped schedule keeps emitting unstamped tasks
	// through `processDueTasks`, which inherits this column.
	const result =
		table === "missions"
			? await ctx.db.query("missions").paginate(pageOpts)
			: table === "briefingNotes"
				? await ctx.db.query("briefingNotes").paginate(pageOpts)
				: await ctx.db.query("recurringTasks").paginate(pageOpts);
	if (result.page.length === 0 && !result.isDone) noProgress(table, cursor);
	for (const row of result.page) {
		meter(row);
		delta.examined++;
		if (row.orgId !== undefined) delta.alreadyStamped++;
		else if (table === "missions") delta.unstampedMission++;
		else delta.orphan++;
	}
	return {
		delta,
		writes,
		bytesRead,
		isDone: result.isDone,
		continueCursor: result.continueCursor,
	};
}

// ── The pass ────────────────────────────────────────────────────────────────
// One page of one table per execution. Convex allows a single paginated read
// per function, and one table per pass is also what keeps the read budget a
// per-table number rather than a sum over four.
//
// Internal: reachable only from other Convex functions and the admin CLI, never
// from a client, so there is no user identity to authorize against.
export const pass = internalMutation({
	args: { state: stateValidator },
	returns: v.null(),
	handler: async (ctx, { state }): Promise<null> => {
		const outcome = await processPage(ctx, state);

		const counts: Counts = { ...state.counts };
		counts[state.table] = addCounts(counts[state.table], outcome.delta);
		const next: ChainState = {
			...state,
			counts,
			passes: state.passes + 1,
			maxWritesInPass: Math.max(state.maxWritesInPass, outcome.writes),
			maxBytesReadInPass: Math.max(state.maxBytesReadInPass, outcome.bytesRead),
		};

		if (!outcome.isDone) {
			await schedulePass(ctx, { ...next, cursor: outcome.continueCursor });
			return null;
		}
		const following = TABLE_ORDER[TABLE_ORDER.indexOf(state.table) + 1];
		if (following !== undefined) {
			await schedulePass(ctx, { ...next, table: following, cursor: null });
			return null;
		}
		// The last page of the last table. `finish` is the durable record of the
		// totals: a chain is COMPLETE if and only if a `finish` job succeeded.
		await ctx.scheduler.runAfter(0, internal.migrations.backfillOrgIds.finish, {
			state: { ...next, cursor: null },
		});
		return null;
	},
});

// The terminal record. It does no work; its ARGUMENTS are the final totals and
// its success is what `status` reads as "complete".
export const finish = internalMutation({
	args: { state: stateValidator },
	returns: v.null(),
	handler: async (): Promise<null> => null,
});

// ── Starting, resuming, asking ──────────────────────────────────────────────
const budgetOverrideArgs = {
	readRows: v.optional(v.number()),
	readBytes: v.optional(v.number()),
	writeBudget: v.optional(v.number()),
};

// Named validators + explicit handler return types. `run`, `resume` and `pass`
// reach each other through `internal.migrations.backfillOrgIds.*`, so this
// module's type is defined in terms of itself. An inferred handler return type
// on that cycle collapses to `any` (TS7022/TS7023), which degrades the whole
// generated `api` and, downstream, `Id<>` and every callback in the suite.
// Annotated return types cut the cycle.
const runResultValidator = v.object({
	started: v.literal(true),
	apply: v.boolean(),
	jobId: v.id("_scheduled_functions"),
});
type RunResult = Infer<typeof runResultValidator>;

const resumeResultValidator = v.object({
	jobId: v.id("_scheduled_functions"),
	resumedAt: v.object({
		table: tableNameValidator,
		cursor: v.union(v.string(), v.null()),
	}),
});
type ResumeResult = Infer<typeof resumeResultValidator>;

export const run = internalMutation({
	args: {
		// Dry run unless explicitly told otherwise. The default is the safe pole.
		apply: v.optional(v.boolean()),
		...budgetOverrideArgs,
	},
	returns: runResultValidator,
	handler: async (ctx, args): Promise<RunResult> => {
		const budgets = resolveBudgets(DEFAULT_BUDGETS, args);
		// Two chains at once would each count the same rows.
		const { job } = await locateTip(ctx.db);
		if (job !== null && isLive(job)) {
			refuse(
				"BACKFILL_ALREADY_RUNNING",
				`a backfill job (${job.name}) is still ${job.state.kind}. Read status first.`,
			);
		}
		const apply = args.apply ?? false;
		const jobId = await schedulePass(ctx, {
			apply,
			table: "missions",
			cursor: null,
			counts: {
				missions: zeroCounts(),
				tasks: zeroCounts(),
				briefingNotes: zeroCounts(),
				recurringTasks: zeroCounts(),
			},
			budgets,
			passes: 0,
			maxWritesInPass: 0,
			maxBytesReadInPass: 0,
		});
		return { started: true as const, apply, jobId };
	},
});

// Re-schedules the job that REFUSED, from the exact state it was handed. Its
// stamps and its successor rolled back together, so replaying it neither
// repeats nor skips a page. Budgets may be shrunk to get past a read refusal.
export const resume = internalMutation({
	args: budgetOverrideArgs,
	returns: resumeResultValidator,
	handler: async (ctx, args): Promise<ResumeResult> => {
		const { job } = await locateTip(ctx.db);
		if (job === null) {
			return refuse("BACKFILL_NOTHING_TO_RESUME", "no backfill job was found.");
		}
		if (job.state.kind !== "failed") {
			return refuse(
				"BACKFILL_NOT_FAILED",
				`the newest backfill job (${job.name}) is ${job.state.kind}; only a failed job can be resumed.`,
			);
		}
		const parsed = parseState(job.args[0]?.state);
		if (parsed === null) {
			return refuse(
				"BACKFILL_STATE_UNREADABLE",
				`the arguments of ${job.name} do not parse as backfill state.`,
			);
		}
		const state: ChainState = {
			...parsed,
			budgets: resolveBudgets(parsed.budgets, args),
		};
		const jobId = FINISH_FN.test(job.name)
			? await ctx.scheduler.runAfter(
					0,
					internal.migrations.backfillOrgIds.finish,
					{ state },
				)
			: await schedulePass(ctx, state);
		return { jobId, resumedAt: { table: state.table, cursor: state.cursor } };
	},
});

const statusValidator = v.object({
	status: v.union(
		v.literal("not_found"),
		v.literal("running"),
		v.literal("complete"),
		v.literal("failed"),
	),
	// True only when a `finish` job succeeded. Anything else is PARTIAL.
	complete: v.boolean(),
	apply: v.union(v.boolean(), v.null()),
	// Where the newest job starts (or started) — the resume point.
	position: v.union(
		v.object({
			table: tableNameValidator,
			cursor: v.union(v.string(), v.null()),
		}),
		v.null(),
	),
	passes: v.number(),
	maxWritesInPass: v.number(),
	maxBytesReadInPass: v.number(),
	// Counts over the pages COMPLETED so far. Never a total unless `complete`.
	countsSoFar: v.union(reportValidator, v.null()),
	// Non-null ONLY when `complete`. A partial pass cannot pass for a total
	// because it has no field to sit in.
	finalCounts: v.union(reportValidator, v.null()),
	failure: v.union(v.string(), v.null()),
	// Scheduled-function rows inspected while locating the chain.
	scanned: v.number(),
});
type Status = Infer<typeof statusValidator>;

const noChainStatus = (
	status: Status["status"],
	failure: string,
	scanned: number,
): Status => ({
	status,
	complete: false,
	apply: null,
	position: null,
	passes: 0,
	maxWritesInPass: 0,
	maxBytesReadInPass: 0,
	countsSoFar: null,
	finalCounts: null,
	failure,
	scanned,
});

export const status = internalQuery({
	args: {},
	returns: statusValidator,
	handler: async (ctx): Promise<Status> => {
		const { job, scanned } = await locateTip(ctx.db);
		if (job === null) {
			return noChainStatus(
				"not_found",
				`no backfill job among the newest ${scanned} scheduled functions. This is NOT a count of zero.`,
				scanned,
			);
		}
		const state = parseState(job.args[0]?.state);
		if (state === null) {
			return noChainStatus(
				"failed",
				`the arguments of ${job.name} do not parse as backfill state.`,
				scanned,
			);
		}
		const kind = job.state.kind;
		const report = reportOf(state.counts);
		const base = {
			apply: state.apply,
			position: { table: state.table, cursor: state.cursor },
			passes: state.passes,
			maxWritesInPass: state.maxWritesInPass,
			maxBytesReadInPass: state.maxBytesReadInPass,
			countsSoFar: report,
			scanned,
		};
		if (FINISH_FN.test(job.name) && kind === "success") {
			return {
				...base,
				status: "complete",
				complete: true,
				finalCounts: report,
				failure: null,
			};
		}
		if (kind === "pending" || kind === "inProgress") {
			return {
				...base,
				status: "running",
				complete: false,
				finalCounts: null,
				failure: null,
			};
		}
		const error =
			"error" in job.state && typeof job.state.error === "string"
				? `: ${job.state.error}`
				: "";
		return {
			...base,
			status: "failed",
			complete: false,
			finalCounts: null,
			failure:
				kind === "success"
					? `${job.name} succeeded but no finish record followed it: the chain stopped without completing.`
					: `${job.name} ${kind}${error}`,
		};
	},
});
