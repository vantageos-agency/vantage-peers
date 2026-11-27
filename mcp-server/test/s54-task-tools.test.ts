/**
 * get_bulk_complete_run, billing_summary_by_project and get_recurring_task are
 * called through the real registerTools() against a mocked Convex client
 * (VantagePeers Cloud + Self-host, MCP server; S-54 of mcp-doctor
 * "tools-tested").
 *
 * Success: the door receives the documented arguments and the answer reaches the
 * caller as text and as a structuredContent that validates against the declared
 * outputSchema. Edge: a missing row is a typed not-found; a bearer outside the
 * run's organisation is told 'not found' (client isolation never rests on a
 * name); billing_summary_by_project is master-only.
 */

import { describe, expect, it } from "vitest";
import { CLIENT_CTX, expectRefused, expectServed, harness } from "./lib/s54Harness.js";

describe("get_bulk_complete_run", () => {
	const run = (over: Record<string, unknown> = {}) => ({
		bulkRunId: "bulk-1760000000000-ab12cd34",
		orgId: "ops",
		createdBy: "beta",
		status: "running",
		closed: 40,
		remaining: true,
		startedAt: 1_760_000_000_000,
		updatedAt: 1_760_000_005_000,
		...over,
	});

	it("serves the run row to the master caller and queries tasks:getBulkCompleteRun by id", async () => {
		const h = harness({ "tasks:getBulkCompleteRun": () => run() });
		const res = await h.tools.get("get_bulk_complete_run")!.handler({
			bulkRunId: "bulk-1760000000000-ab12cd34",
		});
		const out = expectServed(h.tools, "get_bulk_complete_run", res);
		expect(out).toMatchObject({ status: "running", closed: 40, remaining: true });
		expect(JSON.parse(res.content[0].text)).toEqual(out);
		expect(h.calls[0].fn).toBe("tasks:getBulkCompleteRun");
		expect(h.calls[0].args.bulkRunId).toBe("bulk-1760000000000-ab12cd34");
	});

	it("answers 'Bulk run not found' when no run has that id", async () => {
		const h = harness({ "tasks:getBulkCompleteRun": () => null });
		const res = await h.tools.get("get_bulk_complete_run")!.handler({ bulkRunId: "bulk-none" });
		expectRefused(res, /Bulk run not found: bulk-none/);
	});

	it("answers 'not found' to a bearer with no organisation, even for an existing run", async () => {
		const h = harness({ "tasks:getBulkCompleteRun": () => run() }, CLIENT_CTX);
		const res = await h.tools.get("get_bulk_complete_run")!.handler({
			bulkRunId: "bulk-1760000000000-ab12cd34",
		});
		expectRefused(res, /Bulk run not found/);
	});

	it("answers 'not found' to a bearer from another organisation than the run's", async () => {
		const h = harness(
			{ "tasks:getBulkCompleteRun": () => run({ orgId: "other-org" }) },
			{ ...CLIENT_CTX, clerkOrgSlug: "ops" },
		);
		const res = await h.tools.get("get_bulk_complete_run")!.handler({
			bulkRunId: "bulk-1760000000000-ab12cd34",
		});
		expectRefused(res, /Bulk run not found/);
	});
});

describe("billing_summary_by_project", () => {
	const summary = {
		byProject: [
			{ project: "vantage-immo", totalMinutes: 90, taskCount: 3, legacyTaskCount: 1, legacyMinutes: 20 },
		],
		unattributedTaskCount: 2,
		noProjectCount: 1,
		noDurationCount: 1,
		invalidDurationTaskCount: 0,
		truncated: false,
	};

	it("forwards the period and project to tasks:billingSummaryByProject and serves the summary", async () => {
		const h = harness({ "tasks:billingSummaryByProject": () => summary });
		const res = await h.tools.get("billing_summary_by_project")!.handler({
			project: "vantage-immo",
			from: 1_000,
			to: 2_000,
		});
		const out = expectServed(h.tools, "billing_summary_by_project", res);
		expect(out).toEqual(summary);
		expect(JSON.parse(res.content[0].text)).toEqual(summary);
		expect(h.calls[0].fn).toBe("tasks:billingSummaryByProject");
		expect(h.calls[0].args).toEqual({ startDate: 1_000, endDate: 2_000, project: "vantage-immo" });
	});

	it("counts from the first task (startDate 0) when no period is given and passes the no-duration list through", async () => {
		const withList = {
			...summary,
			noDurationTasks: [
				{ taskId: "k1", assignedTo: "beta", project: "vantage-immo", completedAt: 1_500 },
			],
			noDurationTasksTruncated: false,
		};
		const h = harness({ "tasks:billingSummaryByProject": () => withList });
		const res = await h.tools.get("billing_summary_by_project")!.handler({ listNoDuration: true });
		const out = expectServed(h.tools, "billing_summary_by_project", res);
		expect(out.noDurationTasks).toEqual(withList.noDurationTasks);
		expect(h.calls[0].args.startDate).toBe(0);
		expect(h.calls[0].args.listNoDuration).toBe(true);
		expect(h.calls[0].args).not.toHaveProperty("project");
	});

	it("refuses a bearer that is not master, before any door", async () => {
		const h = harness({ "tasks:billingSummaryByProject": () => summary }, CLIENT_CTX);
		const res = await h.tools.get("billing_summary_by_project")!.handler({});
		expectRefused(res, /requires master scope/);
		expect(h.calls).toHaveLength(0);
	});
});

describe("get_recurring_task", () => {
	const ID = "k57dy3049btafda9m2f5d2ggk987ph3f";
	const row = {
		_id: ID,
		_creationTime: 1_700_000_000_000,
		title: "Weekly sweep",
		assignedTo: "beta",
		priority: "medium",
		cronExpression: "0 9 * * 1",
		nextRunAt: 1_700_100_000_000,
		active: true,
		createdBy: "alpha",
	};

	it("serves the stored template and queries recurringTasks:getById by id", async () => {
		const h = harness({ "recurringTasks:getById": () => row });
		const res = await h.tools.get("get_recurring_task")!.handler({ recurringTaskId: ID });
		const out = expectServed(h.tools, "get_recurring_task", res);
		expect(out).toEqual(row);
		expect(JSON.parse(res.content[0].text)).toEqual(row);
		expect(h.calls[0].fn).toBe("recurringTasks:getById");
		expect(h.calls[0].args.recurringTaskId).toBe(ID);
	});

	it("answers 'Recurring task not found' when the door returns no row", async () => {
		const h = harness({ "recurringTasks:getById": () => null });
		const res = await h.tools.get("get_recurring_task")!.handler({ recurringTaskId: ID });
		expectRefused(res, /Recurring task not found/);
	});
});
