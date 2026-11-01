import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import {
	permanentOrgIdOfSlug,
	requireVerifiedActorPrincipal,
} from "./actingPrincipal";
import { resolveAgentRef } from "./agentIdentity";
import type { OrgScope, VerifiedActor } from "./auth";
import { fleetOperatorSlug } from "./operatorOrg";
import { resolveVerifiedOrg, type VerifiedOrg } from "./verifiedOrg";

// ─────────────────────────────────────────────────────────────────────────────
// inboxReader — WHO is reading an inbox, decided once, for every inbox door
// (checkNewMessages, checkNewMessagesEnvelope, getUnreadCount, markAsRead,
// deleteMessage). Cloud security, class of a client incident (task
// k17c5q842gm1gbh0j2qjtc80g18fx5kb); operator decision 2026-10-08: the inbox is
// read by the caller's VERIFIED agent ID, never by a supplied name.
//
// The defect. These doors keyed on the `recipient` NAME. The fleet service
// account (which every MCP seat reaches Convex as) is master with no org, so
// `recipient: "agent-b"` with no tenant read EVERY org's "agent-b" mailbox: the
// wire shape of another org's same-named agent's seat calling check_messages.
//
// The five readers (one of them per call, never a mixture):
//   agent          the transport verified an agent (`verifiedActor`: agents row
//                  ID + the org it was verified in). Resolved BY ID through
//                  @vantageos/cloud-identity (actingPrincipal.ts). Receipts are
//                  its own by `recipientId`, in its org. `recipient`, if sent,
//                  may only NARROW: it must equal the verified agent's ID or
//                  name, a mismatch is a raised RBAC_DENIED naming the door.
//   org-name       the transport verified only an ORGANISATION (`verifiedOrg`: a
//                  token naming several agents). The name resolves, in THAT org
//                  only, to an agents row, and the reader becomes that agent
//                  (kind agent). A name with no agents row in the org stays
//                  confined to that org's tenant and the exact name.
//   member         a Clerk member of an organisation (the dashboard): its own
//                  tenant, derived from its identity, never an argument.
//   fleet          the service account with NO claim (a fleet orchestrator such
//                  as pi / eta, which has no agents row, task
//                  k17a1yprfca2cfjc4cnz4ynvvs8fwe5m): the FLEET's tenant only
//                  ({unstamped, operator-stamped}, RULING 4), by exact name. A
//                  client org's tenant is refused, never served.
//   operator-admin the verified operator-org admin human, master for dashboard
//                  READS: cross-tenant by design (it can list every message),
//                  unchanged.
//
// RECEIPTS WITHOUT `recipientId` (module M6). An agent reader is served by ID
// ONLY: a receipt is its own when `receipt.recipientId === agentId`. There is no
// name fallback: a receipt that carries no ID is delivered to nobody, because a
// name is not an identity (two organisations' agents share one). Such receipts
// are filled by migrations/backfill_actor_ids (messageReceipts.recipient ->
// recipientId, step 1 of the M6 deploy) and listed by
// receiptRecipientIdAudit:unaddressedUnreadPage (the report). The fleet,
// member, org-name and operator-admin readers have no agents row to hold an ID
// and stay name-keyed inside their own tenants (see their kinds above).
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

// ─────────────────────────────────────────────────────────────────────────────
// EXPAND / CONTRACT — the no-interruption contract (task
// k17aypc5cr3edmvvbvwhb32evx8fz1x1). The MCP server (Railway) and these doors
// deploy independently. The MCP that serves every seat until the claim-sending
// MCP is live (main 71510d2) sends NO claim on its inbox tools: a client-org
// seat, a person and a fleet station all reach Convex as the fleet service
// account with a recipient NAME and, at most, a free `tenantId` tool argument.
// Those requests are byte-identical between two orgs' same-named seats, so no
// door can tell them apart; serving them the fleet tenant only would empty
// every client seat's and every person's inbox until the MCP redeploys.
//
// EXPAND (this value `true`): the claimless service account is served exactly
// as production served it before this change: every tenant (or the `tenantId`
// it names), by exact name. A CLAIMED call (verifiedActor / verifiedOrg) is
// already served by the verified reader below, so the same-named agent of
// another org reads only its own the moment the MCP sends the claim.
//
// CONTRACT (set to `false`, then delete this leg): only after the claim-sending
// MCP is OBSERVED live (a seat's check_messages served by its verifiedActor).
// The claimless service account then reads the FLEET's tenant only.
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT is in force (this value `false`): the claim-sending MCP was observed
// live on main 3682c11 (Railway /health commit 3682c11, a seat's check_messages
// served by its verifiedActor, task k17aypc5cr3edmvvbvwhb32evx8fz1x1). The
// EXPAND leg below is dead code kept one release so a rollback is a one-line
// flip; it is deleted in the follow-up.
export const UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT: boolean = false;

