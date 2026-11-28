/// <reference types="vite/client" />
/**
 * errorMonitorLoudFailure -- every silent stop path of the error-monitor loop
 * leaves a durable, queryable record AND a console.error with a stable code.
 *
 * Operator ruling (2026-11-28, via Pi): the monitor is corrected, never
 * paused; a path that stops the loop without a record is the defect. The
 * record never carries a secret value or a value taken from the logs.
 *
 * One pole per path. `listMonitorHealth` is the durable read.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

const DEP = "prod-logs";
const SECRET = "SECRET-DEPLOY-KEY-VALUE-9f8e7d";
const LOG_VALUE = "LOG-VALUE-marie.curie@laboratoire-curie.fr";
const REPO = "vantageos-agency/vantage-peers";

type Resp = {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
	text: () => Promise<string>;
};
const resp = (ok: boolean, status: number, body: unknown = {}): Resp => ({
	ok,
	status,
	json: async () => body,
	text: async () => JSON.stringify(body),
});

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	process.env.TEST_DEPLOY_KEY = SECRET;
	process.env.GITHUB_TOKEN = "ghp_TESTTOKENVALUE";
	delete process.env.AUTO_IRP_PAUSED;
	delete process.env.DEPLOY_WINDOW_UNTIL_MS;
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete process.env.TEST_DEPLOY_KEY;
	delete process.env.GITHUB_TOKEN;
	delete process.env.AUTO_IRP_PAUSED;
	delete process.env.DEPLOY_WINDOW_UNTIL_MS;
});

const poll = (t: ReturnType<typeof convexTest>, env = "TEST_DEPLOY_KEY") =>
	t.action(internal.errorMonitorActions.pollDeploymentLogs, {
		deploymentName: DEP,
		deploymentUrl: "https://example.convex.cloud",
		deployKeyEnvVar: env,
		githubRepo: REPO,
		orchestrator: "sigma",
	});

async function health(t: ReturnType<typeof convexTest>) {
	return await t.query(internal.errorMonitor.listMonitorHealth, {});
}

function expectLoud(
	h: Awaited<ReturnType<typeof health>>,
	code: string,
	stage: string,
) {
	const row = h.failures.find((f) => f.code === code);
	expect(row, `no durable record for ${code}`).toBeDefined();
	expect(row?.stage).toBe(stage);
	expect(row?.deployment).toBe(DEP);
	expect(row?.count).toBeGreaterThanOrEqual(1);
	const logged = errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" "));
	expect(logged.some((l: string) => l.includes(code))).toBe(true);
}

function expectNoLeak(h: Awaited<ReturnType<typeof health>>) {
	const everything =
		JSON.stringify(h) +
		errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");
	expect(everything).not.toContain(SECRET);
	expect(everything).not.toContain(LOG_VALUE);
	expect(everything).not.toContain("ghp_TESTTOKENVALUE");
}

describe("pollDeploymentLogs -- silent stop paths", () => {
	test("deploy key env var missing", async () => {
		const t = convexTest(schema, modules);
		await poll(t, "NO_SUCH_ENV_VAR");
		const h = await health(t);
		expectLoud(h, "DEPLOY_KEY_MISSING", "poll:deploy-key");
		expectNoLeak(h);
	});

	test("log fetch answers non-2xx", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resp(false, 503)));
		const t = convexTest(schema, modules);
		await poll(t);
		expectLoud(await health(t), "LOG_FETCH_HTTP_503", "poll:fetch");
	});

	test("log fetch throws; the thrown message is not recorded", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error(`boom ${SECRET} ${LOG_VALUE}`)),
		);
		const t = convexTest(schema, modules);
		await poll(t);
		const h = await health(t);
		expectLoud(h, "LOG_FETCH_THROWN", "poll:fetch");
		expectNoLeak(h);
	});

	test("log body is not JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				...resp(true, 200),
				json: async () => {
					throw new SyntaxError(`Unexpected token ${LOG_VALUE}`);
				},
			}),
		);
		const t = convexTest(schema, modules);
		await poll(t);
		const h = await health(t);
		expectLoud(h, "LOG_PARSE_FAILED", "poll:parse");
		expectNoLeak(h);
	});

	test("entries is not an array", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(resp(true, 200, { entries: "nope", newCursor: 1 })),
		);
		const t = convexTest(schema, modules);
		await poll(t);
		expectLoud(await health(t), "LOG_SHAPE_INVALID", "poll:parse");
	});

	test("newCursor missing: cursor cannot advance", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(resp(true, 200, { entries: [] })),
		);
		const t = convexTest(schema, modules);
		await poll(t);
		expectLoud(await health(t), "CURSOR_MISSING", "poll:cursor");
	});

	test("newCursor is not a number", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(resp(true, 200, { entries: [], newCursor: "x" })),
		);
		const t = convexTest(schema, modules);
		await poll(t);
		expectLoud(await health(t), "CURSOR_INVALID", "poll:cursor");
	});

	test("processing a malformed entry throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				resp(true, 200, {
					entries: [{ kind: "Completion", identifier: "a:b", error: 12345 }],
					newCursor: 5,
				}),
			),
		);
		const t = convexTest(schema, modules);
		await poll(t);
		expectLoud(await health(t), "POLL_PROCESSING_FAILED", "poll:process");
	});

	test("deploy window drops an escalating error: recorded, not silent", async () => {
		process.env.DEPLOY_WINDOW_UNTIL_MS = String(Date.now() + 3_600_000);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				resp(true, 200, {
					entries: [
						{
							kind: "Completion",
							identifier: "zzmod:fn",
							error: "Uncaught Error: something broke",
							logLines: [],
						},
					],
					newCursor: 9,
				}),
			),
		);
		const t = convexTest(schema, modules);
		await poll(t);
		expectLoud(await health(t), "DEPLOY_WINDOW_SUPPRESSED", "poll:deploy-window");
	});

	test("a clean poll records a recovery marker and no failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(resp(true, 200, { entries: [], newCursor: 3 })),
		);
		const t = convexTest(schema, modules);
		await poll(t);
		const h = await health(t);
		expect(h.failures).toEqual([]);
		expect(h.pollOk.map((p) => p.deployment)).toEqual([DEP]);
	});

	test("a repeated failure increments the count on the same row", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resp(false, 500)));
		const t = convexTest(schema, modules);
		await poll(t);
		await poll(t);
		const h = await health(t);
		expect(h.failures).toHaveLength(1);
		expect(h.failures[0].count).toBe(2);
	});
});

describe("pollAllDeployments -- silent stop paths", () => {
	const seed = async (t: ReturnType<typeof convexTest>, n: number) => {
		await t.run(async (ctx) => {
			for (let i = 0; i < n; i++) {
				await ctx.db.insert("monitoredDeployments", {
					name: `dep-${String(i).padStart(3, "0")}`,
					deploymentUrl: "https://example.convex.cloud",
					deployKeyEnvVar: "NO_SUCH_ENV_VAR",
					githubRepo: REPO,
					orchestrator: "sigma",
					active: true,
					createdAt: Date.now(),
				});
			}
		});
	};

	test("kill switch active: recorded on every active deployment", async () => {
		process.env.AUTO_IRP_PAUSED = "true";
		const t = convexTest(schema, modules);
		await seed(t, 2);
		await t.action(internal.errorMonitorActions.pollAllDeployments, {});
		const h = await health(t);
		const hits = h.failures.filter((f) => f.code === "KILL_SWITCH_ACTIVE");
		expect(hits.map((f) => f.deployment).sort()).toEqual(["dep-000", "dep-001"]);
		const logged = errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" "));
		expect(logged.some((l: string) => l.includes("KILL_SWITCH_ACTIVE"))).toBe(true);
	});

	test("more active deployments than the poll cap: the overflow is recorded", async () => {
		const t = convexTest(schema, modules);
		await seed(t, 51);
		await t.action(internal.errorMonitorActions.pollAllDeployments, {});
		const h = await health(t);
		const hits = h.failures.filter((f) => f.code === "DEPLOY_POLL_CAP_EXCEEDED");
		expect(hits).toHaveLength(1);
		expect(hits[0].stage).toBe("poll:cap");
	});
});

describe("createGitHubIssue -- silent stop paths", () => {
	const insertLog = async (t: ReturnType<typeof convexTest>, extra = {}) =>
		await t.run(async (ctx) =>
			ctx.db.insert("errorLogs", {
				hash: "h1",
				deployment: DEP,
				functionName: "rooms:join",
				errorMessage: "Uncaught Error: x",
				firstSeen: 1,
				lastSeen: 2,
				count: 3,
				...extra,
			}),
		);

	const run = (
		t: ReturnType<typeof convexTest>,
		errorId: Id<"errorLogs">,
		githubRepo = REPO,
	) =>
		t.action(internal.errorMonitorActions.createGitHubIssue, {
			errorId,
			githubRepo,
			functionName: "rooms:join",
			errorMessage: `Uncaught Error: ${LOG_VALUE}`,
			stackTrace: "",
			deployment: DEP,
			orchestrator: "sigma",
		});

	test("GITHUB_TOKEN missing", async () => {
		delete process.env.GITHUB_TOKEN;
		const t = convexTest(schema, modules);
		const id = await insertLog(t);
		await run(t, id);
		expectLoud(await health(t), "GITHUB_TOKEN_MISSING", "issue:token");
	});

	test("githubRepo malformed", async () => {
		const t = convexTest(schema, modules);
		const id = await insertLog(t);
		await run(t, id, "not-a-repo");
		expectLoud(await health(t), "GITHUB_REPO_INVALID", "issue:repo");
	});

	test("kill switch active at the issue layer", async () => {
		process.env.AUTO_IRP_PAUSED = "true";
		const t = convexTest(schema, modules);
		const id = await insertLog(t);
		await run(t, id);
		expectLoud(await health(t), "KILL_SWITCH_ACTIVE", "issue:kill-switch");
	});

	test("the errorLogs row is missing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(resp(true, 201, { number: 5 })),
		);
		const t = convexTest(schema, modules);
		const id = await insertLog(t);
		await t.run(async (ctx) => ctx.db.delete(id));
		await run(t, id);
		const h = await health(t);
		expectLoud(h, "ERRORLOG_ROW_MISSING", "issue:row");
		expectLoud(h, "ISSUE_LINK_FAILED", "issue:link");
	});

	test("open-check fails: files a new issue AND records the failure", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
				calls.push(`${init?.method ?? "GET"} ${url}`);
				if (!init?.method) return resp(false, 502);
				return resp(true, 201, { number: 77 });
			}),
		);
		const t = convexTest(schema, modules);
		const id = await insertLog(t, { issueNumber: 10, issueCreated: true });
		await run(t, id);
		expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/issues"))).toBe(true);
		expectLoud(await health(t), "ISSUE_OPEN_CHECK_FAILED", "issue:open-check");
	});

	test("comment on the open issue fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
				if (!init?.method) return resp(true, 200, { state: "open" });
				if (url.endsWith("/comments")) return resp(false, 403);
				return resp(true, 201, { number: 78 });
			}),
		);
		const t = convexTest(schema, modules);
		const id = await insertLog(t, { issueNumber: 10, issueCreated: true });
		await run(t, id);
		expectLoud(await health(t), "ISSUE_COMMENT_FAILED", "issue:comment");
	});

	test("issue creation answers non-2xx", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resp(false, 422, { message: LOG_VALUE })));
		const t = convexTest(schema, modules);
		const id = await insertLog(t);
		await run(t, id);
		const h = await health(t);
		expectLoud(h, "ISSUE_CREATE_HTTP_422", "issue:create");
		expectNoLeak(h);
	});

	test("issue creation fetch throws", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`net ${LOG_VALUE}`)));
		const t = convexTest(schema, modules);
		const id = await insertLog(t);
		await run(t, id);
		const h = await health(t);
		expectLoud(h, "ISSUE_CREATE_THROWN", "issue:create");
		expectNoLeak(h);
	});

	test("issue creation succeeds but the number is missing", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resp(true, 201, {})));
		const t = convexTest(schema, modules);
		const id = await insertLog(t);
		await run(t, id);
		expectLoud(await health(t), "ISSUE_NUMBER_MISSING", "issue:create");
	});

	test("issue creation succeeds but the body is not JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				...resp(true, 201),
				json: async () => {
					throw new SyntaxError("bad");
				},
			}),
		);
		const t = convexTest(schema, modules);
		const id = await insertLog(t);
		await run(t, id);
		expectLoud(await health(t), "ISSUE_RESPONSE_PARSE_FAILED", "issue:create");
	});

	test("a successful creation records no failure and posts a shape-only body", async () => {
		const posted: Array<{ title: string; body: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (_u: string, init?: RequestInit) => {
				posted.push(JSON.parse(String(init?.body)));
				return resp(true, 201, { number: 91 });
			}),
		);
		const t = convexTest(schema, modules);
		const id = await insertLog(t);
		await run(t, id);
		expect((await health(t)).failures).toEqual([]);
		expect(posted).toHaveLength(1);
		expect(`${posted[0].title}\n${posted[0].body}`).not.toContain(LOG_VALUE);
		expect(posted[0].body).toContain("Uncaught Error");
	});
});

describe("autoResolveStaleIrp -- silent stop paths", () => {
	const seedStale = async (
		t: ReturnType<typeof convexTest>,
		extra: Record<string, unknown> = {},
	) =>
		await t.run(async (ctx) => {
			const missionId = await ctx.db.insert("missions", {
				name: "[Auto] irp",
				project: "p",
				status: "execute",
				priority: "medium",
				pilot: "sigma",
				agents: [],
				createdBy: "sigma",
				createdAt: 1,
				updatedAt: 1,
			});
			const errorId = await ctx.db.insert("errorLogs", {
				hash: "stale1",
				deployment: DEP,
				functionName: "rooms:join",
				errorMessage: "Uncaught Error: x",
				firstSeen: 1,
				lastSeen: 2,
				count: 4,
				issueNumber: 12,
				githubRepo: REPO,
				issueCreated: true,
				irpMissionId: missionId,
				...extra,
			});
			return { missionId, errorId };
		});

	const missionStatus = async (
		t: ReturnType<typeof convexTest>,
		id: Id<"missions">,
	) => (await t.run(async (ctx) => ctx.db.get(id)))?.status;

	const ghMock = (o: { timeline?: Resp; comment?: Resp; patch?: Resp }) =>
		vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/timeline")) return o.timeline ?? resp(true, 200, []);
			if (url.endsWith("/comments")) return o.comment ?? resp(true, 201);
			if (init?.method === "PATCH") return o.patch ?? resp(true, 200);
			return resp(true, 200);
		});

	test("GITHUB_TOKEN missing: nothing is closed, the stop is recorded", async () => {
		delete process.env.GITHUB_TOKEN;
		const t = convexTest(schema, modules);
		const { missionId } = await seedStale(t);
		await t.action(internal.errorMonitorAutoResolver.autoResolveStaleIrp, {});
		expect(await missionStatus(t, missionId)).toBe("execute");
		expectLoud(await health(t), "GITHUB_TOKEN_MISSING", "resolve:token");
	});

	test("timeline check fails: unknown is not 'no PR'; nothing is closed", async () => {
		vi.stubGlobal("fetch", ghMock({ timeline: resp(false, 500) }));
		const t = convexTest(schema, modules);
		const { missionId } = await seedStale(t);
		await t.action(internal.errorMonitorAutoResolver.autoResolveStaleIrp, {});
		expect(await missionStatus(t, missionId)).toBe("execute");
		expectLoud(await health(t), "PR_CHECK_FAILED", "resolve:pr-check");
	});

	test("issue close: comment non-2xx", async () => {
		vi.stubGlobal("fetch", ghMock({ comment: resp(false, 403) }));
		const t = convexTest(schema, modules);
		await seedStale(t);
		await t.action(internal.errorMonitorAutoResolver.autoResolveStaleIrp, {});
		expectLoud(await health(t), "ISSUE_CLOSE_COMMENT_FAILED", "resolve:close");
	});

	test("issue close: state patch non-2xx", async () => {
		vi.stubGlobal("fetch", ghMock({ patch: resp(false, 422) }));
		const t = convexTest(schema, modules);
		await seedStale(t);
		await t.action(internal.errorMonitorAutoResolver.autoResolveStaleIrp, {});
		expectLoud(await health(t), "ISSUE_CLOSE_STATE_FAILED", "resolve:close");
	});

	test("issue close: fetch throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string) => {
				if (url.endsWith("/timeline")) return resp(true, 200, []);
				throw new Error(`net ${LOG_VALUE}`);
			}),
		);
		const t = convexTest(schema, modules);
		await seedStale(t);
		await t.action(internal.errorMonitorAutoResolver.autoResolveStaleIrp, {});
		const h = await health(t);
		expectLoud(h, "ISSUE_CLOSE_THROWN", "resolve:close");
		expectNoLeak(h);
	});

	test("issue close: githubRepo malformed", async () => {
		vi.stubGlobal("fetch", ghMock({}));
		const t = convexTest(schema, modules);
		await seedStale(t, { githubRepo: "bad" });
		await t.action(internal.errorMonitorAutoResolver.autoResolveStaleIrp, {});
		expectLoud(await health(t), "GITHUB_REPO_INVALID", "resolve:repo");
	});

	test("a clean resolution records no failure", async () => {
		vi.stubGlobal("fetch", ghMock({}));
		const t = convexTest(schema, modules);
		const { missionId } = await seedStale(t);
		await t.action(internal.errorMonitorAutoResolver.autoResolveStaleIrp, {});
		expect(await missionStatus(t, missionId)).toBe("complete");
		expect((await health(t)).failures).toEqual([]);
	});
});
