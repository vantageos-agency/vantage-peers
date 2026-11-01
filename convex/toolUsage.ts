import { hasFleetRead, sameOrg } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./lib/functions";
import {
	ORG_ADMIN_ROLES,
	type OrgScope,
	requireResolvedCaller,
	withOrgScope,
} from "./lib/auth";
import {
	resolveVerifiedPerson,
	verifiedPersonValidator,
} from "./lib/personPrincipal";

// ─────────────────────────────────────────────────────────────────────────────
// toolUsage — which MCP tools a caller has called, per organisation (task
// k17cbr6y6da096t5e1k869kgb18hd0ht). MECHANISM ONLY: the tool name, the first and
// last call time and a count, filed under (organisation, caller). It stores no
// argument, no content and no secret, and it names no business list: what a
// consumer does with "has this caller used tool X" lives in the consumer.
//
// WHO WRITES. The MCP tool wrapper (mcp-server/src/registerTool.ts) fires
// `toolUsage:record` after a tool call resolved, fire-and-forget. The ORGANISATION
// is never an argument: it is the organisation the call acts in (the Clerk JWT's
// `org_id`, or the service account's `__actingOrg`). The CALLER KEY is
//   - a Clerk session (the member's own JWT): "user:<verified subject>", always
//     derived here; the `caller` argument is ignored for it;
//   - the fleet service account acting for an organisation (a seat or person
//     bearer): the key the MCP derived from the bearer's verified oauthContext,
//     believed from the service transport only, filed under the acting org only;
//   - the fleet service account with NO acting org (the master bearer): nothing
//     is recorded. Fleet operators are not an organisation's callers.
// A missing identity, an unresolved organisation and a malformed key record
// nothing and return `{ recorded: false }`: a recorder never refuses a tool.
//
// WHO READS. `toolUsage:getToolUsage` (one caller) and `toolUsage:usageByOwner`
// (a person across every agent it owns, aggregated): a caller reads its OWN rows; an
// organisation admin (verified `org:admin` / `admin` role claim) or the fleet
// reads any caller of the organisation in scope. Another organisation, another
// caller without admin standing, and a caller with no credential are RAISED
// (RBAC_DENIED), never answered with an empty list: an empty result means a
// scoped caller with no rows.
//
// CONTENTION. One row per (organisation, caller, tool), patched in place. Two
// writers touch the same document only when the SAME caller calls the SAME tool
// twice at once; Convex retries that optimistic conflict, and the recording is
// fire-and-forget, so nobody waits on it. The sharded counter of nameOnlyCalls
// is for a counter every caller of a door increments; here the key space is
// already per caller, so shards would only turn one read into eight.
// ─────────────────────────────────────────────────────────────────────────────

/** Distinct tools filed per (organisation, caller): a bound on rows a caller can make. */
export const MAX_TOOLS_PER_CALLER = 128;

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const CALLER_KEY = /^(user|agent):[^\s]{1,190}$/;

const READ_DOOR = "toolUsage:getToolUsage";
const OWNER_DOOR = "toolUsage:usageByOwner";

const usageRow = v.object({
	tool: v.string(),
	firstAt: v.number(),
	lastAt: v.number(),
	count: v.number(),
});

function denied(door: string, reason: string, orgId: string | null): never {
	throw new ConvexError(
		`RBAC_DENIED: "${door}" refuses this caller — ${JSON.stringify({
			registration: door,
			orgId,
			reason,
		})}`,
	);
}

export const record = mutation({
	args: {
		toolName: v.string(),
		// Believed from the fleet service transport acting for an organisation
		// ONLY; for a Clerk session the key is the verified subject.
		caller: v.optional(v.string()),
	},
	returns: v.object({ recorded: v.boolean() }),
	handler: async (ctx, args) => {
		const none = { recorded: false };
		if (!TOOL_NAME.test(args.toolName)) return none;
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (scope.anonymous === true || scope.refused === true) return none;
		// The master bearer (fleet service account, no acting org) is not an
		// organisation's caller.
		if (scope.isMaster) return none;
		const orgId = scope.orgClerkId;
		if (orgId === undefined || orgId === "") return none;
		const callerKey =
			scope.serviceTransport === true
				? args.caller
				: `user:${scope.userId}`;
		if (callerKey === undefined || !CALLER_KEY.test(callerKey)) return none;

		const now = Date.now();
		const existing = await ctx.db
			.query("tool_usage")
			.withIndex("by_org_caller_tool", (q) =>
				q.eq("clerkOrgId", orgId).eq("callerKey", callerKey).eq("tool", args.toolName),
			)
			.unique();
		if (existing !== null) {
			await ctx.db.patch(existing._id, {
				count: existing.count + 1,
				lastAt: now,
			});
			return { recorded: true };
		}
		const filed = await ctx.db
			.query("tool_usage")
			.withIndex("by_org_caller", (q) =>
				q.eq("clerkOrgId", orgId).eq("callerKey", callerKey),
			)
			.take(MAX_TOOLS_PER_CALLER);
		if (filed.length >= MAX_TOOLS_PER_CALLER) return none;
		await ctx.db.insert("tool_usage", {
			clerkOrgId: orgId,
			callerKey,
			tool: args.toolName,
			firstAt: now,
			lastAt: now,
			count: 1,
		});
		return { recorded: true };
	},
});

