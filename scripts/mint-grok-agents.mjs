#!/usr/bin/env bun
/**
 * mint-grok-agents.mjs — Model B (Pi's ruling, task k17dpqs9d1sd8z4a395gz6s3v98d2amm).
 *
 * Registers two ADDITIVE agent rows — "pi-grok" and "theta-grok" — and mints
 * a fresh per-agent credential for each, on the VantagePeers prod Convex
 * deployment. The Grok stations will assert `from="pi-grok"` /
 * `from="theta-grok"` — the instance IS the agent name (Pi's exact ruling).
 *
 * ADDITIVE, NOT a rotation of any existing row:
 *   - `registerAgent({orgSlug, name})` is idempotent on (orgSlug, name) — it
 *     creates a NEW row for a NEW name. It never touches "pi", "theta",
 *     "pi-chromebook", "theta-vps", or any other existing agent.
 *   - `mintAgentCredential({orgSlug, agentName})` rotates ONLY the rows for
 *     the EXACT (orgSlug, agentName) pair passed in. A brand-new agentName
 *     ("pi-grok", "theta-grok") has no prior rows to rotate — the first mint
 *     for a new name cannot invalidate anything that already exists. This is
 *     the entire point of Model B.
 *
 * MECHANISM (reused as-is — nothing new added to convex/):
 *   1. `getScopedUserToken(orgAdminUserId)` (mcp-server/src/serviceAccountAuth.ts)
 *      mints a Clerk-NATIVE session JWT (org_id/org_role/org_slug claims
 *      verbatim) for an EXISTING Clerk user who is an org:admin of the fleet
 *      org. This is Clerk's own documented headless sign-in-ticket mechanism
 *      — not a workaround.
 *   2. The org slug is DERIVED, never typed: this script decodes the minted
 *      JWT's own payload and reads its org-slug claim using the EXACT same
 *      precedence order `convex/lib/auth.ts`'s `withOrgScope` uses
 *      (organizationSlug → org_slug → organizationId → org_id). Convex's
 *      `requireOrgAdmin` will independently re-derive and verify the same
 *      claim server-side — this script's local decode is only used to know
 *      which `orgSlug` argument to pass to `registerAgent`/
 *      `mintAgentCredential`; it is never trusted as an authorization
 *      decision by itself.
 *   3. `new ConvexHttpClient(CONVEX_URL).setAuth(jwt)` then
 *      `client.mutation(api.agents.registerAgent, {...})` followed by
 *      `client.mutation(api.agentCredentials.mintAgentCredential, {...})`
 *      for "pi-grok", then the same pair for "theta-grok".
 *
 * SECRETS NEVER PRINTED. Each minted plaintext secret is written to a local,
 * gitignored file (`.secrets/agent-credentials/<name>.secret`, mode 0600) —
 * never to stdout, never to a log. The station's own env var NAME is printed
 * so the operator knows what to set, never the value.
 *
 * USAGE (Sigma runs this in the FOREGROUND against prod — see task brief;
 * this script performs the ACTUAL prod write, so only run it once the org-
 * admin identity + fleet org membership have been confirmed out of band):
 *
 *   CONVEX_URL=https://compassionate-goldfinch-737.convex.cloud \
 *   CLERK_SECRET_KEY=$CLERK_SECRET_KEY \
 *   CLERK_ORG_ADMIN_USER_ID=$CLERK_ORG_ADMIN_USER_ID \
 *   bun run scripts/mint-grok-agents.mjs
 *
 * Optional:
 *   CLERK_DOMAIN               (defaults to the Frontend API domain already
 *                               hardcoded as the fallback in
 *                               mcp-server/src/serviceAccountAuth.ts)
 *   AGENT_SECRETS_DIR           (defaults to <repo>/.secrets/agent-credentials)
 *
 * Every required runtime value is named here as an ENV VAR NAME, never a
 * value:
 *   - CONVEX_URL              prod deployment URL (compassionate-goldfinch-737)
 *   - CLERK_SECRET_KEY        Clerk Backend API secret key
 *   - CLERK_ORG_ADMIN_USER_ID Clerk user_id of an EXISTING org:admin of the
 *                             fleet org. UNKNOWN to this script/task — no
 *                             such user id exists anywhere in this repo's
 *                             tracked source (grep confirms zero prior
 *                             callers of getScopedUserToken outside its own
 *                             module and its unit test, which injects a
 *                             mocked identity rather than a real user id).
 *                             Sigma must resolve this value out of band
 *                             (Clerk dashboard → the fleet org's Members tab
 *                             → an existing org:admin user's `user_id`, or a
 *                             dedicated service-account user provisioned the
 *                             same way CLERK_SERVICE_ACCOUNT_USER_ID was) and
 *                             supply it ONLY as this env var at run time —
 *                             never typed into this file.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";

// Reused as-is (no new mint logic written here) — see mcp-server/src/serviceAccountAuth.ts.
import { getScopedUserToken } from "../mcp-server/src/serviceAccountAuth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const AGENT_NAMES = ["pi-grok", "theta-grok"];

/**
 * decodeOrgSlugFromJwt — reads the org-slug claim off an ALREADY-MINTED,
 * already-signed JWT (payload decode only, no signature verification here —
 * we minted this token ourselves in the previous step via an authenticated
 * call to Clerk's Backend API; Convex independently re-verifies the
 * signature and re-derives this same claim server-side in
 * `withOrgScope`/`requireOrgAdmin`, so this local decode is never itself an
 * authorization decision).
 *
 * SAME precedence order as convex/lib/auth.ts's `withOrgScope`: slug spellings
 * before id spellings, camelCase before snake_case for each pair.
 */
