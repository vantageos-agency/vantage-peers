#!/usr/bin/env node

/**
 * clerk-jwt-smoke.js — G3 post-deploy activation verifier for VantagePeers Cloud.
 *
 * Repairs the intention behind the retired `enforce-clerk-jwt-smoke-prod.py`
 * hook: prove the Clerk -> Convex auth pipeline (`convex/lib/auth.ts`
 * `withOrgScope`) is LIVE against a deployed Convex environment, before that
 * environment is trusted for a prod deploy.
 *
 * BIPOLAR read, both poles measured INDEPENDENTLY, distinguished by CONTENT
 * (never by which flag requested them):
 *
 *   POLE A (MUST_BLOCK / deny) — a real Clerk identity with NO org claim and
 *   whose subject is NOT the configured service account MUST be refused
 *   (RBAC_DENIED) by withOrgScope. A disposable Clerk user is created for
 *   this pole and deleted again in a `finally` block.
 *
 *   POLE B (MUST_PASS / grant) — a real Clerk identity whose subject EQUALS
 *   CLERK_SERVICE_ACCOUNT_USER_ID must be granted master scope.
 *
 * Feasibility (documented, do not fake): a headless JWT is minted with NO
 * browser via the Clerk "sign-in token" ticket strategy:
 *   1. Backend API: signInTokens.createSignInToken({ userId }).
 *   2. Frontend API: POST /v1/client/sign_ins with strategy=ticket&ticket=<t>
 *      -> returns a created session id (no browser required, plain HTTPS).
 *   3. Frontend API: POST /v1/client/sessions/<id>/tokens/<template>
 *      -> returns the session JWT for the "convex" JWT template.
 * This is the same headless pattern Clerk's own E2E testing guidance uses.
 * If any of these three calls fails, the script does NOT fall back to a
 * fake pass — it reports a DEFERRAL with the exact reason (see
 * `deferred` field in the JSON output) and still runs the degraded,
 * config-parity-only check (issuer/audience match against auth.config.ts).
 *
 * Required env (read at runtime, values NEVER printed):
 *   CLERK_SECRET_KEY               - Clerk backend secret key
 *   CONVEX_URL                     - deployed Convex HTTP URL to exercise
 *   CLERK_SERVICE_ACCOUNT_USER_ID  - the service-account subject the door
 *                                    allowlists in convex/lib/auth.ts
 *
 * Optional env:
 *   CLERK_JWT_ISSUER_DOMAIN        - explicit override for the expected
 *                                    Clerk issuer domain. When unset, the
 *                                    domain is derived by reading
 *                                    convex/auth.config.ts (the committed
 *                                    single source of truth) — never
 *                                    hardcoded. See deriveExpectedClerkDomain().
 *
 * Output: single JSON object to stdout. Exit 0 iff passed === true.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClerkClient } from "@clerk/backend";
import { ConvexHttpClient } from "convex/browser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JWT_TEMPLATE = "convex";
// The Convex query used to exercise withOrgScope's fail-closed door. Any
// existing withOrgScope call site works: the no-org refusal / service-
// account carve-out branches are reached whenever a real Clerk identity is
// present, regardless of the allowNoIdentityMaster option (that option only
// changes behaviour when NO identity/bearer is present at all).
const EXERCISE_FUNCTION = "dashboard:getDashboardSummary";

function fail(message) {
	console.error(`could not measure: ${message}`);
	process.exit(1);
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		fail(`required env var ${name} is not set`);
	}
	return value;
}

// Derive the expected Clerk issuer domain from the single source of truth,
// never a hardcoded literal (Eta REVISE on PR #1125, same class of fix as
// vantage-registry #275 @58a022c).
//
// Precedence:
//   1. CLERK_JWT_ISSUER_DOMAIN env var, if set (explicit override).
//   2. convex/auth.config.ts's first provider `domain` field, read as plain
//      text and extracted with a regex (this is a tiny static TS module —
//      no TS import machinery needed for a JS script).
// If NEITHER source yields a domain, fail loud rather than fall back to a
// hardcoded literal.
function deriveExpectedClerkDomain() {
	const envOverride = process.env.CLERK_JWT_ISSUER_DOMAIN;
	if (envOverride) {
		return envOverride;
	}

	const authConfigPath = path.resolve(__dirname, "../../convex/auth.config.ts");
	let source;
	try {
		source = readFileSync(authConfigPath, "utf8");
	} catch {
		fail(
			"could not measure: cannot resolve expected Clerk issuer from CLERK_JWT_ISSUER_DOMAIN or convex/auth.config.ts",
		);
	}
	const match = source.match(/domain:\s*["']([^"']+)["']/);
	if (!match) {
		fail(
			"could not measure: cannot resolve expected Clerk issuer from CLERK_JWT_ISSUER_DOMAIN or convex/auth.config.ts",
		);
	}
	return match[1];
}

// Claims-only JWT decode — NO signature verification performed here. This is
// solely to read `iss`/`aud` off a token this script itself just minted, to
// report parity honestly instead of hardcoding it. Signature trust is not
// asserted or implied by this function.
function decodeJwtPayloadUnverified(jwt) {
	const parts = jwt.split(".");
	if (parts.length !== 3) {
		throw new Error("not a JWT: expected 3 dot-separated segments");
	}
	const payloadB64Url = parts[1];
	const payloadB64 = payloadB64Url.replace(/-/g, "+").replace(/_/g, "/");
	const padded = payloadB64.padEnd(
		payloadB64.length + ((4 - (payloadB64.length % 4)) % 4),
		"=",
	);
	const json = Buffer.from(padded, "base64").toString("utf8");
	return JSON.parse(json);
}

async function mintHeadlessSessionJwt({ clerk, domain, userId, template }) {
	// Step 1 — Backend API: create a disposable sign-in token for this user.
	const signInToken = await clerk.signInTokens.createSignInToken({
		userId,
		expiresInSeconds: 60,
	});

	// Step 2 — Frontend API: exchange the ticket for a session, no browser.
	const signInRes = await fetch(
		`${domain}/v1/client/sign_ins?_is_native=true`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				strategy: "ticket",
				ticket: signInToken.token,
			}),
		},
	);
	const signInBody = await signInRes.json().catch(() => null);
	if (!signInRes.ok || !signInBody) {
		throw new Error(
			`sign_ins ticket exchange failed: HTTP ${signInRes.status}`,
		);
	}
	const sessionId =
		signInBody?.response?.created_session_id ?? signInBody?.created_session_id;
	if (!sessionId) {
		throw new Error("sign_ins ticket exchange returned no created_session_id");
	}

	// Step 3 — Frontend API: mint the JWT for the given template from that session.
	const tokenRes = await fetch(
		`${domain}/v1/client/sessions/${sessionId}/tokens/${template}?_is_native=true`,
		{ method: "POST" },
	);
	const tokenBody = await tokenRes.json().catch(() => null);
	if (!tokenRes.ok || !tokenBody?.jwt) {
		throw new Error(`session token mint failed: HTTP ${tokenRes.status}`);
	}
	return { jwt: tokenBody.jwt, sessionId };
}

async function exerciseDoor({ convexUrl, jwt }) {
	const client = new ConvexHttpClient(convexUrl);
	client.setAuth(jwt);
	try {
		await client.query(EXERCISE_FUNCTION, {});
		return { denied: false, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { denied: /RBAC_DENIED/.test(message), error: message };
	}
}

async function main() {
	const clerkSecretKey = requireEnv("CLERK_SECRET_KEY");
	const convexUrl = requireEnv("CONVEX_URL");
	const serviceAccountUserId = requireEnv("CLERK_SERVICE_ACCOUNT_USER_ID");

	const clerk = createClerkClient({ secretKey: clerkSecretKey });

	const domain = deriveExpectedClerkDomain();
	// issuerMatch/audienceMatch start undetermined — they are DERIVED below
	// from the claims of the first real JWT this script mints (never
	// hardcoded). If no JWT is ever minted (deferral path), they stay null.
	let issuerMatch = null;
	let audienceMatch = null;
	let audienceNote = null;

	const report = {
		tool: "clerk-jwt-smoke",
		measuredAt: new Date().toISOString(),
		deploymentIdentity: convexUrl, // the target the ConvexHttpClient was
		// actually constructed against — never a name typed elsewhere.
		clerkDomain: domain,
		jwtTemplate: JWT_TEMPLATE,
		issuerMatch,
		audienceMatch,
		poleA_denied: false,
		poleB_master: false,
		deferred: null,
		poleDetails: {},
		passed: false,
	};

	let disposableUserId = null;
	try {
		// ── Feasibility spike + POLE A (deny) ──────────────────────────────
		// Create a throwaway Clerk user with NO org attached — the exact
		// shape PR #1123 closes the door on.
		const disposableUser = await clerk.users.createUser({
			emailAddress: [
				`clerk-jwt-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
			],
			skipPasswordChecks: true,
			skipPasswordRequirement: true,
		});
		disposableUserId = disposableUser.id;

		const poleAMint = await mintHeadlessSessionJwt({
			clerk,
			domain,
			userId: disposableUserId,
			template: JWT_TEMPLATE,
		});

		// Derive issuer/audience parity from the FIRST real JWT this script
		// minted (poleA's), instead of asserting it — claims-only decode, no
		// signature verification.
		const mintedPayload = decodeJwtPayloadUnverified(poleAMint.jwt);
		// Clerk's `iss` may include a trailing slash or path; compare on the
		// origin (scheme+host) rather than exact string equality.
		const issuerOrigin = (() => {
			try {
				return new URL(mintedPayload.iss).origin;
			} catch {
				return mintedPayload.iss;
			}
		})();
		issuerMatch = issuerOrigin === new URL(domain).origin;
		if (mintedPayload.aud === undefined || mintedPayload.aud === null) {
			audienceMatch = null;
			audienceNote =
				"not-independently-checked: convex template emits no aud claim";
		} else {
			audienceMatch =
				mintedPayload.aud === "convex" ||
				(Array.isArray(mintedPayload.aud) &&
					mintedPayload.aud.includes("convex"));
		}
		report.issuerMatch = issuerMatch;
		report.audienceMatch = audienceMatch;
		if (audienceNote) {
			report.audienceNote = audienceNote;
		}

		const poleAResult = await exerciseDoor({
			convexUrl,
			jwt: poleAMint.jwt,
		});
		report.poleA_denied = poleAResult.denied;
		report.poleDetails.poleA = {
			subjectKind: "disposable-no-org-user",
			refused: poleAResult.denied,
			wireMessage: poleAResult.error,
		};

		// ── POLE B (grant) — real service-account subject ─────────────────
		const poleBMint = await mintHeadlessSessionJwt({
			clerk,
			domain,
			userId: serviceAccountUserId,
			template: JWT_TEMPLATE,
		});
		const poleBResult = await exerciseDoor({
			convexUrl,
			jwt: poleBMint.jwt,
		});
		// Grant = query succeeded (no RBAC_DENIED thrown).
		report.poleB_master = poleBResult.error === null;
		report.poleDetails.poleB = {
			subjectKind: "service-account",
			granted: report.poleB_master,
			wireMessage: poleBResult.error,
		};

		// A null audienceMatch (honestly unchecked — no aud claim to compare)
		// is not a blocker on its own; a genuine issuer mismatch always is.
		report.passed =
			report.poleA_denied === true &&
			report.poleB_master === true &&
			report.issuerMatch === true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		report.deferred = {
			reason: `live-JWT G3 read deferred: headless mint/exercise failed — ${message}`,
			degraded: {
				issuerMatch,
				audienceMatch,
				note: "config-parity only (derived expected domain from CLERK_JWT_ISSUER_DOMAIN or convex/auth.config.ts) — no live Clerk->Convex round trip was completed",
			},
		};
		report.passed = false;
	} finally {
		if (disposableUserId) {
			try {
				await clerk.users.deleteUser(disposableUserId);
			} catch (cleanupErr) {
				const message =
					cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
				report.cleanupWarning = `disposable Clerk user ${disposableUserId} may not have been deleted: ${message}`;
			}
		}
	}

	console.log(JSON.stringify(report, null, 2));
	process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
	fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