const readerArgs = {
	// Fleet standing only: names the organisation (a permanent Clerk org ID).
	// Any other caller may pass its own organisation's ID or nothing.
	orgId: v.optional(v.string()),
	// The reader's own key, forwarded by the MCP from the bearer's verified
	// oauthContext; believed from the service transport acting for an
	// organisation only (a Clerk session is keyed by its subject).
	selfKey: v.optional(v.string()),
	// A person bearer: the organisation, the subject and the admin role are
	// re-read from the token row (convex/lib/personPrincipal.ts).
	verifiedPerson: v.optional(verifiedPersonValidator),
};

type Reader = {
	orgId: string;
	/** The reader's own key, when it has one. */
	self: string | undefined;
	/** May read any caller of `orgId`: fleet, org admin, or the org-scoped service caller. */
	admin: boolean;
};

/**
 * Who is reading and in which organisation. Shared by both read doors.
 *
 * Standing to read ANY caller of the organisation in scope:
 *   - fleet standing (the master), which names the organisation;
 *   - a verified organisation admin role (Clerk session or person token);
 *   - the ORG-SCOPED SERVICE CALLER: the fleet service account acting for an
 *     organisation (`__actingOrg`) that presents NO identity of its own (neither
 *     `selfKey` nor `verifiedPerson`) - a server process (the onboarding engine)
 *     serving that tenant. The MCP never reaches this branch: its get_tool_usage
 *     tool refuses a bearer that resolves no identity before any call.
 * A seat or a plain member reads its own rows only.
 */
async function resolveReader(
	ctx: Parameters<typeof withOrgScope>[0],
	args: {
		orgId?: string;
		selfKey?: string;
		verifiedPerson?: { accessTokenHash: string };
	},
	door: string,
): Promise<Reader> {
	const transport = await withOrgScope(ctx, { refuseWithoutThrow: true });
	requireResolvedCaller(transport, door, { alsoRefusePreOrg: true });
	const scope = await resolveVerifiedPerson(
		ctx,
		transport,
		args.verifiedPerson,
		{ door },
	);
	const fleet = hasFleetRead(scope);

	let orgId: string;
	if (fleet) {
		if (args.orgId === undefined || args.orgId === "") {
			throw new ConvexError(
				`ORG_REQUIRED: "${door}" read with fleet standing needs \`orgId\`, the organisation to read`,
			);
		}
		orgId = args.orgId;
	} else {
		const own = scope.orgClerkId;
		if (own === undefined || own === "") {
			denied(door, "no-organisation-id", null);
		}
		if (args.orgId !== undefined && !sameOrg({ id: args.orgId }, { id: own })) {
			denied(door, "cross-organisation", args.orgId);
		}
		orgId = own;
	}

	const personal = args.verifiedPerson !== undefined;
	const orgScopedService =
		transport.serviceTransport === true &&
		!personal &&
		args.selfKey === undefined;
	const self = selfKeyOf(scope, personal, args.selfKey);
	const adminRole =
		scope.orgRole !== undefined && ORG_ADMIN_ROLES.includes(scope.orgRole);
	return { orgId, self, admin: fleet || adminRole || orgScopedService };
}

function selfKeyOf(
	scope: OrgScope,
	personal: boolean,
	selfKey: string | undefined,
): string | undefined {
	if (hasFleetRead(scope)) return undefined;
	if (scope.serviceTransport === true && !personal) return selfKey;
	return `user:${scope.userId}`;
}

async function rowsOfCaller(
	ctx: QueryCtx,
	orgId: string,
	callerKey: string,
): Promise<Doc<"tool_usage">[]> {
	return await ctx.db
		.query("tool_usage")
		.withIndex("by_org_caller", (q) =>
			q.eq("clerkOrgId", orgId).eq("callerKey", callerKey),
		)
		.take(MAX_TOOLS_PER_CALLER);
}

const byTool = (a: { tool: string }, b: { tool: string }) =>
	a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0;

