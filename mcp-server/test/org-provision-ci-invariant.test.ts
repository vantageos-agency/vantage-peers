/**
 * T-CHECK — CI invariant for org-binding. Lives in the same PR as T4.
 * Job: vitest-convex (vitest run convex/ + mcp-server/test/).
 * Goes red if the token-hash org-binding branch is deleted from checkDelegationAllowed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("CI invariant — provisioned client org-binding", () => {
	it("checkDelegationAllowed has a token-hash path distinct from clerkJwt * short-circuit", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const auth = readFileSync(join(here, "../src/auth.ts"), "utf8");
		const start = auth.indexOf("export async function checkDelegationAllowed");
		expect(start).toBeGreaterThan(-1);
		const fn = auth.slice(start, auth.indexOf("export function checkNamespacePrefix", start));
		expect(fn).toMatch(/accessTokenHash/);
		expect(fn).toMatch(/clerkOrgSlug/);
		expect(fn).toMatch(/ctx\.clerkJwt && roster\.includes\("\*"\)/);
		expect(fn).not.toMatch(/^\s*if \(roster\.includes\("\*"\)\) return null;/m);
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
