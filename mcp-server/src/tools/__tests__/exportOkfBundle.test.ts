/**
 * exportOkfBundle.test.ts — MCP wrapper unit tests.
 *
 * The wrapper is a thin proxy; tests focus on:
 *   - Tool registration: name + arg schema shape (RFC §3.1)
 *   - Argument forwarding: nullable/undefined coercion to action contract
 *   - Error propagation: surface OKF_* codes verbatim
 *
 * 4 tests — combined with the 14 in convex/__tests__/okfBundle.test.ts brings
 * the T3 total to 18 (target ≥10, met).
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-19
 */

import { describe, expect, test, vi } from "vitest";
import {
	exportOkfBundleArgsSchema,
	registerExportOkfBundle,
} from "../exportOkfBundle";

interface ToolRegistration {
	name: string;
	description: string;
	schema: unknown;
	annotations: unknown;
	handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function makeServer(): { calls: ToolRegistration[]; server: unknown } {
	const calls: ToolRegistration[] = [];
	const server = {
		tool: (
			name: string,
			description: string,
			schema: unknown,
			annotations: unknown,
			handler: (args: Record<string, unknown>) => Promise<unknown>,
		) => {
			calls.push({ name, description, schema, annotations, handler });
		},
	};
	return { calls, server };
}

describe("export_okf_bundle MCP wrapper", () => {
	test("registers tool with the expected name + read-only hint", () => {
		const { calls, server } = makeServer();
		const convex = { action: vi.fn() } as unknown;
		registerExportOkfBundle(
			server as Parameters<typeof registerExportOkfBundle>[0],
			convex as Parameters<typeof registerExportOkfBundle>[1],
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("export_okf_bundle");
		const ann = calls[0].annotations as Record<string, unknown>;
		expect(ann.readOnlyHint).toBe(true);
		expect(ann.destructiveHint).toBe(false);
	});

	test("arg schema declares the 5 RFC §3.1 fields", () => {
		const keys = Object.keys(exportOkfBundleArgsSchema).sort();
		expect(keys).toEqual(
			["format", "namespace", "since", "types", "urlTtl"].sort(),
		);
	});

	test("forwards args to convex.action with nullable normalisation", async () => {
		const { calls, server } = makeServer();
		const action = vi.fn().mockResolvedValue({
			bundleUrl: "https://x/y",
			storageId: "kg-1",
			size: 42,
			fileCount: 3,
			manifest: {
				types: { memoryCount: 1, briefingCount: 1, taskCount: 1 },
				truncated: false,
				urlExpiresAt: "2026-06-19T01:00:00.000Z",
			},
		});
		registerExportOkfBundle(
			server as Parameters<typeof registerExportOkfBundle>[0],
			{ action } as unknown as Parameters<typeof registerExportOkfBundle>[1],
		);
		await calls[0].handler({
			namespace: "project/elpi-corp",
			format: "tarball",
			// types omitted, since omitted → wrapper must coerce to null
		});
		// Eta REVISE fix-pattern m9781h39: action moved to okfBundleNode.ts.
		expect(action).toHaveBeenCalledWith("okfBundleNode:exportOkfBundle", {
			namespace: "project/elpi-corp",
			types: null,
			format: "tarball",
			since: null,
			urlTtl: undefined,
		});
	});

	test("propagates OKF_* error messages verbatim through McpError", async () => {
		const { calls, server } = makeServer();
		const action = vi
			.fn()
			.mockRejectedValue(
				new Error(
					"AUTH_NAMESPACE_DENIED: caller org foo cannot export project/elpi-corp.",
				),
			);
		registerExportOkfBundle(
			server as Parameters<typeof registerExportOkfBundle>[0],
			{ action } as unknown as Parameters<typeof registerExportOkfBundle>[1],
		);
		await expect(
			calls[0].handler({
				namespace: "project/elpi-corp",
				format: "tarball",
			}),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
	});
});
