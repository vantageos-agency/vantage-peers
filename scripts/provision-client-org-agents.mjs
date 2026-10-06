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
 *   - client_org_mapping row for <slug>, isActive, allowedOrchestrators ⊇ agents
 *   - oauth_scope_profiles "<agent>-<slug>" bound to <slug> (clerkOrgSlug)
 *   - the Clerk org exists with our org-admin user as org:admin
 *
 * PER AGENT (idempotent on the registry side; a seat bearer is re-minted each run):
 *   1. oauth_clients row (service account, oauth:createClient), secret hash only
 *   2. refresh + access token (service account), access TTL = --ttl-days
 *   3. agents row + agent credential (org-admin JWT of THIS org, by ID)
 *   writes <stage-dir>/<agent>.bearer and <agent>.secret (0600); prints no secret.
 *
 * Env (gitignored .env.local): CONVEX_URL, CLERK_SECRET_KEY,
 * CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS, CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { getScopedUserToken } from "../mcp-server/src/serviceAccountAuth.ts";
import { api } from "../convex/_generated/api.js";

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
if (stage.startsWith(process.cwd())) throw new Error("--stage-dir must be outside the repository");
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
admin.setAuth(await getScopedUserToken(process.env.CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS, clerkOrgId));

const mapping = await svc.query(api.clientOrgMapping.getByClerkSlug, { orgSlug: org });
if (!mapping || mapping.isActive !== true) throw new Error(`ORG_NOT_READY: no active client_org_mapping for ${org}`);
const missing = seatOnly ? [] : agents.filter((a) => !(mapping.allowedOrchestrators ?? []).includes(a));
if (missing.length) throw new Error(`ROSTER_MISSING: ${missing.join(",")} not in ${org}'s allowedOrchestrators`);

const now = Date.now();
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
	let row = await admin.query(api.agents.getAgent, { orgSlug: org, name: agent });
	if (!row) {
		await admin.mutation(api.agents.registerAgent, { orgSlug: org, name: agent, description: `Agent ${agent} of ${org}` });
		row = await admin.query(api.agents.getAgent, { orgSlug: org, name: agent });
	}
	let secretPath = join(stage, `${agent}.secret`);
	if (!existsSync(secretPath)) {
		const { secret } = await admin.mutation(api.agentCredentials.mintAgentCredential, { orgSlug: org, agentName: agent });
		secretPath = writeSecret(`${agent}.secret`, secret);
	}
	console.log(
		`${agent}: client=${clientId} profile=${profileId} access expires ${new Date(expiresAt).toISOString()} agent=${row?._id} -> ${bearerPath}, ${secretPath}`,
	);
}
console.log("DONE. No secret value was printed.");
