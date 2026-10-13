import type { OAuthContext } from "./auth.js";
import { holdsMasterBearer } from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// operatorClaim - the organisation every claim-bound Convex door is called for
// (backend standard R-54: a service-account call that carries no verified
// organisation is REFUSED, never served as master).
//
// Every MCP caller reaches Convex as ONE service account. The doors listed in
// {@link CLAIM_BOUND_DOORS} therefore refuse a call that names no organisation
// (convex/lib/verifiedOrg.ts requireServiceAccountClaim). This module is the
// transport half: it names the organisation, from the verified oauthContext only,
// and never from a tool argument.
//
//   - a tenant bearer: the organisation of its agent credential, else the one
//     snapshotted on its access-token row (the same value `verifiedOrgArgs`
//     forwards);
//   - the fleet's own stations (the master bearer, the local stdio trust): the
//     OPERATOR organisation, which Convex resolves from stored data
//     (clientOrgMapping:getOperatorOrg, `findOperatorOrg` of
//     @vantageos/cloud-identity) and the transport reads where it builds the
//     context (`ctx.operatorOrgSlug`, operatorOrg.ts). No slug is typed here;
//     when Convex cannot answer, nothing is forwarded and the door refuses the
//     call;
//   - a Clerk-JWT session: nothing, its own org reaches Convex as its identity.
//
// A call that already carries a `verifiedOrg`, or a person (`verifiedPerson`),
// is left as it is: one claim per call.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every public Convex door that refuses a service-account call carrying no
 * verified organisation. The sweep in test/operator-claim-doors.test.ts proves
 * each name declares `verifiedOrg` in convex/ and that no door calling a claim
 * helper is missing; the REFUSED / PRESENT poles of
 * convex/__tests__/claimlessServiceAccountRefused.test.ts prove each one refuses
 * the claimless call and serves the operator organisation's.
 */
export const CLAIM_BOUND_DOORS: ReadonlySet<string> = new Set([
	"briefingNotes:get",
	"briefingNotes:list",
	"briefingNotes:searchBriefingNotesByKeyword",
	"businessUnits:create",
	"businessUnits:get",
	"businessUnits:list",
	"businessUnits:remove",
	"businessUnits:update",
	"dashboard:getDashboardSummary",
	"dashboard:getProjectSummary",
	"diary:deleteDiary",
	"diary:get",
	"diary:list",
	"diary:listByDateRange",
	"diary:write",
	"episodes:getCriticalInsights",
	"episodes:listEpisodes",
	"episodes:storeEpisode",
	"errorMonitor:getError",
	"errorMonitor:listDeployments",
	"errorMonitor:listErrors",
	"errorMonitorFilters:getPendingAliasReleases",
	"errorMonitorFilters:listFilterRules",
	"fixPatterns:get",
	"fixPatterns:listAll",
	"fixPatterns:listByProject",
	"fixPatterns:listByStack",
	"githubOwnerBinding:listBindings",
	"githubOwnerBinding:listUnprovenMappings",
	"githubRepoMapping:add",
	"githubRepoMapping:getByRepo",
	"githubRepoMapping:list",
	"githubRepoMapping:remove",
	"iframeEmbedSessions:createSession",
	"iframeEmbedSessions:getSession",
	"iframeEmbedSessions:revokeSession",
	"iframeEmbedSessions:touchSession",
	"improvisationDigest:scanWindow",
	"issueStatsQueries:getLatest",
	"issues:getByRepoNumber",
	"issues:getStats",
	"issues:listByOrchestrator",
	"issues:listByProject",
	"issues:listByStatus",
	"issues:listExternalOpen",
	"kb:softDeleteDocument",
	"kb:storeDocumentChunked",
	"kbMutations:claimUpload",
	"kbMutations:generateUploadUrl",
	"kbMutations:generateUploadUrlWithTicket",
	"mandates:get",
	"mandates:list",
	"mandates:validateSpending",
	"memories:getMemory",
	"memories:listMemories",
	"memories:softDeleteMemory",
	"memories:storeMemory",
	"messages:getById",
	"messages:listBroadcastStatus",
	"messages:listByChannel",
	"messages:listByChannelPaginated",
	"messages:listMessages",
	"messages:searchMessagesByKeyword",
	"missionTemplates:getByName",
	"missionTemplates:instantiateTemplateIntoMission",
	"missionTemplates:listNames",
	"missions:create",
	"missions:get",
	"missions:list",
	"missions:update",
	"missions:updateProgress",
	"missions:updateStatus",
	"okfBundleDurable:cancelOkfBundleExportDurable",
	"okfBundleDurable:getOkfBundleExportDurableStatus",
	"okfBundleDurable:startOkfBundleExportDurable",
	"okfBundleNode:exportOkfBundle",
	"okfBundleNode:importOkfBundle",
	"okfBundleNode:validateOkfBundle",
	"orgMembership:getMembership",
	"orgRoster:getMyAgentDirectory",
	"orgRoster:getMyOrgRoster",
	"profiles:getProfile",
	"profiles:getProfileWithMemories",
	"profiles:listProfiles",
	"profiles:updateDynamic",
	"profiles:upsertProfile",
	"stats:fleetStats",
	"stats:openTaskCountsByOrchestrator",
	"stats:orchestratorStats",
]);

/**
 * The organisation a TENANT bearer is verified for, or undefined: its agent
 * credential's organisation, else the one on its access-token row. Never the
 * master's (see {@link withOperatorClaim}) and never a Clerk session's.
 */
export function tenantClaimOrgOf(
	ctx: OAuthContext | undefined,
): string | undefined {
	if (!ctx || ctx.clerkJwt !== undefined || holdsMasterBearer(ctx)) {
		return undefined;
	}
	return ctx.actor?.orgSlug ?? ctx.clerkOrgSlug;
}

type Callable = {
	query?: (name: never, args: never, ...rest: never[]) => unknown;
	mutation?: (name: never, args: never, ...rest: never[]) => unknown;
	action?: (name: never, args: never, ...rest: never[]) => unknown;
};

/**
 * Wraps a Convex client so EVERY call to a claim-bound door carries the
 * bearer's verified organisation, whichever tool made it. A tool that forgot to
 * forward it is an outage, never a leak: the door refuses the claimless call.
 * Returns the SAME client object when the bearer has no claim to make (a Clerk
 * session, or an absent context).
 */
export function withOperatorClaim<T extends Callable>(
	convex: T,
	ctx: OAuthContext | undefined,
): T {
	if (!ctx || ctx.clerkJwt !== undefined) return convex;
	const orgSlug = holdsMasterBearer(ctx)
		? ctx.operatorOrgSlug
		: tenantClaimOrgOf(ctx);
	if (orgSlug === undefined) return convex;
	const forward = (name: string, args: unknown): unknown => {
		if (!CLAIM_BOUND_DOORS.has(name)) return args;
		const a = (typeof args === "object" && args !== null ? args : {}) as Record<
			string,
			unknown
		>;
		if (a.verifiedOrg !== undefined || a.verifiedPerson !== undefined) {
			return args;
		}
		return { ...a, verifiedOrg: { orgSlug } };
	};
	return new Proxy(convex, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target) as unknown;
			if (prop === "query" || prop === "mutation" || prop === "action") {
				return (name: string, args: unknown, ...rest: unknown[]) => {
					const call = (target as Record<string, unknown>)[prop] as (
						...a: unknown[]
					) => unknown;
					return call.call(target, name, forward(name, args), ...rest);
				};
			}
			return typeof value === "function"
				? (value as (...a: unknown[]) => unknown).bind(target)
				: value;
		},
	});
}
