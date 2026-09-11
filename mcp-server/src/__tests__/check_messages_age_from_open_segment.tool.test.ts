/**
 * mcp-server/src/__tests__/check_messages_age_from_open_segment.tool.test.ts
 *
 * Consumer test OUTSIDE convex/ that actually reaches the derivation.
 *
 * `age` is rendered to every station on every cycle, so it is a consumer
 * contract. The existing check_messages stuck reader test guards the
 * PASSTHROUGH — it mocks the Convex client, so a change to how `age` is
 * derived leaves it green by construction. This one runs the real Convex
 * functions through the real MCP tool handler, which is the only way a
 * change of derivation can redden a test outside convex/.
 *
 * The discriminating row is one that was paused and resumed: its first
 * start is hours old, its open segment is seconds old. The age a station
 * reads must be the segment's.
 */

import type { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "../../../convex/schema.js";
import { LOCAL_STDIO_TRUST_CTX } from "../auth.js";
import { registerTools } from "../tools.js";

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

type CapturedTool = {
	name: string;
	handler: (args: unknown) => Promise<unknown>;
};

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
	registerTools(fakeServer as never, convex, LOCAL_STDIO_TRUST_CTX);
	return captured;
}

async function callText(tool: CapturedTool, args: unknown): Promise<string> {
	const res = (await tool.handler(args)) as { content?: { text?: string }[] };
	return String(res?.content?.[0]?.text ?? JSON.stringify(res));
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function agesIn(text: string, block: string): number[] {
	const start = text.indexOf(`${block}:`);
	if (start < 0) return [];
	const rest = text.slice(start);
	const end = rest.indexOf("\n\n");
	const section = end < 0 ? rest : rest.slice(0, end);
	return [...section.matchAll(/"age":\s*(\d+)/g)].map((m) => Number(m[1]));
}

// Sibling of agesIn: reads the derived actionableStuckCount off the same
// block instead of the raw per-entry ages.
function actionableStuckCountIn(text: string, block: string): number | null {
	const start = text.indexOf(`${block}:`);
	if (start < 0) return null;
	const rest = text.slice(start);
	const end = rest.indexOf("\n\n");
	const section = end < 0 ? rest : rest.slice(0, end);
	const match = section.match(/"actionableStuckCount":\s*(\d+)/);
	return match ? Number(match[1]) : null;
}

describe("check_messages renders the age a station acts on", () => {
	let t: ReturnType<typeof convexTest>;
	let tools: Map<string, CapturedTool>;

	beforeAll(() => {
		t = convexTest(schema as never, modules as never).withIdentity({
			subject: "test-service-account-user-id",
		});
		tools = captureTools(makeFakeConvexClient(t));
	});

	it("a resumed task reaches the station with the OPEN segment's age, not the first start's", async () => {
		const now = Date.now();
		await t.run(async (ctx: never) => {
			await (ctx as unknown as { db: { insert: Function } }).db.insert(
				"tasks",
				{
					title: "paused, then resumed moments ago",
					assignedTo: "sigma",
					priority: "medium" as const,
					status: "in_progress" as const,
					startedAt: now - 3 * HOUR,
					createdBy: "pi",
					createdAt: now - 3 * HOUR,
					updatedAt: now - 3 * HOUR,
					workSegments: [
						{ start: now - 3 * HOUR, end: now - 3 * HOUR + 4 * MINUTE },
						{ start: now - 10 * 1000 },
					],
				},
			);
		});

		const text = await callText(tools.get("check_messages")!, {
			recipient: "sigma",
		});

		const ages = agesIn(text, "stuckInProgress");
		expect(ages).toHaveLength(1);
		// Minutes, never the three hours since the first start. Bracketed on
		// both sides: a lower bound alone would pass on any large number.
		expect(ages[0]).toBeLessThan(5 * MINUTE);
		expect(ages[0]).toBeGreaterThan(0);
	});
});

describe("check_messages renders actionableStuckCount at the threshold boundary", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a row exactly AT the configured threshold does not count; a row past it does", async () => {
		const threshold = 10 * MINUTE;
		const fixedNow = Date.UTC(2026, 0, 1, 0, 0, 0);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(fixedNow);

		const t = convexTest(schema as never, modules as never).withIdentity({
			subject: "test-service-account-user-id",
		});
		const tools = captureTools(makeFakeConvexClient(t));

		await t.run(async (ctx: never) => {
			const db = (ctx as unknown as { db: { insert: Function } }).db;
			// The threshold is DATA, never the built-in default.
			await db.insert("taskClosureConfig", {
				key: "stuckActionableThresholdMs",
				value: [String(threshold)],
				updatedAt: fixedNow,
			});
			// Under the inverted predicate (PR #1282) an OPEN trailing segment
			// never counts as actionable at any age -- `fromOpenSegment` alone
			// excludes it. So this boundary can no longer be demonstrated with
			// an open segment; both rows below carry NO open segment (no
			// workSegments at all), which puts `staleAge` on the
			// startedAt/_creationTime fallback path instead.
			await db.insert("tasks", {
				title: "no open segment, exactly at the threshold",
				assignedTo: "sigma",
				priority: "medium" as const,
				status: "in_progress" as const,
				startedAt: fixedNow - threshold,
				createdBy: "pi",
				createdAt: fixedNow - threshold,
				updatedAt: fixedNow - threshold,
			});
			// Bracket: a row strictly past the threshold, so a count that is
			// always 0 cannot pass this case vacuously.
			await db.insert("tasks", {
				title: "no open segment, one minute past the threshold",
				assignedTo: "sigma",
				priority: "medium" as const,
				status: "in_progress" as const,
				startedAt: fixedNow - threshold - MINUTE,
				createdBy: "pi",
				createdAt: fixedNow - threshold - MINUTE,
				updatedAt: fixedNow - threshold - MINUTE,
			});
		});

		const text = await callText(tools.get("check_messages")!, {
			recipient: "sigma",
		});

		// Two rows in the list either way; only the one strictly past the
		// threshold is actionable. `>` excludes exact equality.
		expect(agesIn(text, "stuckInProgress")).toHaveLength(2);
		expect(actionableStuckCountIn(text, "stuckInProgress")).toBe(1);
	});
});
