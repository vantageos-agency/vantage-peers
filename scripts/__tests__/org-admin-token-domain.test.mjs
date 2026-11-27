/**
 * requireClerkDomain trims before checking: whitespace is not a domain
 * (task k17efj6v430bwzvbakb9fjnprh8k0zkf).
 */
import { describe, expect, it } from "vitest";
import { requireClerkDomain } from "../lib/org-admin-token.mjs";

describe("requireClerkDomain", () => {
	for (const v of [undefined, "", "   ", "\t\n"]) {
		it(`MUST_BLOCK: ${JSON.stringify(v)} refuses naming CLERK_DOMAIN`, () => {
			expect(() => requireClerkDomain({ CLERK_DOMAIN: v })).toThrow(
				/CLERK_DOMAIN/,
			);
		});
	}
	it("MUST_PASS: returns the trimmed domain", () => {
		expect(
			requireClerkDomain({ CLERK_DOMAIN: "  https://clerk.example.test \n" }),
		).toBe("https://clerk.example.test");
	});
});
