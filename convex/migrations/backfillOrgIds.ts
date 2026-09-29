// ─────────────────────────────────────────────────────────────────────────────
// backfillOrgIds — audit-first tenant backfill for rows written before the
// create-time `orgId` stamp landed.
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
// WHAT THIS FILE DOES DIFFERENTLY
//   - DRY-RUN BY DEFAULT. `apply` defaults to false; nothing is written unless
//     a caller passes `apply: true` deliberately.
//   - It AUDITS before it acts, and its return distinguishes rows EXAMINED from
//     rows STAMPED from rows whose owner COULD NOT BE DERIVED. A field named
//     for an action counts that action and nothing else.
//   - It NEVER GUESSES. Tenancy is read only from evidence that already exists
//     on the row's own parent. A row with no such evidence is REPORTED, not
//     assigned. A backfill that assigns a tenant by inference manufactures a
//     boundary that looks measured, which is worse than the gap it hides.
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
// OPERATIONAL NOTE: this migration has NOT been run against production by its
// author. It is handed over. Run the dry run first and read the counts.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

// Scan ceiling per table. The whole scan runs in ONE Convex transaction, so
// this is also the transaction's row budget. If a table exceeds this, the run
// reports `truncated: true` for it and the operator must page — a silent
// partial backfill that reported success would be the `tasksPatched` defect in
// a new costume.
const SCAN_CAP = 5000;

const tableReportValidator = v.object({
	// Rows READ by this run. Not rows changed.
	examined: v.number(),
	// Rows that already carried an `orgId` before this run touched anything.
	alreadyStamped: v.number(),
	// Rows this run WROTE an `orgId` onto. In a dry run this is always 0 and
	// `wouldStamp` carries the projection instead.
	stamped: v.number(),
	// Rows a real run WOULD stamp, and the evidence it would use.
	wouldStamp: v.number(),
	// Rows with no `orgId` and NO derivable owner. Left untouched, by design.
	ownerNotDerivable: v.number(),
	// True when the table holds more rows than SCAN_CAP — the counts above then
	// describe a PREFIX of the table, not the table.
	truncated: v.boolean(),
});

export const run = internalMutation({
	args: {
		// Dry run unless explicitly told otherwise. The default is the safe pole.
		apply: v.optional(v.boolean()),
	},
	returns: v.object({
		applied: v.boolean(),
		tasks: tableReportValidator,
		missions: tableReportValidator,
		briefingNotes: tableReportValidator,
		recurringTasks: tableReportValidator,
	}),
	handler: async (ctx, args) => {
		const apply = args.apply ?? false;

		// ── missions ───────────────────────────────────────────────────────────
		// A mission has no parent to inherit from. There is no evidence on the
		// row that establishes its tenant, so every unstamped mission is
		// reported as not-derivable. This is the honest answer, not a gap in the
		// implementation: the information was never recorded.
		const missions = await ctx.db.query("missions").take(SCAN_CAP + 1);
		const missionsTruncated = missions.length > SCAN_CAP;
		const missionRows = missions.slice(0, SCAN_CAP);
		let missionsAlready = 0;
		let missionsNotDerivable = 0;
		for (const mission of missionRows) {
			if (mission.orgId !== undefined) missionsAlready++;
			else missionsNotDerivable++;
		}

		// ── tasks ──────────────────────────────────────────────────────────────
		// The ONE derivable case: inherit the parent mission's stated tenant.
		const tasks = await ctx.db.query("tasks").take(SCAN_CAP + 1);
		const tasksTruncated = tasks.length > SCAN_CAP;
		const taskRows = tasks.slice(0, SCAN_CAP);
		let tasksAlready = 0;
		let tasksWouldStamp = 0;
		let tasksStamped = 0;
		let tasksNotDerivable = 0;
		for (const task of taskRows) {
			if (task.orgId !== undefined) {
				tasksAlready++;
				continue;
			}
			if (task.missionId === undefined) {
				// No parent, therefore no evidence. Orchestrator names are NOT
				// consulted — see the header.
				tasksNotDerivable++;
				continue;
			}
			const mission = await ctx.db.get(task.missionId);
			if (mission === null || mission.orgId === undefined) {
				// Dangling parent, or a parent that is itself unstamped. Either
				// way there is no tenant to inherit.
				tasksNotDerivable++;
				continue;
			}
			tasksWouldStamp++;
			if (apply) {
				await ctx.db.patch(task._id, { orgId: mission.orgId });
				tasksStamped++;
			}
		}

		// ── briefingNotes ──────────────────────────────────────────────────────
		// Like missions, a briefing note has no parent row carrying a tenant.
		// `participants` and `createdBy` are orchestrator names and are not
		// evidence of tenancy. Reported, never assigned.
		const notes = await ctx.db.query("briefingNotes").take(SCAN_CAP + 1);
		const notesTruncated = notes.length > SCAN_CAP;
		const noteRows = notes.slice(0, SCAN_CAP);
		let notesAlready = 0;
		let notesNotDerivable = 0;
		for (const note of noteRows) {
			if (note.orgId !== undefined) notesAlready++;
			else notesNotDerivable++;
		}

		// ── recurringTasks ─────────────────────────────────────────────────────
		// The fourth `orgId`-bearing table, and it MUST be reported even though
		// nothing here is derivable: a recurring schedule has no parent row, and
		// its `assignedTo`/`createdBy` are orchestrator names, which the header
		// rules out as evidence. Omitting the table would have understated the
		// gap — an operator reading three clean reports would conclude the
		// backfill was complete while every unstamped schedule kept emitting
		// unstamped tasks through `processDueTasks`, which inherits this column.
		// Each such schedule is a recurring source of invisible rows, so it is
		// counted and surfaced rather than silently skipped.
		const recurring = await ctx.db.query("recurringTasks").take(SCAN_CAP + 1);
		const recurringTruncated = recurring.length > SCAN_CAP;
		const recurringRows = recurring.slice(0, SCAN_CAP);
		let recurringAlready = 0;
		let recurringNotDerivable = 0;
		for (const row of recurringRows) {
			if (row.orgId !== undefined) recurringAlready++;
			else recurringNotDerivable++;
		}

		return {
			applied: apply,
			recurringTasks: {
				examined: recurringRows.length,
				alreadyStamped: recurringAlready,
				stamped: 0,
				wouldStamp: 0,
				ownerNotDerivable: recurringNotDerivable,
				truncated: recurringTruncated,
			},
			tasks: {
				examined: taskRows.length,
				alreadyStamped: tasksAlready,
				stamped: tasksStamped,
				wouldStamp: tasksWouldStamp,
				ownerNotDerivable: tasksNotDerivable,
				truncated: tasksTruncated,
			},
			missions: {
				examined: missionRows.length,
				alreadyStamped: missionsAlready,
				stamped: 0,
				wouldStamp: 0,
				ownerNotDerivable: missionsNotDerivable,
				truncated: missionsTruncated,
			},
			briefingNotes: {
				examined: noteRows.length,
				alreadyStamped: notesAlready,
				stamped: 0,
				wouldStamp: 0,
				ownerNotDerivable: notesNotDerivable,
				truncated: notesTruncated,
			},
		};
	},
});
