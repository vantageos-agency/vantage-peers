/**
 * Consumer test for the githubRepoMapping:add contract change (task
 * k17b5btg6cr9t9824tndte3w2s8fmzx1, PR #1450): the MCP tool `add_repo_mapping`
 * forwards the optional per-repo `reviewer` / `fallbackReviewer` to the Convex
 * mutation and echoes them back; when absent, nothing is forwarded so the
 * fleet default (taskClosureConfig reviewerDefault) applies.
 */

import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const MASTER_CTX: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

function setup() {
	const handlers = new Map<string, Handler>();
	const capture = (...args: unknown[]) => {
		handlers.set(args[0] as string, args[args.length - 1] as Handler);
		return {};
	};
	const server = { tool: capture, registerTool: capture } as Parameters<
		typeof registerTools
	>[0];
	const mutation = vi.fn().mockResolvedValue("mapping-id-1");
	const convex = {
		query: vi.fn().mockResolvedValue(null),
		mutation,
		action: vi.fn().mockResolvedValue(null),
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, MASTER_CTX);
	const handler = handlers.get("add_repo_mapping");
	if (!handler) throw new Error("add_repo_mapping not registered");
	return { handler, mutation };
}

function parse(result: unknown): Record<string, unknown> {
	const r = result as { content: Array<{ text: string }>; isError?: boolean };
	expect(r.isError).not.toBe(true);
	return JSON.parse(r.content[0].text);
}

const BASE = {
	repo: "vantageos-agency/vantage-peers",
	orchestrator: "sigma",
	project: "vantage-peers",
	active: true,
};

describe("add_repo_mapping — reviewer / fallbackReviewer consumer contract", () => {
	it("pole 1: forwards reviewer + fallbackReviewer to githubRepoMapping:add and echoes them", async () => {
		const { handler, mutation } = setup();
		const out = parse(
			await handler({ ...BASE, reviewer: "argus", fallbackReviewer: "omega" }),
		);

		expect(mutation).toHaveBeenCalledTimes(1);
		const [name, args] = mutation.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(name).toBe("githubRepoMapping:add");
		expect(args.reviewer).toBe("argus");
		expect(args.fallbackReviewer).toBe("omega");
		expect(out.reviewer).toBe("argus");
		expect(out.fallbackReviewer).toBe("omega");
	});

	it("pole 2: without them, the mutation carries no reviewer values (fleet default applies)", async () => {
		const { handler, mutation } = setup();
		const out = parse(await handler({ ...BASE }));

		const [name, args] = mutation.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(name).toBe("githubRepoMapping:add");
		expect(args.reviewer).toBeUndefined();
		expect(args.fallbackReviewer).toBeUndefined();
		expect(out.reviewer).toBeUndefined();
		expect(out.fallbackReviewer).toBeUndefined();
	});
});
