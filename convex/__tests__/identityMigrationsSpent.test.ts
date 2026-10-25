// identityMigrationsSpent — a one-off migration whose run is proven spent is DELETED,
// not kept as a dormant identity site (task k17b30hbj2qvkssjwsxy52tn2x8g7rzk, M20).
//
// memberScopesMigration:addDefaultMemberScopes appended the default own-org member
// scopes to `client_org_mapping` rows provisioned before the default widened. Production
// read-back before deletion: 12 client_org_mapping rows, 0 active non-fleetWide rows
// missing a DEFAULT_MEMBER_SCOPES entry (`npx convex data client_org_mapping
// --limit 10000 --format json`, prod key, read only). New orgs are provisioned with the
// defaults by oauth:provisionOrganization, so nothing can re-create a row to fill.
//
// This pins the outcome: the module is gone from the tree and from the generated API,
// and nothing in the backend, scripts, or MCP server still names it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const REPO = resolve(__dirname, "..", "..");
// Split so this file does not match its own search.
const SPENT = ["member", "Scopes", "Migration"].join("");
const SPENT_FN = ["addDefault", "MemberScopes"].join("");

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".git" || name === "dist") continue;
		const p = join(dir, name);
		const s = statSync(p);
		if (s.isDirectory()) walk(p, out);
		else if (/\.(ts|tsx|mjs|js|json|md|py)$/.test(name)) out.push(p);
	}
	return out;
}

describe("spent identity migrations are deleted", () => {
	test("the module file is gone", () => {
		expect(existsSync(join(REPO, "convex", `${SPENT}.ts`))).toBe(false);
	});

	test("the generated API no longer exposes it", () => {
		const api = readFileSync(join(REPO, "convex", "_generated", "api.d.ts"), "utf8");
		expect(api).not.toContain(SPENT);
	});

	test("no source, script, or MCP file still names the module or its function", () => {
		const roots = ["convex", "scripts", join("mcp-server", "src")].map((r) =>
			join(REPO, r),
		);
		const self = resolve(__filename);
		const hits: string[] = [];
		for (const root of roots) {
			if (!existsSync(root)) continue;
			for (const f of walk(root)) {
				if (resolve(f) === self) continue;
				const text = readFileSync(f, "utf8");
				if (text.includes(SPENT) || text.includes(SPENT_FN)) {
					hits.push(relative(REPO, f));
				}
			}
		}
		expect(hits).toEqual([]);
	});
});
