/**
 * The erase_row tool's `table` enum is the backend's COVERED list, in both directions
 * (task k170t9bg650dyw6hxjj627p9fx8hhpeq). The MCP server cannot import the backend source,
 * so mcp-server/src/eraseTables.ts carries a copy; this test parses `ERASE_TABLES` out of
 * convex/lib/eraseRow.ts and the `ERASE_COVERED` policy keys beside it, and fails on any
 * difference. It also pins that the tool's advertised input schema offers exactly that list.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERASE_ROW_TABLES } from "../src/eraseTables.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = readFileSync(
	resolve(HERE, "../../convex/lib/eraseRow.ts"),
	"utf8",
);

function backendTables(): string[] {
	const m = /export const ERASE_TABLES = \[([\s\S]*?)\] as const;/.exec(BACKEND);
	expect(m, "ERASE_TABLES not found in convex/lib/eraseRow.ts").not.toBeNull();
	return [...(m?.[1] ?? "").matchAll(/"([A-Za-z_]+)"/g)].map((x) => x[1]);
}

describe("erase_row tables == the backend's covered tables", () => {
	it("the MCP list equals ERASE_TABLES (set equality, both directions)", () => {
		expect([...ERASE_ROW_TABLES].sort()).toEqual(backendTables().sort());
	});

	it("the backend policy table covers exactly ERASE_TABLES", () => {
		const m = /export const ERASE_COVERED[^=]*= \{([\s\S]*?)\n\};/.exec(BACKEND);
		expect(m).not.toBeNull();
		const keys = [...(m?.[1] ?? "").matchAll(/^\t([A-Za-z_]+): \{/gm)].map(
			(x) => x[1],
		);
		expect(keys.sort()).toEqual(backendTables().sort());
	});

	it("no credential, identity or system table is offered", () => {
		for (const t of ERASE_ROW_TABLES) {
			expect(t).not.toMatch(/^oauth_|credential|agents$|client_org_mapping|orgMembership/);
		}
	});
});