export type InboxReader = {
	kind:
		| "agent"
		| "org-name"
		| "member"
		| "fleet"
		| "operator-admin"
		| "legacy-service-account";
	// The tenant stamps this reader may see. `undefined` is the unstamped fleet.
	tenants: ReadonlyArray<string | undefined> | "all";
	// The reader's own label (the agent's name, or the name the caller gave).
	label: string;
	// Exact stored spellings to probe the name indexes with.
	names: readonly string[];
	// Set for an agent reader: the agents row `_id`.
	agentId?: string;
};

/**
 * The ONE RBAC_DENIED error of the inbox readers, returned so a door can `throw`
 * it in its own handler (a refusal the reader of the source can see). Same code,
 * same payload shape as `refuse`; never a second shape.
 */
export function rbacDenied(
	door: string,
	reason: string,
	detail: string,
): ConvexError<string> {
	return new ConvexError(
		`RBAC_DENIED: ${detail} — ${JSON.stringify({ reason, door })}`,
	);
}

function refuse(door: string, reason: string, detail: string): never {
	throw rbacDenied(door, reason, detail);
}

export type InboxClaims = {
	recipient?: string;
	tenantId?: string;
	verifiedActor?: VerifiedActor;
	verifiedOrg?: VerifiedOrg;
};

async function agentReader(
	ctx: Ctx,
	agent: Doc<"agents">,
	claims: InboxClaims,
	door: string,
): Promise<InboxReader> {
	// The reader is the agent already fixed by ID (a verified actor) or selected
	// by the verified organisation. A `recipient` claim beside it takes no part
	// in the decision: the inbox read is always this agent's own (`label`,
	// `agentId` below come from the row), never the one the claim names.
	if (claims.tenantId !== undefined && claims.tenantId !== agent.orgSlug) {
		refuse(
			door,
			"tenant-not-the-readers-org",
			`tenantId "${claims.tenantId}" is not the verified reader's organisation`,
		);
	}
	const operator = await fleetOperatorSlug(ctx.db);
	return {
		kind: "agent",
		tenants:
			operator !== undefined && operator === agent.orgSlug
				? [agent.orgSlug, undefined]
				: [agent.orgSlug],
		label: agent.name,
		names: [],
		agentId: agent._id,
	};
}

/**
 * Resolves the reader of an inbox door, or throws RBAC_DENIED naming the door.
 * `scope` is the TRANSPORT scope (`withOrgScope`), as each door resolved it.
 */
