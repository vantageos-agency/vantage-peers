import { ConvexError, v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { resolveProvisioningMapping } from "./lib/provisioningMapping";

// ─────────────────────────────────────────────────────────────────────────────
// onboardPerson:readOrgState — the READ half of scripts/onboard-person.mjs
// (VantagePeers Cloud, task k178xp66h7p0ds6vg69sqzw2vn8hbfrw). Operator door
// (`convex run`): the script reads what exists so a re-run changes nothing.
// internalQuery: unreachable from any client. Writes nothing. It does NOT return the rosters
// (allowedAgentIds / allowedOrchestrators): the script reads those through the allow-listed
// `data client_org_mapping` door, so this function reads no scope field of the mapping.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_READ_CAP = 500;

export const readOrgState = internalQuery({
	args: { clerkOrgSlug: v.string() },
	returns: v.object({
		mapping: v.union(
			v.null(),
			v.object({
				id: v.id("client_org_mapping"),
				orgKind: v.union(v.literal("operator"), v.literal("client")),
				clerkOrgId: v.union(v.string(), v.null()),
				isActive: v.boolean(),
			}),
		),
		agents: v.array(
			v.object({
				id: v.id("agents"),
				name: v.string(),
				isActive: v.boolean(),
				clerkOrgId: v.union(v.string(), v.null()),
				personalAgentOf: v.union(v.string(), v.null()),
				invite: v.union(v.null(), v.object({ email: v.string() })),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const provisioned = await resolveProvisioningMapping(ctx, args.clerkOrgSlug);
		const row = provisioned.kind === "row" ? provisioned.row : null;
		const rows = await ctx.db
			.query("agents")
			.withIndex("by_org", (q) => q.eq("orgSlug", args.clerkOrgSlug))
			.take(AGENT_READ_CAP + 1);
		if (rows.length > AGENT_READ_CAP) {
			throw new ConvexError(
				`ONBOARD_STATE_OVER_CAP: "${args.clerkOrgSlug}" holds more than ${AGENT_READ_CAP} agents; refusing to plan from a partial read`,
			);
		}
		return {
			mapping:
				row === null
					? null
					: {
							id: row._id,
							orgKind: row.orgKind ?? "client",
							clerkOrgId: row.clerkOrgId ?? null,
							isActive: row.isActive,
						},
			agents: rows.map((a) => ({
				id: a._id,
				name: a.name,
				isActive: a.isActive,
				clerkOrgId: a.clerkOrgId ?? null,
				personalAgentOf: a.personalAgentOf ?? null,
				invite: a.personalAgentInvite ? { email: a.personalAgentInvite.email } : null,
			})),
		};
	},
});
