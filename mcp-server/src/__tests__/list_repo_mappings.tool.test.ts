// ─────────────────────────────────────────────────────────────────────────────
// list_repo_mappings.tool.test.ts — PR-C TDD-RED phase
// ─────────────────────────────────────────────────────────────────────────────
// Pins the MCP tool description + args schema contract for list_repo_mappings.
//
// T-GREEN must export from mcp-server/src/tools.ts:
//   - LIST_REPO_MAPPINGS_TOOL_DESCRIPTION: string — must contain "default 20",
//     "cap 200", and "fields=lite|full"
//   - listRepoMappingsArgsSchema: z.ZodObject — must accept
//     { limit (1-200), cursor (string), fields ("lite"|"full") }
//     and reject limit > 200 or invalid fields
//
// Both imports will throw "does not provide an export named …" until T-GREEN
// ships them — that is the RED contract.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
// Expected exports from T-GREEN — these do not yet exist in tools.ts → RED
import {
	LIST_REPO_MAPPINGS_TOOL_DESCRIPTION,
	listRepoMappingsArgsSchema,
} from "../tools.js";

describe("list_repo_mappings tool description + args schema (PR-C RED)", () => {
	it("description mentions 'default 20', 'cap 200', and 'fields=lite|full'", () => {
		expect(LIST_REPO_MAPPINGS_TOOL_DESCRIPTION).toContain("default 20");
		expect(LIST_REPO_MAPPINGS_TOOL_DESCRIPTION).toContain("cap 200");
		expect(LIST_REPO_MAPPINGS_TOOL_DESCRIPTION).toContain("fields=lite|full");
	});

	it("args schema accepts {limit (1-200), cursor (string), fields ('lite'|'full')} and rejects out-of-range values", () => {
		// Valid full object
		expect(
			listRepoMappingsArgsSchema.parse({ limit: 20, cursor: "abc", fields: "lite" }),
		).toBeTruthy();

		// Valid — limit at boundaries
		expect(listRepoMappingsArgsSchema.parse({ limit: 1 })).toBeTruthy();
		expect(listRepoMappingsArgsSchema.parse({ limit: 200 })).toBeTruthy();

		// Valid — fields=full, no cursor
		expect(
			listRepoMappingsArgsSchema.parse({ limit: 10, fields: "full" }),
		).toBeTruthy();

		// Invalid — limit exceeds cap
		expect(() => listRepoMappingsArgsSchema.parse({ limit: 250 })).toThrow();

		// Invalid — limit below 1
		expect(() => listRepoMappingsArgsSchema.parse({ limit: 0 })).toThrow();

		// Invalid — fields not in enum
		expect(() => listRepoMappingsArgsSchema.parse({ fields: "xxx" })).toThrow();

		// Invalid — fields "compact" not in enum
		expect(() =>
			listRepoMappingsArgsSchema.parse({ fields: "compact" }),
		).toThrow();
	});
});
