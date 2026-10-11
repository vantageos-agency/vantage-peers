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
		expect(parts.length).toBe(2);
		for (const part of parts) {
			const obj = part.slice(0, 1500);
			expect(obj).toMatch(/fromAllowList/);
			expect(obj).toMatch(/clerkOrgSlug/);
		}
	});

	it("the refresh grant's oauth:rotateRefreshToken payload copies fromAllowList and clerkOrgSlug from the profile", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(join(here, "../server-http.ts"), "utf8");
		const parts = src.split('"oauth:rotateRefreshToken"').slice(1);
		expect(parts.length).toBe(1);
		const obj = parts[0].slice(0, 1500);
		expect(obj).toMatch(/fromAllowList: profile\.fromAllowList/);
		expect(obj).toMatch(/clerkOrgSlug: profile\.clerkOrgSlug/);
	});
});
