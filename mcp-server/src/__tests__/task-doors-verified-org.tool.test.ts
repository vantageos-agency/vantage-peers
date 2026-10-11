/**
 * The ten single-task write tools forward the bearer's VERIFIED org to their
 * Convex door, so an org-a "eta" cannot act on an org-b task that names an
 * org-b "eta" (names collide across tenants; the row's org is the only separator).
 *
 * End-to-end through the real tool handlers into the real Convex mutations
 * (convex-test), as the fleet service account — exactly how MCP reaches Convex.
 * Nothing at the MCP layer reads the target task, so the Convex door is the
 * only place the org compare can happen.
 *
 * POLES (per tool)
 *   REFUSED  org-a bearer, org-b task id           -> error result, org-b row untouched
 *   PRESENT  org-a bearer, org-a task id           -> the write lands
 *   MASTER   fleet master, no verified org         -> unchanged (lands on any tenant)
 *   FORWARD  a `verifiedOrg` smuggled into the tool arguments is never read
 */

import type { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { convexTest } from "../../../tests/fixtures/convexTestWithServiceAccount";
import { beforeEach, describe, expect, it } from "vitest";
import schema from "../../../convex/schema.js";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

const modules = Object.fromEntries(
	Object.entries(
		import.meta.glob<Record<string, unknown>>("../../../convex/**/*.ts"),
	).filter(([path]) => !path.includes("ragSync") && !path.includes("backfill")),
);

type T = ReturnType<typeof convexTest>;
type Handler = (args: Record<string, unknown>) => Promise<{
	isError?: boolean;
	content: Array<{ text: string }>;
}>;

function resolveRef(dotted: string) {
	const [mod, fn] = dotted.split(":");
	return (anyApi as Record<string, Record<string, unknown>>)[mod][fn];
}

function bridge(t: T): ConvexHttpClient {
	return {
		query: (name: string, args: unknown) =>
			t.query(resolveRef(name) as never, args as never),
		mutation: (name: string, args: unknown) =>
			t.mutation(resolveRef(name) as never, args as never),
		action: (name: string, args: unknown) =>
			t.action(resolveRef(name) as never, args as never),
	} as unknown as ConvexHttpClient;
}

function handlersFor(t: T, ctx: OAuthContext): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	registerTools({ tool: reg, registerTool: reg } as never, bridge(t), ctx);
	return handlers;
}

const FUTURE = Date.now() + 3_600_000;
const ORG_A_ETA: OAuthContext = {
	clientId: "client-a",
	userId: "user-a",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["eta"],
	actor: { orgSlug: "org-a", agentName: "eta" },
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: FUTURE,
	isMaster: false,
};
const MASTER: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["mcp:full"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: FUTURE,
	isMaster: true,
};

type Status = "todo" | "in_progress" | "paused";
type Row = {
	status: string;
	title: string;
	pausedAt?: number;
	workSegments?: Array<{ start: number; end?: number; correction?: unknown }>;
};

interface Tool {
	name: string;
	status: Status;
	args: (taskId: string) => Record<string, unknown>;
	landed: (row: Row | null) => boolean;
}

const REASON =
	"# blocked-on-nobody: third-party outage typed by the colliding agent";
const NOTE = "closing, evidence abc1234 and more words here";

