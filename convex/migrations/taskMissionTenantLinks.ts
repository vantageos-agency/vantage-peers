// taskMissionTenantLinks -- READ-ONLY, COUNTS-ONLY measurement of how many stored
// tasks reference a mission of ANOTHER tenant, or a mission that does not exist
// (task k175x770r9f6h01xt0wg0hdd798hf8m4). It decides nothing and migrates nothing.
//
//   migrations/taskMissionTenantLinks:count   ({} or {"limit": N, "cursor": "<nextCursor>"})
//
// Internal: reachable only with the deployment admin credential. The output holds
// counts and org slugs only: never a task or mission id, title or any row content.
// The tenant rule is the one the write doors enforce (lib/missionTenant.ts):
// `sameTenantStamp` over the mission's and the task's server-stamped org.
//
// Bounded: one call reads at most `limit` task rows (default 1000, hard max 2000)
// through `.paginate`. When the table holds more, `truncated` is true and
// `nextCursor` is the opaque cursor of the next page; the counts of one call are
// then a LOWER BOUND over the table, and the caller sums the pages until
// `nextCursor` is null.

import { sameTenantStamp } from "@vantageos/cloud-identity";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { orgRefOfRow } from "../lib/authOrgMapping";
import { fleetOperatorRef } from "../lib/operatorOrg";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 2000;
const NO_ORG = "(none)";

export const count = internalQuery({
	args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
	returns: v.object({
		examined: v.number(),
		withMissionId: v.number(),
		own: v.number(),
		foreign: v.number(),
		dangling: v.number(),
		// Keyed by the TASK's own org slug; "(none)" = the task carries no slug.
		perOrg: v.array(
			v.object({ org: v.string(), foreign: v.number(), dangling: v.number() }),
		),
		truncated: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const numItems = Math.min(
			Math.max(Math.floor(args.limit ?? DEFAULT_LIMIT) || 1, 1),
			MAX_LIMIT,
		);
		const page = await ctx.db
			.query("tasks")
			.paginate({ numItems, cursor: args.cursor ?? null });
		const operatorRef = await fleetOperatorRef(ctx.db);
		const missions = new Map<string, Doc<"missions"> | null>();
		const perOrg = new Map<string, { foreign: number; dangling: number }>();
		let withMissionId = 0;
		let own = 0;
		let foreign = 0;
		let dangling = 0;
		for (const task of page.page) {
			if (task.missionId === undefined) continue;
			withMissionId++;
			const key: string = task.missionId;
			if (!missions.has(key)) {
				missions.set(key, await ctx.db.get(task.missionId as Id<"missions">));
			}
			const mission = missions.get(key) ?? null;
			const org = task.orgId || NO_ORG;
			const bucket = perOrg.get(org) ?? { foreign: 0, dangling: 0 };
			if (mission === null) {
				dangling++;
				bucket.dangling++;
			} else if (
				sameTenantStamp(orgRefOfRow(mission), orgRefOfRow(task), operatorRef)
			) {
				own++;
			} else {
				foreign++;
				bucket.foreign++;
			}
			perOrg.set(org, bucket);
		}
		return {
			examined: page.page.length,
			withMissionId,
			own,
			foreign,
			dangling,
			perOrg: [...perOrg.entries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([org, c]) => ({ org, ...c })),
			truncated: !page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
