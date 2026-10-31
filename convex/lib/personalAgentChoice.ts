import {
	IdentityRefusalError,
	requireOrgAdmin as requireVerifiedOrgAdmin,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { assertAgentLabelValid } from "../agents";
import { assertAgentNameFree } from "./agentIdentity";
import { ORG_ADMIN_ROLES } from "./auth";

// ─────────────────────────────────────────────────────────────────────────────
// personalAgentChoice — the consent screen's "which agent do you act as" step
// (VantagePeers Cloud, task k176wqmafpq7asbh461g95tk7h8hbsmy).
//
// The set a person may CHOOSE from is computed here, once, and used twice: to
// DRAW the screen (`oauth:listPersonalAgentChoices`) and to JUDGE the posted
// choice (`oauth:putPersonCode`, inside the transaction that issues the
// authorization code). The screen is a convenience; the judgement re-reads the
// rows, so an agent that became someone else's between the two is refused.
//
// The person, the organisation and the role are the VERIFIED values the
// authorization code is bound to (the package took them from the Clerk session
// and the live membership). A choice carries an agent ID, never a name: a name
// never selects a row. Re-binding an agent from one person to another is not
// possible here; it stays the operator door `agents:setPersonalAgentOf`.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/** Rows read for one organisation. Over the cap the read FAILS (fail closed), never truncates. */
const CHOICE_ROSTER_CAP = 200;

/** Longest agent name the consent screen accepts (the field's own `maxlength`). */
const AGENT_NAME_MAX_LENGTH = 64;

/** The organisation the code is bound to: its permanent id and the key agents are filed under. */
export type ChoiceOrg = { id: string; key: string };

/** What the person chose on the consent screen. */
export type AgentChoice =
	| { kind: "existing"; agentId: string }
	| { kind: "create"; name: string };

export const AGENT_CHOICE_REFUSED = "AGENT_CHOICE_REFUSED";

function refuse(reason: string): ConvexError<string> {
	return new ConvexError(`${AGENT_CHOICE_REFUSED}: ${reason}`);
}

/**
 * The agents of `org` this person may take: active, an ordinary agent (not the
 * service account, not owned by a person's seat), and either designating this
 * person already or designating nobody. Never one designated to someone else.
 */
export async function choosableAgents(
	ctx: Ctx,
	personId: string,
	org: ChoiceOrg,
): Promise<Doc<"agents">[]> {
	const roster = await ctx.db
		.query("agents")
		.withIndex("by_org", (q) => q.eq("orgSlug", org.key))
		.take(CHOICE_ROSTER_CAP + 1);
	if (roster.length > CHOICE_ROSTER_CAP) {
		throw new ConvexError(
			`AGENT_SCAN_CAP_EXCEEDED: more than ${CHOICE_ROSTER_CAP} agents in this organisation, refusing to list from a partial view`,
		);
	}
	return roster.filter(
		(a) =>
			a.isActive &&
			a.kind !== "service" &&
			a.ownerPersonId === undefined &&
			// The permanent org ID, never the slug label alone: an unstamped row
			// may have been filed under this slug by a former holder of it, and an
			// unstamped row is good for a refusal, never a grant (agentIdentity.ts).
			a.clerkOrgId === org.id &&
			(a.personalAgentOf === undefined || a.personalAgentOf === personId),
	);
}

/** Active agents of `org` that already designate this person (zero, or the one they act as). */
async function activeHolders(
	ctx: Ctx,
	personId: string,
	org: ChoiceOrg,
): Promise<Doc<"agents">[]> {
	const rows = await ctx.db
		.query("agents")
		.withIndex("by_personal_agent_of", (q) =>
			q.eq("personalAgentOf", personId).eq("orgSlug", org.key),
		)
		.take(CHOICE_ROSTER_CAP + 1);
	if (rows.length > CHOICE_ROSTER_CAP) {
		throw new ConvexError(
			"PERSONAL_AGENT_AMBIGUOUS: more than the cap of agents of this organisation already designate this person",
		);
	}
	return rows.filter((a) => a.isActive);
}

/**
 * Refuses unless the role the code is bound to may create an agent in the
 * organisation the code is bound to. The decision is the package's
 * (`requireOrgAdmin`), over the verified role and the admin roles this backend
 * names; this only turns its refusal into this module's.
 */
function assertMayCreateAgent(role: string, orgId: string): void {
	try {
		requireVerifiedOrgAdmin({
			verifiedOrgId: orgId,
			targetOrgId: orgId,
			role,
			adminRoles: ORG_ADMIN_ROLES,
			door: "oauth:personalAgentChoice",
		});
	} catch (err: unknown) {
		if (err instanceof IdentityRefusalError) {
			throw refuse("only an organisation admin may create an agent");
		}
		throw err;
	}
}

/** Whether the screen offers the create field (the same decision, asked without raising). */
function mayCreateAgent(role: string, orgId: string): boolean {
	try {
		assertMayCreateAgent(role, orgId);
		return true;
	} catch (err: unknown) {
		if (err instanceof ConvexError) return false;
		throw err;
	}
}

/** The screen's model for one organisation. */
export async function agentChoicesFor(
	ctx: Ctx,
	personId: string,
	org: ChoiceOrg,
	role: string,
): Promise<{
	agents: { agentId: Doc<"agents">["_id"]; name: string; mine: boolean }[];
	canCreate: boolean;
}> {
	const listed = await choosableAgents(ctx, personId, org);
	const held = await activeHolders(ctx, personId, org);
	// A person who already acts as an agent here is shown that one only: a second
	// designation would make the resolution ambiguous (the person would act as
	// nobody), so offering one would be offering a choice that cannot hold.
	const shown =
		held.length > 0
			? listed.filter((a) => held.some((h) => h._id === a._id))
			: listed;
	return {
		agents: shown.map((a) => ({
			agentId: a._id,
			name: a.name,
			mine: held.some((h) => h._id === a._id),
		})),
		canCreate: held.length === 0 && mayCreateAgent(role, org.id),
	};
}

/**
 * Judges and applies the posted choice, in the caller's transaction. Throws
 * `AGENT_CHOICE_REFUSED` (or `AGENT_NAME_TAKEN` / `AGENT_NAME_INVALID`) before
 * any write; the caller issues the code only after this returns.
 */
export async function applyAgentChoice(
	ctx: MutationCtx,
	bound: { personId: string; org: ChoiceOrg; role: string },
	choice: AgentChoice,
): Promise<void> {
	const { personId, org } = bound;
	const held = await activeHolders(ctx, personId, org);
	if (choice.kind === "existing") {
		const id = ctx.db.normalizeId("agents", choice.agentId);
		const listed = await choosableAgents(ctx, personId, org);
		const picked = id === null ? undefined : listed.find((a) => a._id === id);
		if (picked === undefined) {
			throw refuse(
				"the agent is not one this person may take in this organisation",
			);
		}
		if (held.some((h) => h._id === picked._id)) return;
		if (held.length > 0) {
			throw refuse(
				"this person already acts as another agent in this organisation",
			);
		}
		await ctx.db.patch(picked._id, { personalAgentOf: personId });
		return;
	}
	assertMayCreateAgent(bound.role, org.id);
	if (held.length > 0) {
		throw refuse(
			"this person already acts as another agent in this organisation",
		);
	}
	const name = choice.name.trim();
	if (name.length > AGENT_NAME_MAX_LENGTH) {
		throw new ConvexError(
			`AGENT_NAME_INVALID: an agent name is at most ${AGENT_NAME_MAX_LENGTH} characters`,
		);
	}
	assertAgentLabelValid(name);
	await assertAgentNameFree(ctx, { id: org.id, label: org.key }, name);
	await ctx.db.insert("agents", {
		orgSlug: org.key,
		clerkOrgId: org.id,
		name,
		normalizedName: normalizeOrchestratorId(name),
		personalAgentOf: personId,
		isActive: true,
		createdAt: Date.now(),
	});
}
