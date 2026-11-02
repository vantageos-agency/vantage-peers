/// <reference types="vite/client" />
/**
 * A refusal (RBAC_DENIED / IdentityRefusal) from an access-controlled module is
 * the protection working. It must not reach `upsertError`, so it can never
 * become a task.
 *
 * GAP: the only refusal filter keys on the literal "Uncaught ConvexError:"
 * prefix. A refusal that reaches the log as "Uncaught Error: RBAC_DENIED ..."
 * (a ConvexError re-thrown across an action boundary) or as an
 * "IdentityRefusalError" escalated as a defect.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { internal } from "../_generated/api";
import { DEFAULT_FILTER_RULES } from "../errorMonitorFilters";
import { decideGroupAction } from "../errorMonitorPollDecision";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MODULES = [
	"agentCredentials",
	"agents",
	"clientOrgMapping",
	"dashboard",
	"episodes",
	"iframeEmbedSessions",
	"issues",
	"okfBundleDurable",
];
const unknownVisibility = () => "unknown" as const;

describe("decideGroupAction — refusals from access-controlled modules", () => {
	for (const m of MODULES) {
		test(`${m}: RBAC_DENIED and IdentityRefusal do not escalate`, () => {
			for (const errorMessage of [
				'Uncaught Error: RBAC_DENIED: no authenticated identity — {"door":"x"}',
				"Uncaught IdentityRefusalError: principal-not-found",
				"Uncaught Error: ORG_MISMATCH: target in another organisation",
			]) {
				const action = decideGroupAction(
					{ functionNames: [`${m}:someDoor`], errorMessage },
					DEFAULT_FILTER_RULES,
					unknownVisibility,
				);
				expect(action.kind).not.toBe("escalate");
			}
		});
	}

	test("a mixed group (one module outside the set) still escalates", () => {
		const action = decideGroupAction(
			{
				functionNames: ["dashboard:getDashboardSummary", "tasks:update"],
				errorMessage: "Uncaught Error: RBAC_DENIED: x",
			},
			DEFAULT_FILTER_RULES,
			unknownVisibility,
		);
		expect(action.kind).toBe("escalate");
	});

	test("a non-refusal defect in a listed module still escalates", () => {
		const action = decideGroupAction(
			{
				functionNames: ["dashboard:getDashboardSummary"],
				errorMessage: "Uncaught Error: Cannot read properties of undefined",
			},
			DEFAULT_FILTER_RULES,
			unknownVisibility,
		);
		expect(action.kind).toBe("escalate");
	});
});

describe("pollDeploymentLogs — a refusal from dashboard files nothing", () => {
	beforeEach(() => {
		process.env.TEST_DEPLOY_KEY = "k";
		delete process.env.AUTO_IRP_PAUSED;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.TEST_DEPLOY_KEY;
	});

	test("no errorLogs row, no task", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					entries: [
						{
							kind: "Completion",
							identifier: "dashboard:getDashboardSummary",
							error:
								'Uncaught Error: RBAC_DENIED: no authenticated identity — {"door":"dashboard:getDashboardSummary"}',
							logLines: [],
						},
					],
					newCursor: 1,
				}),
			}),
		);
		const t = convexTest(schema, modules);
		await t.action(internal.errorMonitorActions.pollDeploymentLogs, {
			deploymentName: "prod",
			deploymentUrl: "https://example.convex.cloud",
			deployKeyEnvVar: "TEST_DEPLOY_KEY",
			githubRepo: "vantageos-agency/vantage-peers",
			orchestrator: "sigma",
		});
		const counts = await t.run(async (ctx) => ({
			logs: (await ctx.db.query("errorLogs").collect()).length,
			tasks: (await ctx.db.query("tasks").collect()).length,
		}));
		expect(counts).toEqual({ logs: 0, tasks: 0 });
	});
});
