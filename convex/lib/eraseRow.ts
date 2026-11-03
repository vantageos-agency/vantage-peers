// eraseRow — the ONE erase mechanism of the tenant tables. Task
// k170t9bg650dyw6hxjj627p9fx8hhpeq (Pi 2026-11-03).
//
// THE RULE. An organisation admin erases any row of its organisation; any author erases the
// rows it wrote — a person by its verified subject ("user:<subject>"), an AGENT by its
// agents-row ID (the agent the transport verified for the seat, never a name the caller
// typed); another organisation and a same-organisation non-author are refused, typed
// (`RBAC_DENIED`), row unchanged. A real erase: the row and the rows that only exist for it
// are DELETED (and a memory's search entry is purged); nothing is flagged.
//
// ORDER of the decision (performErase): the row's STORED org ID against the caller's org ID
// (by ID, never by slug label) -> admin, or author by stored ID -> the per-table erase.
// A row with no stored author ID (written before the column, or by a seat that presented no
// agent proof) is erasable by an organisation admin only.
//
// SCOPE. `ERASE_COVERED` and `ERASE_SKIPPED` partition the tenant tables DERIVED from
// convex/schema.ts (convex/migrations/tenantOrgIdInvariant.ts `deriveTenantTables`); the test
// convex/__tests__/tenantEraseCoverage.test.ts fails when a tenant table is in neither, so a
// new tenant table cannot ship without a written decision. A table is SKIPPED only with a
// reason: its deletion is a revocation (credentials, sessions, identity), it is derived
// from another row, it is a system log, or it is configuration with its own remove door.
//
// WHO IS THE CALLER (resolveEraseCaller) — three transports, one outcome:
//   session  the caller's own Clerk session (dashboard, or the MCP forwarding a Clerk-JWT
//            bearer's own JWT): org, role and subject from the verified claims.
//   person   a person signed in through the MCP OAuth flow: the fleet service account is the
//            transport and the bearer hash (`verifiedPerson`) is re-read to a token row.
//   agent    a seat: the service account acting for its organisation plus the agent the
//            transport verified (`verifiedActor`); judged by the one agent-proof check.
// The fleet service account WITHOUT either proof is refused; the operator reaches every org
// through the internal fleet door only.

import {
	assertOrgAdmin,
	personActorName,
	resolveActingPrincipal,
	resolveCallerFromClaims,
	requireServiceAccountStanding,
	sameOrg,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deleteBodyChunks } from "../briefingNoteBodies";
import { internal } from "../_generated/api";
import { anonymousRefusal } from "./agentIdentity";
import {
	ORG_ADMIN_ROLES,
	type OrgScope,
	type VerifiedActor,
	refusalError,
	withOrgScope,
} from "./auth";
import { wireIdentityRefusal } from "./identityRefusalWire";
import { orgByIdLookups, orgByIdPrincipalLookups } from "./orgIdLookups";
import { personPrincipalLookups } from "./actingPrincipal";
import { resolveVerifiedPerson, type VerifiedPerson } from "./personPrincipal";
import { seatAgentIdOf } from "./seatNamespace";

// ── the policy table ─────────────────────────────────────────────────────────────────
export const ERASE_TABLES = [
	"memories",
	"messages",
	"missions",
	"tasks",
	"recurringTasks",
	"briefingNotes",
	"diary",
	"debateRooms",
	"issues",
	"businessUnits",
	"debateTemplates",
] as const;
export type EraseTable = (typeof ERASE_TABLES)[number];

export type ErasePolicy = {
	/** the row's tenant column holding the permanent Clerk org ID */
	orgField: "clerkOrgId" | "tenantOrgId";
	/** the column holding the author BY ID, or null when no author exists by design */
	authorField: string | null;
	/** why the table has no author (written; required when authorField is null) */
	authorlessReason?: string;
};

