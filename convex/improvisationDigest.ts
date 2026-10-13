import { hasFleetRead } from "@vantageos/cloud-identity";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { scopedRowFilter } from "./lib/actingPrincipal";
import { requireResolvedCaller, withOrgScope } from "./lib/auth";

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

// fleet-wide: the digest reads tasks, messages and memories across the whole fleet by purpose and its MCP tool is master-only; the fleet standing reads every tenant, an organisation member is confined to its own tenant's tasks and messages and is served no memories.
export const scanWindow = query({
	args: {
		windowDays: v.number(),
		orchestrators: v.optional(v.array(v.string())),
	},
	returns: v.object({
		countsByOrch: v.any(),
		countsByCategory: v.any(),
		samples: v.array(v.any()),
	}),
	handler: async (ctx, args) => {
		// THE TENANT BOUNDARY, through the same mechanism as every other scoped
		// reader (withOrgScope + the package's scoped row filter). This digest reads three tables
		// fleet-wide; it is a fleet tool (the MCP tool is master-only), so:
		//   - anonymous / no-organisation caller -> typed-empty digest;
		//   - master (the service account)       -> every tenant, unchanged;
		//   - an ordinary org member             -> its OWN tenant's tasks and
		//     messages only. `memories` carries no tenant stamp at all, so an
		//     org-scoped caller is served NONE of them: absence of a stamp
		//     asserts nothing and grants nothing.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
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

		// Every source is READ through its range and narrowed while it is read: the
		// time window and the orchestrator filter are applied to each row as it
		// streams, and the scan cap bounds how many rows a source READS, so the cap
		// never cuts a window first and narrows it after. Where the source is read
		// by creation time alone, the window is part of the range itself.
		const fleetRead = hasFleetRead(scope);

		// ── 1. Tasks (complete_task) ──────────────────────────────────────────
		// A non-master tenant is pushed into the `by_orgId` index, so another
		// tenant's rows cannot crowd the caller's own out of the scan.
		let tasksScanned = 0;
		const visible = await scopedRowFilter(ctx, scope, "improvisationDigest:scanWindow");
		for await (const task of fleetRead || callerOrg === null
			? ctx.db
					.query("tasks")
					.withIndex("by_status", (q) => q.eq("status", "done"))
					.order("desc")
			: ctx.db
					.query("tasks")
					.withIndex("by_orgId", (q) => q.eq("orgId", callerOrg))
					.order("desc")) {
			if (++tasksScanned > DIGEST_TASKS_SCAN_CAP) break;
			if (task._creationTime < cutoff) continue;
			if (task.status !== "done") continue;
			if (!fleetRead && (await visible([task])).length === 0) continue;
			if (!task.completionNote) continue;

			const owner = task.assignedTo;
			if (orchFilter && !orchFilter.includes(owner)) continue;

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
		// Newest-first by _creationTime (the default index) so the cap selects the
		// most-recent rows, not the alphabetically-last senders — by_from carries no
		// time column, so ordering by it and take()-ing biases the selection (Eta #1252).
		let messagesScanned = 0;
		for await (const msg of fleetRead || callerOrg === null
			? ctx.db
					.query("messages")
					.withIndex("by_creation_time", (q) => q.gte("_creationTime", cutoff))
					.order("desc")
			: ctx.db
					.query("messages")
					.withIndex("by_tenant_created", (q) => q.eq("tenantId", callerOrg))
					.order("desc")) {
			if (++messagesScanned > DIGEST_MESSAGES_SCAN_CAP) break;
			if (msg._creationTime < cutoff) continue;

			const owner = msg.from;
			if (orchFilter && !orchFilter.includes(owner)) continue;

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
		// Newest-first by _creationTime (default index) — by_creator has no time
		// column, so ordering by it biases recency out of the selection (Eta #1252).
		// `memories` carries no tenant stamp: only the fleet reads them.
		if (fleetRead) {
			// `memories` is read here without a tenant predicate, so the read states
			// its own reach: only the fleet master gets this far.
			requireResolvedCaller(scope, "improvisationDigest:scanWindow", {
				masterOnly: true,
			});
			let memoriesScanned = 0;
			for await (const mem of ctx.db
				.query("memories")
				.withIndex("by_creation_time", (q) => q.gte("_creationTime", cutoff))
				.order("desc")) {
				if (++memoriesScanned > DIGEST_MEMORIES_SCAN_CAP) break;

				const owner = mem.createdBy;
				if (orchFilter && !orchFilter.includes(owner)) continue;

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
