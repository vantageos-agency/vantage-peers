import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

// nameOnlyCalls:summary — the counts per door over a window of UTC days. Internal:
// run it with `npx convex run nameOnlyCalls:summary '{"fromDay":"2026-10-21","toDay":"2026-10-21"}'`.
// The window is inclusive on both ends. A door with no calls in the window is
// absent from the result (an absence of rows, not a refusal): read an empty
// array as "no name-only call in that window".
export const MAX_WINDOW_DAYS = 400;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const summary = internalQuery({
	args: { fromDay: v.string(), toDay: v.string() },
	returns: v.array(v.object({ door: v.string(), count: v.number() })),
	handler: async (ctx, args) => {
		if (!DAY.test(args.fromDay) || !DAY.test(args.toDay)) {
			throw new Error(
				`INVALID_DAY: fromDay and toDay are UTC days "YYYY-MM-DD" — received ${args.fromDay}, ${args.toDay}`,
			);
		}
		if (args.fromDay > args.toDay) {
			throw new Error(
				`INVALID_DAY: fromDay ${args.fromDay} is after toDay ${args.toDay}`,
			);
		}
		const span =
			(Date.parse(args.toDay) - Date.parse(args.fromDay)) / 86_400_000 + 1;
		if (!(span <= MAX_WINDOW_DAYS)) {
			throw new Error(
				`INVALID_DAY: the window is ${span} days, the maximum is ${MAX_WINDOW_DAYS}`,
			);
		}
		const totals = new Map<string, number>();
		// Bounded: one row per (door, day, shard), 5 doors x 8 shards x <= 400 days.
		const rows = await ctx.db
			.query("nameOnlyCalls")
			.withIndex("by_day", (q) =>
				q.gte("day", args.fromDay).lte("day", args.toDay),
			)
			.take(20_000);
		for (const row of rows) {
			totals.set(row.door, (totals.get(row.door) ?? 0) + row.count);
		}
		return [...totals.entries()]
			.map(([door, count]) => ({ door, count }))
			.sort((a, b) => (a.door < b.door ? -1 : 1));
	},
});