export const ERASE_COVERED: Record<EraseTable, ErasePolicy> = {
	memories: { orgField: "clerkOrgId", authorField: "createdById" },
	messages: { orgField: "tenantOrgId", authorField: "fromId" },
	missions: { orgField: "clerkOrgId", authorField: "createdById" },
	tasks: { orgField: "clerkOrgId", authorField: "createdById" },
	recurringTasks: { orgField: "clerkOrgId", authorField: "createdById" },
	briefingNotes: { orgField: "clerkOrgId", authorField: "createdById" },
	diary: { orgField: "clerkOrgId", authorField: "createdById" },
	debateRooms: { orgField: "tenantOrgId", authorField: "createdById" },
	issues: {
		orgField: "clerkOrgId",
		authorField: null,
		authorlessReason:
			"an issue row mirrors a GitHub issue written by the webhook, so no person or agent of the organisation authored it; only an organisation admin may erase it",
	},
	businessUnits: {
		orgField: "clerkOrgId",
		authorField: null,
		authorlessReason:
			"a business unit is organisation structure kept by its admins (ownerId names the unit's owner, not an author of the row); only an organisation admin may erase it",
	},
	debateTemplates: {
		orgField: "tenantOrgId",
		authorField: null,
		authorlessReason:
			"a debate template is organisation configuration upserted by its admins (updatedBy is the last editor, not the creator); only an organisation admin may erase it",
	},
};

const REVOCATION =
	"deleting this row is a revocation or an identity change handled by its own door (a revoke / remove / unlink), not an erase of authored content";
const DERIVED =
	"the row exists only for another row and is deleted with it by that table's erase";
const SYSTEM_LOG =
	"the row is a system-written record (telemetry, audit, staging) with no authored content and no author";

export const ERASE_SKIPPED: Record<string, string> = {
	messageReceipts: `${DERIVED}: the receipts of a message go with the message (messages cascade)`,
	bulk_complete_runs: `${SYSTEM_LOG}: an audit record of one bulk-complete operation`,
	tool_usage: `${SYSTEM_LOG}: one telemetry row per tool call`,
	githubRepoMapping: `configuration with its own org-scoped remove door (githubRepoMapping:remove): it maps a repository to an orchestrator and holds no authored content`,
	githubOwnerBindings: `${REVOCATION}: a GitHub owner binding is revoked through its binding door`,
	kbUploads: `${SYSTEM_LOG}: upload staging for the knowledge-base pipeline`,
	uploadTickets: `${SYSTEM_LOG}: a short-lived upload ticket`,
	oauth_person_codes: `${REVOCATION}: an OAuth authorisation code is a credential`,
	oauth_access_tokens: `${REVOCATION}: an access token is a credential, revoked through the OAuth revoke door`,
	oauth_refresh_tokens: `${REVOCATION}: a refresh token is a credential, revoked through the OAuth revoke door`,
	oauth_scope_profiles: `${REVOCATION}: a scope profile is the rights definition of a class of connections (rights-change rule)`,
	iframeEmbedSessions: `${REVOCATION}: an embed session is a credential, expired or revoked through its own door`,
	memberWriterRoles: `${REVOCATION}: a writer role is a person's authority in the organisation, changed through the roles door`,
	client_org_mapping: `${REVOCATION}: the organisation mapping is the fleet-owned definition of the tenant itself`,
	orgMembership: `${REVOCATION}: a membership row mirrors Clerk and is changed by the Clerk membership webhook`,
	okfDurableExportProgress: `${SYSTEM_LOG}: export job progress`,
	okfDurableExportEntries: `${SYSTEM_LOG}: export job staging entries`,
	agents: `${REVOCATION}: an agent is an identity; it is deactivated through the agent registry door`,
	agent_relations: `${REVOCATION}: a parent-child agent relation is identity structure changed through the agent registry`,
	agentLinks: `${REVOCATION}: a link between two agents is a grant, revoked through the agent-link door`,
	agent_credentials: `${REVOCATION}: an agent credential is revoked through the agent credential door`,
	debateSettings: `configuration singleton per organisation (limits), reset through its upsert door; it holds no authored content`,
};

export type EraseInventory = {
	covered: { table: string; orgField: string; authorField: string | null }[];
	skipped: { table: string; reason: string }[];
	uncovered: string[];
};

/** The partition of the derived tenant tables; `uncovered` must be empty. */
export function eraseInventory(derived: { table: string }[]): EraseInventory {
	const covered: EraseInventory["covered"] = [];
	const skipped: EraseInventory["skipped"] = [];
	const uncovered: string[] = [];
	for (const { table } of derived) {
		const policy = (ERASE_COVERED as Record<string, ErasePolicy | undefined>)[table];
		if (policy !== undefined) {
			covered.push({
				table,
				orgField: policy.orgField,
				authorField: policy.authorField,
			});
		} else if (ERASE_SKIPPED[table] !== undefined) {
			skipped.push({ table, reason: ERASE_SKIPPED[table] });
		} else {
			uncovered.push(table);
		}
	}
	return { covered, skipped, uncovered };
}

