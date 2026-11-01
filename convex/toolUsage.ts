import { sameOrg } from "@vantageos/cloud-identity";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { ownerMembershipLookups } from "./lib/actingPrincipal";
import {
	isMcpBoundMaster,
	isServiceTransport,
	ORG_ADMIN_ROLES,
	type OrgScope,
	requireResolvedCaller,
	withOrgScope,
} from "./lib/auth";
import { mutation, query } from "./lib/functions";
import { rbacDenied } from "./lib/inboxReader";
import {
	resolveVerifiedPerson,
	verifiedPersonValidator,
} from "./lib/personPrincipal";
import {
	resolveVerifiedOrgScope,
	verifiedOrgValidator,
} from "./lib/verifiedOrg";

// ─────────────────────────────────────────────────────────────────────────────
// toolUsage — which MCP tools a caller has called, per organisation (task
// k17cbr6y6da096t5e1k869kgb18hd0ht). MECHANISM ONLY: the tool name, the first and
// last call time and a count, filed under (organisation, caller). It stores no
// argument, no content and no secret, and it names no business list: what a
// consumer does with "has this caller used tool X" lives in the consumer.
//
// WHO WRITES. The MCP tool wrapper (mcp-server/src/registerTool.ts) fires
// `toolUsage:record` after a tool call resolved, fire-and-forget. The ORGANISATION
// is never a free argument: it is the organisation the call acts in (the Clerk
// JWT's `org_id`, or the service account's transport-verified `verifiedOrg` /
// `__actingOrg`). The CALLER KEY is
//   - a Clerk session (the member's own JWT): "user:<verified subject>", always
//     derived here; the `caller` argument is ignored for it;
//   - the fleet service account acting for an organisation (a seat or person
//     bearer): the key the MCP derived from the bearer's verified oauthContext,
//     believed from the service transport only, filed under that org only;
//   - the fleet service account with NO claim (R-54): REFUSED, never served as
//     master. The MCP never sends it: the master bearer is not recorded, fleet
//     operators are not an organisation's callers.
// An anonymous caller, an unresolved organisation and a malformed key record
// nothing and return `{ recorded: false }`: a recorder never fails a tool.
//
// WHO READS. `toolUsage:getToolUsage` (one caller) and `toolUsage:usageByOwner`
// (a person across every agent it owns, aggregated): a caller reads its OWN rows;
// an organisation admin (verified `org:admin` / `admin` role claim) or the
// ORG-SCOPED SERVICE CALLER reads any caller of its organisation. Another
// organisation, another caller without that standing, and a caller with no
// credential are RAISED (RBAC_DENIED), never answered with an empty list: an
// empty result means a scoped caller with no rows. Members do not read each
// other.
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
/** Agents of one owner read per call: a person owns a handful, one per AI client. */
export const MAX_AGENTS_PER_OWNER = 50;

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const CALLER_KEY = /^(user|agent):[^\s]{1,190}$/;

const RECORD_DOOR = "toolUsage:record";
const READ_DOOR = "toolUsage:getToolUsage";
const OWNER_DOOR = "toolUsage:usageByOwner";

const usageRow = v.object({
	tool: v.string(),
	firstAt: v.number(),
	lastAt: v.number(),
	count: v.number(),
});

/** Unreachable for a read (only the recorder resolves softly): said as a refusal, never as an empty list. */
function unresolved(door: string) {
	return rbacDenied(door, "unresolved", `"${door}" could not resolve its caller`);
}

/** R-54: the fleet service account that names no organisation is refused, never served as master. */
function refuseClaimlessServiceAccount(
	transport: OrgScope,
	claimed: boolean,
	door: string,
): void {
	if (isMcpBoundMaster(transport) && !claimed) {
		throw rbacDenied(
			door,
			"claimless-service-account",
			"the fleet service account acts inside a transport-verified organisation: this call carries no verified claim naming one",
		);
	}
}

