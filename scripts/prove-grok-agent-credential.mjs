#!/usr/bin/env bun
/**
 * prove-grok-agent-credential.mjs — BOTH-WAYS proof for Model B
 * (task k17dpqs9d1sd8z4a395gz6s3v98d2amm, step 3 of the brief).
 *
 * Run AFTER scripts/mint-grok-agents.mjs has minted "pi-grok"'s credential
 * (secret file present at .secrets/agent-credentials/pi-grok.secret).
 *
 * Proves, on ONE guarded surface (`convex/messages.ts`'s `sendMessage`,
 * gated by `requireAgentCredentialMatch` in `convex/lib/auth.ts`), that the
 * SAME call:
 *   - POSITIVE pole: `from="pi-grok"` + the minted `agentCredentialSecret`
 *     → ACCEPTED (returns a messages._id).
 *   - NEGATIVE pole: `from="pi-grok"` + NO `agentCredentialSecret`
 *     → REFUSED with AGENT_CREDENTIAL_REQUIRED (because "pi-grok" now
 *     resolves to a registered `agents` row in this org — the
 *     CONDITIONAL-SECRET rule in requireAgentCredentialMatch, Pi ruling
 *     k1746tn3jy22k0jphbx48vzmvd8d0y50).
 *
 * Positive pole runs FIRST (per brief). Same command, ONE variable changed
 * (presence/absence of agentCredentialSecret) — nothing else differs between
 * the two calls: same `from`, same `channel`, same auth'd client/session.
 *
 * LITMUS: this proof measures AUTHORIZATION, not a broken deploy. If
 * `requireAgentCredentialMatch` were deleted (or its CONDITIONAL-SECRET
 * branch bypassed), the negative pole would ALSO succeed — making this
 * script FAIL (both poles "accepted" is not a pass; see the assertion at
 * the bottom). A broken/misconfigured deploy (bad CONVEX_URL, expired JWT,
 * unknown channel) would make the POSITIVE pole fail instead, which is
 * ALSO reported as a failure — the script does not treat "some call threw"
 * as automatically confirming the negative pole's reason.
 *
 * USAGE:
 *   CONVEX_URL=https://compassionate-goldfinch-737.convex.cloud \
 *   CLERK_SECRET_KEY=$CLERK_SECRET_KEY \
 *   CLERK_ORG_ADMIN_USER_ID=$CLERK_ORG_ADMIN_USER_ID \
 *   bun run scripts/prove-grok-agent-credential.mjs
 *
 * Reuses the exact same org-admin JWT mint + orgSlug derivation as
 * mint-grok-agents.mjs (identity resolution is never duplicated — the
 * channel target below is that SAME org-admin identity's own instance, so
 * the message always has a real recipient and this proof is self-contained;
 * no other orchestrator's inbox is touched).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { getScopedUserToken } from "../mcp-server/src/serviceAccountAuth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function decodeOrgSlugFromJwt(jwt) {
	const parts = jwt.split(".");
	if (parts.length < 2) throw new Error("Minted JWT is malformed");
	const payload = JSON.parse(
		Buffer.from(parts[1], "base64url").toString("utf-8"),
	);
	const orgSlug =
		payload.organizationSlug ??
		payload.org_slug ??
		payload.organizationId ??
		payload.org_id ??
		null;
	if (!orgSlug) throw new Error("Minted JWT carries no org-slug claim");
	return orgSlug;
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value)
		throw new Error(`Missing required env var: ${name}. Cannot proceed.`);
	return value;
}

async function main() {
	const convexUrl = requireEnv("CONVEX_URL");
	requireEnv("CLERK_SECRET_KEY");
	const orgAdminUserId = requireEnv("CLERK_ORG_ADMIN_USER_ID");
	const secretsDir =
		process.env.AGENT_SECRETS_DIR ??
		join(repoRoot, ".secrets", "agent-credentials");

	const secretPath = join(secretsDir, "pi-grok.secret");
	let piGrokSecret;
	try {
		piGrokSecret = readFileSync(secretPath, "utf-8").trim();
	} catch {
		throw new Error(
			`File ${secretPath} not found. Run scripts/mint-grok-agents.mjs first. Aborting.`,
		);
	}
	if (!piGrokSecret) throw new Error(`${secretPath} is empty. Aborting.`);

	const jwt = await getScopedUserToken(orgAdminUserId);
	if (!jwt)
		throw new Error(
			"getScopedUserToken returned null — check CLERK_SECRET_KEY.",
		);
	const orgSlug = decodeOrgSlugFromJwt(jwt);

	const client = new ConvexHttpClient(convexUrl);
	client.setAuth(jwt);
	const { api } = await import("../convex/_generated/api.js");

	const baseArgs = {
		from: "pi-grok",
		channel: orgAdminUserId, // self-addressed instance channel — always resolvable, touches no other orchestrator's inbox
		content: `[Model B both-ways proof] task k17dpqs9d1sd8z4a395gz6s3v98d2amm — orgSlug=${orgSlug}`,
	};

	console.log(
		`[prove] orgSlug="${orgSlug}" — identity for both calls: pi-grok (org-admin session JWT, org "${orgSlug}")`,
	);

	// POSITIVE POLE FIRST: from="pi-grok" + correct credential → must be ACCEPTED.
	let positiveMessageId = null;
	let positiveError = null;
	try {
		positiveMessageId = await client.mutation(api.messages.sendMessage, {
			...baseArgs,
			agentCredentialSecret: piGrokSecret,
		});
	} catch (err) {
		positiveError = err instanceof Error ? err.message : String(err);
	}

	// NEGATIVE POLE: from="pi-grok" WITHOUT the credential → must be REFUSED
	// with AGENT_CREDENTIAL_REQUIRED (same command, ONE variable changed: the
	// key is simply omitted, not set to an empty/garbage string).
	let negativeMessageId = null;
	let negativeError = null;
	try {
		negativeMessageId = await client.mutation(api.messages.sendMessage, {
			...baseArgs,
		});
	} catch (err) {
		negativeError = err instanceof Error ? err.message : String(err);
	}

	console.log(
		`\n[prove] POSITIVE pole (from="pi-grok" + credential): ${
			positiveMessageId
				? `ACCEPTED — messages._id=${positiveMessageId}`
				: `REFUSED — ${positiveError}`
		}`,
	);
	console.log(
		`[prove] NEGATIVE pole (from="pi-grok" + NO credential): ${
			negativeMessageId
				? `ACCEPTED — messages._id=${negativeMessageId} (UNEXPECTED)`
				: `REFUSED — ${negativeError}`
		}`,
	);

	const positivePassed = Boolean(positiveMessageId) && !positiveError;
	const negativeRefusedForRightReason =
		!negativeMessageId &&
		typeof negativeError === "string" &&
		negativeError.includes("AGENT_CREDENTIAL_REQUIRED");

	if (positivePassed && negativeRefusedForRightReason) {
		console.log(
			"\n[prove] BOTH-WAYS PROOF: PASS — credential accepted with secret, refused (AGENT_CREDENTIAL_REQUIRED) without it.",
		);
		process.exitCode = 0;
	} else {
		console.error(
			"\n[prove] BOTH-WAYS PROOF: FAIL — " +
				`positivePassed=${positivePassed}, negativeRefusedForRightReason=${negativeRefusedForRightReason}. ` +
				"Either the credential lock did not accept a valid secret, or it did not refuse an absent one for the expected reason " +
				"(if the negative pole were ACCEPTED, the identity check that this proof is designed to catch has been removed/bypassed).",
		);
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(
		`[prove] FAILED: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exitCode = 1;
});
