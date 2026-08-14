/**
 * mcp-server/src/__tests__/update-task-mcp-optional-caller-still-refused.test.ts
 *
 * Task k174pncsyc3ch7wmm7r0zp3ac58b2nye — coordinator arbitration (2026-07-23):
 * `callerOrchestrator` is the creator/assignee control BETWEEN fleet
 * orchestrators, a thin layer inside a tenant — not the tenant-isolation
 * boundary. It stays `.optional()` at the MCP tool schema (external callers
 * have no orchestrator role to put there), and the six task tools + guardFrom
 * calls revert to their original conditional form.
 *
 * What must NOT regress: with the field optional again at the MCP boundary,
 * a call that omits it is still REFUSED — by convex/tasks.ts, which derives
 * authorization from the TARGET row regardless of what the MCP schema
 * requires. This test exercises the real MCP tool handler end-to-end
 * (registerTools → captured handler → real convex-test mutation), not just
 * the underlying convex mutation directly, so a regression at either layer
 * would show here.
 */

import type { ConvexHttpClient } from "convex/browser";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { beforeAll, describe, expect, it } from "vitest";
import { registerTools } from "../tools.js";
import schema from "../../../convex/schema.js";

const modules = Object.fromEntries(
	Object.entries(
		import.meta.glob<Record<string, unknown>>("../../../convex/**/*.ts"),
	).filter(([path]) => !path.includes("ragSync") && !path.includes("backfill")),
);

function resolveRef(dotted: string) {
	const [mod, fn] = dotted.split(":");
	return (anyApi as Record<string, Record<string, unknown>>)[mod][fn];
}

function makeFakeConvexClient(
	t: ReturnType<typeof convexTest>,
): ConvexHttpClient {
	return {
		query: (name: string, args: unknown) =>
			t.query(resolveRef(name) as never, args as never),
		mutation: (name: string, args: unknown) =>
			t.mutation(resolveRef(name) as never, args as never),
		action: (name: string, args: unknown) =>
			t.action(resolveRef(name) as never, args as never),
	} as unknown as ConvexHttpClient;
}

type CapturedTool = { name: string; handler: (args: unknown) => Promise<unknown> };

function captureTools(convex: ConvexHttpClient): Map<string, CapturedTool> {
	const captured = new Map<string, CapturedTool>();
	const fakeServer = {
		tool: (...allArgs: unknown[]) => {
			const name = allArgs[0] as string;
			const handler = allArgs[allArgs.length - 1] as (
				args: unknown,
			) => Promise<unknown>;
			captured.set(name, { name, handler });
		},
		registerTool: (...allArgs: unknown[]) => {
			const name = allArgs[0] as string;
			const handler = allArgs[allArgs.length - 1] as (
				args: unknown,
			) => Promise<unknown>;
			captured.set(name, { name, handler });
		},
	};
	registerTools(fakeServer as never, convex, undefined);
	return captured;
}

async function callText(tool: CapturedTool, args: unknown): Promise<string> {
	const res = (await tool.handler(args)) as { content?: { text?: string }[] };
	return String(res?.content?.[0]?.text ?? JSON.stringify(res));
}

describe("update_task MCP tool — callerOrchestrator optional at the schema, still refused by Convex when omitted", () => {
	let t: ReturnType<typeof convexTest>;
	let tools: Map<string, CapturedTool>;

	beforeAll(() => {
		t = convexTest(schema as never, modules as never);
		tools = captureTools(makeFakeConvexClient(t));
	});

	it("omitting callerOrchestrator does not mutate the task — Convex refuses it", async () => {
		const createRes = await callText(tools.get("create_task")!, {
			title: "owner-task",
			assignedTo: "alpha",
			createdBy: "alpha",
			priority: "low",
			status: "todo",
		});
		const taskId = JSON.parse(createRes).taskId;
		expect(taskId).toBeTruthy();

		// No callerOrchestrator — schema allows the omission (optional), the
		// MCP layer forwards no guardFrom check, but Convex must still refuse.
		const updateRes = await callText(tools.get("update_task")!, {
			taskId,
			title: "MUTATED-WITHOUT-CALLER",
		});
		expect(updateRes).toMatch(/RBAC_DENIED/);

		const after = await callText(tools.get("get_task")!, { taskId });
		expect(after).not.toContain("MUTATED-WITHOUT-CALLER");
		expect(after).toContain("owner-task");
	});

	it("second assertion — supplying the owning caller still succeeds", async () => {
		const createRes = await callText(tools.get("create_task")!, {
			title: "owner-task-2",
			assignedTo: "alpha",
			createdBy: "alpha",
			priority: "low",
			status: "todo",
		});
		const taskId = JSON.parse(createRes).taskId;

		const updateRes = await callText(tools.get("update_task")!, {
			taskId,
			callerOrchestrator: "alpha",
			title: "UPDATED-BY-OWNER",
		});
		expect(updateRes).not.toMatch(/RBAC_DENIED/);

		const after = await callText(tools.get("get_task")!, { taskId });
		expect(after).toContain("UPDATED-BY-OWNER");
	});
});