// ── who is the caller ────────────────────────────────────────────────────────────────
export type EraseCaller =
	| { kind: "fleet" }
	| {
			kind: "org";
			/** the caller's permanent Clerk org ID */
			orgId: string;
			isAdmin: boolean;
			/** the stored author IDs this caller IS: an agent ID, or "user:<subject>" */
			authorIds: readonly string[];
			via: "session" | "person" | "agent";
	  };

function denied(door: string, reason: string, detail?: Record<string, unknown>) {
	return new ConvexError(
		`RBAC_DENIED: ${door} refused — ${JSON.stringify({ reason, door, ...detail })}`,
	);
}

/** The fleet SERVICE ACCOUNT as transport (plain, or acting for an organisation). */
export function requireServiceAccount(transport: OrgScope, door: string): void {
	if (transport.serviceTransport === true) return;
	try {
		requireServiceAccountStanding(transport, door);
	} catch (err: unknown) {
		throw wireIdentityRefusal(err);
	}
}

export async function resolveEraseCaller(
	ctx: MutationCtx,
	args: {
		door: string;
		verifiedPerson?: VerifiedPerson;
		verifiedActor?: VerifiedActor;
	},
): Promise<EraseCaller> {
	const { door } = args;
	if (args.verifiedPerson !== undefined && args.verifiedActor !== undefined) {
		throw denied(door, "two-proofs", {});
	}

	// PERSON bearer: the service account carries the bearer hash; the person is rebuilt from
	// its token row and proven in its org by ID.
	if (args.verifiedPerson !== undefined) {
		const transport = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireServiceAccount(transport, door);
		const person = await resolveVerifiedPerson(ctx, transport, args.verifiedPerson, {
			door,
		});
		const acting = await resolveActingPrincipal(
			{
				kind: "person",
				personId: person.userId ?? "",
				verifiedOrgId: person.orgClerkId ?? "",
				verifiedOrgRole: person.orgRole,
			},
			personPrincipalLookups(ctx, person.userId),
			door,
		);
		if (!acting.ok) throw refusalError(acting.refusal);
		const admin = assertOrgAdmin(acting.principal, acting.principal.orgId, {
			adminRoles: ORG_ADMIN_ROLES,
			door,
		});
		return {
			kind: "org",
			orgId: acting.principal.orgId,
			isAdmin: admin.ok,
			authorIds: [personActorName(person.userId ?? "")],
			via: "person",
		};
	}

	// AGENT (a seat): the service account acting for its organisation, plus the agent the
	// transport verified. The proof is judged by the one agent-proof check; the org is the
	// acting org's permanent ID. An agent is never an organisation admin.
	if (args.verifiedActor !== undefined) {
		const scope = await withOrgScope(ctx);
		if (scope.serviceTransport !== true || scope.orgClerkId === undefined) {
			throw denied(door, "agent-proof-needs-acting-org", {});
		}
		const agentId = await seatAgentIdOf(ctx, scope, args.verifiedActor);
		if (agentId === undefined) throw denied(door, "agent-proof-not-accepted", {});
		return {
			kind: "org",
			orgId: scope.orgClerkId,
			isAdmin: false,
			authorIds: [agentId],
			via: "agent",
		};
	}

	// SESSION: the caller's own verified Clerk claims.
	const caller = await resolveCallerFromClaims(
		await ctx.auth.getUserIdentity(),
		{
			orgLookups: orgByIdLookups(ctx),
			principalLookups: orgByIdPrincipalLookups(ctx),
		},
		{ adminRoles: ORG_ADMIN_ROLES, door },
	);
	if (!caller.ok) {
		if (caller.subject === undefined) throw anonymousRefusal(door);
		throw refusalError(caller.refusal);
	}
	const admin = assertOrgAdmin(caller.principal, caller.principal.orgId, {
		adminRoles: ORG_ADMIN_ROLES,
		door,
	});
	return {
		kind: "org",
		orgId: caller.principal.orgId,
		isAdmin: admin.ok,
		authorIds: [caller.actorName],
		via: "session",
	};
}

/**
 * The decision, shared by every table and by the memory redact door: the row's STORED org
 * ID against the caller's, then admin, or author by stored ID. Throws `RBAC_DENIED`.
 * A missing row and a row of another org answer alike (no existence oracle).
 */