function decodeOrgSlugFromJwt(jwt) {
	const parts = jwt.split(".");
	if (parts.length < 2) {
		throw new Error("Minted JWT is malformed (expected 3 dot-separated parts)");
	}
	const payload = JSON.parse(
		Buffer.from(parts[1], "base64url").toString("utf-8"),
	);
	const orgSlug =
		payload.organizationSlug ??
		payload.org_slug ??
		payload.organizationId ??
		payload.org_id ??
		null;
	if (!orgSlug || typeof orgSlug !== "string") {
		throw new Error(
			"Minted JWT carries no org-slug claim (organizationSlug/org_slug/organizationId/org_id all absent) — " +
				"the org-admin user this token was minted for must belong to the fleet org in Clerk.",
		);
	}
	return orgSlug;
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required env var: ${name}. Cannot proceed.`);
	}
	return value;
}

function writeSecretFile(secretsDir, agentName, secret) {
	mkdirSync(secretsDir, { recursive: true });
	const path = join(secretsDir, `${agentName}.secret`);
	writeFileSync(path, `${secret}\n`, { encoding: "utf-8", mode: 0o600 });
	chmodSync(path, 0o600); // belt-and-suspenders on platforms that ignore mode on writeFileSync
	return path;
}

function envVarNameFor(agentName) {
	// PI_GROK_AGENT_SECRET / THETA_GROK_AGENT_SECRET
	return `${agentName.replace(/-/g, "_").toUpperCase()}_AGENT_SECRET`;
}

async function main() {
	const convexUrl = requireEnv("CONVEX_URL");
	requireEnv("CLERK_SECRET_KEY"); // read internally by getScopedUserToken
	const orgAdminUserId = requireEnv("CLERK_ORG_ADMIN_USER_ID");
	const secretsDir =
		process.env.AGENT_SECRETS_DIR ??
		join(repoRoot, ".secrets", "agent-credentials");

	console.log(
		`[mint-grok-agents] minting org-admin session JWT for CLERK_ORG_ADMIN_USER_ID (value not printed)...`,
	);
	const jwt = await getScopedUserToken(orgAdminUserId);
	if (!jwt) {
		throw new Error(
			"getScopedUserToken returned null — CLERK_SECRET_KEY not configured, or the Clerk sign-in-ticket exchange failed.",
		);
	}

	const orgSlug = decodeOrgSlugFromJwt(jwt);
	console.log(
		`[mint-grok-agents] derived orgSlug="${orgSlug}" from the minted JWT's own org claim (not typed).`,
	);

	const client = new ConvexHttpClient(convexUrl);
	client.setAuth(jwt);

	// api.agents / api.agentCredentials come from the generated Convex API —
	// imported dynamically so this script can run against whatever generated
	// bundle is present without a hard build-time dependency edge into
	// convex/_generated from scripts/.
	const { api } = await import("../convex/_generated/api.js");

	for (const agentName of AGENT_NAMES) {
		console.log(
			`\n[mint-grok-agents] registering agent "${agentName}" in org "${orgSlug}"...`,
		);
		const agentId = await client.mutation(api.agents.registerAgent, {
			orgSlug,
			name: agentName,
			description:
				"Grok station — Model B (task k17dpqs9d1sd8z4a395gz6s3v98d2amm)",
		});
		console.log(`[mint-grok-agents] agents._id = ${agentId} (non-secret)`);

		const { secret, mintedAt } = await client.mutation(
			api.agentCredentials.mintAgentCredential,
			{
				orgSlug,
				agentName,
			},
		);

		const path = writeSecretFile(secretsDir, agentName, secret);
		const envVarName = envVarNameFor(agentName);
		console.log(
			`[mint-grok-agents] minted credential for "${agentName}" at ${new Date(mintedAt).toISOString()}.`,
		);
		console.log(
			`[mint-grok-agents] plaintext secret written to: ${path} (mode 0600, NOT printed here)`,
		);
		console.log(
			`[mint-grok-agents] station should read this file's contents into env var: ${envVarName}`,
		);
	}

	console.log(
		"\n[mint-grok-agents] DONE. No secret value was printed to stdout at any point. " +
			`Secrets live under: ${secretsDir} (gitignored — .secrets/).`,
	);
}

main().catch((err) => {
	console.error(
		`[mint-grok-agents] FAILED: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exitCode = 1;
});
