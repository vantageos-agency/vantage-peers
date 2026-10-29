/**
 * Backend-compat boot check.
 *
 * The MCP server (Railway) and the Convex backend deploy independently. On
 * 2026-10-12 the MCP went out calling `oauth:rotateRefreshToken` and passing
 * new arguments while Convex prod was still an older build, and clients
 * failed for hours (task k1716jehh2mhy4xah4js2804g58g4nsc).
 *
 * Before serving, the MCP now asks the backend it is pointed at for its
 * contract manifest (`meta:backendContract`, convex/meta.ts) and checks that
 * (1) the backend HAS a manifest, (2) it is at least REQUIRED_CONTRACT_VERSION,
 * and (3) every function in MCP_CALLED_FUNCTIONS is in it. Any failure is a
 * refusal: log a loud error that NAMES the cause (and the missing functions),
 * exit non-zero. On Railway a process that exits before it listens fails the
 * healthcheck, so the previous deployment keeps serving.
 *
 * Every failure is its own reason, because they are different operator
 * actions and must not read alike (refusal-is-distinguishable-from-absence):
 *   no-manifest          backend predates the manifest door -- deploy Convex
 *   refused              the door raised RBAC_DENIED -- this MCP's identity
 *                        is not the fleet service account
 *   cannot-authenticate  the MCP could not even mint its identity
 *   version-too-old      backend contract version < REQUIRED_CONTRACT_VERSION
 *   malformed            the answer is not a manifest
 *   missing-functions    named functions are absent -- deploy Convex first
 *   unreachable          the backend did not answer (retried 3x: 1s, 2s, 4s)
 *
 * What this does NOT see: a function that exists but whose ARGUMENTS changed.
 * A new argument passed to an existing function requires bumping
 * BACKEND_CONTRACT_VERSION (convex/lib/backendManifest.ts) and
 * REQUIRED_CONTRACT_VERSION here in the same delivery. And it runs at boot
 * only: a Convex deploy that REMOVES a function under a running MCP is not
 * detected until the next boot.
 *
 * MCP_CALLED_FUNCTIONS is pinned to the source by
 * mcp-server/test/backend-compat-boot.test.ts: a call site added (or removed)
 * without updating this list fails that test. A call site whose name is built
 * at runtime instead of written as a `"module:function"` literal is invisible
 * to it -- write the literal.
 */

/** Contract version this MCP build requires from the backend. */
export const REQUIRED_CONTRACT_VERSION = 7;

