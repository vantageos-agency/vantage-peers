/**
 * Deploy skew: Railway redeploys this MCP server on merge, the Convex prod
 * deploy comes later (.claude/rules/railway-mcp-redeploy.md). In that window
 * generate_upload_url (with sha256) and claim_upload call Convex functions
 * prod does not have yet. They must answer with a clear error RESULT naming
 * the window, never crash, and never fall back to the ticketless (unbound)
 * flow. Exercised with a mocked ConvexHttpClient that throws the
 * unknown-function error.
 */

import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerKbIngestTools } from "../tools/kbIngest.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
type ToolResult = { isError?: boolean; content: { text: string }[] };

function makeStubServer() {
	const handlers = new Map<string, ToolHandler>();
	return {
		tool(
			name: string,
			_d: unknown,
			_s: unknown,
			_a: unknown,
			handler: ToolHandler,
		) {
			handlers.set(name, handler);
		},
		registerTool(name: string, _config: unknown, handler: ToolHandler) {
			handlers.set(name, handler);
		},
		handlers,
	};
}

/** The text Convex returns for a function the deployment does not have. */
const unknownFunction = (path: string) =>
	new Error(
		`[Request ID: 3f1c0a9e] Server Error\nCould not find public function for '${path}'. Did you forget to run \`npx convex dev\` or \`npx convex deploy\`?`,
	);

function stubConvex(impl: (path: string) => unknown) {
	const mutation = vi.fn(async (path: string) => impl(path));
	return {
		stub: { mutation } as unknown as ConvexHttpClient,
		mutation,
	};
}

const teamA: OAuthContext = {
	clientId: "dcr-clerk-org-A",
	userId: "user-123",
	scopes: ["mcp:full"],
	scopeProfile: "team-member",
	fromAllowList: [],
	namespaceReadPrefixes: ["team/org-A"],
	namespaceWritePrefixes: ["team/org-A"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
};

const SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const TICKET = "a".repeat(64);

function toolsWith(impl: (path: string) => unknown) {
	const server = makeStubServer();
	const { stub, mutation } = stubConvex(impl);
	registerKbIngestTools(server as never, stub, teamA);
	const get = (name: string) => {
		const h = server.handlers.get(name);
		if (!h) throw new Error(`${name} not registered`);
		return h;
	};
	return { get, mutation };
}

describe("upload claim tools tolerate the MCP-ahead-of-Convex deploy window", () => {
	it("claim_upload: the unknown-function error becomes a clear error result, not a crash", async () => {
		const { get } = toolsWith((p) => {
			throw unknownFunction(p);
		});
		const r = (await get("claim_upload")({
			storageId: "kg2anjqa",
			ticket: TICKET,
		})) as ToolResult;
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("UPLOAD_CLAIM_NOT_AVAILABLE");
		expect(r.content[0].text).toContain(
			"upload claim not available on this deployment yet",
		);
	});

	it("generate_upload_url with sha256: error result, and NO fallback to the ticketless generateUploadUrl", async () => {
		const { get, mutation } = toolsWith((p) => {
			if (p === "kbMutations:generateUploadUrlWithTicket")
				throw unknownFunction(p);
			return "https://example.convex.cloud/api/storage/upload?token=x";
		});
		const r = (await get("generate_upload_url")({ sha256: SHA })) as ToolResult;
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("UPLOAD_CLAIM_NOT_AVAILABLE");
		expect(r.content[0].text).not.toContain("https://");
		expect(mutation.mock.calls.map((c) => c[0])).toEqual([
			"kbMutations:generateUploadUrlWithTicket",
		]);
	});

	it("not the skew window: a coded refusal from a deployed claimUpload is still surfaced as that refusal", async () => {
		const { get } = toolsWith(() => {
			throw new Error(
				"[Request ID: 1] Server Error\nUncaught ConvexError: AUTH_UPLOAD_TICKET_INVALID: no upload ticket matches",
			);
		});
		await expect(
			get("claim_upload")({ storageId: "kg2anjqa", ticket: TICKET }),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_INVALID/);
	});

	it("not the skew window: an unknown-function error naming ANOTHER function is not classified as it", async () => {
		const { get } = toolsWith(() => {
			throw unknownFunction("someOtherModule:fn");
		});
		await expect(
			get("claim_upload")({ storageId: "kg2anjqa", ticket: TICKET }),
		).rejects.toThrow(
			/Could not find public function for 'someOtherModule:fn'/,
		);
	});

	it("without sha256 the ticketless path is unchanged (and explicit: ticket null)", async () => {
		const { get, mutation } = toolsWith(
			() => "https://example.convex.cloud/api/storage/upload?token=x",
		);
		const r = (await get("generate_upload_url")({})) as ToolResult;
		expect(r.isError).toBeUndefined();
		expect(r.content[0].text).toMatch(/^https:\/\//);
		expect(JSON.parse(r.content[1].text).ticket).toBeNull();
		expect(mutation.mock.calls.map((c) => c[0])).toEqual([
			"kbMutations:generateUploadUrl",
		]);
	});
});
