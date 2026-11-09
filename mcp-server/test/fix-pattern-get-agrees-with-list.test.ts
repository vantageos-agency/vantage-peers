/**
 * Task k17a388w6d0cxmyw8gfk5tryp18hvw2k (b): get_fix_pattern resolves a row under
 * the same scope rule as list_fix_patterns.
 *
 * Production: a fleet-master seat (allowlist "*") that carries a seat agent LISTED
 * patterns created by another station, and the wrapped client then forwarded that
 * seat's verifiedActor to fixPatterns:get, which narrowed to the actor's own
 * patterns and answered null -> "Fix pattern not found".
 *
 *   MASTER   forwards no actor and no roster: it reads what it lists.
 *   REFUSED  a scoped caller outside the roster is told it is REFUSED (RBAC_DENIED).
 *   ABSENT   an id that does not exist stays "Fix pattern not found".
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const PATTERN_ID = "m974tpxzvq7q13ydqhx6w7abtx89n77q";
const SIGMA_ID = "kd7sigma00000000000000000000000";

const text = (r: unknown): string =>
	(r as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";

function seatOf(allow: string[]): OAuthContext {
	return {
		clientId: "c",
		userId: "u",
		scopes: ["vantage:read"],
		scopeProfile: allow.includes("*") ? "fleet-master" : "seat",
		fromAllowList: allow,
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		accessTokenHash: "h",
		clerkOrgSlug: "vantage",
		seatAgent: { agentId: SIGMA_ID, orgId: "vantage", agentName: "sigma" },
	};
}

const row = {
	_id: PATTERN_ID,
	_creationTime: 1,
	symptom: "eta-symptom",
	rootCause: "rc",
	tags: [],
	stack: [],
	sourceProject: "p",
	createdBy: "eta",
	severity: "minor",
	createdAt: 1,
	updatedAt: 1,
	attempts: [],
};

async function callGet(
	ctx: OAuthContext,
	backend: (args: Record<string, unknown>) => unknown,
) {
	const handlers = new Map<string, ToolHandler>();
	const capture = (...a: unknown[]): unknown => {
		handlers.set(a[0] as string, a[a.length - 1] as ToolHandler);
		return {};
	};
	const server = { tool: capture, registerTool: capture } as unknown as McpServer;
	const calls: Array<Record<string, unknown>> = [];
	const query = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
		calls.push(args);
		return backend(args);
	});
	registerTools(
		server,
		{ query, mutation: vi.fn(), action: vi.fn() } as unknown as ConvexHttpClient,
		ctx,
	);
	const result = await handlers.get("get_fix_pattern")?.({ patternId: PATTERN_ID });
	return { result, calls };
}

describe("get_fix_pattern agrees with list_fix_patterns", () => {
	it("MASTER: a fleet-master seat forwards neither verifiedActor nor a roster, and reads the row it lists", async () => {
		const { result, calls } = await callGet(seatOf(["*"]), (args) =>
			args.verifiedActor === undefined && args.callerIdentities === undefined
				? row
				: null,
		);
		expect(calls[0].verifiedActor).toBeUndefined();
		expect(calls[0].callerIdentities).toBeUndefined();
		expect(text(result)).toContain("eta-symptom");
	});

	it("REFUSED: a scoped caller whose roster does not name the creator is told RBAC_DENIED, not 'not found'", async () => {
		const { result } = await callGet(seatOf(["sigma"]), () => row);
		expect(text(result)).toContain("RBAC_DENIED");
		expect(text(result)).not.toContain("not found");
	});

	it("REFUSED (door): a Convex RBAC_DENIED reaches the caller unchanged", async () => {
		const { result } = await callGet(seatOf(["sigma"]), () => {
			throw Object.assign(new Error("redacted"), {
				data: "RBAC_DENIED: caller may not read fix pattern — fixPatterns:get",
			});
		});
		expect(text(result)).toContain("RBAC_DENIED");
	});

	it("ABSENT: an id that does not exist stays 'Fix pattern not found'", async () => {
		const { result } = await callGet(seatOf(["sigma"]), () => null);
		expect(text(result)).toContain("Fix pattern not found");
	});
});
