import type { OAuthContext, SeatOrgResolution } from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// doorScope — the ONE resolver of the scope arguments an MCP tool hands a Convex
// door (task k176y0q5jcz3m8m673bf61kva98h49js).
//
// Why one. Every tool used to compose its own scope from four helpers
// (personDoorArgs, seatOrgDoorArgs, verifiedOrgArgs, inboxOrgArgs). A write tool
// that forgot one forwarded LESS scope than its read sibling: create_task spread
// personDoorArgs only, list_tasks spread verifiedOrgArgs, so a person acting as
// its personal agent wrote a task its own reads could never return. Here the
// arguments are decided by the DOOR, from a table pinned to each door's Convex
// validator (test/door-scope-resolver.test.ts), and a tool cannot choose less.
//
// What is forwarded, and when. Every value comes from the verified oauthContext
// (the caller facts below), never from a tool argument.
//   - verifiedPerson: the door takes it and a PERSON acts in its own name (no
//     acting name, a person token, its bearer hash). Convex rebuilds the
//     person's scope from the token row (convex/lib/personPrincipal.ts).
//   - verifiedOrg: the door takes it and the bearer has a verified org (a
//     non-master, non-Clerk bearer). The door's rule decides how it sits beside
//     the other proofs:
//       "always"        - forwarded whatever else rides the call;
//       "unless-person" - not beside verifiedPerson (the person's own scope
//                         already carries its org);
//       "unless-proof"  - the inbox doors: not beside verifiedPerson, nor beside
//                         a verified agent ID (the reader is then that ID).
//   - seatOrgSlug: the door takes it, no person acts in its own name, and the
//     seat's org resolves (a refusal is returned as `denied`, never a widening).
// The agent ID (`verifiedActor`) is added by withVerifiedActor (verifiedActor.ts)
// for the doors in VERIFIED_ACTOR_DOORS; it is a fact here, never an output.
// ─────────────────────────────────────────────────────────────────────────────

export type OrgBesideProof = "always" | "unless-person" | "unless-proof";

export type DoorScopeRule = {
	readonly verifiedPerson?: true;
	readonly verifiedOrg?: OrgBesideProof;
	readonly seatOrgSlug?: true;
};

/**
 * Every Convex door an MCP tool hands caller scope to, with the scope arguments
 * that door's validator accepts. A door whose validator accepts `verifiedOrg`,
 * `verifiedPerson` or `seatOrgSlug` and is called by a tool MUST be here, with
 * exactly those arguments (pinned by test/door-scope-resolver.test.ts).
 */
export const DOOR_SCOPE: Readonly<Record<string, DoorScopeRule>> = {
	// memories / episodes
	"memories:getMemory": { verifiedOrg: "always" },
	// messages
	"messages:sendMessage": { verifiedPerson: true, seatOrgSlug: true },
	"messages:checkNewMessagesEnvelope": { verifiedOrg: "unless-proof" },
	"messages:markAsRead": { verifiedPerson: true, verifiedOrg: "unless-proof" },
	"messages:deleteMessage": { verifiedOrg: "unless-proof" },
	"messages:listMessages": { verifiedOrg: "always" },
	"messages:searchMessagesByKeyword": { verifiedOrg: "always" },
	"messages:listBroadcastStatus": { verifiedOrg: "always" },
	"messages:getById": { verifiedOrg: "always" },
	// tasks
	"tasks:create": { verifiedPerson: true, verifiedOrg: "unless-person" },
	"tasks:list": { verifiedOrg: "always" },
	"tasks:searchTasksByKeyword": { verifiedOrg: "always" },
	"tasks:bulkComplete": { verifiedOrg: "always" },
	"tasks:update": { verifiedPerson: true, verifiedOrg: "always" },
	"tasks:complete": { verifiedPerson: true, verifiedOrg: "always" },
	"tasks:start": { verifiedPerson: true, verifiedOrg: "always" },
	"tasks:failTask": { verifiedOrg: "always" },
	"tasks:pause": { verifiedOrg: "always" },
	"tasks:resume": { verifiedOrg: "always" },
	"tasks:correctSegment": { verifiedOrg: "always" },
	"tasks:checkout": { verifiedOrg: "always" },
	"tasks:deleteTask": { verifiedOrg: "always" },
	"tasks:blockTask": { verifiedOrg: "always" },
	// missions
	"missions:create": { verifiedPerson: true, verifiedOrg: "unless-person" },
	"missions:update": { verifiedPerson: true },
	// briefing notes
	"briefingNotes:create": { verifiedOrg: "always" },
	"briefingNotes:get": { verifiedOrg: "always" },
	"briefingNotes:list": { verifiedOrg: "always" },
	"briefingNotes:searchBriefingNotesByKeyword": { verifiedOrg: "always" },
	// business units
	"businessUnits:create": { verifiedOrg: "always" },
	"businessUnits:update": { verifiedOrg: "always" },
	"businessUnits:get": { verifiedOrg: "always" },
	"businessUnits:list": { verifiedOrg: "always" },
	"businessUnits:remove": { verifiedOrg: "always" },
	// GitHub repo mappings
	"githubRepoMapping:list": { verifiedOrg: "always" },
	"githubRepoMapping:add": { verifiedOrg: "always" },
	"githubRepoMapping:remove": { verifiedOrg: "always" },
	// knowledge base: a seat reaches these as the service account, so the org it
	// acts on is the verified one (tools/kbIngest.ts), never a namespace prefix
	"kb:storeDocumentChunked": { verifiedOrg: "always" },
	"kb:softDeleteDocument": { verifiedOrg: "always" },
	"kbMutations:generateUploadUrl": { verifiedOrg: "always" },
	"kbMutations:generateUploadUrlWithTicket": { verifiedOrg: "always" },
	"kbMutations:claimUpload": { verifiedOrg: "always" },
};

