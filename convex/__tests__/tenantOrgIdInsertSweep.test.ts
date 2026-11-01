// Every insert of a `messages` row and a `messageReceipts` row stamps the permanent org
// ID (`tenantOrgId`), or is a declared fleet site that has no organisation and therefore
// no ID to know (task k1783fk8r6p795x9fxrzyt9evd8hcxm7, PR 2a). Without this, a row
// created after the backfill would arrive without an ID and vanish from the reads that
// switch to tenantOrgId. A new insert site that stamps nothing and is not declared here
// fails this test.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = join(__dirname, "..");

// file -> count of insert sites that legitimately carry no organisation.
const FLEET_BY_DESIGN: Record<string, number> = {
	// notifyBlockerResolved: a system message and its receipt to a waiting task's
	// assignee. Stamps NEITHER tenantId nor tenantOrgId today (a fleet-shaped message);
	// stamping would change who can read it, which is a behaviour decision, not a
	// backfill one. Declared, not silently passed.
	"tasks.ts": 2,
};

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) {
			return e.name === "__tests__" || e.name === "_generated"
				? []
				: sourceFiles(join(dir, e.name));
		}
		return e.name.endsWith(".ts") && !/\.test\.tsx?$/.test(e.name)
			? [join(dir, e.name)]
			: [];
	});
}

// The statement: from the insert line to the first line that is a bare `});`.
function statementAt(lines: string[], start: number): string {
	for (let j = start; j < lines.length; j++) {
		if (/^\s*\}\);\s*$/.test(lines[j])) {
			return lines.slice(start, j + 1).join("\n");
		}
	}
	return lines.slice(start).join("\n");
}

describe("insert sites of messages and messageReceipts stamp tenantOrgId", () => {
	test("every site stamps it, except the declared fleet sites", () => {
		const unstamped: Record<string, number> = {};
		let sites = 0;
		for (const file of sourceFiles(CONVEX_DIR)) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (!/\.insert\(\s*"(messages|messageReceipts)"/.test(line)) return;
				sites++;
				if (!/\btenantOrgId\b/.test(statementAt(lines, i))) {
					const name = file.slice(CONVEX_DIR.length + 1);
					unstamped[name] = (unstamped[name] ?? 0) + 1;
				}
			});
		}
		expect(sites).toBeGreaterThanOrEqual(6);
		expect(unstamped).toEqual(FLEET_BY_DESIGN);
	});
});
