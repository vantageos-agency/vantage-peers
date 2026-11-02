/// <reference types="vite/client" />
/**
 * The error monitor files a VantagePeers task for the backend owner, never a
 * GitHub issue, and the task carries no data.
 *
 * DEFECT: the repository is PUBLIC. `createGitHubIssue` POSTed the raw error
 * message and stack trace to it, and one body echoed a client name and internal
 * ids. Poles: one task / zero api.github.com calls; the body holds no argument
 * object, message or stack; a repeat on an OPEN task files nothing; a repeat on
 * a CLOSED task files a new one; AUTO_IRP_PAUSED files nothing.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const SENTINEL = "SENTINEL_CLIENT_ACME_k17zzzzzzzz";
const ERROR_MESSAGE = `ArgumentValidationError: Value does not match validator.\nPath: .clientName\nValue: "${SENTINEL}"\nValidator: v.string()`;
const STACK = `at handler (${SENTINEL})`;

type T = ReturnType<typeof convexTest>;

async function seedErrorLog(t: T): Promise<Id<"errorLogs">> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert("errorLogs", {
			hash: "hash-abc123",
			deployment: "prod",
			functionName: "recurringTasks:processDueTasks",
			errorMessage: ERROR_MESSAGE,
			stackTrace: STACK,
			firstSeen: now,
			lastSeen: now,
			count: 5,
			githubRepo: "vantageos-agency/vantage-peers",
			issueCreated: false,
		});
	});
}

function run(t: T, errorId: Id<"errorLogs">) {
	return t.action(internal.errorMonitorActions.createGitHubIssue, {
		errorId,
		githubRepo: "vantageos-agency/vantage-peers",
		functionName: "recurringTasks:processDueTasks",
		errorMessage: ERROR_MESSAGE,
		stackTrace: STACK,
		deployment: "prod",
		orchestrator: "sigma",
	});
}

const allTasks = (t: T) => t.run(async (ctx) => ctx.db.query("tasks").collect());

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	process.env.GITHUB_TOKEN = "test-token";
	delete process.env.AUTO_IRP_PAUSED;
	fetchMock = vi.fn().mockResolvedValue({
		ok: false,
		status: 404,
		json: async () => ({}),
		text: async () => "",
	});
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.GITHUB_TOKEN;
	delete process.env.AUTO_IRP_PAUSED;
});

describe("error monitor -> VantagePeers task (no GitHub)", () => {
	test("an error creates ONE task for sigma in vantage-peers and makes NO call to api.github.com", async () => {
		const t = convexTest(schema, modules);
		const errorId = await seedErrorLog(t);
		await run(t, errorId);

		const tasks = await allTasks(t);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].assignedTo).toBe("sigma");
		expect(tasks[0].project).toBe("vantage-peers");
		expect(tasks[0].title).toContain("recurringTasks:processDueTasks");
		expect(tasks[0].description ?? "").toContain("ArgumentValidationError");
		const githubCalls = fetchMock.mock.calls.filter(([u]) =>
			String(u).includes("api.github.com"),
		);
		expect(githubCalls).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("the task carries no argument object, no message, no stack", async () => {
		const t = convexTest(schema, modules);
		const errorId = await seedErrorLog(t);
		await run(t, errorId);

		const [task] = await allTasks(t);
		const everything = JSON.stringify(task);
		expect(everything).not.toContain(SENTINEL);
		expect(everything).not.toContain("clientName");
		expect(everything).not.toContain("Value:");
		expect(everything).not.toContain("Path:");
	});

	test("repeat while the task is OPEN files nothing; once it is DONE a new one is filed", async () => {
		const t = convexTest(schema, modules);
		const errorId = await seedErrorLog(t);
		await run(t, errorId);
		await run(t, errorId);
		expect(await allTasks(t)).toHaveLength(1);

		await t.run(async (ctx) => {
			const [task] = await ctx.db.query("tasks").collect();
			await ctx.db.patch(task._id, { status: "done" });
		});
		await run(t, errorId);
		expect(await allTasks(t)).toHaveLength(2);
	});

	test("AUTO_IRP_PAUSED=true files nothing", async () => {
		process.env.AUTO_IRP_PAUSED = "true";
		const t = convexTest(schema, modules);
		const errorId = await seedErrorLog(t);
		await run(t, errorId);
		expect(await allTasks(t)).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