export function assertMayErase(
	caller: EraseCaller,
	row: Record<string, unknown> | null,
	policy: Pick<ErasePolicy, "orgField" | "authorField">,
	door: string,
): void {
	if (caller.kind === "fleet") return;
	const rowOrg = row === null ? undefined : row[policy.orgField];
	if (
		row === null ||
		typeof rowOrg !== "string" ||
		!sameOrg({ id: rowOrg }, { id: caller.orgId })
	) {
		throw denied(door, "row-not-found-or-not-in-caller-org");
	}
	if (caller.isAdmin) return;
	const author = policy.authorField === null ? undefined : row[policy.authorField];
	if (typeof author === "string" && author !== "" && caller.authorIds.includes(author)) {
		return;
	}
	throw denied(door, "not-author-or-admin", { via: caller.via });
}

// ── the erase itself ─────────────────────────────────────────────────────────────────
export type EraseOutcome = {
	table: EraseTable;
	rowId: string;
	erased: true;
	cascaded: Record<string, number>;
};

/**
 * Applies the rule and the table's erase. `rowId` is whatever the caller sent: an id of
 * another table, or one that does not exist, is refused like a row of another org.
 */
export async function performErase(
	ctx: MutationCtx,
	args: { table: EraseTable; rowId: string; caller: EraseCaller; door: string },
): Promise<EraseOutcome> {
	const { table, caller, door } = args;
	const policy = ERASE_COVERED[table];
	const id = ctx.db.normalizeId(table, args.rowId) as string | null;
	const row =
		id === null
			? null
			: ((await ctx.db.get(id as never)) as Record<string, unknown> | null);
	assertMayErase(caller, row, policy, door);
	if (id === null || row === null) {
		throw new ConvexError(
			`ERASE_ROW_NOT_FOUND: ${table} row ${args.rowId} does not exist — ${JSON.stringify({ table, door })}`,
		);
	}
	const cascaded = await eraseTableRow(ctx, table, id, row);
	return { table, rowId: id, erased: true, cascaded };
}

async function eraseTableRow(
	ctx: MutationCtx,
	table: EraseTable,
	id: string,
	row: Record<string, unknown>,
): Promise<Record<string, number>> {
	const cascaded: Record<string, number> = {};
	switch (table) {
		case "memories": {
			// The body and the search index both go: a purge of every version of the entry.
			await ctx.db.delete(id as Id<"memories">);
			await ctx.scheduler.runAfter(0, internal.ragSync.removeRagEntry, {
				memoryId: id as Id<"memories">,
				namespace: String(row.namespace),
			});
			cascaded.searchEntry = 1;
			return cascaded;
		}
		case "messages": {
			const receipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_message", (q) => q.eq("messageId", id as Id<"messages">))
				.collect();
			for (const receipt of receipts) await ctx.db.delete(receipt._id);
			await ctx.db.delete(id as Id<"messages">);
			cascaded.messageReceipts = receipts.length;
			return cascaded;
		}
		case "briefingNotes": {
			const noteId = id as Id<"briefingNotes">;
			await ctx.db.delete(noteId);
			await deleteBodyChunks(ctx.db, noteId);
			const participants = await ctx.db
				.query("briefingNoteParticipants")
				.withIndex("by_note", (q) => q.eq("noteId", noteId))
				.collect();
			for (const row of participants) await ctx.db.delete(row._id);
			cascaded.briefingNoteParticipants = participants.length;
			return cascaded;
		}
		case "debateRooms": {
			const roomId = id as Id<"debateRooms">;
			const turns = await ctx.db
				.query("debateTurns")
				.withIndex("by_room_seq", (q) => q.eq("roomId", roomId))
				.collect();
			for (const turn of turns) await ctx.db.delete(turn._id);
			await ctx.db.delete(roomId);
			cascaded.debateTurns = turns.length;
			return cascaded;
		}
		case "missions":
			await ctx.db.delete(id as Id<"missions">);
			return cascaded;
		case "tasks":
			await ctx.db.delete(id as Id<"tasks">);
			return cascaded;
		case "recurringTasks":
			await ctx.db.delete(id as Id<"recurringTasks">);
			return cascaded;
		case "diary":
			await ctx.db.delete(id as Id<"diary">);
			return cascaded;
		case "issues":
			await ctx.db.delete(id as Id<"issues">);
			return cascaded;
		case "businessUnits":
			await ctx.db.delete(id as Id<"businessUnits">);
			return cascaded;
		case "debateTemplates":
			await ctx.db.delete(id as Id<"debateTemplates">);
			return cascaded;
	}
}
