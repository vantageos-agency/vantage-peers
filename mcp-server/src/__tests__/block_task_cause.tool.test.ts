/**
 * mcp-server/src/__tests__/block_task_cause.tool.test.ts
 *
 * T1 (VantagePeers mission k576mw0smxeqsg9wp7957njfsn8crey4, task
 * k174embwj7n7h2e1bm93attb218csffr; PRD-evevantage-v1 §7.1, FR-10/FR-12).
 * Consumer test OUTSIDE convex/ — exercises the real `block_task` MCP tool
 * handler end-to-end (registerTools -> captured handler -> real convex-test
 * mutation), proving the `blockedCause` discriminator round-trips through
 * the MCP boundary and that a human-cause block is distinguishable from an
 * authorisation-cause block from the tool's own JSON response, not just the
 * underlying Convex mutation directly.
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

describe("block_task MCP tool — blockedCause round-trips, human vs authorisation distinguishable", () => {
	let t: ReturnType<typeof convexTest>;
	let tools: Map<string, CapturedTool>;

	beforeAll(() => {
		t = convexTest(schema as never, modules as never).withIdentity({ subject: "test-service-account-user-id" });
		tools = captureTools(makeFakeConvexClient(t));
	});

	it("blockedCause='human' and blockedCause='authorisation' produce distinguishable tool output", async () => {
		const humanTaskRes = await callText(tools.get("create_task")!, {
			title: "waiting-on-human",
			assignedTo: "sigma",
			createdBy: "sigma",
			priority: "medium",
			status: "todo",
		});
		const humanTaskId = JSON.parse(humanTaskRes).taskId;

		const authTaskRes = await callText(tools.get("create_task")!, {
			title: "waiting-on-authorisation",
			assignedTo: "sigma",
			createdBy: "sigma",
			priority: "medium",
			status: "todo",
		});
		const authTaskId = JSON.parse(authTaskRes).taskId;

		const humanBlockRes = await callText(tools.get("block_task")!, {
			taskId: humanTaskId,
			callerOrchestrator: "sigma",
			blockedCause: "human",
			reason: "# blocked-on-nobody: waiting on Laurent's decision",
		});
		const authBlockRes = await callText(tools.get("block_task")!, {
			taskId: authTaskId,
			callerOrchestrator: "sigma",
			blockedCause: "authorisation",
			reason: "# blocked-on-nobody: waiting on Pi's merge token",
		});

		expect(JSON.parse(humanBlockRes).blockedCause).toBe("human");
		expect(JSON.parse(authBlockRes).blockedCause).toBe("authorisation");
		expect(JSON.parse(humanBlockRes).blockedCause).not.toBe(
			JSON.parse(authBlockRes).blockedCause,
		);

		const humanRead = await callText(tools.get("get_task")!, { taskId: humanTaskId });
		const authRead = await callText(tools.get("get_task")!, { taskId: authTaskId });
		expect(JSON.parse(humanRead).blockedCause).toBe("human");
		expect(JSON.parse(authRead).blockedCause).toBe("authorisation");
	});

	it("omitting blockedCause at the MCP boundary still succeeds and defaults to 'other' server-side", async () => {
		const createRes = await callText(tools.get("create_task")!, {
			title: "old-caller-no-blockedCause",
			assignedTo: "sigma",
			createdBy: "sigma",
			priority: "low",
			status: "todo",
		});
		const taskId = JSON.parse(createRes).taskId;

		const blockRes = await callText(tools.get("block_task")!, {
			taskId,
			callerOrchestrator: "sigma",
			reason: "# blocked-on-nobody: pre-existing caller shape, no blockedCause arg",
		});
		expect(JSON.parse(blockRes).blockedCause).toBe("other");

		const read = await callText(tools.get("get_task")!, { taskId });
		expect(JSON.parse(read).blockedCause).toBe("other");
	});
});
