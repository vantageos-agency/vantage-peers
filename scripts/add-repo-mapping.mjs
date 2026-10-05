#!/usr/bin/env bun
/**
 * add-repo-mapping.mjs — route a GitHub repo's webhook events to an orchestrator
 * (githubRepoMapping:add, upsert by repo), then read the row back.
 *
 *   bun run scripts/add-repo-mapping.mjs <owner/repo> <orchestrator> <project>
 *
 * The mutation requires master or service-account scope; an org-admin JWT is refused
 * (RBAC_DENIED). The MCP tools add_repo_mapping / list_repo_mappings are disabled on the
 * production server, so this goes to Convex directly as the service account.
 * Env (from the gitignored .env.local): CLERK_SECRET_KEY, CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS,
 * CONVEX_URL. Prints no secret.
 */
import { ConvexHttpClient } from "convex/browser";
import { getScopedUserToken } from "../mcp-server/src/serviceAccountAuth.ts";
import { api } from "../convex/_generated/api.js";

const [repo, orchestrator, project] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !orchestrator || !project) {
	console.error("usage: add-repo-mapping.mjs <owner/repo> <orchestrator> <project>");
	process.exit(2);
}
for (const name of ["CONVEX_URL", "CLERK_SECRET_KEY", "CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS"]) {
	if (!process.env[name]) {
		console.error(`Missing required env var: ${name}`);
		process.exit(2);
	}
}

const client = new ConvexHttpClient(process.env.CONVEX_URL);
const token = await getScopedUserToken(process.env.CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS);
if (!token) {
	console.error("getScopedUserToken returned null: the Clerk sign-in-ticket exchange failed.");
	process.exit(1);
}
client.setAuth(token);
await client.mutation(api.githubRepoMapping.add, { repo, orchestrator, project });
const row = await client.query(api.githubRepoMapping.getByRepo, { repo });
if (!row || row.orchestrator !== orchestrator || row.project !== project || row.active !== true) {
	console.error(`repo mapping read-back FAILED for ${repo}`);
	process.exit(1);
}
console.log(`repo mapping: ${repo} -> ${orchestrator} (project ${project}) row=${row._id}`);
