/**
 * add_task_dependency (task k171180dv49sn33fw83dpkzs158hd7vr): the tool sends the
 * ids as `addDependsOn` (APPEND) and never as `dependsOn` (REPLACE) to
 * tasks:update, and reports the list the row holds afterwards.
 *
 *   APPEND     the mutation carries addDependsOn and NO dependsOn key
 *   REPORT     the tool's answer is the stored list read back, not the input
 *   REPLACE    update_task keeps sending dependsOn (the explicit replace path)
 *   CONTRACT   MCP requires 14, Convex serves 14
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
type Call = { name: string; args: Record<string, unknown> };

const TASK = "k171qx2jhx49xdvak3rtfmeb718hcj45";
const A = "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "k17bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "k17cccccccccccccccccccccccccccccc";

function master(): OAuthContext {
	return {
		clientId: "master",
		userId: "master",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: true,
	} as OAuthContext;
}

function harness(stored: string[]) {
	const handlers = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const calls: Call[] = [];
	const convex = {
		query: async (name: string) =>
			name === "tasks:getById" ? { _id: TASK, dependsOn: stored } : [],
		mutation: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			return null;
		},
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(
		{ registerTool: reg, tool: reg } as unknown as Parameters<typeof registerTools>[0],
		convex,
		master(),
	);
	return { handlers, calls };
}

describe("add_task_dependency", () => {
	it("APPEND + REPORT: sends addDependsOn (no dependsOn) and reports the stored list", async () => {
		const h = harness([A, B, C]);
		const res = await h.handlers.get("add_task_dependency")?.({
			taskId: TASK,
			dependsOn: [B, C],
			callerOrchestrator: "sigma",
		});
		expect(res?.isError, res?.content[0]?.text).not.toBe(true);
		expect(h.calls.map((c) => c.name)).toEqual(["tasks:update"]);
		expect(h.calls[0]?.args.addDependsOn).toEqual([B, C]);
		expect("dependsOn" in (h.calls[0]?.args ?? {})).toBe(false);
		expect(JSON.parse(res?.content[0]?.text ?? "{}")).toEqual({
			taskId: TASK,
			dependsOn: [A, B, C],
			updated: true,
		});
	});

	it("REPLACE: update_task still sends dependsOn, never addDependsOn", async () => {
		const h = harness([B]);
		await h.handlers.get("update_task")?.({
			taskId: TASK,
			dependsOn: [B],
			callerOrchestrator: "sigma",
		});
		const args = h.calls.find((c) => c.name === "tasks:update")?.args ?? {};
		expect(args.dependsOn).toEqual([B]);
		expect("addDependsOn" in args).toBe(false);
	});

	it("CONTRACT: the new argument bumped the contract on both sides", () => {
		expect(REQUIRED_CONTRACT_VERSION).toBe(14);
		expect(BACKEND_CONTRACT_VERSION).toBe(14);
	});
});
