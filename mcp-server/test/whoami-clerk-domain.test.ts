/**
 * whoami never reports or hashes in the dev Clerk instance when CLERK_DOMAIN is unset
 * (task k17efj6v430bwzvbakb9fjnprh8k0zkf). Unknown issuer => caller_id null, never an id
 * derived from an invented domain.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import {
	deriveOpaqueCallerId,
	resolveWhoamiIdentity,
} from "../src/whoamiIdentity.js";

const SECRET = "test-whoami-secret-not-a-real-credential";
const DEV = "https://sharp-sponge-67.clerk.accounts.dev";
const SUB = "user_2abcDEFghiJKLmno";

function ctx(): OAuthContext {
	return {
		clientId: "c",
		userId: SUB,
		scopes: ["vantage:read"],
		scopeProfile: "team-member",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		clerkJwt: "eyJ.raw.jwt",
		accessTokenHash: "a".repeat(64),
		clerkOrgSlug: "acme",
	};
}

function idFor(issuer: string): string {
	const key = createHmac("sha256", SECRET).update("vp-whoami-key-v1").digest();
	const d = createHmac("sha256", key)
		.update(`vp-whoami-v1\0${issuer}\0${SUB}`)
		.digest("hex");
	return `vpu_${d.slice(0, 32)}`;
}

describe("whoami issuer", () => {
	for (const [label, v] of [
		["unset", undefined],
		["empty", ""],
		["whitespace", "  "],
	] as const) {
		it(`MUST_BLOCK: CLERK_DOMAIN ${label} -> caller_id null, never the dev-derived id`, () => {
			const env = { WHOAMI_ID_SECRET: SECRET, CLERK_DOMAIN: v };
			expect(deriveOpaqueCallerId(ctx(), env)).toBeNull();
			expect(deriveOpaqueCallerId(ctx(), env)).not.toBe(idFor(DEV));
			expect(resolveWhoamiIdentity(ctx(), env).caller_id).toBeNull();
		});
	}

	it("MUST_PASS: configured domain (trimmed) is the issuer", () => {
		const env = {
			WHOAMI_ID_SECRET: SECRET,
			CLERK_DOMAIN: "  https://clerk.prod.example.test ",
		};
		expect(deriveOpaqueCallerId(ctx(), env)).toBe(
			idFor("https://clerk.prod.example.test"),
		);
	});
});