export const getToolUsage = query({
	args: {
		// The caller to read; omitted: the reader's own rows.
		caller: v.optional(v.string()),
		...readerArgs,
	},
	returns: v.array(usageRow),
	handler: async (ctx, args) => {
		// isolation-contract: no reactive subscriber exists - this door is new in
		// task k17cbr6y6da096t5e1k869kgb18hd0ht and its only caller is the MCP
		// tool get_tool_usage (imperative); a throw cannot crash a render.
		const reader = await resolveReader(ctx, args, READ_DOOR);
		const target = args.caller ?? reader.self;
		if (target === undefined) {
			throw new ConvexError(
				`CALLER_REQUIRED: "${READ_DOOR}" cannot tell whose rows to read - pass \`caller\``,
			);
		}
		if (!CALLER_KEY.test(target)) {
			throw new ConvexError(
				`INVALID_CALLER_KEY: "${target}" is not "user:<subject>" or "agent:<agent id>"`,
			);
		}
		if (target !== reader.self && !reader.admin) {
			denied(READ_DOOR, "not-org-admin", reader.orgId);
		}
		const rows = await rowsOfCaller(ctx, reader.orgId, target);
		return rows
			.map((r) => ({
				tool: r.tool,
				firstAt: r.firstAt,
				lastAt: r.lastAt,
				count: r.count,
			}))
			.sort(byTool);
	},
});

/** Agents of one owner read per call: a person owns a handful, one per AI client. */
export const MAX_AGENTS_PER_OWNER = 50;

/**
 * usageByOwner - the tools a PERSON has used across everything it owns, in one
 * organisation: every agent of the organisation whose `personalAgentOf` is the
 * owner (one per AI client), plus the owner's own direct calls (a Clerk session
 * or person token files under "user:<owner>"). Per tool: firstAt = min,
 * lastAt = max, count = sum. Per-caller rows stay the storage; this is a read.
 *
 * Standing: the owner reads itself; an organisation admin, the fleet and the
 * org-scoped service caller read any member of THEIR organisation. A plain
 * member asking for ANOTHER member is refused (members do not read each other).
 * The owner must belong to the organisation in scope (a live `orgMembership`
 * row, or an agent of that organisation designating it): an owner of another
 * organisation is RBAC_DENIED, never an empty list. A member with no agents and
 * no direct calls is an empty SUCCESS.
 */
export const usageByOwner = query({
	args: { ownerUserId: v.string(), ...readerArgs },
	returns: v.array(usageRow),
	handler: async (ctx, args) => {
		// isolation-contract: no reactive subscriber exists - this door is new in
		// task k17cbr6y6da096t5e1k869kgb18hd0ht; its callers are the MCP tool
		// get_owner_tool_usage (imperative) and the onboarding engine (a server).
		const door = OWNER_DOOR;
		const reader = await resolveReader(ctx, args, door);
		if (args.ownerUserId === "" || /\s/.test(args.ownerUserId)) {
			throw new ConvexError(
				`INVALID_OWNER: "${door}" needs the owner's Clerk user id`,
			);
		}
		const ownKey = `user:${args.ownerUserId}`;
		if (ownKey !== reader.self && !reader.admin) {
			denied(door, "not-org-admin", reader.orgId);
		}

		const agents = await ctx.db
			.query("agents")
			.withIndex("by_personal_agent_of_clerk_id", (q) =>
				q.eq("personalAgentOf", args.ownerUserId).eq("clerkOrgId", reader.orgId),
			)
			.take(MAX_AGENTS_PER_OWNER);
		const membership = await ctx.db
			.query("orgMembership")
			.withIndex("by_org_user_clerk_id", (q) =>
				q.eq("clerkOrgId", reader.orgId).eq("clerkUserId", args.ownerUserId),
			)
			.unique();
		const isMember = membership !== null && membership.deletedAt === undefined;
		if (!isMember && agents.length === 0) {
			denied(door, "owner-not-in-organisation", reader.orgId);
		}

		const merged = new Map<
			string,
			{ tool: string; firstAt: number; lastAt: number; count: number }
		>();
		const keys = [ownKey, ...agents.map((a) => `agent:${a._id}`)];
		for (const key of keys) {
			for (const r of await rowsOfCaller(ctx, reader.orgId, key)) {
				const seen = merged.get(r.tool);
				if (seen === undefined) {
					merged.set(r.tool, {
						tool: r.tool,
						firstAt: r.firstAt,
						lastAt: r.lastAt,
						count: r.count,
					});
				} else {
					seen.firstAt = Math.min(seen.firstAt, r.firstAt);
					seen.lastAt = Math.max(seen.lastAt, r.lastAt);
					seen.count += r.count;
				}
			}
		}
		return [...merged.values()].sort(byTool);
	},
});
