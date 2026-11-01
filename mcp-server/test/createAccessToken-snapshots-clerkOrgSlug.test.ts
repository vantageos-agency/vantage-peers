/**
 * Eta REVISE #1216 Blocker 2: every oauth:createAccessToken mint must copy
 * clerkOrgSlug from the profile the same way it copies fromAllowList. The refresh
 * grant mints through oauth:rotateRefreshToken (module M3), whose payload carries
 * the same profile snapshot.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("createAccessToken mint copies clerkOrgSlug from profile", () => {
	it("each oauth:createAccessToken payload in server-http.ts includes clerkOrgSlug", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(join(here, "../server-http.ts"), "utf8");
		const parts = src
			.split('"oauth:createAccessToken"')
			.slice(1)
			.filter((p) => p.includes("tokenHash"));
		// The person exchange (its payload is the `personTokenArgs` literal, sent
		// with the refresh row and, as a fallback, without it) and the admin mint.
		expect(parts.length).toBe(2);
		for (const part of parts) {
			const obj = part.includes("personTokenArgs")
				? src.slice(src.indexOf("const personTokenArgs = {"))
				: part;
			const window = obj.slice(0, 1500);
			expect(window).toMatch(/fromAllowList/);
			expect(window).toMatch(/clerkOrgSlug/);
		}
	});

	it("the refresh grant's oauth:rotateRefreshToken payload copies fromAllowList and clerkOrgSlug from the profile", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(join(here, "../server-http.ts"), "utf8");
		const parts = src.split('"oauth:rotateRefreshToken"').slice(1);
		// the person branch first, then the seat call
		expect(parts.length).toBe(2);
		const person = parts[0].slice(0, 600);
		const seat = parts[1].slice(0, 1500);
		expect(seat).toMatch(/fromAllowList: profile\.fromAllowList/);
		expect(seat).toMatch(/clerkOrgSlug: profile\.clerkOrgSlug/);
		// a PERSON rotation sends no authority at all: not a profile, not a snapshot
		expect(person).not.toMatch(/fromAllowList|scopeProfile|scopes|namespace/);
		expect(person).toMatch(/presentedHash/);
	});
});