/**
 * The organisation THIS bearer was verified for, for a call that reaches Convex
 * as the fleet service account (so `ctx.auth` there carries no org). Read from the
 * verified oauthContext only: the agent credential's org (`actor`, bound to the
 * principal's own org before it is set) or the org snapshotted on the access-token
 * row. Never from an argument or a namespace prefix. The master and a Clerk-JWT
 * caller (whose own org Convex already sees) have none here.
 */
export function verifiedOrgSlugOf(
	oauthCtx: OAuthContext | undefined,
): string | undefined {
	if (!oauthCtx || oauthCtx.isMaster || oauthCtx.clerkJwt !== undefined) {
		return undefined;
	}
	return oauthCtx.actor?.orgSlug ?? oauthCtx.clerkOrgSlug;
}

/** What the verified oauthContext says about the caller. Never a tool argument. */
export type DoorScopeFacts = {
	/** The bearer hash of a PERSON token, when the caller is a person acting as itself. */
	readonly personAccessTokenHash?: string;
	/** The bearer's verified org (agent credential's, or the token row's); none for master / Clerk. */
	readonly verifiedOrgSlug?: string;
	/** True when the bearer resolved ONE agent ID (withVerifiedActor forwards it). */
	readonly hasVerifiedActor: boolean;
	/** The seat's org for a recipient-scoped door (resolveSeatOrg). */
	readonly seat: SeatOrgResolution;
};

export type DoorScopeArgs = {
	verifiedPerson?: { accessTokenHash: string };
	verifiedOrg?: { orgSlug: string };
	seatOrgSlug?: string;
};

export type DoorScopeResolution =
	| { readonly args: DoorScopeArgs }
	| { readonly denied: string };

/**
 * The scope arguments `door` is handed for a caller described by `facts`, acting
 * under `actingName` (undefined: no acting name, which for a person means "in
 * its own name"). A door absent from {@link DOOR_SCOPE} is a programming error
 * and throws, so a new call site cannot silently forward nothing.
 */
export function resolveDoorScope(
	door: string,
	actingName: string | undefined,
	facts: DoorScopeFacts,
): DoorScopeResolution {
	const rule = DOOR_SCOPE[door];
	if (rule === undefined) {
		throw new Error(
			`doorScope: "${door}" is not in DOOR_SCOPE — add it with the scope arguments its Convex validator accepts`,
		);
	}
	const personActsAsItself =
		actingName === undefined && facts.personAccessTokenHash !== undefined;
	const args: DoorScopeArgs = {};
	if (rule.verifiedPerson === true && personActsAsItself) {
		args.verifiedPerson = {
			accessTokenHash: facts.personAccessTokenHash as string,
		};
	}
	if (rule.verifiedOrg !== undefined && facts.verifiedOrgSlug !== undefined) {
		const besideProof =
			rule.verifiedOrg === "always" ||
			(rule.verifiedOrg === "unless-person" && !personActsAsItself) ||
			(rule.verifiedOrg === "unless-proof" &&
				!personActsAsItself &&
				!facts.hasVerifiedActor);
		if (besideProof) args.verifiedOrg = { orgSlug: facts.verifiedOrgSlug };
	}
	if (rule.seatOrgSlug === true && !personActsAsItself) {
		if (facts.seat.kind === "refused") return { denied: facts.seat.error };
		if (facts.seat.kind === "org") args.seatOrgSlug = facts.seat.orgSlug;
	}
	return { args };
}