/** Every public Convex function this MCP build calls (`module:function`). */
export const MCP_CALLED_FUNCTIONS: readonly string[] = [
	"agentCredentials:resolveAgentCredential",
	"briefingNotes:create",
	"briefingNotes:get",
	"briefingNotes:list",
	"briefingNotes:searchBriefingNotesByKeyword",
	"briefingNotes:update",
	"businessUnits:create",
	"businessUnits:get",
	"businessUnits:list",
	"businessUnits:remove",
	"businessUnits:update",
	"clientOrgMapping:getByClerkSlug",
	"debate:getRoom",
	"debate:postTurn",
	"diary:get",
	"diary:list",
	"diary:write",
	"episodes:storeEpisode",
	"errorMonitor:addDeployment",
	"errorMonitor:getError",
	"errorMonitor:listErrors",
	"errorMonitor:removeDeployment",
	"fixPatterns:addAttempt",
	"fixPatterns:create",
	"fixPatterns:get",
	"fixPatterns:linkIssue",
	"fixPatterns:listAll",
	"fixPatterns:listByProject",
	"fixPatterns:validate",
	"githubOwnerBinding:listBindings",
	"githubOwnerBinding:listUnprovenMappings",
	"githubRepoMapping:add",
	"githubRepoMapping:getByRepo",
	"githubRepoMapping:list",
	"githubRepoMapping:remove",
	"improvisationDigest:scanWindow",
	"issues:getByRepoNumber",
	"issues:getStats",
	"issues:linkCommit",
	"issues:listByOrchestrator",
	"issues:listByProject",
	"issues:listByStatus",
	"issues:updateStatus",
	"issues:verify",
	"kb:softDeleteDocument",
	"kb:storeDocumentChunked",
	"kbMutations:claimUpload",
	"kbMutations:generateUploadUrl",
	"kbMutations:generateUploadUrlWithTicket",
	"mandates:accept",
	"mandates:create",
	"mandates:get",
	"mandates:list",
	"mandates:settle",
	"mandates:update",
	"mandates:validateSpending",
	"memberWriterRoles:assertPersonMayWrite",
	"memories:getMemory",
	"memories:listMemories",
	"memories:softDeleteMemory",
	"memories:storeMemory",
	"messages:checkNewMessages",
	"messages:checkNewMessagesEnvelope",
	"messages:deleteMessage",
	"messages:getById",
	"messages:getUnreadCount",
	"messages:listBroadcastStatus",
	"messages:listMessages",
	"messages:markAsRead",
	"messages:searchMessagesByKeyword",
	"messages:sendMessage",
	"missionTemplates:getByName",
	"missionTemplates:instantiateTemplateIntoMission",
	"missionTemplates:softDelete",
	"missionTemplates:upsert",
	"missions:create",
	"missions:get",
	"missions:list",
	"missions:update",
	"missions:updateStatus",
	"oauth:consumePersonCode",
	"oauth:createAccessToken",
	"oauth:createClient",
	"oauth:deleteClient",
	"oauth:getAccessTokenByHash",
	"oauth:getClientByClientId",
	"oauth:getRefreshTokenForGrant",
	"oauth:getScopeProfile",
	"oauth:listClients",
	"oauth:patchClientScopeAndRefreshTokens",
	"oauth:patchScopeProfileEmergency",
	"oauth:provisionOrganization",
	"oauth:putPersonCode",
	"oauth:registerPublicClient",
	"oauth:revokeAccessTokensForCode",
	"oauth:revokeAccessTokensOnly",
	"oauth:rotateRefreshToken",
	"oauth:seedDefaultProfiles",
	"okfBundleNode:exportOkfBundle",
	"okfBundleNode:importOkfBundle",
	"okfBundleNode:validateOkfBundle",
	"orgRoster:getAgentDirectoryForAccessToken",
	"orgRoster:getForAccessToken",
	"orgRoster:getMyAgentDirectory",
	"orgRoster:getMyOrgRoster",
	"profiles:getProfile",
	"profiles:listProfiles",
	"profiles:updateDynamic",
	"profiles:upsertProfile",
	"recurringTasks:create",
	"recurringTasks:getById",
	"recurringTasks:list",
	"recurringTasks:pause",
	"recurringTasks:remove",
	"recurringTasks:resume",
	"recurringTasks:update",
	"search:hybridSearch",
	"search:recall",
	"search:searchFixPatterns",
	"search:textSearch",
	"tasks:billingSummaryByProject",
	"tasks:blockTask",
	"tasks:bulkComplete",
	"tasks:checkout",
	"tasks:complete",
	"tasks:correctSegment",
	"tasks:create",
	"tasks:deleteTask",
	"tasks:failTask",
	"tasks:get",
	"tasks:getBulkCompleteRun",
	"tasks:getById",
	"tasks:list",
	"tasks:listBlockedOnMe",
	"tasks:listByMission",
	"tasks:pause",
	"tasks:resume",
	"tasks:searchTasksByKeyword",
	"tasks:start",
	"tasks:update",
];

export type BackendCompatFailure =
	| "no-manifest"
	| "refused"
	| "cannot-authenticate"
	| "version-too-old"
	| "malformed"
	| "missing-functions"
	| "unreachable";

export type BackendCompat =
	| { ok: true; checked: number; contractVersion: number }
	| {
			ok: false;
			reason: BackendCompatFailure;
			message: string;
			missing?: string[];
	  };

/** The one client method the check needs; ConvexHttpClient satisfies it. */
export interface ManifestClient {
	// biome-ignore lint/suspicious/noExplicitAny: Convex string API
	query(name: any, args: any): Promise<unknown>;
}

export interface BootCheckOptions {
	sleep?: (ms: number) => Promise<void>;
	log?: (message: string) => void;
	exit?: (code: number) => never;
	label?: string;
}

const MANIFEST_DOOR = "meta:backendContract";
const RETRY_DELAYS_MS = [1000, 2000, 4000];

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(err: unknown): string {
	if (err && typeof err === "object") {
		const data = (err as { data?: unknown }).data;
		const message = (err as { message?: unknown }).message;
		return [typeof data === "string" ? data : "", String(message ?? "")]
			.filter(Boolean)
			.join(" | ");
	}
	return String(err);
}