export async function resolveInboxReader(
	ctx: Ctx,
	scope: OrgScope,
	claims: InboxClaims,
	door: string,
): Promise<InboxReader> {
	if (claims.verifiedActor !== undefined) {
		const principal = await requireVerifiedActorPrincipal(
			ctx,
			scope,
			claims.verifiedActor,
			door,
		);
		// The principal's org is its permanent ID; the claim names the org by label,
		// so the label is converted (an org with no ID matches nobody).
		if (
			claims.verifiedOrg !== undefined &&
			(await permanentOrgIdOfSlug(ctx, claims.verifiedOrg.orgSlug)) !==
				principal.orgId
		) {
			return refuse(
				door,
				"verified-org-differs-from-actor",
				"verifiedOrg and verifiedActor name different organisations",
			);
		}
		const id = ctx.db.normalizeId("agents", principal.principalId);
		const agent = id === null ? null : await ctx.db.get(id);
		if (agent === null || !agent.isActive) {
			return refuse(
				door,
				"reader-not-found",
				"the verified reader is not an active agent",
			);
		}
		return await agentReader(ctx, agent, claims, door);
	}

	if (claims.verifiedOrg !== undefined) {
		const orgSlug = await resolveVerifiedOrg(
			ctx,
			scope,
			claims.verifiedOrg,
			door,
		);
		if (orgSlug === undefined) {
			return refuse(door, "reader-unidentified", "no verified reader");
		}
		if (claims.recipient === undefined) {
			return refuse(
				door,
				"recipient-required",
				"a verified organisation reads the inbox of a named agent; none was named",
			);
		}
		if (claims.tenantId !== undefined && claims.tenantId !== orgSlug) {
			return refuse(
				door,
				"tenant-not-the-readers-org",
				`tenantId "${claims.tenantId}" is not the verified organisation`,
			);
		}
		const agent = await resolveAgentRef(ctx, {
			label: claims.recipient,
			orgSlug,
			door: "inboxReader:resolveInboxReader",
			arg: "recipient",
			measure: false,
		});
		if (agent !== null) {
			if (!agent.isActive) {
				return refuse(
					door,
					"reader-not-found",
					`recipient "${claims.recipient}" is not an active agent of the verified organisation`,
				);
			}
			return await agentReader(ctx, agent, claims, door);
		}
		// No agents row for the name in this org: confined to the org's tenant and
		// the exact name, never another org's.
		return {
			kind: "org-name",
			tenants: [orgSlug],
			label: claims.recipient,
			names: [claims.recipient],
		};
	}

	if (claims.recipient === undefined) {
		return refuse(
			door,
			"recipient-required",
			"this caller names its inbox by recipient and none was given; an agent presents a verified identity instead",
		);
	}

	if (scope.isMaster) {
		if (scope.masterSource === "operator-admin") {
			return {
				kind: "operator-admin",
				tenants: claims.tenantId !== undefined ? [claims.tenantId] : "all",
				label: claims.recipient,
				names: [claims.recipient],
			};
		}
		// EXPAND: the claimless service account, as production served it (see
		// UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT above).
		if (UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT) {
			return {
				kind: "legacy-service-account",
				tenants: claims.tenantId !== undefined ? [claims.tenantId] : "all",
				label: claims.recipient,
				names: [claims.recipient],
			};
		}
		// The fleet service account, no claim: the FLEET's tenant, by exact name.
		const operator = await fleetOperatorSlug(ctx.db);
		const fleet: Array<string | undefined> =
			operator !== undefined ? [undefined, operator] : [undefined];
		if (claims.tenantId !== undefined && !fleet.includes(claims.tenantId)) {
			return refuse(
				door,
				"tenant-inbox-needs-verified-reader",
				`a client organisation's inbox ("${claims.tenantId}") is read by that organisation's verified agent, never by a name`,
			);
		}
		return {
			kind: "fleet",
			tenants: fleet,
			label: claims.recipient,
			names: [claims.recipient],
		};
	}

	if (scope.orgSlug === null) {
		return refuse(
			door,
			"reader-unidentified",
			"the caller resolves no organisation",
		);
	}
	return {
		kind: "member",
		tenants: [scope.orgSlug],
		label: claims.recipient,
		names: [claims.recipient],
	};
}

/** Is this receipt the reader's? The one predicate every inbox door applies. */
export function ownsReceipt(
	reader: InboxReader,
	receipt: Doc<"messageReceipts">,
	recipientInstanceId?: string,
): boolean {
	if (
		recipientInstanceId !== undefined &&
		receipt.recipientInstanceId !== undefined &&
		receipt.recipientInstanceId !== recipientInstanceId
	) {
		return false;
	}
	// An agent reader owns a receipt by its ID and by nothing else (module M6).
	// THE ID IS THE PROOF (module M1): a receipt that carries the verified
	// agent's own ID is that agent's whatever tenant it was written in (a client
	// org's mail to an operator coordinator is stamped in the CLIENT's tenant with
	// the operator agent's ID; only the send path, after assertPrincipalListed,
	// stamps an ID). A receipt with no ID, or another agent's, is not its own.
	if (reader.agentId !== undefined) {
		return (
			receipt.recipientId !== undefined &&
			receipt.recipientId === reader.agentId
		);
	}
	// Readers without an agents row stay inside their own tenants, by exact name.
	if (reader.tenants !== "all" && !reader.tenants.includes(receipt.tenantId)) {
		return false;
	}
	return reader.names.includes(receipt.recipient);
}

/** Is this message one the reader SENT? (deleteMessage is sender-keyed.) */
export function ownsSentMessage(
	reader: InboxReader,
	message: Doc<"messages">,
): boolean {
	if (reader.tenants !== "all" && !reader.tenants.includes(message.tenantId)) {
		return false;
	}
	if (reader.agentId !== undefined) {
		if (message.fromId !== undefined) return message.fromId === reader.agentId;
		return (
			normalizeOrchestratorId(message.from) ===
			normalizeOrchestratorId(reader.label)
		);
	}
	return reader.names.includes(message.from);
}

