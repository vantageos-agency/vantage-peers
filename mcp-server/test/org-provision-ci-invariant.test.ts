/**
 * T-CHECK — CI invariant for org-binding. Lives in the same PR as T4.
 * Job: vitest-convex (vitest run convex/ + mcp-server/test/).
 * Goes red if the token-hash org-binding branch is deleted from checkDelegationAllowed.
 *
 * Eta REVISE (ETA-M25 / ETA-M26): quote character must not defeat the NEG;
 * a missing end-anchor must throw REFUSING TO JUDGE (never String#slice(start, -1));
 * a runtime probe on the token-hash path must refuse roster ["*"] + foreign assignedTo.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	checkDelegationAllowed,
	type OAuthContext,
} from "../src/auth.js";

const CHECK_DELEGATION_START_ANCHOR =
	"export async function checkDelegationAllowed";
const CHECK_DELEGATION_END_ANCHOR = "export function checkNamespacePrefix";

/** Unguarded wildcard allow — either quote. Must NOT match the clerkJwt-prefixed line. */
const UNGUARDED_WILDCARD_ALLOW =
	/^\s*if\s*\(\s*roster\.includes\(\s*(["'])\*\1\s*\)\s*\)\s*return\s+null\s*;/m;

/** Wildcard allow is Clerk-JWT only — either quote on the `*` literal. */
const CLERK_JWT_WILDCARD_ALLOW =
	/ctx\.clerkJwt\s*&&\s*roster\.includes\(\s*(["'])\*\1\s*\)/;

/**
 * Cut the checkDelegationAllowed body. indexOf === -1 must not reach
 * String#slice: a negative end is length+end, i.e. rest-of-file (ETA-M26).
 */
function sliceCheckDelegationAllowedBody(
	source: string,
	endAnchor: string = CHECK_DELEGATION_END_ANCHOR,
): string {
	const start = source.indexOf(CHECK_DELEGATION_START_ANCHOR);
	if (start === -1) {
		throw new Error(
			`REFUSING TO JUDGE: start-anchor ${JSON.stringify(CHECK_DELEGATION_START_ANCHOR)} not found in mcp-server/src/auth.ts`,
		);
	}
	const end = source.indexOf(endAnchor, start);
	if (end === -1) {
		throw new Error(
			`REFUSING TO JUDGE: end-anchor ${JSON.stringify(endAnchor)} not found after checkDelegationAllowed — refusing to slice the rest of the file (ETA-M26)`,
		);
	}
	return source.slice(start, end);
}

function readAuthSource(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return readFileSync(join(here, "../src/auth.ts"), "utf8");
}

describe("CI invariant — provisioned client org-binding", () => {
	it("checkDelegationAllowed has a token-hash path distinct from clerkJwt * short-circuit", () => {
		const fn = sliceCheckDelegationAllowedBody(readAuthSource());
		expect(fn).toMatch(/accessTokenHash/);
		expect(fn).toMatch(/clerkOrgSlug/);
		expect(fn).toMatch(CLERK_JWT_WILDCARD_ALLOW);
		expect(fn).not.toMatch(UNGUARDED_WILDCARD_ALLOW);
	});

	it("missing checkNamespacePrefix end-anchor throws REFUSING TO JUDGE (ETA-M26)", () => {
		const stub =
			"export async function checkDelegationAllowed() { return null; }\n" +
			"export function someOtherFunction() { return true; }\n";
		expect(() => sliceCheckDelegationAllowedBody(stub)).toThrow(
			/REFUSING TO JUDGE/,
		);
	});

	it("runtime: token-hash ctx + roster ['*'] + foreign assignedTo refuses (ETA-M25)", async () => {
		const ctx: OAuthContext = {
			clientId: "client-orch-a",
			userId: "orch-a",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "orch-a-plan-org-alpha",
			fromAllowList: ["orch-a"],
			namespaceReadPrefixes: ["orchestrator/orch-a"],
			namespaceWritePrefixes: ["orchestrator/orch-a"],
			expiresAt: Date.now() + 3600_000,
			isMaster: false,
			accessTokenHash: "hash-of-orch-a-token",
			clerkOrgSlug: "plan-org-alpha",
		};
		const result = await checkDelegationAllowed(
			ctx,
			"someone-in-another-org",
			async () => ["*"],
		);
		expect(result).toEqual(expect.any(String));
		expect(result).toMatch(/Forbidden/i);
		expect(result).not.toBeNull();
	});

	it("provisionOrganization mutation exists and writes clerkOrgSlug", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const oauth = readFileSync(
			join(here, "../../convex/oauth.ts"),
			"utf8",
		);
		expect(oauth).toMatch(/export const provisionOrganization = mutation/);
		const start = oauth.indexOf("export const provisionOrganization");
		const fn = oauth.slice(start, start + 8000);
		expect(fn).toMatch(/clerkOrgSlug: slug/);
		expect(fn).toMatch(/fromAllowList: \[name\]/);
	});

	it("admin POST /organizations is registered", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const http = readFileSync(join(here, "../server-http.ts"), "utf8");
		expect(http).toMatch(/admin\.post\("\/organizations"/);
		expect(http).toMatch(/oauth:provisionOrganization/);
	});
});
