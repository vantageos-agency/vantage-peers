// ─────────────────────────────────────────────────────────────────────────────
// list_bus.tool.test.ts — PR-A TDD-RED phase
// ─────────────────────────────────────────────────────────────────────────────
// Pins the MCP tool description + args schema contract for list_bus.
//
// T-GREEN must export from mcp-server/src/tools.ts:
//   - LIST_BUS_TOOL_DESCRIPTION: string — must contain "default 20", "cap 200",
//     and "fields=lite|full"
//   - listBusArgsSchema: z.ZodObject — must accept { limit (1-200), cursor
//     (string), fields ("lite"|"full") } and reject limit > 200 or invalid fields
//
// Both imports will throw "does not provide an export named …" until T-GREEN
// ships them — that is the RED contract.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
// Expected exports from T-GREEN — these do not yet exist in tools.ts → RED
import { LIST_BUS_TOOL_DESCRIPTION, listBusArgsSchema } from "../tools.js";

describe("list_bus tool description + args schema (PR-A RED)", () => {
	it("description mentions 'default 20', 'cap 200', and 'fields=lite|full'", () => {
		expect(LIST_BUS_TOOL_DESCRIPTION).toContain("default 20");
		expect(LIST_BUS_TOOL_DESCRIPTION).toContain("cap 200");
		expect(LIST_BUS_TOOL_DESCRIPTION).toContain("fields=lite|full");
	});

	it("args schema accepts {limit (1-200), cursor (string), fields ('lite'|'full')} and rejects out-of-range values", () => {
		// Valid full object
		expect(
			listBusArgsSchema.parse({ limit: 20, cursor: "abc", fields: "lite" }),
		).toBeTruthy();

		// Valid — limit at boundary
		expect(listBusArgsSchema.parse({ limit: 1 })).toBeTruthy();
		expect(listBusArgsSchema.parse({ limit: 200 })).toBeTruthy();

		// Invalid — limit exceeds cap
		expect(() => listBusArgsSchema.parse({ limit: 250 })).toThrow();

		// Invalid — limit below 1
		expect(() => listBusArgsSchema.parse({ limit: 0 })).toThrow();

		// Invalid — fields not in enum
		expect(() => listBusArgsSchema.parse({ fields: "xxx" })).toThrow();

		// Invalid — fields "compact" not in enum
		expect(() => listBusArgsSchema.parse({ fields: "compact" })).toThrow();
	});
});