/**
 * Is this task visible to the reader? Tasks are stamped `orgId`; the envelope's
 * task blocks (stale / stuck / peers) are keyed on a name and so crossed orgs
 * the same way the receipts did.
 */
export function taskVisibleTo(
	reader: InboxReader,
	task: Doc<"tasks">,
	role: "assignee" | "creator",
): boolean {
	if (reader.tenants !== "all" && !reader.tenants.includes(task.orgId)) {
		return false;
	}
	if (reader.agentId !== undefined) {
		const id = role === "assignee" ? task.assignedToId : task.createdById;
		if (id !== undefined) return id === reader.agentId;
	}
	return true;
}

export type UnreadReadOptions = {
	recipientInstanceId?: string;
	since?: number;
	take: number;
};

/**
 * The reader's unread receipts, oldest first, at most `take`. Indexes only
 * locate candidates; `ownsReceipt` decides, so a candidate that is not the
 * reader's can never be returned.
 */
export async function fetchUnreadReceipts(
	ctx: Ctx,
	reader: InboxReader,
	opts: UnreadReadOptions,
): Promise<Doc<"messageReceipts">[]> {
	const { recipientInstanceId: instance, since, take } = opts;
	const found = new Map<string, Doc<"messageReceipts">>();
	const keep = (rows: Doc<"messageReceipts">[]) => {
		for (const row of rows) {
			if (ownsReceipt(reader, row, instance)) found.set(row._id, row);
		}
	};

	// An agent reader: the ID index, nothing else. No name probe exists for it.
	if (reader.agentId !== undefined) {
		const agentId = reader.agentId;
		keep(
			await ctx.db
				.query("messageReceipts")
				.withIndex("by_recipientId_unread", (q) =>
					q.eq("recipientId", agentId).eq("readAt", undefined),
				)
				.filter((f) => {
					const parts = [];
					if (since !== undefined) {
						parts.push(f.gt(f.field("_creationTime"), since));
					}
					if (instance !== undefined) {
						parts.push(
							f.or(
								f.eq(f.field("recipientInstanceId"), undefined),
								f.eq(f.field("recipientInstanceId"), instance),
							),
						);
					}
					return parts.length === 0 ? true : f.and(...parts);
				})
				.take(take),
		);
		return [...found.values()]
			.sort((a, b) => a._creationTime - b._creationTime)
			.slice(0, take);
	}

	const tenants: ReadonlyArray<string | undefined | "all"> =
		reader.tenants === "all" ? ["all"] : reader.tenants;

	for (const tenant of tenants) {
		for (const name of reader.names) {
			const base =
				tenant === "all"
					? ctx.db
							.query("messageReceipts")
							.withIndex("by_recipient_unread", (q) =>
								q.eq("recipient", name).eq("readAt", undefined),
							)
					: ctx.db
							.query("messageReceipts")
							.withIndex("by_tenant_recipient_unread", (q) =>
								q
									.eq("tenantId", tenant)
									.eq("recipient", name)
									.eq("readAt", undefined),
							);
			keep(
				await base
					.filter((f) => {
						const parts = [];
						if (since !== undefined) {
							parts.push(f.gt(f.field("_creationTime"), since));
						}
						if (instance !== undefined) {
							parts.push(f.eq(f.field("recipientInstanceId"), undefined));
						}
						return parts.length === 0 ? true : f.and(...parts);
					})
					.take(take),
			);
		}
		if (instance !== undefined) {
			const base =
				tenant === "all"
					? ctx.db
							.query("messageReceipts")
							.withIndex("by_instance_unread", (q) =>
								q.eq("recipientInstanceId", instance).eq("readAt", undefined),
							)
					: ctx.db
							.query("messageReceipts")
							.withIndex("by_tenant_instance_unread", (q) =>
								q
									.eq("tenantId", tenant)
									.eq("recipientInstanceId", instance)
									.eq("readAt", undefined),
							);
			keep(
				await base
					.filter((f) =>
						since !== undefined ? f.gt(f.field("_creationTime"), since) : true,
					)
					.take(take),
			);
		}
	}

	return [...found.values()]
		.sort((a, b) => a._creationTime - b._creationTime)
		.slice(0, take);
}
