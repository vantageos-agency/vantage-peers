import { decideActingClaim } from "@vantageos/cloud-identity";
import {
	actingClaimDecision,
	internalClient,
	type OAuthContext,
	seatAgentOf,
} from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// actorFromAgentId - when the bearer resolves an agent ID, the actor IS that ID.
//
// VantagePeers Cloud (multi-tenant). Task k1728rrwzwtzc7hvc42d62t6558ha92a.
// Operator order 2026-10-31: identity is the agent ID; a name never selects or
// authorises.
//
// Before: a caller resolved to an agent BY ID (a per-agent credential, a seat
// stamp, a person token's personal agent) was still judged on the SPELLING of
// the acting name it typed: `hélios` passed, `Helios` and `marie` were refused
// (@vantageos/cloud-identity decideActingClaim compares the typed name with the
// agent's label). The spelling decided.
//
// Now, for such a caller, the acting name is optional and is never a selector:
//   - omitted                                 -> the agent's stored label (bindActingNames);
//   - the agent's own label or ID             -> admitted;
//   - it designates a DIFFERENT agent         -> AGENT_IDENTITY_MISMATCH;
//   - it designates no agent the caller's own organisation lists -> admitted.
// In every admitted case the write is attributed to the caller's ID under the
// agent's STORED label (the argument is rebound to it), which is what the Convex
// door receives together with `verifiedActor` (verifiedActor.ts).
//
// "Designates a different agent" is read from the caller's OWN organisation
// directory, orgRoster:getAgentDirectoryForAccessToken, which returns each
// listed agent's stored ID beside its label. The key into that door is the
// token hash the bearer presented; no organisation and no name from the call
// reaches it. Label equality is NOT re-implemented here: it is the package's
// own comparator (decideActingClaim), probed once per listed agent.
//
// What is refused, and why it fails closed:
//   - a value that is an agent ID (Convex ID-shaped) the directory does not list
//     under the caller's ID: another organisation's agent, or an unknown one;
//   - any value other than the agent's own, when the directory cannot be read
//     (no token hash, an org that disagrees with the token's, a throwing or
//     malformed answer): "designates no agent" cannot be asserted without the
//     directory, so it is not assumed;
//   - the name of an agent of ANOTHER organisation is indistinguishable, from
//     here, from a name that designates nobody: the caller's own directory does
//     not list it and no door answers across organisations (that answer would be
//     an existence oracle). It is admitted as "no agent" and the write is still
//     attributed to the caller's own ID. Proposal: see the task completion note.
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_DIRECTORY_DOOR = "orgRoster:getAgentDirectoryForAccessToken";

/** A Convex document ID as the `agents` table stores it: 32 lowercase alphanumerics. */
const CONVEX_ID_SHAPE = /^[a-z0-9]{32}$/;

export type ResolvedAgent = {
	agentId: string;
	agentLabel: string;
	orgSlug: string;
};

/**
 * The agent this request resolved BY ID, or undefined: a credential-bound
 * `actor` that carries an ID, else a seat stamp (the same order as
 * `actingClaimDecision`). A caller with neither keeps today's rules.
 */
export function resolvedAgentOf(
	ctx: OAuthContext | undefined,
): ResolvedAgent | undefined {
	if (!ctx) return undefined;
	if (ctx.actor) {
		const { agentId, agentName, orgSlug } = ctx.actor;
		if (agentId === undefined || agentId === "" || agentName === "") {
			return undefined;
		}
		return { agentId, agentLabel: agentName, orgSlug };
	}
	const seat = seatAgentOf(ctx);
	if (seat === undefined) return undefined;
	return {
		agentId: seat.agentId,
		agentLabel: seat.agentName,
		orgSlug: seat.orgId,
	};
}

export type ActorFromIdDecision =
	| { ok: true; label: string }
	| { ok: false; error: string };

type DirectoryEntry = { name: string; agentId: string | null };

function refuse(
	claimed: string,
	resolved: ResolvedAgent,
	why: string,
): ActorFromIdDecision {
	return {
		ok: false,
		error:
			`AGENT_IDENTITY_MISMATCH: this call names "${claimed}" but ${why}; ` +
			`the caller resolves to agent "${resolved.agentLabel}" (${resolved.agentId}, org "${resolved.orgSlug}"), ` +
			"and a caller acts as its resolved agent ID. Omit the name to act as the resolved agent " +
			"(door mcp:acting-claim).",
	};
}

async function readDirectory(
	ctx: OAuthContext,
	resolved: ResolvedAgent,
): Promise<DirectoryEntry[] | null> {
	// The directory is the token's organisation. It must be the resolved agent's
	// own, or "no agent listed" says nothing about the agent's organisation.
	if (
		ctx.accessTokenHash === undefined ||
		ctx.clerkOrgSlug !== resolved.orgSlug
	) {
		return null;
	}
	try {
		const raw: unknown = await internalClient().query(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			AGENT_DIRECTORY_DOOR as any,
			{ tokenHash: ctx.accessTokenHash },
		);
		if (!Array.isArray(raw)) return null;
		const out: DirectoryEntry[] = [];
		for (const e of raw as unknown[]) {
			const row = e as { name?: unknown; agentId?: unknown };
			if (typeof row?.name !== "string") return null;
			out.push({
				name: row.name,
				agentId: typeof row.agentId === "string" ? row.agentId : null,
			});
		}
		return out;
	} catch {
		return null;
	}
}

/** True when `claimed` is `entry`'s label, by the package's own comparator. */
function sameLabelAsEntry(claimed: string, entry: DirectoryEntry): boolean {
	return decideActingClaim({
		claimed,
		caller: {
			kind: "agent-credential",
			agentId: entry.agentId ?? "inactive-agent",
			agentLabel: entry.name,
			orgSlug: "directory-probe",
		},
		mode: "strict",
		door: AGENT_DIRECTORY_DOOR,
	}).ok;
}

/**
 * Decides an acting name typed by a caller that resolved `resolved` BY ID.
 * Admits with the agent's stored label, or refuses AGENT_IDENTITY_MISMATCH.
 */
export async function decideActingNameForResolvedAgent(
	ctx: OAuthContext,
	resolved: ResolvedAgent,
	claimed: string,
): Promise<ActorFromIdDecision> {
	// The agent itself, by its label (the package's comparator) or by its ID.
	if (
		claimed === resolved.agentId ||
		actingClaimDecision(ctx, claimed, "strict").ok
	) {
		return { ok: true, label: resolved.agentLabel };
	}
	const directory = await readDirectory(ctx, resolved);
	if (directory === null) {
		return refuse(
			claimed,
			resolved,
			"the caller's organisation directory could not be read to tell whether that name designates another agent",
		);
	}
	for (const entry of directory) {
		if (entry.agentId === resolved.agentId) continue;
		if (
			(entry.agentId !== null && claimed === entry.agentId) ||
			sameLabelAsEntry(claimed, entry)
		) {
			return refuse(claimed, resolved, "that designates another agent");
		}
	}
	if (CONVEX_ID_SHAPE.test(claimed)) {
		return refuse(
			claimed,
			resolved,
			"that is an agent ID this organisation does not list for the caller",
		);
	}
	return { ok: true, label: resolved.agentLabel };
}