const TOOLS: Tool[] = [
	{
		name: "complete_task",
		status: "in_progress",
		args: (taskId) => ({
			taskId,
			completionNote: NOTE,
			callerOrchestrator: "eta",
		}),
		landed: (r) => r?.status === "done",
	},
	{
		name: "update_task",
		status: "todo",
		args: (taskId) => ({
			taskId,
			title: "HIJACKED",
			callerOrchestrator: "eta",
		}),
		landed: (r) => r?.title === "HIJACKED",
	},
	{
		name: "start_task",
		status: "todo",
		args: (taskId) => ({ taskId, callerOrchestrator: "eta" }),
		landed: (r) => r?.status === "in_progress",
	},
	{
		name: "pause_task",
		status: "in_progress",
		args: (taskId) => ({ taskId, callerOrchestrator: "eta" }),
		landed: (r) => r?.pausedAt !== undefined,
	},
	{
		name: "resume_task",
		status: "paused",
		args: (taskId) => ({ taskId, callerOrchestrator: "eta" }),
		landed: (r) => r !== null && r.pausedAt === undefined,
	},
	{
		name: "block_task",
		status: "in_progress",
		args: (taskId) => ({ taskId, reason: REASON, callerOrchestrator: "eta" }),
		landed: (r) => r?.status === "blocked",
	},
	{
		name: "fail_task",
		status: "in_progress",
		args: (taskId) => ({
			taskId,
			failureNote: "failing it, evidence abc1234 and more words here",
			callerOrchestrator: "eta",
		}),
		landed: (r) => r?.status === "failed",
	},
	{
		name: "delete_task",
		status: "todo",
		args: (taskId) => ({ taskId, callerOrchestrator: "eta" }),
		landed: (r) => r === null,
	},
	{
		name: "checkout_task",
		status: "todo",
		args: (taskId) => ({ taskId, callerOrchestrator: "eta" }),
		landed: (r) => r?.status === "in_progress",
	},
	{
		name: "correct_task_segment",
		status: "in_progress",
		args: (taskId) => ({
			taskId,
			segmentIndex: 0,
			start: Date.now() - 50_000,
			end: Date.now() - 30_000,
			reason: REASON,
			callerOrchestrator: "eta",
		}),
		landed: (r) => r?.workSegments?.[0]?.correction !== undefined,
	},
];

let t: T;

beforeEach(async () => {
	t = convexTest(schema as never, modules as never).withIdentity({
		subject: "test-service-account-user-id",
	} as never);
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: Date.now(),
		});
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: ["eta"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
});

async function seed(orgId: string, status: Status): Promise<string> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const id = await ctx.db.insert("tasks", {
			title: `${orgId} task`,
			assignedTo: "eta",
			createdBy: "eta",
			priority: "low",
			status: status === "paused" ? "in_progress" : status,
			orgId,
			...(status === "in_progress"
				? { startedAt: now - 60_000, workSegments: [{ start: now - 60_000 }] }
				: {}),
			...(status === "paused"
				? {
						startedAt: now - 60_000,
						pausedAt: now - 1000,
						workSegments: [{ start: now - 60_000, end: now - 1000 }],
					}
				: {}),
			createdAt: now,
			updatedAt: now,
		});
		return id as string;
	});
}

const read = (id: string) =>
	t.run(async (ctx) => (await ctx.db.get(id as never)) as Row | null);

describe("the ten single-task write tools carry the bearer's verified org to Convex", () => {
	for (const tool of TOOLS) {
		describe(tool.name, () => {
			it("REFUSED: an org-a eta bearer cannot act on an org-b task that names an org-b eta", async () => {
				const id = await seed("org-b", tool.status);
				const before = JSON.stringify(await read(id));
				const res = await handlersFor(t, ORG_A_ETA).get(tool.name)?.(
					tool.args(id),
				);
				expect(res?.isError, res?.content[0]?.text).toBe(true);
				expect(res?.content[0]?.text).toMatch(/RBAC_DENIED/);
				expect(tool.landed(await read(id))).toBe(false);
				expect(JSON.stringify(await read(id))).toBe(before);
			});

			it("PRESENT: the same org-a eta bearer acts on its own org-a task", async () => {
				const id = await seed("org-a", tool.status);
				const res = await handlersFor(t, ORG_A_ETA).get(tool.name)?.(
					tool.args(id),
				);
				expect(res?.isError, res?.content[0]?.text).not.toBe(true);
				expect(tool.landed(await read(id))).toBe(true);
			});

			it("MASTER: the fleet master (no verified org) keeps its reach into any tenant", async () => {
				const id = await seed("org-b", tool.status);
				const res = await handlersFor(t, MASTER).get(tool.name)?.(
					tool.args(id),
				);
				expect(res?.isError, res?.content[0]?.text).not.toBe(true);
				expect(tool.landed(await read(id))).toBe(true);
			});

			it("FORWARD: a verifiedOrg typed into the tool arguments is never read", async () => {
				const id = await seed("org-b", tool.status);
				const res = await handlersFor(t, ORG_A_ETA).get(tool.name)?.({
					...tool.args(id),
					verifiedOrg: { orgSlug: "org-b" },
				});
				expect(res?.isError, res?.content[0]?.text).toBe(true);
				expect(tool.landed(await read(id))).toBe(false);
			});
		});
	}
});