function classify(err: unknown): BackendCompatFailure | "transient" {
	const text = errorText(err);
	if (/Could not find public function/i.test(text)) return "no-manifest";
	if (/RBAC_DENIED/.test(text)) return "refused";
	if (/service-account (identity|token)/i.test(text))
		return "cannot-authenticate";
	return "transient";
}

function parseManifest(
	value: unknown,
): { contractVersion: number; functions: Set<string> } | null {
	if (!value || typeof value !== "object") return null;
	const v = value as { contractVersion?: unknown; functions?: unknown };
	if (typeof v.contractVersion !== "number") return null;
	if (!Array.isArray(v.functions)) return null;
	if (!v.functions.every((f) => typeof f === "string")) return null;
	return {
		contractVersion: v.contractVersion,
		functions: new Set(v.functions as string[]),
	};
}

/**
 * Asks the backend for its manifest and judges it. Never throws: every
 * outcome is a value, so a caller cannot mistake a failure for a pass.
 */
export async function checkBackendCompat(
	client: ManifestClient,
	opts: Pick<BootCheckOptions, "sleep"> = {},
): Promise<BackendCompat> {
	const sleep = opts.sleep ?? defaultSleep;
	let raw: unknown;
	for (let attempt = 0; ; attempt++) {
		try {
			// No argument: nothing secret can travel with the question.
			raw = await client.query(MANIFEST_DOOR, {});
			break;
		} catch (err) {
			const kind = classify(err);
			if (kind === "no-manifest") {
				return {
					ok: false,
					reason: "no-manifest",
					message:
						`backend has no contract manifest: "${MANIFEST_DOOR}" is not deployed there. ` +
						"The backend predates this MCP build -- deploy Convex first.",
				};
			}
			if (kind === "refused") {
				return {
					ok: false,
					reason: "refused",
					message: `backend REFUSED the manifest request (${errorText(err)}). The MCP's identity is not the fleet service account; this is a credential problem, not a missing manifest.`,
				};
			}
			if (kind === "cannot-authenticate") {
				return {
					ok: false,
					reason: "cannot-authenticate",
					message: `the MCP could not present its service-account identity (${errorText(err)}).`,
				};
			}
			if (attempt >= RETRY_DELAYS_MS.length) {
				return {
					ok: false,
					reason: "unreachable",
					message: `backend did not answer the manifest request after ${RETRY_DELAYS_MS.length + 1} attempts (${errorText(err)}).`,
				};
			}
			await sleep(RETRY_DELAYS_MS[attempt]);
		}
	}

	const manifest = parseManifest(raw);
	if (!manifest) {
		return {
			ok: false,
			reason: "malformed",
			message: `"${MANIFEST_DOOR}" answered something that is not a manifest (need { contractVersion: number, functions: string[] }).`,
		};
	}
	if (manifest.contractVersion < REQUIRED_CONTRACT_VERSION) {
		return {
			ok: false,
			reason: "version-too-old",
			message: `backend contract version ${manifest.contractVersion} < required ${REQUIRED_CONTRACT_VERSION} -- deploy Convex first.`,
		};
	}
	const missing = MCP_CALLED_FUNCTIONS.filter(
		(f) => !manifest.functions.has(f),
	);
	if (missing.length > 0) {
		return {
			ok: false,
			reason: "missing-functions",
			missing,
			message: `backend is missing ${missing.length} function(s) this MCP calls: ${missing.join(", ")}. Deploy Convex first.`,
		};
	}
	return {
		ok: true,
		checked: MCP_CALLED_FUNCTIONS.length,
		contractVersion: manifest.contractVersion,
	};
}

/**
 * Runs the check at boot. Compatible: logs one line and returns. Anything
 * else: logs a loud error that names the cause and exits 1 -- before the
 * caller binds a port or starts a transport.
 */
export async function bootCheckOrExit(
	client: ManifestClient,
	opts: BootCheckOptions = {},
): Promise<void> {
	const log = opts.log ?? ((m: string) => console.error(m));
	const exit = opts.exit ?? ((code: number) => process.exit(code));
	const label = opts.label ?? "mcp";
	const result = await checkBackendCompat(client, { sleep: opts.sleep });
	if (result.ok) {
		log(
			`[vantage-peers-mcp:${label}] backend compatible: ${result.checked} called functions present, contract v${result.contractVersion}`,
		);
		return;
	}
	log(
		`[vantage-peers-mcp:${label}] BACKEND INCOMPATIBLE (${result.reason}) -- BOOT CHECK refused to serve: ${result.message}`,
	);
	exit(1);
}
