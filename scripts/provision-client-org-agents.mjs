#!/usr/bin/env bun
/**
 * provision-client-org-agents.mjs — give each agent of a CLIENT organisation its own
 * VantagePeers access: an OAuth seat bearer (bound to the org) and an agent credential
 * (registered by ID in the org's agents registry). First use: CGT Alsachimie,
 * task k17bnmfdan9xgxgyy3ny61ebps8fr0gw. Runbook: runbooks/onboard-client-org.md.
 *
 *   bun run scripts/provision-client-org-agents.mjs --org <slug> --clerk-org-id <org_…> \
 *       --agents neo,hal,mimir --stage-dir <0700 dir outside the repo> [--ttl-days 90]
 *
 * PRECONDITIONS (done by the operator commands in the runbook, read back here):
 *   - client_org_mapping row for <slug>, isActive. An agent not yet on its roster is registered here by
 *     ID and the script exits 3 printing the operator's addRosterMembers + setAgentOwner commands.
 *   - oauth_scope_profiles "<agent>-<slug>" bound to <slug> (clerkOrgSlug)
 *   - the Clerk org exists with our org-admin user as org:admin
 *
 * PER AGENT (idempotent on the registry side; a seat bearer is re-minted each run):
 *   1. oauth_clients row (service account, oauth:createClient), secret hash only
 *   2. refresh + access token (service account), access TTL = --ttl-days
 *   3. agents row + agent credential (org-admin JWT minted for THIS org, its org_id claim
 *      verified equal to --clerk-org-id before any write; mismatch exits 1, nothing registered)
 *   4. prints the agents:setAgentOwner command (internal mutation: operator step, deploy key)
 *   writes <stage-dir>/<agent>.bearer and <agent>.secret (0600); prints no secret.
 *
 * Env (gitignored .env.local): CONVEX_URL, CLERK_DOMAIN (the Clerk frontend domain of THIS environment, required for the agent registry, no default), CLERK_ORG_ADMIN_JWT_TEMPLATE (default convex), CLERK_SECRET_KEY,
 * CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS, CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { getScopedUserToken } from "../mcp-server/src/serviceAccountAuth.ts";
import { api } from "../convex/_generated/api.js";
import { mintOrgAdminToken, ownerStepCommand } from "./lib/org-admin-token.mjs";
import { planRoster, rosterStepCommand } from "./lib/roster-plan.mjs";
import { agentRowByLabel } from "./lib/station-agents.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : d;
};
const org = arg("org");
const clerkOrgId = arg("clerk-org-id");
const agents = (arg("agents", "") || "").split(",").filter(Boolean);
const stage = arg("stage-dir");
const ttlDays = Number(arg("ttl-days", "90"));
// --seat-only: a non-agent seat (e.g. a client portal relay). Bearer only, no agents row,
// no agent credential, and it need not be on the org roster.
const seatOnly = argv.includes("--seat-only");
if (!org || !clerkOrgId || agents.length === 0 || !stage) {
	console.error("usage: --org <slug> --clerk-org-id <org_…> --agents a,b --stage-dir <dir> [--ttl-days 90]");
	process.exit(2);
}
if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) throw new Error("--ttl-days must be 1..365");
for (const n of ["CONVEX_URL", "CLERK_SECRET_KEY", "CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS", "CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS"]) {
	if (!process.env[n]) throw new Error(`Missing env var: ${n}`);
}
// Secrets must never land in a git tree. Resolve the stage dir to its real path (through
// relative segments, `..` and symlinks, via its nearest existing ancestor) and refuse it if it
// sits inside this script's repository or inside any repository containing the cwd.
const realOfNearest = (p) => {
	let cur = resolve(p);
	const rest = [];
	while (!existsSync(cur)) {
		rest.unshift(basename(cur));
		cur = dirname(cur);
	}
	return join(realpathSync(cur), ...rest);
};
const toplevel = (dir) => {
	try {
		return realpathSync(execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim());
	} catch {
		return null;
	}
};
const stageReal = realOfNearest(stage);
let stageAnchor = stageReal;
while (!existsSync(stageAnchor)) stageAnchor = dirname(stageAnchor);
// Refuse ANY git work tree, not only this one: a secret committed to another repo leaks the same way.
const stageTree = toplevel(stageAnchor);
if (stageTree) throw new Error(`--stage-dir must be outside any git work tree (${stageReal} is inside ${stageTree})`);
for (const root of new Set([toplevel(dirname(fileURLToPath(import.meta.url))), toplevel(process.cwd())])) {
	if (root && (stageReal === root || stageReal.startsWith(root + sep))) {
		throw new Error(`--stage-dir must be outside the repository (${stageReal} is inside ${root})`);
	}
}
mkdirSync(stage, { recursive: true, mode: 0o700 });
chmodSync(stage, 0o700);

const hex = (n) => randomBytes(n).toString("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const writeSecret = (name, value) => {
	const p = join(stage, name);
	writeFileSync(p, `${value}\n`, { mode: 0o600 });
	chmodSync(p, 0o600);
	return p;
};

const svc = new ConvexHttpClient(process.env.CONVEX_URL);
svc.setAuth(await getScopedUserToken(process.env.CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS));
const admin = new ConvexHttpClient(process.env.CONVEX_URL);
const adminUserId = process.env.CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS;
// The agent registry takes its org from the token's org_id. The token is minted FOR the requested
// org and its org_id claim is checked here, before any write of any kind (seat or registry).
// A mismatch exits non-zero naming both ids with nothing registered.
if (!seatOnly) {
	try {
		const tok = await mintOrgAdminToken({
			userId: adminUserId,
			orgId: clerkOrgId,
			secretKey: process.env.CLERK_SECRET_KEY,
			domain: process.env.CLERK_DOMAIN,
			template: process.env.CLERK_ORG_ADMIN_JWT_TEMPLATE || "convex",
		});
		admin.setAuth(tok.jwt);
		console.log(`org-admin token verified: org_id = ${clerkOrgId}`);
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}

const mapping = await svc.query(api.clientOrgMapping.getByClerkSlug, { orgSlug: org });
if (!mapping || mapping.isActive !== true) throw new Error(`ORG_NOT_READY: no active client_org_mapping for ${org}`);
const { missing, toRegister } = planRoster({
	mapping,
	agents,
	rows: seatOnly ? [] : await admin.query(api.agents.listAgentsByOrg, {}),
	seatOnly,
});
if (missing.length) {
	// A new agent on an existing org. The roster is written by agent ID, and an ID exists only after
	// registerAgent, so register first (org-admin, in THIS org), then hand the operator the two
	// internal steps. Nothing is minted for any agent in this run: re-run once the roster step is done.
	const ids = [];
	for (const agent of missing) {
		let row = agentRowByLabel(await admin.query(api.agents.listAgentsByOrg, {}), agent);
		if (!row) {
			const agentId = await admin.mutation(api.agents.registerAgent, { name: agent, description: `Agent ${agent} of ${org}` });
			row = await admin.query(api.agents.getAgent, { agentId });
		}
		ids.push(row._id);
	}
	console.log(`registered: ${toRegister.join(",") || "(none, already registered)"}`);
	console.log(`ROSTER_STEP_REQUIRED: ${missing.join(",")} not on ${org}'s roster. Operator, in order, then re-run this script:`);
	console.log(`  ${rosterStepCommand({ agentIds: ids, org })}`);
	console.log(`  ${ownerStepCommand({ agentIds: ids, ownerPersonId: adminUserId, org })}`);
	process.exit(3);
}

const now = Date.now();
const registeredIds = [];
for (const agent of agents) {
	const profileId = `${agent}-${org}`;
	const ns = [`orchestrator/${agent}`, `project/${org}`];

	// 1. seat client
	const clientId = hex(16);
	await svc.mutation(api.oauth.createClient, {
		clientId,
		clientSecretHash: sha(hex(32)),
		name: profileId,
		redirectUris: ["https://localhost/dev-null"],
		scopeProfile: profileId,
		tokenEndpointAuthMethod: "client_secret_basic",
	});
	// 2. tokens
	const refresh = hex(32);
	await svc.mutation(api.oauth.createRefreshToken, {
		tokenHash: sha(refresh),
		clientId,
		userId: agent,
		scopeProfile: profileId,
		expiresAt: now + 30 * 24 * 3600 * 1000,
	});
	const access = hex(32);
	const expiresAt = now + ttlDays * 24 * 3600 * 1000;
	await svc.mutation(api.oauth.createAccessToken, {
		tokenHash: sha(access),
		clientId,
		userId: agent,
		scopes: ["mcp:full"],
		scopeProfile: profileId,
		fromAllowList: [agent],
		namespaceReadPrefixes: ns,
		namespaceWritePrefixes: ns,
		expiresAt,
		refreshTokenHash: sha(refresh),
		clerkOrgSlug: org,
	});
	const bearerPath = writeSecret(`${agent}.bearer`, access);

	if (seatOnly) {
		console.log(`${agent}: seat-only client=${clientId} profile=${profileId} access expires ${new Date(expiresAt).toISOString()} -> ${bearerPath}`);
		continue;
	}
	// 3. agent registry, by ID, in THIS org
	let row = agentRowByLabel(await admin.query(api.agents.listAgentsByOrg, {}), agent);
	if (!row) {
		const agentId = await admin.mutation(api.agents.registerAgent, { name: agent, description: `Agent ${agent} of ${org}` });
		row = await admin.query(api.agents.getAgent, { agentId });
	}
	registeredIds.push(row._id);
	let secretPath = join(stage, `${agent}.secret`);
	if (!existsSync(secretPath)) {
		const { secret } = await admin.mutation(api.agentCredentials.mintAgentCredential, { agentId: row._id });
		secretPath = writeSecret(`${agent}.secret`, secret);
	}
	console.log(
		`${agent}: client=${clientId} profile=${profileId} access expires ${new Date(expiresAt).toISOString()} agent=${row?._id} -> ${bearerPath}, ${secretPath}`,
	);
}
if (registeredIds.length) {
	// agentCredentials resolve an agent only when agents.ownerPersonId is set, and neither
	// registerAgent nor mintAgentCredential sets it. agents:setAgentOwner is an internalMutation:
	// the org-admin JWT cannot call it, so this script cannot either. The operator runs it.
	console.log("OWNER_STEP_REQUIRED: set the owner of the registered agents, or every agent credential is refused (AGENT_CREDENTIAL_INVALID).");
	console.log(`  ${ownerStepCommand({ agentIds: registeredIds, ownerPersonId: adminUserId, org })}`);
}
console.log("DONE. No secret value was printed.");
