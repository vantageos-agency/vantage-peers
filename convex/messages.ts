import { type PaginationResult, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
// convex-strict-mode-doc-type-import-needed-when-refactoring-list-query-from-early-return-to-accumulator-post-filter
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import {
	lookupOrgMapping,
	requireAgentCredentialMatch,
	verifiedActorValidator,
	requireResolvedCaller,
	requireScope,
	requireOrchestratorOnRoster,
	requireSenderInstanceOfSender,
	isOrchestratorOnOrgRoster,
	type OrgScope,
	withOrgScope,
} from "./lib/auth";
import { isFleetSystemCaller } from "./lib/systemCaller";
import {
	isHumanActorName,
	memberActorOf,
	resolveHumanActor,
} from "./lib/humanActor";
import {
	resolveVerifiedPerson,
	verifiedPersonValidator,
} from "./lib/personPrincipal";
import { findAgentByName } from "./lib/agentIdentity";
import {
	recipientScopeOfPrincipal,
	requireTargetOrgOfPrincipal,
	requireVerifiedActorPrincipal,
} from "./lib/actingPrincipal";
import { requireId } from "./lib/ids";
import { normalizeOrchestratorId } from "./_helpers/normalizeOrchestratorId";
import { creatorValidator } from "./schema";
import {
	afterDeliveryWork,
	claimDeliveryStep,
	deliveryClaimValidator,
} from "./deliveryLedger";
import {
	computePeersStuckOnYou,
	computeStaleInProgress,
	computeStuckInProgress,
} from "./lib/taskClosureGate";
import { actorIdResolver } from "./lib/actorIds";

// getUnreadCount only needs the count, not the rows; the receipts table per
// recipient is small, so this bound exists to guard against unbounded growth
// rather than reflecting an expected volume.
const UNREAD_RECEIPTS_SCAN_CAP = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Org-scope orchestrator enforcement (same defect class as
// convex/memories.ts's isNamespaceAllowedForScope — see
// .claude/rules/authority-attached-to-anonymous-object.md). markAsRead and
// deleteMessage act on a receipt/message identified by a stored orchestrator
// name (receipt.recipient / message.from). Master scope (no identity with
// legacy opt-in, or the recognized service-account identity) retains
// unrestricted access — preserves internal/MCP-server behaviour unchanged. A
// Clerk-org-scoped caller may only act on an orchestrator listed in its own
// client_org_mapping row's allowedOrchestrators; anything else is denied.
// ─────────────────────────────────────────────────────────────────────────────

function isOrchestratorAllowedForScope(scope: OrgScope, orchestrator: string): boolean {
	if (scope.isMaster) return true;
	if (scope.orgSlug === null) return false;
	return scope.allowedOrchestrators.includes(orchestrator);
}

// Channel membership for a non-master, org-scoped caller: "broadcast" (shared),
// a channel under its own `team/<orgSlug>` prefix, or one of the orchestrators
// in its client_org_mapping roster. Same rule `listByChannel` applies inline.
function isChannelOnScope(scope: OrgScope, channel: string): boolean {
	if (scope.isMaster) return true;
	if (channel === "broadcast") return true;
	if (scope.orgSlug !== null && channel.startsWith(`team/${scope.orgSlug}`)) {
		return true;
	}
	return scope.allowedOrchestrators.includes(channel);
}

const staleInProgressValidator = v.array(
	v.object({
		taskId: v.id("tasks"),
		title: v.string(),
		age: v.number(),
	}),
);

const cappedStaleInProgressValidator = v.object({
	entries: staleInProgressValidator,
	total: v.number(),
	truncated: v.boolean(),
	// Count of `entries` that have NO open work segment behind their
	// in_progress status and are past the configured stuck-actionable
	// threshold — see isActionableStuck in lib/taskClosureGate.ts. The
	// obligation to act keys on THIS field, not on entries.length: the list
	// itself is non-empty on every cycle where anyone is working (any-age by
	// design), so "list non-empty" is not a usable signal.
	actionableStuckCount: v.number(),
});

// ─────────────────────────────────────────────────────────────────────────────
// sendMessage — send a message to one, many, or all orchestrators
// channel: "broadcast" | "tau" | "pi,phi" (comma-separated for multi)
// Creates one message row + one receipt per recipient.
// ─────────────────────────────────────────────────────────────────────────────

// Broadcast resolves dynamically from the profiles table.
// Any orchestrator with a profile receives broadcasts.
// No hardcoded list — new orchestrators are included automatically after calling update_profile.

// ─────────────────────────────────────────────────────────────────────────────
// Person recipients (task k1792yz3em7hyw84d765hq71j98ft5h4, client portal reply
// path). A PERSON is written down as "user:<verified Clerk subject>" (sendAsHuman,
// convex/lib/humanActor.ts), a colon-prefixed value no roster slug can equal. A
// portal request therefore carries a sender an agent can answer, provided the
// reply is addressed to that name. WHO may address a person is decided here and
// nowhere else:
//   - only an agent of the SAME organisation: the person must already have
//     written in the sender's own tenant. The row that proves it was stamped by
//     the verified scope at that time (never a client string), so a person of
//     another org has no such row in this tenant and is refused;
//   - the fleet master (no org) is refused: a fleet orchestrator replying to a
//     client's person is a cross-org message;
//   - a foreign person and an unknown person get ONE refusal (same code, same
//     reason), so the refusal is not an oracle for "this subject exists".
// The bound on the proof scan is stated, not hidden: the 200 most recent rows the
// person wrote. A person whose last 200 messages are all in another org is
// reported as not in this org (fail closed).
// ─────────────────────────────────────────────────────────────────────────────

const PERSON_PROOF_SCAN = 200;

async function requirePersonRecipientInOrg(
	ctx: MutationCtx,
	reach: OrgScope,
	person: string,
): Promise<void> {
	const door = "messages:sendMessage";
	const refuse = (reason: string): never => {
		throw new ConvexError(
			`RBAC_DENIED: "${person}" is not a person of the sender's organisation — ${JSON.stringify({ reason, door, orgSlug: reach.orgSlug })}`,
		);
	};
	if (reach.orgSlug === null) return refuse("person-recipient-needs-org-agent");
	const orgSlug = reach.orgSlug;
	const written = await ctx.db
		.query("messages")
		.withIndex("by_from", (q) => q.eq("from", person))
		.order("desc")
		.take(PERSON_PROOF_SCAN);
	if (!written.some((m) => m.tenantId === orgSlug)) {
		return refuse("person-recipient-not-in-org");
	}
}

// A person's inbox belongs to that person. The generic reads take a free
// `recipient`; for a person name only the person itself (or the fleet master,
// bound at the MCP layer) may name it. Other orgs are already excluded by the
// tenant filter on the receipts; this closes the same-org colleague.
function assertPersonInboxOwner(
	scope: OrgScope,
	recipient: string,
	door: string,
): void {
	if (!isHumanActorName(recipient)) return;
	if (scope.isMaster && scope.orgSlug === null) return;
	if (scope.userId !== "" && recipient === memberActorOf(scope)) return;
	throw new ConvexError(
		`RBAC_DENIED: a person's inbox may be read only by that person — ${JSON.stringify({ reason: "person-inbox-not-yours", door, orgSlug: scope.orgSlug })}`,
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// sendMessageCore — shared delivery core for both the public `sendMessage`
// and the HMAC-webhook-only `sendMessageInternal`
// (task sigma/tenant-scope-write-symmetry). Performs recipient resolution,
// the zero-recipient bounce, the message insert, and the per-recipient
// receipt insert, given an ALREADY-RESOLVED `scope`. The two wrappers below
// (`sendMessage` public, `sendMessageInternal` HMAC-webhook-only) differ
// ONLY in how they resolve that scope — never duplicate this loop.
// ─────────────────────────────────────────────────────────────────────────────

interface SendMessageArgs {
	from: string;
	fromInstanceId?: string;
	channel: string;
	content: string;
	sessionDay?: number;
	tenantId?: string;
}

async function sendMessageCore(
	ctx: MutationCtx,
	args: SendMessageArgs,
	scope: OrgScope,
	// The recipient scope when it differs from the caller's own: an MCP seat of a
	// client org reaches Convex as the service account (fleet master, no org), so
	// `scope` alone would give it fleet reach. Set only by `sendMessage`, from
	// `resolveSeatRecipientScope`; it narrows recipients and nothing else (the
	// tenant stamp still derives from `scope`).
	recipientScope?: OrgScope,
): Promise<Doc<"messages">["_id"]> {
	const reach = recipientScope ?? scope;
	// Tenant-scope write symmetry (task sigma/tenant-scope-write-symmetry):
		// the scoped READS (listMessages/listByChannel/searchMessagesByKeyword)
		// force `.eq("tenantId", scope.orgSlug)` for non-master callers — the
		// write must stamp the SAME derived tenant, never trust the
		// client-supplied args.tenantId, or a non-master send silently
		// produces a row invisible to (or spoofable across) the caller's own
		// scoped reads. `scope` reused from the top of this handler.
		let derivedTenantId: string | undefined;
		if (scope.isMaster && scope.orgSlug === null) {
			// TRUE internal master (service account / Laurent) carve-out —
			// mirrors the broadcast branch's isMaster && orgSlug===null
			// discriminant below: legitimate internal fleet traffic keeps
			// today's behavior when no tenantId is supplied. BUT a master
			// caller supplying a tenantId is no longer written verbatim — a
			// master credential could otherwise stamp ANY string, including
			// a namespace-shaped value no organisation can ever match
			// (production incident: 2 receipts stamped "project/example-client", a
			// namespace where an org SLUG belongs — invisible to every
			// scoped reader and unreachable by the no-tenant backfill).
			// Reuses the SAME client_org_mapping join withOrgScope/
			// requireOrgAdmin already use (lookupOrgMapping) — no new
			// source of truth.
			if (args.tenantId === undefined) {
				// Absent tenant on the master path: unchanged legacy
				// internal-fleet behavior (e.g. the GitHub webhook's
				// sendMessageInternal calls, which never pass tenantId) -- EXCEPT
				// an MCP seat of a client org: its verified org (recipientScope,
				// resolveSeatRecipientScope) is the tenant, so the row and its
				// receipts are visible to that org's own scoped readers (a person
				// reading a reply addressed to it).
				derivedTenantId = recipientScope?.orgSlug ?? undefined;
			} else if (args.tenantId === "") {
				// Empty string is a VALUE the caller explicitly supplied, not
				// an omission — silently treating "" as "absent" would mask
				// a caller bug (e.g. a template that interpolates an unset
				// variable into an empty string) behind today's "legacy
				// internal traffic" carve-out. Refused, same as any other
				// non-matching value.
				throw new ConvexError(
					'TENANT_UNKNOWN: sendMessage tenantId "" is not a valid tenant. Accepted: no tenantId (omit the field entirely), or an active organisation slug registered in client_org_mapping.',
				);
			} else {
				const mapping = await lookupOrgMapping(ctx, args.tenantId);
				if (!mapping || !mapping.isActive) {
					throw new ConvexError(
						`TENANT_UNKNOWN: sendMessage tenantId "${args.tenantId}" is not a known, active organisation slug. Accepted: no tenantId (legacy internal fleet traffic), or an active organisation slug registered in client_org_mapping.`,
					);
				}
				derivedTenantId = args.tenantId;
			}
		} else if (scope.orgSlug !== null) {
			// Any real client org (including a client org whose
			// client_org_mapping row carries the ["*"] read sentinel): the
			// client_org_mapping path always returns isMaster: false
			// unconditionally (lib/auth.ts:~198-210) — this branch selects on
			// orgSlug alone, never on isMaster. The stamped
			// tenant is DERIVED from the verified scope, never the
			// client-supplied args.tenantId. Deriving — not
			// comparing-then-rejecting — makes a foreign-tenant spoof
			// impossible: a supplied foreign tenant is simply overridden by
			// the caller's real org.
			derivedTenantId = scope.orgSlug;
		} else {
			// Anonymous / no-identity, non-master (isMaster===false,
			// orgSlug===null): an absent tenant is an event, never a rest —
			// refuse loudly instead of writing a null-tenant receipt that
			// would be invisible to the caller's own scoped reads (and, for
			// a DM to a known role, would otherwise silently "succeed").
			throw new ConvexError(
				"RBAC_DENIED: sendMessage requires an authenticated org — no tenant could be derived for this write. The caller has no tenantId and is not the authenticated master identity.",
			);
		}

		// R-53: sender and recipients BY ID, resolved within the message's own
		// tenant (the operator org for a fleet message). A name with no agents row
		// in that org stays unset: never guessed, never matched across orgs.
		const resolveActor = actorIdResolver(ctx, derivedTenantId);
		const fromId = await resolveActor(args.from);

		const messageId = await ctx.db.insert("messages", {
			from: args.from,
			...(fromId !== undefined ? { fromId } : {}),
			fromInstanceId: args.fromInstanceId,
			channel: args.channel,
			content: args.content,
			sessionDay: args.sessionDay,
			tenantId: derivedTenantId,
			createdAt: Date.now(),
		});

		// Resolve recipients — channel can be a role or instanceId
		// If channel contains "-" (e.g. "pi-vps"), treat as instance-level
		//
		// Bounce contract (task k17dr97dwpe07n9zfgzzypkfm18bv6ws): a channel that
		// resolves to ZERO real recipients — unknown role, non-existent instance,
		// reserved non-target word, empty string, or an unknown comma-list part
		// — is refused with an actionable ConvexError instead of silently
		// succeeding with no receipts written. The recipient set is DERIVED from
		// the org (the `profiles` table), never a hardcoded denylist — mirrors
		// the broadcast branch below.
		let recipients: string[];
		if (args.channel === "broadcast") {
			// Dynamic: get all registered orchestrators from profiles
			const profiles = await ctx.db.query("profiles").collect();
			const orchestratorIds = [
				...new Set(profiles.map((p) => p.orchestratorId)),
			];

			// Cross-tenant leak fix (mission fix-broadcast-org-scoped-v1, T1):
			// bound the broadcast fan-out to the EMITTER's own tenant, derived
			// from withOrgScope(ctx) — never from the client-supplied
			// args.tenantId (unauthenticated/self-declared, see T0 audit
			// analysis/broadcast-org-scope-audit-t0-day157.md). Resolved
			// FAIL-CLOSED (no allowNoIdentityMaster) — consistent with the
			// Day-156 SEC-AUDIT doctrine. The MCP server forwards its
			// service-account identity, which resolves to master via the
			// CLERK_SERVICE_ACCOUNT_USER_ID carve-out (lib/auth.ts:111-121),
			// so legitimate internal broadcasts still resolve to master. An
			// anonymous/no-identity caller resolves to isMaster=false with an
			// empty allowedOrchestrators, so it falls into the client branch
			// below and yields zero recipients — the existing zero-recipient
			// bounce fires (no fail-open path to the internal fleet).
			// `scope` reused from the top of this handler (resolved once, before
			// the [P-T5] ORG BIND lock above) — never re-derived here.

			// convex-reviewer CRITICAL (mission fix-broadcast-org-scoped-v1, T1
			// REVISE): scope.isMaster is OVERLOADED — it is also true for a
			// CLIENT org whose client_org_mapping row carries the ["*"] read
			// sentinel (lib/auth.ts:182: isMaster =
			// allowedOrchestrators.includes("*")). Gating the fleet-wide
			// master branch on isMaster alone would let a client
			// (mis)configured with ["*"] fan out to the entire internal
			// fleet + other tenants. The true internal master (service
			// account / Laurent, lib/auth.ts:77-89 and :123-135) is the ONLY
			// case with orgSlug === null — a client's isMaster=true always
			// carries a set orgSlug (lib/auth.ts:177-183). So the
			// fleet-wide branch is gated on BOTH isMaster AND orgSlug===null;
			// this discriminant is applied locally here, not in lib/auth.ts
			// (shared type, out of scope for this fix).
			if (reach.isMaster && reach.orgSlug === null) {
				// True internal/master emitter: exclude every orchestrator bound
				// to any client tenant — active OR inactive — so an internal
				// broadcast never reaches a client orchestrator, the exact leak
				// reported in the T0 audit. Inactive mappings are included in
				// the exclusion set deliberately: an inactive client_org_mapping
				// row still identifies that orchestratorId as CLIENT-bound, not
				// internal — dropping the isActive filter here would let a
				// merely-disabled client's orchestrator silently rejoin the
				// internal broadcast pool, which is itself a leak class. This
				// is independent of whether that inactive org could ever
				// authenticate (it can't — withOrgScope throws Forbidden on
				// inactive orgs); the exclusion is about the identity of the
				// orchestratorId, not the org's ability to log in.
				const mappings = await ctx.db.query("client_org_mapping").collect();
				const clientBound = new Set<string>();
				for (const mapping of mappings) {
					for (const orchestratorId of mapping.allowedOrchestrators) {
						if (orchestratorId !== "*") clientBound.add(orchestratorId);
					}
				}
				recipients = orchestratorIds.filter(
					(o) => o !== args.from && !clientBound.has(o),
				);
			} else {
				// Client-scoped emitter (including a client-org isMaster=true
				// with orgSlug set — the ["*"] read-sentinel case): recipients
				// bounded to this org's own allowedOrchestrators — never
				// another tenant, never the internal fleet. A ["*"]
				// allowedOrchestrators list never matches a real
				// orchestratorId (the literal string "*" is not a
				// registered orchestrator), so this yields zero recipients
				// and the bounce below fires — fail-closed, not a leak.
				const allowed = new Set(reach.allowedOrchestrators);
				recipients = orchestratorIds.filter(
					(o) => o !== args.from && allowed.has(o),
				);
			}

			// Zero-recipient bounce contract (task k17dr97dwpe07n9zfgzzypkfm18bv6ws)
			// extends to the tenant-scoped broadcast: an anonymous/no-identity
			// caller resolves to isMaster=false with allowedOrchestrators=[],
			// so it would otherwise silently "succeed" with zero receipts
			// written. Fail-closed here means an explicit refusal, never a
			// fall-through to the internal fleet.
			if (recipients.length === 0) {
				throw new ConvexError(
					`recipient error / message non livré : "broadcast" ne correspond à aucun destinataire de l'organisation pour cet émetteur.`,
				);
			}
		} else {
			const profiles = await ctx.db.query("profiles").collect();
			const knownRoles = new Set(profiles.map((p) => p.orchestratorId));
			const knownInstances = new Set(
				profiles
					.map((p) => p.instanceId)
					.filter((id): id is string => id !== undefined),
			);

			// Cross-tenant DIRECT-message fix (task
			// k17axar1dx4k6grekykm9tzz098frfm3): `profiles` carries no tenant, so
			// the sets above span every org. Mirror the broadcast branch: only the
			// true internal master (isMaster && orgSlug === null) reaches
			// fleet-wide; any client-scoped caller (including a client org whose
			// roster is the ["*"] read sentinel, which names nobody) may reach only
			// orchestrators on its OWN roster, directly or via one of their
			// instances. Enforced here, in Convex, so no transport can bypass it.
			const fleetWide = reach.isMaster && reach.orgSlug === null;
			const instanceOwner = new Map<string, string>();
			for (const p of profiles) {
				if (p.instanceId !== undefined) {
					instanceOwner.set(p.instanceId, p.orchestratorId);
				}
			}
			// Pi ruling (b): the org's own roster PLUS its explicit allow-list of
			// fleet coordinators (client_org_mapping.addressableFleetCoordinators,
			// empty by default, written only by setAddressableFleetCoordinators).
			// Never inferred; "*" is never a grant.
			let coordinators: string[] = [];
			if (!fleetWide && reach.orgSlug !== null) {
				const orgSlug = reach.orgSlug;
				const mapping = await ctx.db
					.query("client_org_mapping")
					.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", orgSlug))
					.first();
				coordinators = (mapping?.addressableFleetCoordinators ?? [])
					.filter((n) => n !== "*")
					.map(normalizeOrchestratorId);
			}
			const isReachable = (orchestrator: string): boolean =>
				isOrchestratorOnOrgRoster(reach, orchestrator) ||
				coordinators.includes(normalizeOrchestratorId(orchestrator));
			const isOnOwnRoster = (part: string): boolean => {
				if (fleetWide) return true;
				if (knownRoles.has(part) && isReachable(part)) return true;
				const owner = instanceOwner.get(part);
				return owner !== undefined && isReachable(owner);
			};

			const rawParts = args.channel
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);

			const bounce = () => {
				throw new ConvexError(
					`recipient error / message non livré : "${args.channel}" ne correspond à aucun destinataire de l'organisation. Formes valides : <role existant> | <instance> | broadcast | liste "eta,pi".`,
				);
			};

			if (rawParts.length === 0) {
				bounce();
			}
			for (const part of rawParts) {
				if (part === args.from) continue; // sender excluding itself never needs to resolve
				if (isHumanActorName(part)) {
					// A PERSON ("user:<subject>"): addressable by an agent of the
					// SAME org only, never by role or profile.
					await requirePersonRecipientInOrg(ctx, reach, part);
					continue;
				}
				const isKnown = knownRoles.has(part) || knownInstances.has(part);
				// One foreign or unknown part refuses the WHOLE send (same bounce).
				if (!isKnown || !isOnOwnRoster(part)) {
					bounce();
				}
			}

			recipients = rawParts.filter((s) => s !== args.from);
			if (recipients.length === 0) {
				bounce();
			}
		}

		for (const recipient of recipients) {
			// Determine if this is an instance target or role target
			// A person is one inbox, never an instance: its subject is not split.
			const isInstance = !isHumanActorName(recipient) && recipient.includes("-");
			const role = isInstance ? recipient.split("-")[0] : recipient;

			const recipientId = await resolveActor(role);
			await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: role,
				...(recipientId !== undefined ? { recipientId } : {}),
				recipientInstanceId: isInstance ? recipient : undefined,
				tenantId: derivedTenantId,
				readAt: undefined,
			});
		}

	return messageId;
}

// ─────────────────────────────────────────────────────────────────────────────
// seatOrgSlug — the verified org of an MCP SEAT of a client organisation, forwarded
// by the MCP server on the service-account path (task
// k174f54w3fv3amnk16v68tb3jh8frxxt). That path resolves as the true fleet master
// (isMaster, orgSlug null), so the #1470 recipient scope never applied to a seat.
// The MCP derives the value from the bearer's verified principal (the token row's
// org / the credential-bound actor org), never from a tool argument; this door
// believes it from the SERVICE ACCOUNT ONLY (same trust rule as `verifiedActor`
// and `verifiedPerson`), refuses it from anyone else, and fails closed unless it
// names an ACTIVE client_org_mapping row. It yields the org's own recipient scope
// (roster + addressableFleetCoordinators, applied by sendMessageCore).
// ─────────────────────────────────────────────────────────────────────────────

async function resolveSeatRecipientScope(
	ctx: MutationCtx,
	transportScope: OrgScope,
	seatOrgSlug: string | undefined,
	tenantId: string | undefined,
): Promise<OrgScope | undefined> {
	if (seatOrgSlug === undefined) return undefined;
	const door = "messages:sendMessage";
	const refuse = (reason: string, detail: string): never => {
		throw new ConvexError(
			`RBAC_DENIED: ${detail} — ${JSON.stringify({ reason, door })}`,
		);
	};
	if (
		!(
			transportScope.isMaster &&
			transportScope.masterSource === "service-account"
		)
	) {
		return refuse(
			"seat-org-not-trusted",
			"seatOrgSlug is a transport-verified claim and is accepted only from the fleet service account",
		);
	}
	const mapping =
		seatOrgSlug === "" ? null : await lookupOrgMapping(ctx, seatOrgSlug);
	if (!mapping || !mapping.isActive) {
		return refuse(
			"seat-org-not-active",
			`seatOrgSlug "${seatOrgSlug}" is not a known, active organisation`,
		);
	}
	if (tenantId !== undefined && tenantId !== seatOrgSlug) {
		return refuse(
			"seat-org-tenant-mismatch",
			`seatOrgSlug "${seatOrgSlug}" and tenantId "${tenantId}" name different organisations`,
		);
	}
	return {
		userId: transportScope.userId,
		orgSlug: seatOrgSlug,
		allowedOrchestrators: mapping.allowedOrchestrators,
		scopes: mapping.scopes,
		isMaster: false,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// requireSeatSenderNotForeign — what the service-account + seatOrgSlug path may
// believe about `from`. That path resolves as the fleet master, so the roster
// bind (requireOrchestratorOnRoster) and the credential lock (no org to bind to)
// never judged the sender, and `from` was free text: measured, a seat of one org
// could send as a fleet orchestrator, as another org's orchestrator, or as
// "user:<subject>" (a forged person). The within-org identity of an agent is the
// MCP layer's job (the bearer's fromAllowList / the resolved credential, which
// this door cannot see); what THIS door can refuse, from data, is every identity
// that is not the seat's own:
//   - a person name (a person is never an agent, and is written only from a
//     verified subject);
//   - an identity known anywhere in the system (a profile, an instance, any
//     org's roster) that is not on the seat org's own roster.
// A label no identity owns (the portal's "cgt-alsachimie") is not an
// impersonation of anyone and is left to the MCP allow-list; it is the shape the
// person path replaces.
// ─────────────────────────────────────────────────────────────────────────────

async function requireSeatSenderNotForeign(
	ctx: MutationCtx,
	seat: OrgScope,
	from: string,
): Promise<void> {
	const door = "messages:sendMessage";
	const refuse = (reason: string): never => {
		throw new ConvexError(
			`RBAC_DENIED: sender "${from}" is not an identity of org "${seat.orgSlug}" — ${JSON.stringify({ reason, door, from, orgSlug: seat.orgSlug })}`,
		);
	};
	if (isHumanActorName(from)) return refuse("seat-sender-is-person");
	if (isRecipientOnRoster(seat, from)) return;
	const claimed = normalizeOrchestratorId(from);
	const segments = claimed.split("-");
	const candidates: string[] = [];
	for (let i = segments.length; i >= 1; i--) {
		candidates.push(segments.slice(0, i).join("-"));
	}
	for (const candidate of candidates) {
		if (seat.orgSlug !== null && (await findAgentByName(ctx, seat.orgSlug, candidate))) {
			return;
		}
	}
	const owns = (id: string | undefined): boolean =>
		id !== undefined &&
		(normalizeOrchestratorId(id) === claimed ||
			claimed.startsWith(`${normalizeOrchestratorId(id)}-`));
	const profiles = await ctx.db.query("profiles").collect();
	if (profiles.some((p) => owns(p.orchestratorId) || owns(p.instanceId))) {
		return refuse("seat-sender-foreign-identity");
	}
	const mappings = await ctx.db.query("client_org_mapping").collect();
	if (mappings.some((m) => m.allowedOrchestrators.some(owns))) {
		return refuse("seat-sender-foreign-identity");
	}
	// The `agents` table is the registered-identity table (RULING 4): a name
	// registered there is somebody's identity even with no roster entry and no
	// profile. Candidates are the name and each hyphen-prefix of it, so an
	// instance spelling ("nadia-vps-1") resolves to its agent ("nadia"). The
	// seat org's own rows are accepted; a row of any other org (client,
	// operator or fleet, every org of `client_org_mapping`) is refused. Lookup
	// is `findAgentByName` per org (index by_org_normalized_name).
	for (const m of mappings) {
		if (m.clerkOrgSlug === seat.orgSlug) continue;
		for (const candidate of candidates) {
			if (await findAgentByName(ctx, m.clerkOrgSlug, candidate)) {
				return refuse("seat-sender-foreign-identity");
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// sendAsHuman — the HUMAN path of sendMessage (task
// k17d5k5bw741p3681bc0pq76ah8fk4sn, Admin CRUD B2). A dashboard org member with a
// writer role (data: memberWriterRoles) sends in its OWN name: the sender is
// "user:<Clerk subject>" — a colon-prefixed value no roster slug can equal, so a
// human can never pose as an orchestrator — to a channel made only of its OWN
// org's roster (or "broadcast", which the core already bounds to that roster).
// The tenant is derived from the scope by sendMessageCore, as for any member.
// An agent proof (credential / verifiedActor) or an instance label on this path
// is a contradiction (they assert an agent identity this path does not have):
// refused, not ignored.
// ─────────────────────────────────────────────────────────────────────────────

function isRecipientOnRoster(scope: OrgScope, part: string): boolean {
	if (isOrchestratorOnOrgRoster(scope, part)) return true;
	// An instance id is "<role>" or "<role>-<suffix>": a roster entry owns it.
	const instance = normalizeOrchestratorId(part);
	return scope.allowedOrchestrators.some(
		(entry) =>
			entry !== "*" &&
			instance.startsWith(`${normalizeOrchestratorId(entry)}-`),
	);
}

async function sendAsHuman(
	ctx: MutationCtx,
	args: {
		fromInstanceId?: string;
		channel: string;
		content: string;
		sessionDay?: number;
		tenantId?: string;
		agentCredentialSecret?: string;
		verifiedActor?: unknown;
	},
	scope: OrgScope,
): Promise<Doc<"messages">["_id"]> {
	const door = "messages:sendMessage";
	if (
		args.agentCredentialSecret !== undefined ||
		args.verifiedActor !== undefined ||
		args.fromInstanceId !== undefined
	) {
		throw new ConvexError(
			`RBAC_DENIED: a human sender (no \`from\`) may not present an agent credential, a verified actor or an instance label — ${JSON.stringify({ reason: "agent-proof-on-human-path", door })}`,
		);
	}
	// create mode: no row — the tenant is stamped from the scope by the core.
	const actor = await resolveHumanActor(ctx, scope, { door });
	if (args.channel !== "broadcast") {
		const parts = args.channel
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (parts.length === 0 || !parts.every((p) => isRecipientOnRoster(scope, p))) {
			throw new ConvexError(
				`RBAC_DENIED: a human may message only its own organisation's orchestrators — ${JSON.stringify({ reason: "recipient-not-on-roster", door, channel: args.channel, orgSlug: scope.orgSlug })}`,
			);
		}
	}
	return await sendMessageCore(
		ctx,
		{
			from: actor,
			channel: args.channel,
			content: args.content,
			sessionDay: args.sessionDay,
			tenantId: args.tenantId,
		},
		scope,
	);
}

const SEND_DOOR = "messages:sendMessage";

export const sendMessage = mutation({
	args: {
		// OPTIONAL: omitting `from` is the HUMAN path (a dashboard org member
		// speaking in its own name). The sender is then derived from the verified
		// identity as "user:<Clerk subject>", never taken from the client.
		from: v.optional(creatorValidator),
		fromInstanceId: v.optional(v.string()),
		channel: v.string(),
		content: v.string(),
		sessionDay: v.optional(v.number()),
		tenantId: v.optional(v.string()),
		// [P-T5] THE LOCK — optional per-agent credential secret (see
		// convex/agentCredentials.ts). When presented, `args.from` MUST equal
		// the agent name the credential resolves to (see
		// requireAgentCredentialMatch) — a call asserting a DIFFERENT `from`
		// than the resolved identity is refused with AGENT_IDENTITY_MISMATCH.
		// Omitted entirely, this is a no-op — pre-P-T5 callers are unchanged.
		agentCredentialSecret: v.optional(v.string()),
		// verifiedActor: the MCP's own header-verification result, the second proof
		// carrier. Trusted ONLY from the service account; one proof per call.
		verifiedActor: v.optional(verifiedActorValidator),
		// A person reached through the MCP service account: sends in its own
		// name, scope rebuilt from its token row (convex/lib/personPrincipal.ts).
		verifiedPerson: v.optional(verifiedPersonValidator),
		// The verified org of an MCP seat of a client organisation (see
		// resolveSeatRecipientScope). Service account only; any other caller is
		// refused. Scopes the RECIPIENTS to that org's roster + coordinators.
		seatOrgSlug: v.optional(v.string()),
	},
	returns: v.id("messages"),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("messages:sendMessage", …) at mcp-server/src/tools.ts:3158 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
		// [Pi ruling k1746tn3jy22k0jphbx48vzmvd8d0y50] Resolve scope BEFORE the
		// credential lock so the lock can bind the presented credential's org
		// against the SAME `orgSlug` the rest of this handler already derives
		// (reused below by sendMessageCore — never re-derived).
		const { verifiedPerson, seatOrgSlug, ...sendArgs } = args;
		// The transport's own scope is bound first (the service account, or the
		// dashboard member); resolveVerifiedPerson returns it unchanged unless a
		// person is carried (convex/lib/personPrincipal.ts).
		const transportScope = await withOrgScope(ctx);
		const scope = await resolveVerifiedPerson(
			ctx,
			transportScope,
			verifiedPerson,
			{
				door: "messages:sendMessage",
				assertedName: args.from,
				agentProof:
					args.agentCredentialSecret !== undefined ||
					args.verifiedActor !== undefined,
			},
		);

		// Judged on the TRANSPORT scope: the claim is believed from the service
		// account only, and a person-resolved scope is never that.
		const seatScope = await resolveSeatRecipientScope(
			ctx,
			transportScope,
			seatOrgSlug,
			args.tenantId,
		);

		// R-53: an acting agent forwarded BY ID (`verifiedActor`) is resolved
		// through @vantageos/cloud-identity (convex/lib/actingPrincipal.ts), and
		// every organisation this call names (the seat's verified org, a declared
		// tenantId) is checked against the principal's stored org ID before
		// anything is written. The recipients and the tenant stamp then derive
		// from the principal's own org, never from the service-account transport:
		// a same-named agent of another org can neither act as this org's agent
		// nor reach its recipients.
		let recipientScope = seatScope;
		if (args.verifiedActor !== undefined) {
			const principal = await requireVerifiedActorPrincipal(
				ctx,
				transportScope,
				args.verifiedActor,
				SEND_DOOR,
			);
			if (seatOrgSlug !== undefined) {
				await requireTargetOrgOfPrincipal(ctx, principal, seatOrgSlug, SEND_DOOR);
			}
			if (args.tenantId !== undefined) {
				await requireTargetOrgOfPrincipal(ctx, principal, args.tenantId, SEND_DOOR);
			}
			recipientScope = await recipientScopeOfPrincipal(
				ctx,
				transportScope,
				principal,
				SEND_DOOR,
			);
		}

		if (args.from === undefined) {
			return await sendAsHuman(ctx, sendArgs, scope);
		}
		const from = args.from;

		// The seat path's `from` is judged here, from data (see the function).
		if (recipientScope !== undefined) {
			await requireSeatSenderNotForeign(ctx, recipientScope, from);
		}

		await requireAgentCredentialMatch(
			ctx,
			args.agentCredentialSecret,
			from,
			scope.orgSlug,
			{ scope, verifiedActor: args.verifiedActor, declaredOrgSlug: args.tenantId },
		);

		// The sender derives from the verified caller: a member of an org may
		// only speak as an orchestrator on its own roster (see
		// requireOrchestratorOnRoster). Master/service account is unchanged here.
		requireOrchestratorOnRoster(scope, from, "messages:sendMessage");
		// ...and may only label the message with an instance of that sender.
		// The stored label is the NORMALISED form that was checked.
		const fromInstanceId = requireSenderInstanceOfSender(
			scope,
			from,
			args.fromInstanceId,
			"messages:sendMessage",
		);

		return await sendMessageCore(
			ctx,
			{ ...sendArgs, from, fromInstanceId },
			scope,
			recipientScope,
		);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// sendMessageInternal — HMAC-webhook-only. Called EXCLUSIVELY from
// convex/http.ts's GitHub-webhook `httpAction` (authed by
// GITHUB_WEBHOOK_SECRET/HMAC, never a Clerk identity by construction — there
// is no ctx.auth identity for withOrgScope to resolve). Mirrors
// internal.tasks.createForWebhook's shape/convention: an internalMutation is
// structurally unreachable from api.* / the public MCP surface (see
// convex/_generated/api.d.ts — it is registered only under the `internal`
// tree), so this bypass cannot be invoked by any client. Scope is resolved
// via withOrgScope(ctx, { allowNoIdentityMaster: true }), which takes the
// TRUE-internal-master carve-out (isMaster=true, orgSlug=null) — internal
// fleet notifications are master/null-tenant traffic, exactly like
// createForWebhook's task writes. The public `sendMessage` above keeps its
// strict withOrgScope(ctx) + anonymous-refuse UNCHANGED; this wrapper never
// relaxes that refusal, it only gives the webhook a distinct, provably
// unreachable-by-clients path to the SAME delivery core.
// ─────────────────────────────────────────────────────────────────────────────

export const sendMessageInternal = internalMutation({
	args: {
		from: creatorValidator,
		fromInstanceId: v.optional(v.string()),
		channel: v.string(),
		content: v.string(),
		sessionDay: v.optional(v.number()),
		tenantId: v.optional(v.string()),
	},
	returns: v.id("messages"),
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx, { allowNoIdentityMaster: true });
		return await sendMessageCore(ctx, args, scope);
	},
});

// `sendMessageInternal` for a delivery-keyed GitHub webhook call: the delivery
// claim is the FIRST write of this transaction and the message is sent by a
// NESTED mutation in the same transaction, so claim and message commit together
// or not at all. null = this delivery step was already claimed (a redelivery).
export const sendMessageDelivery = internalMutation({
	args: {
		delivery: deliveryClaimValidator,
		from: creatorValidator,
		fromInstanceId: v.optional(v.string()),
		channel: v.string(),
		content: v.string(),
		sessionDay: v.optional(v.number()),
		tenantId: v.optional(v.string()),
	},
	returns: v.union(v.id("messages"), v.null()),
	handler: async (ctx, rawArgs): Promise<Id<"messages"> | null> => {
		const { delivery, ...args } = rawArgs;
		if (!(await claimDeliveryStep(ctx, delivery))) return null;
		const id = await ctx.runMutation(
			internal.messages.sendMessageInternal,
			args,
		);
		afterDeliveryWork(delivery.deliveryId);
		return id;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// checkNewMessages — get unread messages for a recipient
// Returns messages with their receipt IDs (for marking as read).
// ─────────────────────────────────────────────────────────────────────────────

export const checkNewMessages = query({
	args: {
		recipient: creatorValidator,
		recipientInstanceId: v.optional(v.string()),
		tenantId: v.optional(v.string()),
		since: v.optional(v.number()), // Unix ms — only return receipts with _creationTime > since
	},
	returns: v.array(
		v.object({
			receiptId: v.id("messageReceipts"),
			messageId: v.id("messages"),
			from: creatorValidator,
			fromInstanceId: v.optional(v.string()),
			fromId: v.optional(v.string()),
			channel: v.optional(v.string()),
			content: v.string(),
			createdAt: v.number(),
		}),
	),
	// FROZEN CONTRACT — do not change this return shape. checkNewMessages is
	// intentionally left as a bare array for vp-mcp <2.12.0 callers ("no
	// break" — see mcp-server/CHANGELOG.md:40). The MCP server only calls
	// checkNewMessagesEnvelope in practice (mcp-server/src/tools.ts:2776);
	// staleInProgress (Day 130) is delivered there, not here. Protected by
	// convex/__tests__/staleInProgress.test.ts
	// "checkNewMessages frozen contract — returns a bare array".
	//
	// Read-half tenant identity (task sigma/read-half-tenant-identity — the
	// READ half of the tenant-isolation defect; T1 fixed the WRITE half in
	// sendMessageCore above). `args.tenantId` is no longer trusted verbatim:
	// the EFFECTIVE tenant is derived from `withOrgScope(ctx)`, mirroring the
	// sibling reads (listMessages / listByChannel / searchMessagesByKeyword).
	// A TRUE master identity (isMaster && orgSlug===null) keeps today's
	// admin/legacy all-tenants behavior when args.tenantId is omitted — that
	// is now gated on a VERIFIED master principal, not on arg-omission alone.
	// A non-master caller (orgSlug !== null) always reads its OWN derived
	// tenant; args.tenantId is ignored for widening. An anonymous caller
	// (!isMaster && orgSlug===null) sees nothing, mirroring the sibling
	// reads' `!isMaster && orgSlug===null → []` guard.
	handler: async (ctx, args) => {
		// R-50: reactively-subscribed public query — refuseWithoutThrow narrows
		// the signed-in-no-org branch to a typed-empty result instead of a throw.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });

		// STOP-CLAUSE SITE (task k1749w7ecx2yffr1hbhjpk8v858fbrf1). This is the ONE
		// of the six pre-organisation sites that keeps the bare `[]`, and it is a
		// measured decision, not an inheritance. The refusal shape cannot be
		// raised (a dashboard `useQuery` subscribes) and cannot be the envelope
		// either: vantage-peers-dashboard
		// `components/messages/message-timeline.tsx:69` subscribes to this read and
		// casts the RAW result to an array and calls `.map()` on it (lines 78-83
		// and 89-93, no `.items` normalisation). `{ refused: true, items: [] }` is
		// truthy, so `.map` would throw "map is not a function" inside a render.
		// The return is also a frozen bare-array contract for vp-mcp <2.12.0
		// (convex/__tests__/staleInProgress.test.ts). To close this site the
		// dashboard must first read `.items`; until then a pre-org caller here is
		// answered with bytes identical to an absence, and that is REPORTED, not
		// silent. The bare `[]` this line returns is pinned as an ARRAY by
		// convex/__tests__/preOrgRefusalCarriesItsMarker.test.ts.
		if (!scope.isMaster && scope.orgSlug === null) return [];
		assertPersonInboxOwner(scope, args.recipient, "messages:checkNewMessages");

		const effectiveTenantId =
			scope.isMaster && scope.orgSlug === null
				? args.tenantId
				: (scope.orgSlug ?? undefined);

		let receipts;

		if (args.recipientInstanceId !== undefined) {
			// Instance-level: get messages targeted at this specific instance
			// PLUS role-level messages (recipientInstanceId === undefined)
			//
			// R-11 fix (task k171ev3awqn4n2r9hfhbv2n1jx8df4tt) — when tenantId is
			// supplied, push it INTO the query via by_tenant_instance_unread /
			// by_tenant_recipient_unread (index predicate) rather than relying on
			// the post-query .filter below alone. The .filter is KEPT as
			// belt-and-suspenders, mirroring the conform pattern at :735/:995.
			const instanceReceipts =
				effectiveTenantId !== undefined
					? await ctx.db
							.query("messageReceipts")
							.withIndex("by_tenant_instance_unread", (q) =>
								q
									.eq("tenantId", effectiveTenantId)
									.eq("recipientInstanceId", args.recipientInstanceId!)
									.eq("readAt", undefined),
							)
							.filter((q) =>
								args.since !== undefined
									? q.gt(q.field("_creationTime"), args.since)
									: true,
							)
							.take(100)
					: await ctx.db
							.query("messageReceipts")
							.withIndex("by_instance_unread", (q) =>
								q
									.eq("recipientInstanceId", args.recipientInstanceId!)
									.eq("readAt", undefined),
							)
							.filter((q) =>
								args.since !== undefined
									? q.gt(q.field("_creationTime"), args.since)
									: true,
							)
							.take(100);

			const roleReceipts =
				effectiveTenantId !== undefined
					? await ctx.db
							.query("messageReceipts")
							.withIndex("by_tenant_recipient_unread", (q) =>
								q
									.eq("tenantId", effectiveTenantId)
									.eq("recipient", args.recipient)
									.eq("readAt", undefined),
							)
							.filter((q) => {
								const base = q.eq(q.field("recipientInstanceId"), undefined);
								return args.since !== undefined
									? q.and(base, q.gt(q.field("_creationTime"), args.since))
									: base;
							})
							.take(100)
					: await ctx.db
							.query("messageReceipts")
							.withIndex("by_recipient_unread", (q) =>
								q.eq("recipient", args.recipient).eq("readAt", undefined),
							)
							.filter((q) => {
								const base = q.eq(q.field("recipientInstanceId"), undefined);
								return args.since !== undefined
									? q.and(base, q.gt(q.field("_creationTime"), args.since))
									: base;
							})
							.take(100);

			// Merge and deduplicate by receiptId
			const seen = new Set<string>();
			receipts = [];
			for (const r of [...instanceReceipts, ...roleReceipts]) {
				if (!seen.has(r._id)) {
					seen.add(r._id);
					receipts.push(r);
				}
			}

			// Belt-and-suspenders: ensure no cross-tenant row leaks through.
			if (effectiveTenantId !== undefined) {
				receipts = receipts.filter((r) => r.tenantId === effectiveTenantId);
			}
		} else {
			// Role-level: get all unread for this role
			if (effectiveTenantId !== undefined) {
				receipts = await ctx.db
					.query("messageReceipts")
					.withIndex("by_tenant_recipient_unread", (q) =>
						q
							.eq("tenantId", effectiveTenantId)
							.eq("recipient", args.recipient)
							.eq("readAt", undefined),
					)
					.filter((q) =>
						args.since !== undefined
							? q.gt(q.field("_creationTime"), args.since)
							: true,
					)
					.take(100);
			} else {
				receipts = await ctx.db
					.query("messageReceipts")
					.withIndex("by_recipient_unread", (q) =>
						q.eq("recipient", args.recipient).eq("readAt", undefined),
					)
					.filter((q) =>
						args.since !== undefined
							? q.gt(q.field("_creationTime"), args.since)
							: true,
					)
					.take(100);
			}
		}

		const results = [];
		for (const receipt of receipts) {
			const message = await ctx.db.get(receipt.messageId);
			if (message !== null) {
				results.push({
					receiptId: receipt._id,
					messageId: receipt.messageId,
					from: message.from,
					fromInstanceId: message.fromInstanceId,
					channel: message.channel,
					content: message.content,
					createdAt: message.createdAt,
				});
			}
		}

		return results;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// checkNewMessagesEnvelope — envelope-guarded variant of checkNewMessages.
//
// Day 102 — Pi BLOCKER task k1702xaahb: 36 unread messages = 53 KB of content
// exceeded the Claude Code tool-response cap and crashed the cron. This variant
// adds (a) a `limit` arg (default 20, clamp [1,50]), (b) a `maxBytes` arg
// (default 40_000, clamp [1_000, 60_000]) summing JSON.stringify(projected)
// per included row, (c) returns `{messages, truncated, nextSince}` so callers
// can resume via `since=nextSince` on the next tick.
//
// The legacy `checkNewMessages` is intentionally left intact for vp-mcp
// <2.12.0 consumers. New mcp-server >=2.12.0 calls THIS variant.
// ─────────────────────────────────────────────────────────────────────────────

export const checkNewMessagesEnvelope = query({
	args: {
		recipient: creatorValidator,
		recipientInstanceId: v.optional(v.string()),
		tenantId: v.optional(v.string()),
		since: v.optional(v.number()),
		limit: v.optional(v.number()),
		maxBytes: v.optional(v.number()),
	},
	returns: v.object({
		messages: v.array(
			v.object({
				receiptId: v.id("messageReceipts"),
				messageId: v.id("messages"),
				from: creatorValidator,
				fromInstanceId: v.optional(v.string()),
				fromId: v.optional(v.string()),
				channel: v.optional(v.string()),
				content: v.string(),
				createdAt: v.number(),
			}),
		),
		truncated: v.boolean(),
		nextSince: v.union(v.number(), v.null()),
		staleInProgress: staleInProgressValidator,
		stuckInProgress: cappedStaleInProgressValidator,
		peersStuckOnYou: cappedStaleInProgressValidator,
	}),
	handler: async (ctx, args) => {
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
		const maxBytes = Math.min(Math.max(args.maxBytes ?? 40_000, 1_000), 60_000);
		const takeBudget = limit + 1;

		// Read-half tenant identity (task sigma/read-half-tenant-identity) —
		// see the identical derivation + comment on checkNewMessages above,
		// which this envelope variant mirrors exactly. R-50: reactively-
		// subscribed public query — refuseWithoutThrow narrows the
		// signed-in-no-org branch to a typed-empty result instead of a throw.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });

		if (!scope.isMaster && scope.orgSlug === null) {
			return {
				messages: [],
				truncated: false,
				nextSince: null,
				staleInProgress: [],
				stuckInProgress: {
					entries: [],
					total: 0,
					truncated: false,
					actionableStuckCount: 0,
				},
				peersStuckOnYou: {
					entries: [],
					total: 0,
					truncated: false,
					actionableStuckCount: 0,
				},
			};
		}

		assertPersonInboxOwner(
			scope,
			args.recipient,
			"messages:checkNewMessagesEnvelope",
		);

		const effectiveTenantId =
			scope.isMaster && scope.orgSlug === null
				? args.tenantId
				: (scope.orgSlug ?? undefined);

		let receipts: Doc<"messageReceipts">[];

		if (args.recipientInstanceId !== undefined) {
			// R-11 fix (task k171ev3awqn4n2r9hfhbv2n1jx8df4tt) — when tenantId is
			// supplied, push it INTO the query via by_tenant_instance_unread /
			// by_tenant_recipient_unread (index predicate) rather than relying on
			// the post-query .filter below alone. The .filter is KEPT as
			// belt-and-suspenders, mirroring the conform pattern at :735/:995.
			const instanceReceipts =
				effectiveTenantId !== undefined
					? await ctx.db
							.query("messageReceipts")
							.withIndex("by_tenant_instance_unread", (q) =>
								q
									.eq("tenantId", effectiveTenantId)
									.eq("recipientInstanceId", args.recipientInstanceId!)
									.eq("readAt", undefined),
							)
							.filter((q) =>
								args.since !== undefined
									? q.gt(q.field("_creationTime"), args.since)
									: true,
							)
							.take(takeBudget)
					: await ctx.db
							.query("messageReceipts")
							.withIndex("by_instance_unread", (q) =>
								q
									.eq("recipientInstanceId", args.recipientInstanceId!)
									.eq("readAt", undefined),
							)
							.filter((q) =>
								args.since !== undefined
									? q.gt(q.field("_creationTime"), args.since)
									: true,
							)
							.take(takeBudget);

			const roleReceipts =
				effectiveTenantId !== undefined
					? await ctx.db
							.query("messageReceipts")
							.withIndex("by_tenant_recipient_unread", (q) =>
								q
									.eq("tenantId", effectiveTenantId)
									.eq("recipient", args.recipient)
									.eq("readAt", undefined),
							)
							.filter((q) => {
								const base = q.eq(q.field("recipientInstanceId"), undefined);
								return args.since !== undefined
									? q.and(base, q.gt(q.field("_creationTime"), args.since))
									: base;
							})
							.take(takeBudget)
					: await ctx.db
							.query("messageReceipts")
							.withIndex("by_recipient_unread", (q) =>
								q.eq("recipient", args.recipient).eq("readAt", undefined),
							)
							.filter((q) => {
								const base = q.eq(q.field("recipientInstanceId"), undefined);
								return args.since !== undefined
									? q.and(base, q.gt(q.field("_creationTime"), args.since))
									: base;
							})
							.take(takeBudget);

			const seen = new Set<string>();
			receipts = [];
			for (const r of [...instanceReceipts, ...roleReceipts]) {
				if (!seen.has(r._id)) {
					seen.add(r._id);
					receipts.push(r);
				}
			}
			// Belt-and-suspenders: ensure no cross-tenant row leaks through.
			if (effectiveTenantId !== undefined) {
				receipts = receipts.filter((r) => r.tenantId === effectiveTenantId);
			}
		} else if (effectiveTenantId !== undefined) {
			receipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_tenant_recipient_unread", (q) =>
					q
						.eq("tenantId", effectiveTenantId)
						.eq("recipient", args.recipient)
						.eq("readAt", undefined),
				)
				.filter((q) =>
					args.since !== undefined
						? q.gt(q.field("_creationTime"), args.since)
						: true,
				)
				.take(takeBudget);
		} else {
			receipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_recipient_unread", (q) =>
					q.eq("recipient", args.recipient).eq("readAt", undefined),
				)
				.filter((q) =>
					args.since !== undefined
						? q.gt(q.field("_creationTime"), args.since)
						: true,
				)
				.take(takeBudget);
		}

		receipts.sort((a, b) => a._creationTime - b._creationTime);

		const messages: Array<{
			receiptId: Doc<"messageReceipts">["_id"];
			messageId: Doc<"messages">["_id"];
			from: Doc<"messages">["from"];
			fromInstanceId?: string;
			channel?: string;
			content: string;
			createdAt: number;
		}> = [];
		let bytes = 0;
		let truncated = false;
		let lastIncludedReceiptCreationTime: number | null = null;

		for (const receipt of receipts) {
			if (messages.length >= limit) {
				truncated = true;
				break;
			}
			const message = await ctx.db.get(receipt.messageId);
			if (message === null) continue;
			const projected = {
				receiptId: receipt._id,
				messageId: receipt.messageId,
				from: message.from,
				fromInstanceId: message.fromInstanceId,
				channel: message.channel,
				content: message.content,
				createdAt: message.createdAt,
			};
			const projectedBytes = JSON.stringify(projected).length;
			if (messages.length > 0 && bytes + projectedBytes > maxBytes) {
				truncated = true;
				break;
			}
			messages.push(projected);
			bytes += projectedBytes;
			lastIncludedReceiptCreationTime = receipt._creationTime;
		}

		const nextSince = truncated ? lastIncludedReceiptCreationTime : null;

		// Day 130 closure gate — surface the recipient's own overdue
		// in_progress work on every check_messages call, no extra cron. This
		// is the ONLY path staleInProgress is delivered on: mcp-server calls
		// exclusively checkNewMessagesEnvelope (tools.ts:2776); the legacy
		// checkNewMessages array contract stays frozen (see its own comment).
		const now = Date.now();
		const [staleInProgress, stuckInProgress, peersStuckOnYou] =
			await Promise.all([
				computeStaleInProgress(ctx, args.recipient, now),
				computeStuckInProgress(ctx, args.recipient, now),
				computePeersStuckOnYou(ctx, args.recipient, now),
			]);

		return {
			messages,
			truncated,
			nextSince,
			staleInProgress,
			stuckInProgress,
			peersStuckOnYou,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listMyInbox — the unread messages addressed to the CALLING PERSON.
//
// The recipient is never an argument: it is "user:<verified subject>", derived
// from the caller's own scope (a Clerk member), or from the token row behind a
// `verifiedPerson` carried by the MCP service account. Four callers, each told in
// the shape it can survive (.claude/rules/refusal-is-distinguishable-from-absence.md):
//   anonymous                     RAISES RBAC_DENIED
//   signed in, no organisation    { refused: true, items: [] } (a mounted render)
//   the bare service account /
//   a master with no org          RAISES RBAC_DENIED (it is not a person)
//   a person                      { items } -- a real absence is { items: [] }
// ─────────────────────────────────────────────────────────────────────────────

export const listMyInbox = query({
	args: {
		verifiedPerson: v.optional(verifiedPersonValidator),
		since: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	returns: v.object({
		refused: v.optional(v.literal(true)),
		items: v.array(
			v.object({
				receiptId: v.id("messageReceipts"),
				messageId: v.id("messages"),
				from: creatorValidator,
				fromInstanceId: v.optional(v.string()),
				fromId: v.optional(v.string()),
				channel: v.optional(v.string()),
				content: v.string(),
				createdAt: v.number(),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const door = "messages:listMyInbox";
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(transportScope, door);
		if (transportScope.refused) return { refused: true as const, items: [] };
		const scope = await resolveVerifiedPerson(
			ctx,
			transportScope,
			args.verifiedPerson,
			{ door },
		);
		if (scope.orgSlug === null || scope.userId === "") {
			throw new ConvexError(
				`RBAC_DENIED: "${door}" reads a person's inbox and the caller is not a person — ${JSON.stringify({ reason: "not-a-person", door, orgSlug: scope.orgSlug })}`,
			);
		}
		const tenantId = scope.orgSlug;
		const recipient = memberActorOf(scope);
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
		const since = args.since;
		const receipts = await ctx.db
			.query("messageReceipts")
			.withIndex("by_tenant_recipient_unread", (q) =>
				q
					.eq("tenantId", tenantId)
					.eq("recipient", recipient)
					.eq("readAt", undefined),
			)
			.filter((q) =>
				since !== undefined ? q.gt(q.field("_creationTime"), since) : true,
			)
			.take(limit);
		const items = [];
		for (const receipt of receipts) {
			const message = await ctx.db.get(receipt.messageId);
			if (message === null) continue;
			items.push({
				receiptId: receipt._id,
				messageId: receipt.messageId,
				from: message.from,
				fromInstanceId: message.fromInstanceId,
				channel: message.channel,
				content: message.content,
				createdAt: message.createdAt,
			});
		}
		return { items };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// markAsRead — mark one or more receipts as read
// ─────────────────────────────────────────────────────────────────────────────

export const markAsRead = mutation({
	args: {
		// Accept raw strings (not v.id("messageReceipts")) so we can normalize
		// each element ourselves and throw an actionable ConvexError instead of
		// letting the v.id() validator reject before the handler runs. Convex
		// prod REDACTS non-ConvexError validator messages before they reach the
		// client (issue #1064) — only an explicitly-thrown ConvexError's .data
		// payload survives the wire.
		receiptIds: v.array(v.string()),
		// k179nrp3apj700pm0h1ckewm2h8b3nz7 — ownership gate. When provided, every
		// resolved receipt MUST belong to this recipient or the whole call is
		// rejected (RBAC_DENIED). Optional only to stay behavior-preserving for
		// legacy/system callers that predate the MCP-layer guard (mirrors the
		// deleteMessage callerOrchestrator pattern above); the MCP tool now
		// ALWAYS passes it (tools.ts mark_as_read), closing the cross-owner hole
		// where any caller could mark another orchestrator's mail read.
		callerOrchestrator: v.optional(creatorValidator),
		// A person reached through the MCP service account acknowledges its OWN
		// receipts (convex/lib/personPrincipal.ts); scope rebuilt from its token.
		verifiedPerson: v.optional(verifiedPersonValidator),
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		// write-contract: two imperative callers — MCP: mcp-server client.mutation("messages:markAsRead", …) at mcp-server/src/tools.ts:3423; dashboard: components/messages/message-timeline.tsx:75 useMutation(api.messages.markAsRead) (dashboard origin/main 00a43cf, an event-handler call, never a subscription; measured 2026-10-03 with `grep -rn "messages:markAsRead" mcp-server/src` and `git -C <dashboard> grep -n "api.messages.markAsRead" origin/main -- app components hooks lib contexts providers`). The org/RBAC-keyed throw is an R-16 refusal at an imperative call that the caller catches, not an uncaught Server Error.
		//
		// Fail-closed multi-tenant fix (defect class: authority attached to an
		// anonymously-registered object — see
		// .claude/rules/authority-attached-to-anonymous-object.md). markAsRead
		// used to authorize solely on the client-supplied callerOrchestrator
		// argument: an anonymous caller (or a caller from a DIFFERENT org)
		// could pass ANY orchestrator name and mark that org's receipts read.
		// withOrgScope is called WITHOUT allowNoIdentityMaster — the MCP
		// server always presents a real Clerk identity (the caller's own org
		// JWT or its service-account token; see
		// mcp-server/src/authenticatedConvexClient.ts), so the fail-closed
		// default here never breaks that live path.
		const transportScope = await withOrgScope(ctx);
		const scope = await resolveVerifiedPerson(
			ctx,
			transportScope,
			args.verifiedPerson,
			{
				door: "messages:markAsRead",
				assertedName: args.callerOrchestrator,
			},
		);

		const normalizedIds = args.receiptIds.map((raw, index) =>
			requireId(
				ctx,
				"messageReceipts",
				raw,
				`receiptIds[${index}]`,
				"Use the full 32-char receiptId returned by check_messages.",
			),
		);

		const now = Date.now();
		let count = 0;
		for (const receiptId of normalizedIds) {
			const receipt = await ctx.db.get(receiptId);
			if (receipt === null) continue;
			// A person's own receipt ("user:<subject>", written by a reply addressed
			// to it) is acknowledged by that person and by nobody else; the tenant
			// gate below still applies.
			const ownPersonReceipt =
				scope.orgSlug !== null &&
				scope.userId !== "" &&
				isHumanActorName(receipt.recipient) &&
				receipt.recipient === memberActorOf(scope);
			if (
				!ownPersonReceipt &&
				!isOrchestratorAllowedForScope(scope, receipt.recipient)
			) {
				throw new ConvexError(
					`RBAC_DENIED: caller may not mark receipt ${receiptId} (recipient "${receipt.recipient}") as read — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
				);
			}
			// TENANT GATE. The roster above is a string membership, not a tenant
			// boundary: two orgs may both name "seat-x". A non-master caller may
			// only touch a receipt STAMPED with its own org; an absent tenantId
			// asserts nothing and grants nothing (same stance as filterByOrgScope).
			if (!scope.isMaster && receipt.tenantId !== scope.orgSlug) {
				throw new ConvexError(
					`RBAC_DENIED: caller may not mark receipt ${receiptId} as read — it does not belong to the caller's organisation — ${JSON.stringify({ registration: "messages:markAsRead", orgSlug: scope.orgSlug, reason: "receipt-tenant-mismatch" })}`,
				);
			}
			if (
				args.callerOrchestrator !== undefined &&
				receipt.recipient !== args.callerOrchestrator
			) {
				throw new ConvexError(
					`RBAC_DENIED: ${args.callerOrchestrator} is not the recipient of receipt ${receiptId} — mark_as_read denied`,
				);
			}
			if (receipt.readAt === undefined) {
				await ctx.db.patch(receiptId, { readAt: now });
				count++;
			}
		}
		return count;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteMessage — delete a message and cascade-delete its receipts
// RBAC: only the sender or "system" may delete. Pass callerOrchestrator=undefined
// to bypass the check (server-to-server / admin use).
// ─────────────────────────────────────────────────────────────────────────────

// cascadeDeleteMessage — the ONE receipt cascade shared by the agent and the
// human branch of deleteMessage: delete every receipt of the message, then the
// message; returns how many receipts went.
async function cascadeDeleteMessage(
	ctx: MutationCtx,
	messageId: Doc<"messages">["_id"],
): Promise<number> {
	const receipts = await ctx.db
		.query("messageReceipts")
		.withIndex("by_message", (q) => q.eq("messageId", messageId))
		.collect();
	for (const receipt of receipts) {
		await ctx.db.delete(receipt._id);
	}
	await ctx.db.delete(messageId);
	return receipts.length;
}

export const deleteMessage = mutation({
	args: {
		messageId: v.id("messages"),
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.object({ deleted: v.boolean(), receiptsDeleted: v.number() }),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("messages:deleteMessage", …) at mcp-server/src/tools.ts:3460 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main 2498c00); never a subscribing pre-org client shell. The RBAC_DENIED throw is the R-16 coded refusal the MCP layer catches, not an uncaught Server Error.
		// Fail-closed multi-tenant fix (same defect class as markAsRead
		// above) — deleteMessage used to authorize solely on the
		// client-supplied callerOrchestrator argument: an anonymous caller
		// (or a caller from a DIFFERENT org) could pass "system" or the
		// sender's own name and delete any org's message. withOrgScope is
		// called WITHOUT allowNoIdentityMaster for the same reason as
		// markAsRead: the MCP server always presents a real Clerk identity
		// on this path.
		//
		// Resolved BEFORE ctx.db.get(args.messageId) (convex-reviewer REVISE
		// on PR #1313): an anonymous caller must get RBAC_DENIED, never
		// "Message not found" — a get-then-scope order lets messageId
		// existence act as an unauthenticated existence oracle.
		const scope = await withOrgScope(ctx);

		// Anonymous/no-identity, non-master (isMaster===false, orgSlug===null)
		// can never pass isOrchestratorAllowedForScope for ANY message.from —
		// refuse here, before ctx.db.get, so a non-existent messageId cannot
		// be distinguished from an existing-but-foreign one by an
		// unauthenticated caller (mirrors checkNewMessages'/listMessages'
		// `!isMaster && orgSlug===null` guard above).
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete message ${args.messageId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const message = await ctx.db.get(args.messageId);
		if (!message) throw new Error("Message not found");

		if (args.callerOrchestrator === undefined && !scope.isMaster) {
			// HUMAN path (task k17d5k5bw741p3681bc0pq76ah8fk4sn): a dashboard
			// org:admin deletes a message of its OWN organisation (the row's
			// tenantId stamp equals the verified org; an unstamped row is refused)
			// whatever its sender — an agent's or a human's. Destructive: admin only.
			await resolveHumanActor(ctx, scope, {
				door: "messages:deleteMessage",
				row: { orgId: message.tenantId },
				rowKind: "message",
				rowId: args.messageId,
				tenantOnly: true,
				adminOnly: true,
			});
			return { deleted: true, receiptsDeleted: await cascadeDeleteMessage(ctx, args.messageId) };
		}

		if (!isOrchestratorAllowedForScope(scope, message.from)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete message ${args.messageId} (sender "${message.from}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		// TENANT GATE (same as markAsRead): the roster check above is a name
		// match, not a tenant boundary, and this mutation cascade-deletes the
		// message's receipts. A non-master caller may only delete a message
		// stamped with its own org.
		if (!scope.isMaster && message.tenantId !== scope.orgSlug) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete message ${args.messageId} — it does not belong to the caller's organisation — ${JSON.stringify({ registration: "messages:deleteMessage", orgSlug: scope.orgSlug, reason: "message-tenant-mismatch" })}`,
			);
		}

		// RBAC: callerOrchestrator is required and must match message.from
		if (args.callerOrchestrator === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: callerOrchestrator is required to delete a message — omitting it is refused, not exempted — ${JSON.stringify({ registration: "messages:deleteMessage", orgSlug: scope.orgSlug, reason: "caller-orchestrator-required" })}`,
			);
		}
		if (
			!isFleetSystemCaller(scope, args.callerOrchestrator) &&
			message.from !== args.callerOrchestrator
		) {
			throw new ConvexError(
				`RBAC_DENIED: only ${message.from} (sender) or system can delete this message — ${JSON.stringify({ registration: "messages:deleteMessage", orgSlug: scope.orgSlug, reason: "not-sender" })}`,
			);
		}

		// Cascade: delete all receipts for this message, then the message.
		return { deleted: true, receiptsDeleted: await cascadeDeleteMessage(ctx, args.messageId) };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listMessages — get messages for a day or from a sender (history/replay)
// ─────────────────────────────────────────────────────────────────────────────

// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m). When
// paginating via `createdBefore`, the post-take filter only finds rows
// older than the cursor if the FETCH is wide enough to include them —
// mission k574p02m DEFECT 2, lot 2.
export const MESSAGES_LIST_SCAN_CAP = 2000;

export const listMessages = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		sessionDay: v.optional(v.number()),
		from: v.optional(creatorValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("messages"),
			_creationTime: v.number(),
			from: creatorValidator,
			fromInstanceId: v.optional(v.string()),
			fromId: v.optional(v.string()),
			channel: v.optional(v.string()),
			to: v.optional(creatorValidator),
			content: v.string(),
			sessionDay: v.optional(v.number()),
			createdAt: v.number(),
			// Day 98 Cat A k17e611z4 fix — issues #655, #644, #643. Multi-tenant
			// rows carry tenantId; returns shape must declare it or Convex
			// emits ReturnsValidationError "extra field tenantId".
			tenantId: v.optional(v.string()),
		}),
	),
	handler: async (ctx, args) => {
		// ── Identity-derived tenant scope ────────────────────────────────────────
		// m977mqck: no-identity callers (MCP server / CLI) → isMaster=true, all rows.
		// m9748paff: Clerk callers are fail-CLOSED — scoped to their own tenantId.
		// k179fk0c: same per-tool tenancy doctrine as tasks.list.
		// isolation-contract: NO reactive subscriber. Re-decided (task
		// k1749w7ecx2yffr1hbhjpk8v858fbrf1), not inherited from R-50. Measured by
		// command: `grep -rn "api\.messages\.listMessages" --include=*.ts
		// --include=*.tsx` in vantage-peers-dashboard (origin/main) finds ZERO
		// call sites; the only consumers are one-shot reads — mcp-server
		// `list_messages` (tools.ts, `convex.query`) and the `messages-feed` UI
		// primitive (`fetchConvex`, which renders a thrown error as an error
		// div). A signed-in caller with no organisation therefore has no render
		// for a throw to crash, and a bare `[]` would be byte-identical to "no
		// messages exist". So `alsoRefusePreOrg` raises `RBAC_DENIED` at it. The
		// helper also runs BEFORE requireScope, which would otherwise raise for
		// that caller with a different, un-coded message.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "messages:listMessages", {
			alsoRefusePreOrg: true,
		});
		requireScope(scope, "view-own-tasks");

		const limit = args.limit ?? 100;
		const before = args.createdBefore;
		const needsWideScan = before !== undefined;
		const fetchCap = needsWideScan ? MESSAGES_LIST_SCAN_CAP + 1 : limit;

		let rows: Doc<"messages">[];

		if (!scope.isMaster && scope.orgSlug !== null) {
			// ── Clerk (non-master) path — tenant-scoped index ─────────────────────
			// Push tenantId equality BEFORE .take(limit) using by_tenant_created so
			// fleet (null-tenant) traffic cannot crowd out tenant rows in the window.
			// sessionDay and full-scan branches are intentionally merged here: Clerk
			// callers have no business querying a specific sessionDay of fleet traffic,
			// so we always use the tenant-scoped index and apply `from` as a post-index
			// .filter() (acceptable: within a single tenant, volume is low compared to
			// the full cross-tenant table). (task k176wgsrhha0fr0dxxahctvhw588q5a1,
			// Eta completeness edge from PR #775 verdict jn7563v34)
			const orgSlug = scope.orgSlug;
			rows = await ctx.db
				.query("messages")
				.withIndex("by_tenant_created", (q) => q.eq("tenantId", orgSlug))
				.order("desc")
				.filter((q) =>
					args.from !== undefined ? q.eq(q.field("from"), args.from) : true,
				)
				.take(fetchCap);

			// Belt-and-suspenders: ensure no cross-tenant row leaks through.
			rows = rows.filter((r) => r.tenantId === orgSlug);
		} else {
			// ── Master path — existing index logic, unchanged ──────────────────────
			if (args.sessionDay !== undefined) {
				const sessionDay = args.sessionDay;
				rows = await ctx.db
					.query("messages")
					.withIndex("by_day", (q) => q.eq("sessionDay", sessionDay))
					.order("asc")
					.take(fetchCap);
			} else if (args.from !== undefined) {
				const from = args.from;
				rows = await ctx.db
					.query("messages")
					.withIndex("by_from", (q) => q.eq("from", from))
					.order("desc")
					.take(fetchCap);
			} else {
				rows = await ctx.db.query("messages").order("desc").take(fetchCap);
			}
		}

		// S3.3 B8 follow-up batch 2 — drop rows newer-or-equal to anchor.
		if (before !== undefined) {
			rows = rows.filter((r) => r._creationTime < before);
		}

		return rows.slice(0, limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getUnreadCount — count unread receipts for a recipient role
// ─────────────────────────────────────────────────────────────────────────────

export const getUnreadCount = query({
	args: { orchestratorId: creatorValidator },
	// A served caller gets the bare number; a signed-in caller with no
	// organisation gets the typed envelope (a zero would be a false figure).
	returns: v.union(
		v.number(),
		v.object({ refused: v.literal(true), count: v.number() }),
	),
	handler: async (ctx, { orchestratorId }) => {
		// GATE — this read took NO identity check: it counted the unread receipts
		// of ANY recipient name for ANY caller, including one presenting no
		// credential at all. `messageReceipts` carries `tenantId`, so a non-master
		// caller is served only its OWN organisation's receipts, pushed into the
		// index (`by_tenant_recipient_unread`) before the scan cap, never a filter
		// after the read.
		//
		// CALLERS (measured): MCP — none (grep getUnreadCount mcp-server/src -> 0);
		// dashboard — app-sidebar.tsx:289 and message-timeline.tsx:66, both
		// `useQuery`, both in a mounted shell behind clerkMiddleware.
		//   anonymous            -> RAISES RBAC_DENIED (no mounted render exists).
		//   signed in, no org    -> `{ refused: true, count: 0 }`: a mounted render
		//                           (the sidebar badge) cannot take a throw, and a
		//                           bare 0 is byte-identical to "nothing unread". The
		//                           dashboard reads both shapes (readUnreadCount,
		//                           vantage-peers-dashboard PR #60).
		//   member, off-roster   -> `{ refused: true, count: 0 }` (same envelope).
		//   member, own roster   -> the unread count of its own tenant.
		//   fleet master         -> unchanged (all tenants, by recipient).
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "messages:getUnreadCount");

		if (scope.isMaster) {
			const receipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_recipient_unread", (q) =>
					q.eq("recipient", orchestratorId).eq("readAt", undefined),
				)
				.take(UNREAD_RECEIPTS_SCAN_CAP);
			return receipts.length;
		}
		if (scope.orgSlug === null) {
			return { refused: true as const, count: 0 };
		}
		// A member counts only the mailbox of an orchestrator on ITS OWN roster
		// (the free `orchestratorId` argument is not a licence to probe another
		// recipient's mailbox inside the tenant). Off-roster is the SAME typed
		// envelope as pre-org, never a bare 0 (the bytes of an absence) and never
		// a throw (the sidebar badge is a mounted useQuery). Bound on the
		// normalised name (NFC + lowercase + trim) on both sides; "*" names nobody.
		// isolation-contract: subscribers enumerated with
		// grep -rn "api.messages.getUnreadCount" in vantage-peers-dashboard
		// (app-sidebar.tsx, message-timeline.tsx), both read the envelope (PR #60).
		if (!isOrchestratorOnOrgRoster(scope, orchestratorId)) {
			return { refused: true as const, count: 0 };
		}
		// STORED-FORM LOOKUP. `messageReceipts.recipient` is written verbatim by
		// the delivery core: a broadcast stores the roster entry as the roster
		// spells it, a direct send stores the trimmed profile id. Neither path
		// normalises, so a roster entry "Eta" has receipts stored as "Eta".
		// Looking up only normalizeOrchestratorId(name) would MISS those rows and
		// under-count, so the index is probed with every stored form that the
		// normalised name can denote: the normalised form, the argument as sent,
		// and each roster spelling that normalises to it (distinct keys, so no
		// receipt is counted twice).
		const orgSlug = scope.orgSlug;
		const wanted = normalizeOrchestratorId(orchestratorId);
		const storedForms = new Set<string>([wanted, orchestratorId.trim()]);
		for (const entry of scope.allowedOrchestrators) {
			if (entry !== "*" && normalizeOrchestratorId(entry) === wanted) {
				storedForms.add(entry);
			}
		}
		let unread = 0;
		for (const recipient of storedForms) {
			const receipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_tenant_recipient_unread", (q) =>
					q
						.eq("tenantId", orgSlug)
						.eq("recipient", recipient)
						.eq("readAt", undefined),
				)
				.take(UNREAD_RECEIPTS_SCAN_CAP);
			unread += receipts.length;
		}
		return unread;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listBroadcastStatus — show who read a broadcast message and who didn't
// ─────────────────────────────────────────────────────────────────────────────

export const listBroadcastStatus = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		messageId: v.id("messages"),
		// Fix for the "list_broadcast_status returns Server Error" incident: the
		// MCP wrapper (mcp-server/src/tools.ts) always sent `limit` even when the
		// caller omitted it, but this arg list previously did not declare it,
		// so Convex rejected EVERY call with ArgumentValidationError. `limit` is
		// now declared AND applied (see `truncated` below — a capped list never
		// looks complete).
		limit: v.optional(v.number()),
	},
	returns: v.object({
		messageId: v.id("messages"),
		from: creatorValidator,
		channel: v.optional(v.string()),
		createdAt: v.number(),
		receipts: v.array(
			v.object({
				recipient: v.string(),
				recipientInstanceId: v.optional(v.string()),
				read: v.boolean(),
				readAt: v.optional(v.number()),
			}),
		),
		// True when `limit` truncated the receipts list — "I showed you N of M"
		// must never render identically to "there are N".
		truncated: v.boolean(),
	}),
	handler: async (ctx, { messageId, limit }) => {
		// GATE — membership of the message's OWN channel, resolved BEFORE the
		// receipts are read. Measured against the serving deployment: this query
		// answered a caller with NO CREDENTIAL AT ALL with the message's sender,
		// channel, timestamp and every recipient's read state. Read receipts are a
		// fact about OTHER PARTIES, so "some authenticated caller" is not entitled
		// (coordinator ruling). A non-master caller must (1) be a resolved member
		// of an active org holding `view-own-tasks` (the same scope
		// `listMessages` demands), (2) belong to the org that SENT the message
		// (`message.tenantId`), and (3) be on its channel under the same rule
		// `listByChannel` already applies (`isChannelOnScope`). Master passes.
		// Predicate lives inside the query, before any receipt row is read.
		//
		// REFUSAL SHAPE — a RAISE. isolation-contract: no reactive subscriber.
		// Enumerated by command against vantage-peers-dashboard:
		//   grep -rn "api\.issues\.\|api\.messages\." --include=*.tsx --include=*.ts \
		//     app components hooks lib contexts providers | grep "listBroadcastStatus"  -> 0 hits
		// Its only consumer is the MCP `list_broadcast_status` tool (one-shot
		// `convex.query`). So `alsoRefusePreOrg` is safe and a throw crashes no
		// render. See .claude/rules/refusal-is-distinguishable-from-absence.md.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "messages:listBroadcastStatus", {
			alsoRefusePreOrg: true,
		});
		requireScope(scope, "view-own-tasks");

		const message = await ctx.db.get(messageId);
		if (!message) throw new Error("Message not found");

		if (!scope.isMaster) {
			if (message.tenantId !== scope.orgSlug) {
				throw new ConvexError(
					`RBAC_DENIED: "messages:listBroadcastStatus" refuses a caller outside the organisation that sent message ${messageId} — ${JSON.stringify(
						{
							registration: "messages:listBroadcastStatus",
							orgSlug: scope.orgSlug,
							reason: "cross-tenant",
						},
					)}`,
				);
			}
			if (!isChannelOnScope(scope, message.channel)) {
				throw new ConvexError(
					`RBAC_DENIED: "messages:listBroadcastStatus" refuses a caller who is not on channel "${message.channel}" of message ${messageId} — ${JSON.stringify(
						{
							registration: "messages:listBroadcastStatus",
							orgSlug: scope.orgSlug,
							reason: "not-on-channel",
						},
					)}`,
				);
			}
		}

		// Deterministic order from the `by_message` index — no Date.now() here,
		// queries must stay reproducible for reactivity.
		const receipts = await ctx.db
			.query("messageReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", messageId))
			.collect();

		const mapped = receipts.map((r) => ({
			recipient: r.recipient,
			recipientInstanceId: r.recipientInstanceId,
			read: r.readAt !== undefined,
			readAt: r.readAt,
		}));

		const truncated = limit !== undefined && mapped.length > limit;
		const page = limit !== undefined ? mapped.slice(0, limit) : mapped;

		return {
			messageId,
			from: message.from,
			channel: message.channel,
			createdAt: message.createdAt,
			receipts: page,
			truncated,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByChannel — list recent messages for a channel (or all if unspecified)
// ─────────────────────────────────────────────────────────────────────────────

const listByChannelRow = v.object({
	_id: v.id("messages"),
	_creationTime: v.number(),
	from: creatorValidator,
	fromInstanceId: v.optional(v.string()),
	fromId: v.optional(v.string()),
	tenantId: v.optional(v.string()),
	channel: v.string(),
	content: v.string(),
	sessionDay: v.optional(v.number()),
	createdAt: v.number(),
});

export const listByChannel = query({
	args: {
		channel: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	// A bare array is a served result (rows, or a genuine absence). The
	// envelope is the refusal, said to a caller whose render is subscribed.
	returns: v.union(
		v.array(listByChannelRow),
		v.object({ refused: v.literal(true), items: v.array(listByChannelRow) }),
	),
	handler: async (ctx, { channel, limit }) => {
		const take = limit ?? 100;
		// R-50: reactively-subscribed public query — refuseWithoutThrow narrows
		// the signed-in-no-org branch to a typed-empty scope (isChannelAllowed
		// below already renders that scope as "broadcast only", never a throw).
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });

		// THE FAIL-OPEN POLE, CLOSED. This registration is the ONE of the fourteen
		// measured leaks that was NOT unguarded — it resolves a scope on the line
		// above and then DISCARDS it for one channel. `isChannelAllowed` below
		// returns true for `ch === "broadcast"` unconditionally, so at commit
		// bd8c60e9 a caller presenting NO CREDENTIAL AT ALL was served broadcast
		// message content straight off the public deployment URL (1 row, measured).
		// A HARDCODED LITERAL IS NOT AN AUTHORISATION — the same defect class as a
		// constant namespace standing in for a resolved one
		// (.claude/rules/authority-attached-to-anonymous-object.md).
		//
		// This is also why an instrument that only asks "does it resolve an
		// identity" cannot see this site, and why R-50/R-51 could not either: the
		// refusal SHAPE here was already correct, there simply was no refusal on
		// the anonymous pole at all.
		//
		// withOrgScope returns the IDENTICAL empty shape (orgSlug null, not master)
		// for both the anonymous branch and the signed-in-no-org `refused` branch,
		// so this ONE check closes both. Everything below is unchanged: an ordinary
		// member of an ACTIVE org still reads broadcast and still reads its own
		// roster's channels (both pinned as ALLOW poles in
		// publicRegistrationResolvesCaller.test.ts — a withheld grant here would be
		// as much a defect as the leak).
		// REFUSAL SHAPE — typed empty, never a throw: reactively-subscribed public
		// READ (R-50/R-51).
		//
		// REFUSAL SHAPE, CORRECTED (task k177hpz3cx9bb842tc9201wf118f94sa). The two
		// lines above reasoned correctly about R-50 and then drew the wrong
		// conclusion for the ANONYMOUS pole. A caller with no credential at all has
		// no mounted render for a throw to crash: the only subscribing consumer of
		// this backend is the vantage-peers-dashboard Next.js app, every route of
		// which sits behind `clerkMiddleware`, so no `useQuery` subscription is ever
		// established without a Clerk session. Returning an empty SUCCESS to that
		// caller is the defect — "you may not" and "there is nothing" come out as
		// identical bytes. `missions:list` has raised RBAC_DENIED at this same pole
		// in production all along while being reactively subscribed
		// (components/missions/mission-board.tsx:25).
		//
		// A dashboard `useQuery` DOES subscribe to this read
		// (components/messages/message-timeline.tsx:51,
		// components/messages/message-history-table.tsx:85,
		// components/activity/unified-activity-feed.tsx:153 — measured by grep in
		// vantage-peers-dashboard, origin/main), so `alsoRefusePreOrg` is NOT
		// passed: a throw would crash the pre-organisation caller's mounted render.
		//
		// RE-DECIDED (task k1749w7ecx2yffr1hbhjpk8v858fbrf1), not inherited: R-50's
		// reasoning (never throw at a mounted render) holds, but it justified a
		// bare `[]`, which is byte-identical to "no messages exist". Both
		// value-reading consumers already normalise the envelope
		// (message-timeline.tsx:55-59, unified-activity-feed.tsx normaliseList:
		// `Array.isArray(r) ? r : (r.items ?? [])`), so `{ refused: true, items: [] }`
		// renders as empty AND says it was refused.
		// See `.claude/rules/refusal-is-distinguishable-from-absence.md`.
		requireResolvedCaller(scope, "messages:listByChannel");
		if (!scope.isMaster && scope.orgSlug === null) {
			return { refused: true as const, items: [] };
		}

		// Fail-closed channel scoping. Messages DO carry `tenantId` (schema.ts, set
		// by sendMessage from the verified sender's org — never a client argument),
		// and a client's "broadcast" is tenant-scoped at write time. So the
		// "broadcast" channel is NOT universally shared: a hardcoded
		// `ch === "broadcast"` grant served every org's broadcast rows to every
		// resolved member (cross-tenant read). A non-master caller reads only rows
		// of its OWN tenant, pushed into the index predicate, and within that
		// tenant only channels `isChannelOnScope` admits. The master reads all.
		if (scope.isMaster) {
			if (channel !== undefined) {
				return await ctx.db
					.query("messages")
					.withIndex("by_channel", (q) => q.eq("channel", channel))
					.order("desc")
					.take(take);
			}
			return await ctx.db.query("messages").order("desc").take(take);
		}

		const orgSlug = scope.orgSlug;
		if (orgSlug === null) return { refused: true as const, items: [] };

		if (channel !== undefined) {
			if (!isChannelOnScope(scope, channel)) return [];
			return await ctx.db
				.query("messages")
				.withIndex("by_tenant_channel", (q) =>
					q.eq("tenantId", orgSlug).eq("channel", channel),
				)
				.order("desc")
				.take(take);
		}

		const rows = await ctx.db
			.query("messages")
			.withIndex("by_tenant_created", (q) => q.eq("tenantId", orgSlug))
			.order("desc")
			.take(take);
		return rows.filter((r) => isChannelOnScope(scope, r.channel));
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByChannelPaginated — the dashboard message-history table's own read.
//
// `components/messages/message-history-table.tsx:85` (vantage-peers-dashboard
// origin/main e2dc58f) calls `usePaginatedQuery(api.messages.listByChannel,
// { from?, since?, until? })`. usePaginatedQuery injects `paginationOpts`, and
// `listByChannel` (args: channel, limit) rejects it BEFORE its handler runs
// ("Unexpected field `paginationOpts` in object" — reproduced in
// convex/__tests__/operatorListByChannel.test.ts), which prod shows as
// `Server Error` for EVERY caller, org or no org. Same cure as
// `tasks.listPaginated`: a dedicated paginated read, same scope rules as
// `listByChannel`, the tenant predicate inside the index range.
//
// Index per branch (never `.filter()`): master -> by_channel / by_from /
// by_createdAt; a non-master -> by_tenant_channel / by_tenant_created. `from`
// is index-backed for the master when no channel is named; in every other
// branch it narrows the already index-bounded page in memory (a page may be
// short, `isDone`/`continueCursor` stay correct). The roster rule
// (`isChannelOnScope`) is applied the same way.
//
// REFUSAL SHAPE (.claude/rules/refusal-is-distinguishable-from-absence.md): a
// caller with no credential is RAISED at; a signed-in caller with no
// organisation gets an empty page carrying `refused: true` (a mounted render
// must not throw, and the bytes must not be those of an absence).
// ─────────────────────────────────────────────────────────────────────────────

// The return validator is exact: PaginationResult also carries optional
// `pageStatus`/`splitCursor`, which would fail it, so project the three fields.
function toHistoryPage(
	result: { isDone: boolean; continueCursor: string },
	page: Doc<"messages">[],
) {
	return {
		page,
		isDone: result.isDone,
		continueCursor: result.continueCursor,
	};
}

export const listByChannelPaginated = query({
	args: {
		paginationOpts: paginationOptsValidator,
		channel: v.optional(v.string()),
		from: v.optional(creatorValidator),
		since: v.optional(v.number()),
		until: v.optional(v.number()),
	},
	returns: v.object({
		page: v.array(listByChannelRow),
		isDone: v.boolean(),
		continueCursor: v.string(),
		refused: v.optional(v.literal(true)),
	}),
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "messages:listByChannelPaginated");
		if (!scope.isMaster && scope.orgSlug === null) {
			return {
				page: [],
				isDone: true,
				continueCursor: "",
				refused: true as const,
			};
		}

		const { channel, from, since, until, paginationOpts } = args;

		let result: PaginationResult<Doc<"messages">>;
		if (scope.isMaster) {
			if (channel !== undefined) {
				result = await ctx.db
					.query("messages")
					.withIndex("by_channel", (q) => {
						const base = q.eq("channel", channel);
						if (since !== undefined && until !== undefined)
							return base.gte("createdAt", since).lt("createdAt", until);
						if (since !== undefined) return base.gte("createdAt", since);
						if (until !== undefined) return base.lt("createdAt", until);
						return base;
					})
					.order("desc")
					.paginate(paginationOpts);
			} else if (from !== undefined) {
				result = await ctx.db
					.query("messages")
					.withIndex("by_from", (q) => {
						const base = q.eq("from", from);
						if (since !== undefined && until !== undefined)
							return base.gte("createdAt", since).lt("createdAt", until);
						if (since !== undefined) return base.gte("createdAt", since);
						if (until !== undefined) return base.lt("createdAt", until);
						return base;
					})
					.order("desc")
					.paginate(paginationOpts);
			} else {
				result = await ctx.db
					.query("messages")
					.withIndex("by_createdAt", (q) => {
						if (since !== undefined && until !== undefined)
							return q.gte("createdAt", since).lt("createdAt", until);
						if (since !== undefined) return q.gte("createdAt", since);
						if (until !== undefined) return q.lt("createdAt", until);
						return q;
					})
					.order("desc")
					.paginate(paginationOpts);
			}
			// Master + a channel + a sender: the channel index bounded the page;
			// narrow by sender in memory.
			return toHistoryPage(
				result,
				channel !== undefined && from !== undefined
					? result.page.filter((r) => r.from === from)
					: result.page,
			);
		}

		const orgSlug = scope.orgSlug;
		if (orgSlug === null) {
			return {
				page: [],
				isDone: true,
				continueCursor: "",
				refused: true as const,
			};
		}
		if (channel !== undefined && !isChannelOnScope(scope, channel)) {
			// A channel this caller may not read is an absence of ROWS for it, as in
			// `listByChannel` (the tenant predicate would match nothing anyway).
			return { page: [], isDone: true, continueCursor: "" };
		}

		result =
			channel !== undefined
				? await ctx.db
						.query("messages")
						.withIndex("by_tenant_channel", (q) => {
							const base = q.eq("tenantId", orgSlug).eq("channel", channel);
							if (since !== undefined && until !== undefined)
								return base.gte("createdAt", since).lt("createdAt", until);
							if (since !== undefined) return base.gte("createdAt", since);
							if (until !== undefined) return base.lt("createdAt", until);
							return base;
						})
						.order("desc")
						.paginate(paginationOpts)
				: await ctx.db
						.query("messages")
						.withIndex("by_tenant_created", (q) => {
							const base = q.eq("tenantId", orgSlug);
							if (since !== undefined && until !== undefined)
								return base.gte("createdAt", since).lt("createdAt", until);
							if (since !== undefined) return base.gte("createdAt", since);
							if (until !== undefined) return base.lt("createdAt", until);
							return base;
						})
						.order("desc")
						.paginate(paginationOpts);
		return toHistoryPage(
			result,
			result.page.filter(
				(r) =>
					isChannelOnScope(scope, r.channel) &&
					(from === undefined || r.from === from),
			),
		);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 100 — Phase 2 get_by_id surface fix (task k172735brsw6bc3j2dkkkfxqrx88kkjq)
// Single-row read by Convex doc ID. Returns null on miss (MCP layer reshapes
// to scope-aware "not found"). No validator on returns — schema for messages
// rows varies by send variant; raw row is fine for read-by-id.
// ─────────────────────────────────────────────────────────────────────────────

export const getById = query({
	// A wrong-table but well-formed 32-char id passes the `v.id("messages")`
	// validator's format check yet fails table membership, and that rejection
	// happens BEFORE the handler, so a wrong-table ID is rejected with a message
	// Convex redacts in prod (`Server Error`, `error.data` undefined — measured).
	// Narrowing inside the handler via requireId() throws a ConvexError whose
	// payload survives redaction. Same contract as PR #1069 (markAsRead) and
	// #1072 (tasks:getById), on a read.
	args: { messageId: v.string() },
	handler: async (ctx, args) => {
		// GATE — this read returned ANY message row to ANY caller by id, including
		// one with no credential. A non-master caller must be a resolved member of
		// an active org, belong to the org that SENT the row (`tenantId`), and be
		// on its channel (`isChannelOnScope`) — the exact rule
		// `listBroadcastStatus` applies. Master passes.
		// REFUSAL SHAPE — a RAISE. isolation-contract: no reactive subscriber.
		//   grep -rn "messages\.getById" app components hooks lib  (dashboard) -> 0
		// Its only consumer is the MCP `get_message` tool (one-shot
		// `convex.query`, tools.ts). See
		// .claude/rules/refusal-is-distinguishable-from-absence.md.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "messages:getById", {
			alsoRefusePreOrg: true,
		});

		const messageId = requireId(
			ctx,
			"messages",
			args.messageId,
			"messageId",
			"Use the full 32-char messageId returned by list_messages or checkNewMessages.",
		);
		const row = await ctx.db.get(messageId);
		if (row === null || scope.isMaster) return row;

		if (row.tenantId !== scope.orgSlug) {
			throw new ConvexError(
				`RBAC_DENIED: "messages:getById" refuses a caller outside the organisation that sent message ${messageId} — ${JSON.stringify(
					{
						registration: "messages:getById",
						orgSlug: scope.orgSlug,
						reason: "cross-tenant",
					},
				)}`,
			);
		}
		if (!isChannelOnScope(scope, row.channel)) {
			throw new ConvexError(
				`RBAC_DENIED: "messages:getById" refuses a caller who is not on channel "${row.channel}" of message ${messageId} — ${JSON.stringify(
					{
						registration: "messages:getById",
						orgSlug: scope.orgSlug,
						reason: "not-on-channel",
					},
				)}`,
			);
		}
		return row;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r).
// BM25 keyword search over message content via Convex native .searchIndex().
//
// Backed by the `search_content` searchIndex declared in schema.ts.
// Filter axes: from, channel, sessionDay, tenantId (matches messages.list()).
// ─────────────────────────────────────────────────────────────────────────────

export const searchMessagesByKeyword = query({
	args: {
		query: v.string(),
		from: v.optional(creatorValidator),
		channel: v.optional(v.string()),
		sessionDay: v.optional(v.number()),
		tenantId: v.optional(v.string()),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
	},
	handler: async (ctx, args) => {
		// ── Identity-derived tenant scope ────────────────────────────────────────
		// m977mqck: no-identity callers (MCP server / CLI) → isMaster=true, all rows.
		// m9748paff: Clerk callers are fail-CLOSED — scoped to their own tenantId.
		// k179fk0c: same per-tool tenancy doctrine as tasks.searchTasksByKeyword.
		// isolation-contract: NO reactive subscriber. Re-decided (task
		// k1749w7ecx2yffr1hbhjpk8v858fbrf1), not inherited from R-50. Measured by
		// command: `grep -rn "searchMessagesByKeyword" --include=*.ts
		// --include=*.tsx` in vantage-peers-dashboard (origin/main) finds ZERO
		// call sites; the only consumer is mcp-server `search_messages_by_keyword`
		// (tools.ts, one-shot `convex.query`). No render exists for a throw to
		// crash, and a bare `[]` would say "no matches" to a caller that was
		// refused. So `alsoRefusePreOrg` raises `RBAC_DENIED` at the pre-org
		// caller; the helper runs before requireScope for the same reason as in
		// listMessages.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "messages:searchMessagesByKeyword", {
			alsoRefusePreOrg: true,
		});
		requireScope(scope, "view-own-tasks");

		const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
		const lite = args.fields === "lite";

		const results = await ctx.db
			.query("messages")
			.withSearchIndex("search_content", (q) => {
				let qb = q.search("content", args.query);
				if (args.from !== undefined) qb = qb.eq("from", args.from);
				if (args.channel !== undefined) qb = qb.eq("channel", args.channel);
				if (args.sessionDay !== undefined)
					qb = qb.eq("sessionDay", args.sessionDay);
				// For Clerk callers: push scope.orgSlug into the search index filter
				// (primary isolation). For master callers: use caller-supplied tenantId
				// if provided (backward-compatible narrow by tenant for admin queries).
				if (!scope.isMaster && scope.orgSlug !== null) {
					qb = qb.eq("tenantId", scope.orgSlug);
				} else if (args.tenantId !== undefined) {
					qb = qb.eq("tenantId", args.tenantId);
				}
				return qb;
			})
			.take(limit);

		// Defense-in-depth: messages have no pilot/assignedTo so filterByOrgScope()
		// does not fit. Enforce tenantId match inline for non-master scopes — the
		// index .eq("tenantId", scope.orgSlug) above is the primary isolation; this
		// is the belt-and-suspenders pass (mirrors briefingNotes pattern).
		const filtered = !scope.isMaster
			? results.filter((r) => r.tenantId === scope.orgSlug)
			: results;

		if (!lite) return filtered;
		return filtered.map((m) => ({
			_id: m._id,
			from: m.from,
			channel: m.channel,
			content: m.content,
			sessionDay: m.sessionDay,
			createdAt: m.createdAt,
		}));
	},
});