export const record = mutation({
	args: {
		toolName: v.string(),
		// Believed from the fleet service transport ONLY; for a Clerk session or a
		// verified person the key is the verified subject and this is ignored.
		caller: v.optional(v.string()),
		verifiedPerson: v.optional(verifiedPersonValidator),
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: v.object({ recorded: v.boolean() }),
	handler: async (ctx, args) => {
		const none = { recorded: false };
		if (!TOOL_NAME.test(args.toolName)) return none;
		const reader = await resolveReader(ctx, args, RECORD_DOOR, true, args.caller);
		if (reader === null) return none;
		const { orgId, orgSlug } = reader;
		const callerKey = reader.trusted ? args.caller : reader.userKey;
		if (callerKey === undefined || !CALLER_KEY.test(callerKey)) return none;

		const now = Date.now();
		const existing = await ctx.db
			.query("tool_usage")
			.withIndex("by_org_caller_tool", (q) =>
				q
					.eq("clerkOrgId", orgId)
					.eq("callerKey", callerKey)
					.eq("tool", args.toolName),
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
			orgSlug,
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
	// The reader's own key, forwarded by the MCP from the bearer's verified
	// oauthContext; believed from the service transport only (a Clerk session is
	// keyed by its subject).
	selfKey: v.optional(v.string()),
	// A person bearer: the organisation, the subject and the admin role are
	// re-read from the token row (convex/lib/personPrincipal.ts).
	verifiedPerson: v.optional(verifiedPersonValidator),
	// The organisation the service account reads for (R-54).
	verifiedOrg: v.optional(verifiedOrgValidator),
};

type Reader = {
	orgId: string;
	/** The organisation's label, a tenant stamp only. */
	orgSlug: string;
	/** "user:<subject>" of the scope the call runs under. */
	userKey: string;
	/** The call is the service transport with no person proof: its forwarded keys are believed. */
	trusted: boolean;
	/** The reader's own key, when it has one. */
	self: string | undefined;
	/** May read any caller of `orgId`: an org admin, or the org-scoped service caller. */
	admin: boolean;
};

type ClaimArgs = {
	selfKey?: string;
	verifiedPerson?: { accessTokenHash: string };
	verifiedOrg?: { orgSlug: string };
};

/**
 * THE one place a tool-usage door resolves its caller and its organisation
 * (the three doors share it). `soft` (the recorder) answers a caller that has no
 * organisation with `null`; a read raises instead.
 *
 *   - the fleet service account that names no organisation is REFUSED (R-54);
 *   - a `verifiedPerson` is the person's own scope, re-read from its token row;
 *   - otherwise `verifiedOrg` narrows the service account to that organisation's
 *     member scope (a Clerk session cannot name one: refused).
 *
 * Standing to read ANY caller of the organisation in scope:
 *   - a verified organisation admin role (Clerk session or person token);
 *   - the ORG-SCOPED SERVICE CALLER: the fleet service account acting for an
 *     organisation (`verifiedOrg` / `__actingOrg`) that presents NO identity of
 *     its own (neither `selfKey` nor `verifiedPerson`) - a server process (the
 *     onboarding engine) serving that tenant. The MCP never reaches this branch:
 *     its tool refuses a bearer that resolves no identity before any call.
 * A seat or a plain member reads its own rows only.
 */
async function resolveReader(
	ctx: Parameters<typeof withOrgScope>[0],
	args: ClaimArgs,
	door: string,
	soft: boolean,
	forwardedKey: string | undefined,
): Promise<Reader | null> {
	const transport = await withOrgScope(ctx, { refuseWithoutThrow: true });
	if (soft) {
		if (transport.anonymous === true || transport.refused === true) return null;
	} else {
		requireResolvedCaller(transport, door, { alsoRefusePreOrg: true });
	}
	const personal = args.verifiedPerson !== undefined;
	refuseClaimlessServiceAccount(
		transport,
		args.verifiedOrg !== undefined || personal,
		door,
	);
	const claimed =
		args.verifiedOrg === undefined
			? undefined
			: await resolveVerifiedOrgScope(ctx, transport, args.verifiedOrg, door);
	const scope = personal
		? await resolveVerifiedPerson(ctx, transport, args.verifiedPerson, { door })
		: (claimed ?? transport);
	// A person bearer's organisation is its token's; a `verifiedOrg` carried beside
	// it must name that same organisation, never a second source of the organisation.
	if (
		personal &&
		claimed !== undefined &&
		!sameOrg({ id: claimed.orgClerkId }, { id: scope.orgClerkId })
	) {
		throw rbacDenied(
			door,
			"cross-organisation",
			`"${door}" refuses a claim naming another organisation than the caller's`,
		);
	}
	// The call is the service transport with no person proof: the key it forwards
	// (`caller` / `selfKey`) is believed, for that organisation only.
	const trusted = isServiceTransport(transport) && !personal;
	// A forwarded agent key must belong to the verified organisation it is filed
	// under: the agent row is read by that ID and its stamped org ID compared by
	// the package's `sameOrg`. An unreadable ID, a missing row or another org's
	// agent is refused, and nothing is recorded or read.
	if (trusted && forwardedKey?.startsWith("agent:") === true) {
		const agentId = ctx.db.normalizeId("agents", forwardedKey.slice(6));
		const agent = agentId === null ? null : await ctx.db.get(agentId);
		if (
			agent === null ||
			!sameOrg({ id: agent.clerkOrgId }, { id: scope.orgClerkId })
		) {
			throw rbacDenied(
				door,
				"agent-not-in-organisation",
				`"${door}" refuses an agent key that does not belong to the verified organisation`,
			);
		}
	}
	const orgId = scope.orgClerkId;
	const orgSlug = scope.orgSlug;
	if (orgId === undefined || orgId === "" || orgSlug === null) {
		if (soft) return null;
		throw rbacDenied(
			door,
			"no-organisation-id",
			`"${door}" refuses this caller: it acts in no organisation with a permanent ID`,
		);
	}
	const adminRole =
		scope.orgRole !== undefined && ORG_ADMIN_ROLES.includes(scope.orgRole);
	const userKey = `user:${scope.userId}`;
	return {
		orgId,
		orgSlug,
		userKey,
		trusted,
		self: trusted ? args.selfKey : userKey,
		admin: adminRole || (trusted && args.selfKey === undefined),
	};
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
		const reader = await resolveReader(ctx, args, READ_DOOR, false, args.selfKey);
		if (reader === null) throw unresolved(READ_DOOR);
		const target = args.caller ?? reader.self;
		if (target === undefined || !CALLER_KEY.test(target)) {
			throw rbacDenied(
				READ_DOOR,
				"caller-unidentified",
				`"${READ_DOOR}" needs the caller to read as "user:<subject>" or "agent:<agent id>"`,
			);
		}
		if (target !== reader.self && !reader.admin) {
			throw rbacDenied(
				READ_DOOR,
				"not-org-admin",
				`"${READ_DOOR}" lets a caller read its own rows; another caller needs an organisation admin`,
			);
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

/**
 * usageByOwner - the tools a PERSON has used across everything it owns, in one
 * organisation: every agent of the organisation whose `personalAgentOf` is the
 * owner (one per AI client), plus the owner's own direct calls (a Clerk session
 * or person token files under "user:<owner>"). Per tool: firstAt = min,
 * lastAt = max, count = sum. Per-caller rows stay the storage; this is a read.
 *
 * Standing: the owner reads itself; an organisation admin and the org-scoped
 * service caller read any member of THEIR organisation. A plain member asking
 * for ANOTHER member is refused (members do not read each other). The owner must
 * belong to the organisation in scope (a live membership, or an agent of that
 * organisation designating it): an owner of another organisation is
 * RBAC_DENIED, never an empty list. A member with no agents and no direct calls
 * is an empty SUCCESS.
 */
export const usageByOwner = query({
	args: { ownerUserId: v.string(), ...readerArgs },
	returns: v.array(usageRow),
	handler: async (ctx, args) => {
		// isolation-contract: no reactive subscriber exists - this door is new in
		// task k17cbr6y6da096t5e1k869kgb18hd0ht; its callers are the MCP tool
		// get_owner_tool_usage (imperative) and the onboarding engine (a server).
		const reader = await resolveReader(ctx, args, OWNER_DOOR, false, args.selfKey);
		if (reader === null) throw unresolved(OWNER_DOOR);
		if (args.ownerUserId === "" || /\s/.test(args.ownerUserId)) {
			throw rbacDenied(
				OWNER_DOOR,
				"owner-unidentified",
				`"${OWNER_DOOR}" needs the owner's Clerk user id`,
			);
		}
		const ownKey = `user:${args.ownerUserId}`;
		if (ownKey !== reader.self && !reader.admin) {
			throw rbacDenied(
				OWNER_DOOR,
				"not-org-admin",
				`"${OWNER_DOOR}" lets a person read its own usage; another member needs an organisation admin`,
			);
		}

		const agents = await ctx.db
			.query("agents")
			.withIndex("by_personal_agent_of_clerk_id", (q) =>
				q.eq("personalAgentOf", args.ownerUserId).eq("clerkOrgId", reader.orgId),
			)
			.take(MAX_AGENTS_PER_OWNER);
		const member =
			(await ownerMembershipLookups(ctx).personById?.(
				args.ownerUserId,
				reader.orgId,
			)) ?? null;
		if (member === null && agents.length === 0) {
			throw rbacDenied(
				OWNER_DOOR,
				"owner-not-in-organisation",
				`"${OWNER_DOOR}" refuses an owner that is not a member of the organisation in scope`,
			);
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
