#!/usr/bin/env bun
/**
 * prove-station-agent-credential.mjs — both-poles proof of the agent credential
 * lock for ONE station (task k17awnbe5njbfwxed3z4e1md358fhra0). Generalisation of
 * prove-grok-agent-credential.mjs.
 *
 * Surface: messages:sendMessage, gated by requireAgentCredentialMatch
 * (convex/lib/auth.ts). Same command, ONE variable changed per pole: the
 * presence of agentCredentialSecret. Every call is made as the org-admin
 * session JWT, asserting from="<station>"; the identity each call ran under is
 * printed (JWT sub, orgSlug, asserted from, credential presented yes/no).
 *
 * PHASES
 *   red    (BEFORE registration) without credential -> must be ACCEPTED. Proves
 *          the lock is not yet engaged for this name (legacy no-op path), i.e.
 *          the proof can tell the two states apart.
 *   green  (AFTER mint) with credential -> ACCEPTED, then without -> REFUSED
 *          with AGENT_CREDENTIAL_REQUIRED.
 *   auto   (default) red if the agents row does not exist, green if it does.
 *
 * A call that fails for another reason (e.g. RBAC_DENIED sender-not-on-roster,
 * bad deployment) is reported with its own code and FAILS the proof: "some call
 * threw" is never read as the lock refusing.
 *
 * --dry-run does every read (JWT, agents:getAgent, credential status), prints
 * which phase would run and the secret file it would read, and sends nothing.
 * The plaintext secret is read from <secrets-dir>/<station>.secret and never printed.
 *
 * USAGE
 *   CONVEX_URL, CLERK_SECRET_KEY and CLERK_ORG_ADMIN_USER_ID in the environment, then:
 *   bun run scripts/prove-station-agent-credential.mjs --station eta \
 *       --secrets-dir /secure/path [--phase auto|red|green] [--dry-run]
 */

import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { getScopedUserToken } from "../mcp-server/src/serviceAccountAuth.ts";
import {
	agentRowByLabel,
	decodeJwtClaims,
	envVarNameFor,
	errorCode,
	normalizeRole,
	orgSlugFromClaims,
	parseArgs,
	secretPathFor,
} from "./lib/station-agents.mjs";

const TAG = "[prove-station]";

function requireEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required env var: ${name}. Cannot proceed.`);
	return value;
}

async function attempt(fn) {
	try {
		return { id: await fn(), code: null };
	} catch (err) {
		if (process.env.PROVE_DEBUG) console.error(TAG, "error data:", String(typeof err?.data === "string" ? err.data : JSON.stringify(err?.data ?? err?.message)).slice(0, 300));
		return { id: null, code: errorCode(err) };
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.station) throw new Error("Missing required parameter: --station <agentName>. Cannot proceed.");
	if (!args.secretsDir) throw new Error("Missing required parameter: --secrets-dir <path>. Cannot proceed.");
	const station = normalizeRole(args.station);
	const convexUrl = requireEnv("CONVEX_URL");
	requireEnv("CLERK_SECRET_KEY");
	const orgAdminUserId = requireEnv("CLERK_ORG_ADMIN_USER_ID");

	const jwt = await getScopedUserToken(orgAdminUserId);
	if (!jwt) throw new Error("getScopedUserToken returned null: CLERK_SECRET_KEY missing or the Clerk exchange failed.");
	const claims = decodeJwtClaims(jwt);
	const orgSlug = orgSlugFromClaims(claims);
	const client = new ConvexHttpClient(convexUrl);
	client.setAuth(jwt);
	const { api } = await import("../convex/_generated/api.js");

	const agent = agentRowByLabel(await client.query(api.agents.listAgentsByOrg, { orgSlug }), station);
	const status = agent
		? await client.query(api.agentCredentials.getAgentCredentialStatus, { orgSlug, agentId: agent._id })
		: { hasActiveCredential: false, activeRows: 0 };
	const phase = args.phase === "auto" ? (agent ? "green" : "red") : args.phase;

	const identity = `JWT sub=${claims.sub} org="${orgSlug}" asserts from="${station}"`;
	console.log(`${TAG} deployment=${new URL(convexUrl).hostname} station="${station}" agentRow=${agent ? agent._id : "none"} activeCredentialRows=${status.activeRows} phase=${phase}`);

	if (phase === "green" && !agent) {
		throw new Error(`Phase green requires an agents row for "${station}" (none). Run mint-station-agents first. Aborting.`);
	}
	if (phase === "red" && agent) {
		throw new Error(`Phase red is only meaningful BEFORE registration, but an agents row exists for "${station}". Aborting.`);
	}

	let secret = null;
	if (phase === "green") {
		const path = secretPathFor(args.secretsDir, station);
		try {
			secret = readFileSync(path, "utf-8").trim();
		} catch {
			throw new Error(`File ${path} not found. Run scripts/mint-station-agents.mjs first (var ${envVarNameFor(station)}). Aborting.`);
		}
		if (!secret) throw new Error(`${path} is empty. Aborting.`);
	}

	const base = {
		from: station,
		channel: process.env.PROVE_CHANNEL || "pi", // a roster recipient other than the sender (a self-addressed send yields zero recipients and bounces)
		content: `[credential proof ${phase}] task k17awnbe5njbfwxed3z4e1md358fhra0 station=${station}`,
	};

	if (args.dryRun) {
		console.log(`${TAG} DRY-RUN. Would run phase ${phase} as: ${identity}`);
		if (phase === "red") console.log(`${TAG}   1 call WITHOUT credential, expected ACCEPTED (lock not yet engaged).`);
		else console.log(`${TAG}   2 calls: WITH credential (expected ACCEPTED), WITHOUT (expected REFUSED AGENT_CREDENTIAL_REQUIRED).`);
		console.log(`${TAG} Nothing sent.`);
		return;
	}

	let pass;
	if (phase === "red") {
		const r = await attempt(() => client.mutation(api.messages.sendMessage, base));
		console.log(`${TAG} RED   ${identity}, credential presented: no -> ${r.id ? `ACCEPTED messages._id=${r.id}` : `REFUSED ${r.code}`}`);
		pass = Boolean(r.id);
		console.log(pass ? `${TAG} RED POLE: PASS (accepted without credential before registration).` : `${TAG} RED POLE: FAIL (expected ACCEPTED; code ${r.code}).`);
	} else {
		const pos = await attempt(() => client.mutation(api.messages.sendMessage, { ...base, agentCredentialSecret: secret }));
		console.log(`${TAG} GREEN ${identity}, credential presented: yes -> ${pos.id ? `ACCEPTED messages._id=${pos.id}` : `REFUSED ${pos.code}`}`);
		const neg = await attempt(() => client.mutation(api.messages.sendMessage, base));
		console.log(`${TAG} GREEN ${identity}, credential presented: no -> ${neg.id ? `ACCEPTED messages._id=${neg.id} (UNEXPECTED)` : `REFUSED ${neg.code}`}`);
		pass = Boolean(pos.id) && !neg.id && neg.code === "AGENT_CREDENTIAL_REQUIRED";
		console.log(
			pass
				? `${TAG} BOTH-WAYS PROOF: PASS (accepted with the secret, refused AGENT_CREDENTIAL_REQUIRED without it).`
				: `${TAG} BOTH-WAYS PROOF: FAIL (positiveAccepted=${Boolean(pos.id)} negativeCode=${neg.code ?? "ACCEPTED"}).`,
		);
	}
	process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
	console.error(`${TAG} FAILED: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
});
