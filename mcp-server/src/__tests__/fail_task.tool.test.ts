/**
 * mcp-server/src/__tests__/fail_task.tool.test.ts
 *
 * T1 extension (Pi amendment) — VantagePeers mission
 * k576mw0smxeqsg9wp7957njfsn8crey4, task k174embwj7n7h2e1bm93attb218csffr;
 * PRD-evevantage-v1 §7.1. Consumer test OUTSIDE convex/ — exercises the
 * real `fail_task` MCP tool handler end-to-end (registerTools -> captured
 * handler -> real convex-test mutation), proving the FAILED terminal is
 * reachable and distinguishable from done/cancelled through the tool's own
 * JSON response, and that `update_task` refuses status="failed" at the
 * same MCP boundary a real client would call.
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

describe("fail_task MCP tool — the third terminal state, distinguishable from done/cancelled", () => {
	let t: ReturnType<typeof convexTest>;
	let tools: Map<string, CapturedTool>;

	beforeAll(() => {
		t = convexTest(schema as never, modules as never);
		tools = captureTools(makeFakeConvexClient(t));
	});

	it("fail_task returns status='failed', distinct from complete_task's 'done'", async () => {
		const failCreate = await callText(tools.get("create_task")!, {
			title: "will-fail",
			assignedTo: "sigma",
			createdBy: "sigma",
			priority: "medium",
			status: "todo",
		});
		const failTaskId = JSON.parse(failCreate).taskId;

		const doneCreate = await callText(tools.get("create_task")!, {
			title: "will-succeed",
			assignedTo: "sigma",
			createdBy: "sigma",
			priority: "medium",
			status: "todo",
		});
		const doneTaskId = JSON.parse(doneCreate).taskId;

		const failRes = await callText(tools.get("fail_task")!, {
			taskId: failTaskId,
			callerOrchestrator: "sigma",
			failureNote: "Migration errored on row 4102, rolled back cleanly.",
		});
		const doneRes = await callText(tools.get("complete_task")!, {
			taskId: doneTaskId,
			callerOrchestrator: "sigma",
			completionNote: "Shipped and smoke-tested.",
		});

		expect(JSON.parse(failRes).status).toBe("failed");
		expect(JSON.parse(doneRes).status).toBe("done");

		const failRead = await callText(tools.get("get_task")!, { taskId: failTaskId });
		expect(JSON.parse(failRead).status).toBe("failed");
		expect(JSON.parse(failRead).completionOutcome).toBe("failed");
	});

	it("update_task refuses status='failed' at the MCP boundary the same way it refuses 'blocked'", async () => {
		const createRes = await callText(tools.get("create_task")!, {
			title: "no-backdoor-to-failed",
			assignedTo: "sigma",
			createdBy: "sigma",
			priority: "low",
			status: "todo",
		});
		const taskId = JSON.parse(createRes).taskId;

		// The MCP tool schema itself excludes "failed" from updateTaskStatusSchema
		// (mcp-server/src/tools.ts) — calling the underlying Convex mutation
		// directly (bypassing the zod schema, as a malformed client could)
		// still gets refused server-side.
		const updateRes = await callText(tools.get("update_task")!, {
			taskId,
			callerOrchestrator: "sigma",
			status: "failed",
		});
		expect(updateRes).toMatch(/FAILED_VIA_UPDATE_REFUSED/);

		const read = await callText(tools.get("get_task")!, { taskId });
		expect(JSON.parse(read).status).toBe("todo");
	});
});
