/**
 * Task k1783jwzj5q67fycmtehzgjdw18hexvs. Convex redacts the MESSAGE of a ConvexError to
 * "[Request ID: ...] Server Error" and carries the real payload on `.data`
 * (convex/browser http_client forwardErrorData). The tool result must carry that
 * payload (the typed code and text), and the failure LOG must too, so a typed
 * refusal never reads as a crash.
 */
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;

// What the Convex HTTP client throws for a ConvexError over the wire.
function wireConvexError(data: string): Error {
	const e = new ConvexError(`[Request ID: abc123] Server Error`) as ConvexError<string>;
	(e as { data: string }).data = data;
	return e;
}

function toolsRejectingWith(error: Error): Map<string, Tool> {
	const map = new Map<string, Tool>();
	const server = {
		tool() {},
		registerTool: (name: string, _config: unknown, handler: Tool) => {
			map.set(name, handler);
		},
	} as never;
	const convex = {
		query: async () => [],
		mutation: async () => {
			throw error;
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: test double
	registerTools(server, convex as any, LOCAL_STDIO_TRUST_CTX);
	return map;
}

afterEach(() => vi.restoreAllMocks());

describe("a ConvexError(string) reaches the tool caller and the log, not 'Server Error'", () => {
	const cases: Array<[string, string, Record<string, unknown>]> = [
		[
			"store_memory",
			'RBAC_DENIED: caller may not write to namespace "orchestrator/victor" — {"orgSlug":"iris-rh"}',
			{ namespace: "orchestrator/victor", type: "feedback", content: "c", createdBy: "pi" },
		],
		[
			"send_message",
			'RBAC_DENIED: recipient error / message non livré : "sigma,victor" ne correspond à aucun destinataire de l\'organisation. — {"reason":"recipient-not-addressable","door":"messages:sendMessage"}',
			{ from: "pi", channel: "sigma,victor", content: "hello" },
		],
	];
	for (const [name, data, args] of cases) {
		it(`${name}: result text carries the typed code and payload; log carries errorData`, async () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {});
			const tool = toolsRejectingWith(wireConvexError(data)).get(name);
			expect(tool).toBeDefined();
			const result = await (tool as Tool)(args);
			expect(result.isError).toBe(true);
			const text = result.content[0].text;
			expect(text).toContain("RBAC_DENIED");
			expect(text).not.toBe("Error: [Request ID: abc123] Server Error");
			expect(text).not.toMatch(/^\{?\s*"?code"?:?\s*"?ServerError/);
			const logged = JSON.stringify(spy.mock.calls);
			expect(logged).toContain("RBAC_DENIED");
		});
	}
});
