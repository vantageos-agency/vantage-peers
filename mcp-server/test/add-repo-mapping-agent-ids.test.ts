/**
 * Routing S2 (task k1730d1b6wzwepjyyth266xq958jxfv0): add_repo_mapping carries the
 * agent IDs of its labels to the Convex door, so an organisation that adopted
 * explicit review routing has a task's assignee compared with stored IDs.
 *
 *   FORWARD   given IDs are sent verbatim
 *   ABSENT    no IDs -> none of the three keys is sent (the call is as before)
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Result = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function seat(): OAuthContext {
	return {
		clientId: "client-clio",
		userId: "user-clio",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "clio-acme-hr",
		fromAllowList: ["clio", "helios"],
		namespaceReadPrefixes: ["team/acme-hr"],
		namespaceWritePrefixes: ["team/acme-hr"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		accessTokenHash: "hash-clio",
		clerkOrgSlug: "acme-hr",
		seatAgent: {
			agentId: "jh72scrneffpeqwy51rg8hny1x8fv2c4",
			orgId: "acme-hr",
			agentName: "clio",
		},
	};
}

type Call = { kind: string; name: string; args: Record<string, unknown> };

function harness() {
	const handlers = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const calls: Call[] = [];
	const convex = {
		query: async (name: string, args: Record<string, unknown>) => {
			calls.push({ kind: "query", name, args });
			if (name.startsWith("orgRoster:")) return ["clio", "helios"];
			return [];
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			calls.push({ kind: "mutation", name, args });
			return "doc-id";
		},
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(
		{ registerTool: reg, tool: reg } as unknown as Parameters<
			typeof registerTools
		>[0],
		convex,
		seat(),
	);
	const call = (args: Record<string, unknown>) => {
		const h = handlers.get("add_repo_mapping");
		if (!h) throw new Error("add_repo_mapping not registered");
		return h(args);
	};
	const sent = () => calls.find((c) => c.kind === "mutation")?.args ?? {};
	return { call, sent };
}

const BASE = {
	repo: "acme-hr/payroll",
	orchestrator: "clio",
	project: "payroll",
	reviewer: "helios",
};

describe("add_repo_mapping forwards the agent IDs", () => {
	it("FORWARD: the three IDs are sent verbatim", async () => {
		const h = harness();
		const res = await h.call({
			...BASE,
			fallbackReviewer: "hermes",
			orchestratorAgentId: "agent-clio",
			reviewerAgentId: "agent-helios",
			fallbackReviewerAgentId: "agent-hermes",
		});
		expect(res.isError).toBeFalsy();
		expect(h.sent().orchestratorAgentId).toBe("agent-clio");
		expect(h.sent().reviewerAgentId).toBe("agent-helios");
		expect(h.sent().fallbackReviewerAgentId).toBe("agent-hermes");
	});

	it("ABSENT: no IDs given -> none of the three keys is sent", async () => {
		const h = harness();
		await h.call(BASE);
		expect(h.sent()).not.toHaveProperty("orchestratorAgentId");
		expect(h.sent()).not.toHaveProperty("reviewerAgentId");
		expect(h.sent()).not.toHaveProperty("fallbackReviewerAgentId");
	});
});
