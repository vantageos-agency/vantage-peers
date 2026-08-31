import { v } from "convex/values";
import { query } from "./_generated/server";

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

		// ── 1. Tasks (complete_task) ──────────────────────────────────────────
		// Use by_status index to get done tasks, then filter by time
		const doneTasks = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) =>
				q.eq("status", "done"),
			)
			.order("desc")
			.take(DIGEST_TASKS_SCAN_CAP);

		for (const task of doneTasks) {
			if (task._creationTime < cutoff) continue;
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
		const recentMessages = await ctx.db
			.query("messages")
			.order("desc")
			.take(DIGEST_MESSAGES_SCAN_CAP);

		for (const msg of recentMessages) {
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
		const recentMemories = await ctx.db
			.query("memories")
			.order("desc")
			.take(DIGEST_MEMORIES_SCAN_CAP);

		for (const mem of recentMemories) {
			if (mem._creationTime < cutoff) continue;

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
