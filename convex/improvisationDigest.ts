import { hasFleetRead } from "@vantageos/cloud-identity";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import {
	filterByOrgScope,
	isMcpBoundMaster,
	verifiedActorValidator,
	withOrgScope,
} from "./lib/auth";
import { requireFleetAgentActor } from "./lib/fleetActors";

// ─────────────────────────────────────────────────────────────────────────────
// improvisationDigest — PR-I T-GREEN
//
// V1 data source = VP tasks + messages + memories (Pi-approved Option C).
// Transcript replay (Option A) is reserved for V2.
//
// Detection heuristic (Eta A5):
//   DURABLE ARTIFACT = closed task (completionNote) | broadcast/DM message | memory
//   FLEET/STATE SCOPE FILTER = artifact text matches SHA | PR# | VP id | decisive verb
//   IMPROVISATION FLAG = passes scope filter AND has NO VP-Sources footer
//   MODE = ADVISORY only — never blocks.
// ─────────────────────────────────────────────────────────────────────────────

// Regex patterns for Eta A5 fleet/state scope filter
const SHA_RE = /\b[0-9a-f]{7,40}\b/;
const PR_RE = /\B#\d{2,5}\b/;
const VP_ID_RE = /\b[jkm][0-9a-z]{20,}\b/;
const DECISIVE_VERB_RE =
	/\b(merged|deployed|tested|approved|reviewed|verified|passed|failed|landed|shipped)\b/i;

// VP-Sources footer proxy patterns (recall upstream)
const FOOTER_RE =
	/VP-Sources:\s*(recall|search|hybrid)\("[^"]*"\)\s*→\s*\[[^\]]*\]/;
const NONE_NEEDED_RE = /none-needed:\s*\S+/;

function passesFleetFilter(text: string): boolean {
	return (
		SHA_RE.test(text) ||
		PR_RE.test(text) ||
		VP_ID_RE.test(text) ||
		DECISIVE_VERB_RE.test(text)
	);
}

function hasFooter(text: string): boolean {
	return FOOTER_RE.test(text) || NONE_NEEDED_RE.test(text);
}

// R-20 — per-run scan bound. scanWindow previously `.collect()`-ed the
// entire `tasks`/`messages`/`memories` tables before filtering by
// `windowDays` — wide-scan-cap pattern (see convex/tasks.ts
// TASK_LIST_SCAN_CAP, convex/recurringTasks.ts
// RECURRING_TASKS_LIST_SCAN_CAP): fetch is capped, not the table.
const DIGEST_TASKS_SCAN_CAP = 2000;
const DIGEST_MESSAGES_SCAN_CAP = 2000;
const DIGEST_MEMORIES_SCAN_CAP = 2000;

// R-55: the window is read newest-first in bounded pages, each page cut by an
// index RANGE that already holds the tenant and the time cutoff. The caller's
// remaining predicates (roster, `orchestrators`) run per row in the loop that
// fills the capped window, so a row the caller may not see never uses a slot and
// the scan ends at the cap, at the end of the range, or when a page yields
// nothing new (rows tying on the cursor key are de-duplicated by id).
const DIGEST_SCAN_PAGE = 250;

async function* newestFirst<T extends { _id: string }>(
	page: (before: number | undefined) => Promise<T[]>,
	cursorOf: (row: T) => number,
): AsyncGenerator<T> {
	const seen = new Set<string>();
	let before: number | undefined;
	for (;;) {
		const batch = await page(before);
		let fresh = 0;
		for (const row of batch) {
			if (seen.has(row._id)) continue;
			seen.add(row._id);
			fresh += 1;
			yield row;
		}
		if (batch.length < DIGEST_SCAN_PAGE || fresh === 0) return;
		before = cursorOf(batch[batch.length - 1]);
	}
}

