#!/usr/bin/env bun
/**
 * mint-station-agents.mjs — credential every fleet station as a VantagePeers
 * agent (task k17awnbe5njbfwxed3z4e1md358fhra0). Generalisation of
 * mint-grok-agents.mjs (Model B, task k17dpqs9d1sd8z4a395gz6s3v98d2amm).
 *
 * MECHANISM (identical, nothing new in convex/): org-admin Clerk-native JWT via
 * getScopedUserToken, then orgSlug DERIVED from that JWT's claim (never typed),
 * then agents:registerAgent and agentCredentials:mintAgentCredential through
 * ConvexHttpClient. Convex re-derives and verifies the same claim server-side
 * in requireOrgAdmin; the local decode only chooses the orgSlug argument.
 *
 * INPUT: a JSON file, array of { "role": "eta", "instanceId": "eta-vps" }
 *   (instanceId optional, default "{role}-vps"; optional "agentName", default
 *   role). The agent name IS the name the station asserts as `from` /
 *   `createdBy` / `callerOrchestrator` (see requireAgentCredentialMatch).
 *
 * IDEMPOTENT. Per station, reads first (agents:getAgent,
 * agentCredentials:getAgentCredentialStatus), then decideStation():
 *   no row: register + mint.
 *   row without a credential: mint only.
 *   row WITH an active credential: SKIP (a mint rotates and locks out the live
 *     holder; pass --rotate to do that on purpose).
 *   inactive row: BLOCKED (never revived by this tool).
 * registerAgent is never called on an existing row (it patches description away).
 *
 * SECRETS: plaintext is written ONLY to <secrets-dir>/<agentName>.secret
 * (mode 0600, dir 0700), a path the operator names and that must be OUTSIDE the
 * repository. stdout carries only the agents row id, the file path and the env
 * var NAME. --dry-run performs every read, prints the plan, writes nothing.
 *
 * USAGE
 *   CONVEX_URL, CLERK_SECRET_KEY and CLERK_ORG_ADMIN_USER_ID in the environment, then:
 *   bun run scripts/mint-station-agents.mjs --stations stations.json \
 *       --secrets-dir /secure/path [--dry-run] [--rotate]
 * (--secrets-dir is not needed with --dry-run.)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { getScopedUserToken } from "../mcp-server/src/serviceAccountAuth.ts";
import {
	assertSecretPathOutsideRepo,
	decideStation,
	decodeJwtClaims,
	envVarNameFor,
	orgSlugFromClaims,
	parseArgs,
	secretFileExists,
	validateStations,
	writeSecretFile,
} from "./lib/station-agents.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = "[mint-stations]";

function requireEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required env var: ${name}. Cannot proceed.`);
	return value;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.stations) throw new Error("Missing required parameter: --stations <file.json>. Cannot proceed.");
	if (!args.dryRun && !args.secretsDir) {
		throw new Error("Missing required parameter: --secrets-dir <path> (not needed with --dry-run). Cannot proceed.");
	}

	let raw;
	try {
		raw = readFileSync(args.stations, "utf-8");
	} catch (err) {
		if (err?.code === "ENOENT") throw new Error(`File ${args.stations} not found. Aborting.`);
		throw err;
	}
	const stations = validateStations(JSON.parse(raw));
	const secretsDir = args.secretsDir ? assertSecretPathOutsideRepo(args.secretsDir, repoRoot) : null;

	const convexUrl = requireEnv("CONVEX_URL");
	requireEnv("CLERK_SECRET_KEY"); // read internally by getScopedUserToken
	const orgAdminUserId = requireEnv("CLERK_ORG_ADMIN_USER_ID");

	console.log(
		`${TAG} mode=${args.dryRun ? "DRY-RUN (reads only, no write)" : "WRITE"} stations=${stations.length} deployment=${new URL(convexUrl).hostname}`,
	);
	const jwt = await getScopedUserToken(orgAdminUserId);
	if (!jwt) {
		throw new Error("getScopedUserToken returned null: CLERK_SECRET_KEY missing or the Clerk sign-in-ticket exchange failed.");
	}
	const claims = decodeJwtClaims(jwt);
	const orgSlug = orgSlugFromClaims(claims);
	console.log(
		`${TAG} identity: sub=${claims.sub} orgSlug="${orgSlug}" (derived from the JWT claim, not typed) role=${claims.org_role ?? claims.organizationRole ?? "?"}`,
	);

	const client = new ConvexHttpClient(convexUrl);
	client.setAuth(jwt);
	const { api } = await import("../convex/_generated/api.js");

	const plan = [];
	for (const st of stations) {
		const agent = await client.query(api.agents.getAgent, { orgSlug, name: st.agentName });
		const status = agent
			? await client.query(api.agentCredentials.getAgentCredentialStatus, { orgSlug, agentName: st.agentName })
			: { hasActiveCredential: false, activeRows: 0 };
		plan.push({ st, agent, status, decision: decideStation({ agent, status, rotate: args.rotate }) });
	}

	console.log(`\n${TAG} PLAN`);
	for (const { st, agent, status, decision } of plan) {
		const action = decision.blocked ? "BLOCKED" : decision.mint ? (decision.register ? "REGISTER+MINT" : "MINT") : "SKIP";
		console.log(
			`${TAG}   ${action.padEnd(13)} agent="${st.agentName}" instanceId="${st.instanceId}" row=${agent ? agent._id : "none"} activeCredentialRows=${status.activeRows} var=${envVarNameFor(st.agentName)} - ${decision.reason}`,
		);
	}
	const counts = { register: 0, mint: 0, skip: 0, blocked: 0 };
	for (const p of plan) {
		if (p.decision.register) counts.register++;
		if (p.decision.blocked) counts.blocked++;
		else if (p.decision.mint) counts.mint++;
		else counts.skip++;
	}
	console.log(`${TAG} totals: ${JSON.stringify(counts)}`);

	if (args.dryRun) {
		console.log(`${TAG} DRY-RUN complete. Nothing written, no secret minted.`);
		return;
	}
	if (counts.blocked > 0) {
		throw new Error("At least one station is BLOCKED (inactive agent). Resolve it explicitly, then re-run. Nothing was written.");
	}
	for (const { st, decision } of plan) {
		if (decision.mint && secretFileExists(secretsDir, st.agentName)) {
			throw new Error(
				`Secret file for "${st.agentName}" already exists in ${secretsDir}. Move it aside deliberately, then re-run. Nothing was written.`,
			);
		}
	}

	for (const { st, agent, decision } of plan) {
		if (!decision.mint) continue;
		let agentId = agent?._id;
		if (decision.register) {
			agentId = await client.mutation(api.agents.registerAgent, {
				orgSlug,
				name: st.agentName,
				description: `Fleet station ${st.agentName} (${st.instanceId}), task k17awnbe5njbfwxed3z4e1md358fhra0`,
			});
		}
		const { secret, mintedAt } = await client.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug,
			agentName: st.agentName,
		});
		const path = writeSecretFile(secretsDir, st.agentName, secret);
		console.log(
			`${TAG} ${st.agentName}: agents._id=${agentId} minted ${new Date(mintedAt).toISOString()} -> ${path} (0600) var=${envVarNameFor(st.agentName)}`,
		);
	}
	console.log(`${TAG} DONE. No secret value was printed.`);
}

main().catch((err) => {
	console.error(`${TAG} FAILED: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
});
