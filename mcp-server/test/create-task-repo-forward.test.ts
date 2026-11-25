/**
 * Routing S2 (task k1730d1b6wzwepjyyth266xq958jxfv0): create_task carries the
 * optional `repo` ("owner/name") to tasks:create verbatim, so an organisation that
 * adopted explicit review routing can have the assignment judged against its route.
 *
 *   FORWARD   `repo` given -> sent unchanged to tasks:create
 *   ABSENT    no `repo` -> no `repo` key sent (the call is byte-identical to before)
 *   REFUSAL   a backend refusal reaches the caller as an error naming its code
 *   CONTRACT  the new argument to an existing function bumped the contract to >= 31
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
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

function harness(refuse?: string) {
	const handlers = new Map<string, Handler>();
	const shapes = new Map<string, z.ZodTypeAny>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		const config = a[1] as { inputSchema?: z.ZodTypeAny } | undefined;
		if (config?.inputSchema) shapes.set(a[0] as string, config.inputSchema);
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
			if (refuse !== undefined) throw new Error(refuse);
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
		const h = handlers.get("create_task");
		if (!h) throw new Error("create_task not registered");
		return h(args);
	};
	const to = (name: string) =>
		calls.filter((c) => c.kind !== "query" && c.name === name);
	return { call, to, shapes };
}

const BASE = {
	project: "test-project",
	title: "t",
	assignedTo: "clio",
	priority: "low",
	status: "todo",
	createdBy: "clio",
};

describe("create_task forwards `repo`", () => {
	it("FORWARD: repo is sent verbatim to tasks:create", async () => {
		const h = harness();
		const res = await h.call({ ...BASE, repo: "acme-hr/payroll" });
		expect(res.isError).toBeFalsy();
		expect(h.to("tasks:create")[0]?.args.repo).toBe("acme-hr/payroll");
	});

	it("ABSENT: no repo given -> no repo key sent", async () => {
		const h = harness();
		await h.call(BASE);
		expect(h.to("tasks:create")[0]?.args).not.toHaveProperty("repo");
	});

	it("REFUSAL: a routing refusal reaches the caller as an error naming its code", async () => {
		const h = harness(
			'RBAC_DENIED: tasks:create — repo "acme-hr/payroll" is routed to owner "helios" — {"reason":"repo-routed-to-other-owner","owner":"helios"}',
		);
		const res = await h.call({ ...BASE, repo: "acme-hr/payroll" });
		expect(res.isError).toBe(true);
		expect(res.content[0]?.text).toContain("RBAC_DENIED");
		expect(res.content[0]?.text).toContain("helios");
	});
});

describe("CONTRACT", () => {
	it("the new argument bumped the contract: MCP requires >= 31, Convex serves the same", () => {
		expect(REQUIRED_CONTRACT_VERSION).toBeGreaterThanOrEqual(31);
		expect(BACKEND_CONTRACT_VERSION).toBe(REQUIRED_CONTRACT_VERSION);
	});
});