export const scanWindow = query({
	args: {
		windowDays: v.number(),
		orchestrators: v.optional(v.array(v.string())),
		// The acting agent the MCP transport verified, for a call that reaches
		// Convex as the fleet service account (which carries no organisation of
		// its own). Required of that account: the claimless call is refused.
		verifiedActor: v.optional(verifiedActorValidator),
	},
	returns: v.object({
		countsByOrch: v.any(),
		countsByCategory: v.any(),
		samples: v.array(v.any()),
	}),
	handler: async (ctx, args) => {
		// THE TENANT BOUNDARY, through the same mechanism as every other scoped
		// reader (withOrgScope + filterByOrgScope). This digest reads three tables
		// fleet-wide; it is a fleet tool (the MCP tool is master-only), so:
		//   - anonymous / no-organisation caller -> typed-empty digest;
		//   - master (the service account)       -> every tenant, unchanged;
		//   - an ordinary org member             -> its OWN tenant's tasks and
		//     messages only. `memories` carries no tenant stamp at all, so an
		//     org-scoped caller is served NONE of them: absence of a stamp
		//     asserts nothing and grants nothing.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		// R-54: the fleet service account reads every tenant, so it is served only
		// with the acting agent's verified ID. `requireFleetAgentActor` believes the
		// claim from that account alone, loads the agents row BY ID and refuses an
		// agent of any other organisation than the operator's; with no claim it
		// refuses (RBAC_DENIED `verified-actor-required`). An org member is not the
		// service account and carries no claim.
		if (isMcpBoundMaster(scope) || args.verifiedActor !== undefined) {
			await requireFleetAgentActor(ctx, scope, args.verifiedActor, "improvisationDigest:scanWindow");
		}
		const callerOrg = scope.orgSlug;
		if (scope.refused || (!hasFleetRead(scope) && callerOrg === null)) {
			return {
				countsByOrch: {},
				countsByCategory: {
					complete_task: 0,
					send_message: 0,
					store_memory: 0,
				},
				samples: [],
			};
		}
		const cutoff = Date.now() - args.windowDays * 24 * 60 * 60 * 1000;
		const orchFilter = args.orchestrators;

		type SampleEntry = {
			orchestrator: string;
			day: string;
			category: "complete_task" | "send_message" | "store_memory";
			snippet: string;
			artifactId: string;
			creationTime: number;
		};

		const flagged: SampleEntry[] = [];

		// R-55: every caller-dependent predicate sits in the index range or in the
		// loop that fills the capped window, never on a window already cut.
		//   - tenant: a member's own organisation LEADS the range (`by_orgId_status`,
		//     `by_tenant_created`), so a foreign row is never read and cannot take a
		//     slot of the cap;
		//   - window: the cutoff is the range bound (`_creationTime` / `createdAt`),
		//     so the cap bounds rows INSIDE the window, not rows of all time;
		//   - roster, `orchestrators` filter: applied per streamed row, ahead of the
		//     count the cap bounds (a fill loop that stops at DIGEST_*_SCAN_CAP kept
		//     rows), so a row the caller may not see never uses a slot.
		// The fleet reads the window across every tenant, unchanged.
		const fleetRead = hasFleetRead(scope);

		// ── 1. Tasks (complete_task) ──────────────────────────────────────────
		const doneTasks: Doc<"tasks">[] = [];
		for await (const task of newestFirst(
			(before) =>
				fleetRead
					? ctx.db
							.query("tasks")
							.withIndex("by_creation_time", (q) =>
								before === undefined
									? q.gte("_creationTime", cutoff)
									: q.gte("_creationTime", cutoff).lt("_creationTime", before),
							)
							.order("desc")
							.take(DIGEST_SCAN_PAGE)
					: ctx.db
							.query("tasks")
							.withIndex("by_orgId_status", (q) => {
								const own = q
									.eq("orgId", callerOrg as string)
									.eq("status", "done");
								return before === undefined
									? own.gte("_creationTime", cutoff)
									: own.gte("_creationTime", cutoff).lt("_creationTime", before);
							})
							.order("desc")
							.take(DIGEST_SCAN_PAGE),
			(row) => row._creationTime,
		)) {
			if (task.status !== "done") continue;
			if (!fleetRead && filterByOrgScope([task], scope).length === 0) continue;
			if (orchFilter && !orchFilter.includes(task.assignedTo)) continue;
			doneTasks.push(task);
			if (doneTasks.length >= DIGEST_TASKS_SCAN_CAP) break;
		}

		for (const task of doneTasks) {
			if (!task.completionNote) continue;

			const owner = task.assignedTo;
			const text = task.completionNote;
			if (!passesFleetFilter(text)) continue;
			if (hasFooter(text)) continue;

			flagged.push({
				orchestrator: owner,
				day: new Date(task._creationTime).toISOString().slice(0, 10),
				category: "complete_task",
				snippet: text.slice(0, 200),
				artifactId: task._id,
				creationTime: task._creationTime,
			});
		}

		// ── 2. Messages (send_message) ────────────────────────────────────────
		// Newest-first so the cap selects the most-recent rows (Eta #1252).
		const recentMessages: Doc<"messages">[] = [];
		for await (const msg of newestFirst(
			(before) =>
				fleetRead
					? ctx.db
							.query("messages")
							.withIndex("by_creation_time", (q) =>
								before === undefined
									? q.gte("_creationTime", cutoff)
									: q.gte("_creationTime", cutoff).lt("_creationTime", before),
							)
							.order("desc")
							.take(DIGEST_SCAN_PAGE)
					: ctx.db
							.query("messages")
							.withIndex("by_tenant_created", (q) => {
								const own = q.eq("tenantId", callerOrg as string);
								return before === undefined
									? own.gte("createdAt", cutoff)
									: own.gte("createdAt", cutoff).lte("createdAt", before);
							})
							.order("desc")
							.take(DIGEST_SCAN_PAGE),
			(row) => (fleetRead ? row._creationTime : row.createdAt),
		)) {
			if (orchFilter && !orchFilter.includes(msg.from)) continue;
			recentMessages.push(msg);
			if (recentMessages.length >= DIGEST_MESSAGES_SCAN_CAP) break;
		}

		for (const msg of recentMessages) {
			const owner = msg.from;
			const text = msg.content;
			if (!passesFleetFilter(text)) continue;
			if (hasFooter(text)) continue;

			flagged.push({
				orchestrator: owner,
				day: new Date(msg._creationTime).toISOString().slice(0, 10),
				category: "send_message",
				snippet: text.slice(0, 200),
				artifactId: msg._id,
				creationTime: msg._creationTime,
			});
		}

		// ── 3. Memories (store_memory) ────────────────────────────────────────
		// `memories` carries no tenant stamp: only the fleet reads them. Newest-first
		// over the window (Eta #1252).
		const recentMemories: Doc<"memories">[] = [];
		if (fleetRead) {
			for await (const mem of newestFirst(
				(before) =>
					ctx.db
						.query("memories")
						.withIndex("by_creation_time", (q) =>
							before === undefined
								? q.gte("_creationTime", cutoff)
								: q.gte("_creationTime", cutoff).lt("_creationTime", before),
						)
						.order("desc")
						.take(DIGEST_SCAN_PAGE),
				(row) => row._creationTime,
			)) {
				if (orchFilter && !orchFilter.includes(mem.createdBy)) continue;
				recentMemories.push(mem);
				if (recentMemories.length >= DIGEST_MEMORIES_SCAN_CAP) break;
			}
		}

		for (const mem of recentMemories) {
			const owner = mem.createdBy;
			const text = mem.content;
			if (!passesFleetFilter(text)) continue;
			if (hasFooter(text)) continue;

			flagged.push({
				orchestrator: owner,
				day: new Date(mem._creationTime).toISOString().slice(0, 10),
				category: "store_memory",
				snippet: text.slice(0, 200),
				artifactId: mem._id,
				creationTime: mem._creationTime,
			});
		}

		// ── Aggregation ───────────────────────────────────────────────────────
		const countsByOrch: Record<string, number> = {};
		const countsByCategory = {
			complete_task: 0,
			send_message: 0,
			store_memory: 0,
		};

		for (const entry of flagged) {
			countsByOrch[entry.orchestrator] =
				(countsByOrch[entry.orchestrator] ?? 0) + 1;
			countsByCategory[entry.category] += 1;
		}

		// Sort newest first, cap samples at 50
		flagged.sort((a, b) => b.creationTime - a.creationTime);
		const samples = flagged.slice(0, 50).map(
			({ orchestrator, day, category, snippet, artifactId }) => ({
				orchestrator,
				day,
				category,
				snippet,
				artifactId,
			}),
		);

		console.log(
			`[improvisationDigest] scanWindow(${args.windowDays}d): scanned tasks<=${DIGEST_TASKS_SCAN_CAP} messages<=${DIGEST_MESSAGES_SCAN_CAP} memories<=${DIGEST_MEMORIES_SCAN_CAP}, flagged ${flagged.length}.`,
		);

		return { countsByOrch, countsByCategory, samples };
	},
});
