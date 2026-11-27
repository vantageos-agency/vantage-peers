/**
 * list_repo_mappings must serve a stored out-of-scope row (task k174dm9s483yj3tr03d7v4tgsx8k0ecw).
 *
 * githubRepoMapping.orchestrator is optional in convex/schema.ts (contract 33): an
 * out-of-scope row has no orchestrator and carries outOfScope: { reason }. The tool's
 * outputSchema declared orchestrator as required, so the SDK's output validation refused
 * any page holding such a row, for fields=lite and fields=full alike.
 *
 * The harness captures the handler AND the outputSchema the SDK would validate the
 * handler's structuredContent against, and applies it.
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const masterCtx: OAuthContext = {
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

type Captured = {
	handler: (args: unknown) => Promise<{
		isError?: boolean;
		structuredContent?: unknown;
		content: { text: string }[];
	}>;
	outputSchema: {
		safeParse: (v: unknown) => {
			success: boolean;
			error?: { message: string };
		};
	};
};

function capture(page: unknown): Captured {
	let found: Captured | undefined;
	const mockServer = {
		registerTool: (
			name: string,
			config: { outputSchema?: Captured["outputSchema"] },
			handler: Captured["handler"],
		) => {
			if (name === "list_repo_mappings" && config.outputSchema) {
				found = { handler, outputSchema: config.outputSchema };
			}
		},
	} as never;
	const mockConvex = {
		query: async (path: string) =>
			path === "githubRepoMapping:list" ? page : null,
		mutation: async () => null,
		action: async () => null,
	} as never;
	registerTools(mockServer, mockConvex, masterCtx);
	if (!found) {
		throw new Error("list_repo_mappings was not registered with an outputSchema");
	}
	return found;
}

type Row = {
	_id: string;
	_creationTime: number;
	repo: string;
	orchestrator?: string;
	project: string;
};

const outOfScopeFull = {
	_id: "rm_out",
	_creationTime: 3,
	repo: "acme/not-ours",
	outOfScope: { reason: "owned by another team, not routed here" },
	project: "acme",
	active: false,
	orgId: "org-a",
};
const agentRowFull = {
	_id: "rm_agent",
	_creationTime: 2,
	repo: "acme/app",
	orchestrator: "sigma",
	orchestratorAgentId: "agent_o",
	reviewerAgentId: "agent_r",
	fallbackReviewerAgentId: "agent_f",
	project: "acme",
	active: true,
	orgId: "org-a",
};
const normalFull = {
	_id: "rm_norm",
	_creationTime: 1,
	repo: "acme/web",
	orchestrator: "omega",
	project: "acme",
	active: true,
};
// The lite projection of convex/githubRepoMapping.ts: orchestrator only when present.
const lite = (r: Row): Row => ({
	_id: r._id,
	_creationTime: r._creationTime,
	repo: r.repo,
	...(r.orchestrator !== undefined ? { orchestrator: r.orchestrator } : {}),
	project: r.project,
});

describe("list_repo_mappings serves an out-of-scope row", () => {
	for (const fields of ["lite", "full"] as const) {
		it(`fields=${fields}: output validation passes and every row comes back`, async () => {
			const full = [outOfScopeFull, agentRowFull, normalFull];
			const items = fields === "full" ? full : full.map(lite);
			const tool = capture({ items, nextCursor: null });
			const res = await tool.handler({ fields });
			expect(res.isError).not.toBe(true);
			const parsed = tool.outputSchema.safeParse(res.structuredContent);
			expect(parsed.error?.message).toBeUndefined();
			expect(parsed.success).toBe(true);
			const ids = (
				res.structuredContent as { items: { _id: string }[] }
			).items.map((r) => r._id);
			expect(ids).toEqual(["rm_out", "rm_agent", "rm_norm"]);
		});
	}

	it("a full out-of-scope row keeps its marker; an agent-ID row keeps its IDs", async () => {
		const tool = capture({
			items: [outOfScopeFull, agentRowFull],
			nextCursor: null,
		});
		const res = await tool.handler({ fields: "full" });
		const rows = (res.structuredContent as { items: Record<string, unknown>[] })
			.items;
		expect(rows[0].outOfScope).toEqual(outOfScopeFull.outOfScope);
		expect(rows[0].orchestrator).toBeUndefined();
		expect(rows[1].orchestratorAgentId).toBe("agent_o");
		expect(rows[1].reviewerAgentId).toBe("agent_r");
		expect(rows[1].fallbackReviewerAgentId).toBe("agent_f");
	});
});
