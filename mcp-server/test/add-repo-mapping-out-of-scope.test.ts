/**
 * Out-of-scope repos (task k179tb3srh93pkqk0hwanxkqax8jw8xf): add_repo_mapping carries
 * `outOfScope: { reason }` to the Convex door and accepts it with no orchestrator.
 *
 *   FORWARD   outOfScope is sent verbatim; no orchestrator key is sent
 *   ABSENT    no outOfScope -> no outOfScope key (the call is as before)
 *   REFUSE    a routed call with no orchestrator, and an out-of-scope call that also names an
 *             orchestrator, are refused at the tool schema before any backend call
 *   CONTRACT  the new argument to an existing function bumped the contract to >= 33
 */
import { describe, expect, it } from "vitest";
import { BACKEND_CONTRACT_VERSION } from "../../convex/lib/backendManifest";
import type { OAuthContext } from "../src/auth.js";
import { REQUIRED_CONTRACT_VERSION } from "../src/backendContract";
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
	const mutations = () => calls.filter((c) => c.kind === "mutation").length;
	return { call, sent, mutations };
}

const REASON = "no owning station, no activity in 30 days";

describe("add_repo_mapping records an out-of-scope repo", () => {
	it("FORWARD: outOfScope is sent verbatim and no orchestrator is sent", async () => {
		const h = harness();
		const res = await h.call({
			repo: "acme-hr/old",
			project: "payroll",
			outOfScope: { reason: REASON },
		});
		expect(res.isError, res.content[0]?.text).toBeFalsy();
		expect(h.sent().outOfScope).toEqual({ reason: REASON });
		expect(h.sent()).not.toHaveProperty("orchestrator");
	});

	it("ABSENT: a routed call sends no outOfScope key", async () => {
		const h = harness();
		await h.call({
			repo: "acme-hr/payroll",
			orchestrator: "clio",
			project: "payroll",
		});
		expect(h.sent()).not.toHaveProperty("outOfScope");
		expect(h.sent().orchestrator).toBe("clio");
	});

	it("REFUSE: a routed call with no orchestrator never reaches the backend", async () => {
		const h = harness();
		const res = await h.call({ repo: "acme-hr/payroll", project: "payroll" });
		expect(res.isError).toBe(true);
		expect(h.mutations()).toBe(0);
	});

	it("REFUSE: outOfScope beside an orchestrator never reaches the backend", async () => {
		const h = harness();
		const res = await h.call({
			repo: "acme-hr/old",
			orchestrator: "clio",
			project: "payroll",
			outOfScope: { reason: REASON },
		});
		expect(res.isError).toBe(true);
		expect(h.mutations()).toBe(0);
	});
});

describe("CONTRACT", () => {
	it("the new argument bumped the contract: MCP requires >= 33, Convex serves the same", () => {
		expect(REQUIRED_CONTRACT_VERSION).toBeGreaterThanOrEqual(33);
		expect(BACKEND_CONTRACT_VERSION).toBe(REQUIRED_CONTRACT_VERSION);
	});
});
