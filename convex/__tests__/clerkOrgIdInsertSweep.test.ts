// Every insert of a `tasks` row and an `oauth_scope_profiles` row stamps the permanent
// org ID (`clerkOrgId`), or is a declared fleet/catalog-by-design site that has no
// organisation and therefore no ID to know (task k1783fk8r6p795x9fxrzyt9evd8hcxm7).
// Without this, a row created between the backfill and the slug-class refusal would
// arrive without an ID and be refused. A new insert site that stamps nothing and is not
// declared here fails this test.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = join(__dirname, "..");
const WINDOW = 45; // lines after the insert in which the stamp must appear

// file -> count of insert sites that legitimately carry no organisation.
const FLEET_OR_CATALOG_BY_DESIGN: Record<string, number> = {
	// createDeployTaskWithDedup (2 sites) and createOrUpdateReviewTask: webhook
	// automation over this repo's own pull requests; `orgId: undefined` on purpose.
	"tasks.ts": 3,
	// seedDefaultProfiles and seedTestTenantTrio: hard-coded catalog profiles that
	// carry no clerkOrgSlug (master, client-generic, public-readonly, test trio).
	"oauth.ts": 2,
};

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) {
			return e.name === "__tests__" || e.name === "_generated"
				? []
				: sourceFiles(join(dir, e.name));
		}
		return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
			? [join(dir, e.name)]
			: [];
	});
}

describe("insert sites of tasks and oauth_scope_profiles stamp clerkOrgId", () => {
	test("every site stamps it, except the declared fleet/catalog sites", () => {
		const unstamped: Record<string, number> = {};
		let sites = 0;
		for (const file of sourceFiles(CONVEX_DIR)) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (!/\.insert\(\s*"(tasks|oauth_scope_profiles)"/.test(line)) return;
				sites++;
				const body = lines.slice(i, i + WINDOW).join("\n");
				if (!body.includes("clerkOrgId")) {
					const name = file.slice(CONVEX_DIR.length + 1);
					unstamped[name] = (unstamped[name] ?? 0) + 1;
				}
			});
		}
		expect(sites).toBeGreaterThanOrEqual(12);
		expect(unstamped).toEqual(FLEET_OR_CATALOG_BY_DESIGN);
	});
});
