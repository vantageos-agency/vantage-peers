/**
 * A NON-master bearer whose organisation cannot be resolved (no verified actor,
 * no token-row org, not a Clerk session) is a DENY at the MCP boundary, never a
 * fall-through to the name-only check: .claude/rules/http-boundary-derives-from-principal.md.
 * Applies to the ten single-task write tools and bulk_complete_tasks.
 *
 * POLES
 *   REFUSED   no actor, no clerkOrgSlug -> RBAC_DENIED (verified-org-unresolved),
 *             Convex never reached, no row changes (org-a and org-b rows alike)
 *   MASTER    unchanged: reaches Convex and the write lands
 *   CLERK-JWT a caller on its own Clerk session is scoped by Convex's own org scope
 *             (own-org task allowed, foreign-org task refused) and forwards no verifiedOrg
 */

import type { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { convexTest } from "../../../tests/fixtures/convexTestWithServiceAccount";
import { beforeEach, describe, expect, it } from "vitest";
import schema from "../../../convex/schema.js";
import { testClerkOrgId } from "../../../tests/fixtures/testClerkOrgId";
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
type Row = {
	status: string;
	title: string;
	pausedAt?: number;
	workSegments?: Array<{ start: number; end?: number; correction?: unknown }>;
};

const ref = (dotted: string) => {
	const [mod, fn] = dotted.split(":");
	return (anyApi as Record<string, Record<string, unknown>>)[mod][fn] as never;
};

let t: T;
let service: T;

function harness(ctx: OAuthContext, as: T) {
	let reached = 0;
	const client = {
		query: (n: string, a: unknown) => as.query(ref(n), a as never),
		mutation: (n: string, a: unknown) => {
			reached++;
			return as.mutation(ref(n), a as never);
		},
		action: (n: string, a: unknown) => as.action(ref(n), a as never),
	} as unknown as ConvexHttpClient;
	const handlers = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	registerTools({ tool: reg, registerTool: reg } as never, client, ctx);
	return { handlers, reached: () => reached };
}

const FUTURE = Date.now() + 3_600_000;
const NO_ORG: OAuthContext = {
	clientId: "client-x",
	userId: "user-x",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["eta"],
	namespaceReadPrefixes: ["team/none"],
	namespaceWritePrefixes: ["team/none"],
	accessTokenHash: "legacy-seat-hash",
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
	{
		name: "add_task_dependency",
		status: "todo",
		args: (taskId) => ({ taskId, dependsOn: [], callerOrchestrator: "eta" }),
		landed: () => false,
	},
];

beforeEach(async () => {
	t = convexTest(schema as never, modules as never);
	service = t.withIdentity({
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
				clerkOrgId: testClerkOrgId(slug),
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
			clerkOrgId: testClerkOrgId(orgId),
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

describe("a non-master bearer with no resolvable org is refused at the MCP layer", () => {
	for (const tool of TOOLS) {
		it(`REFUSED ${tool.name}: no actor, no clerkOrgSlug -> RBAC_DENIED, Convex never reached, no row changes`, async () => {
			for (const org of ["org-a", "org-b"]) {
				const id = await seed(org, tool.status);
				const before = JSON.stringify(await read(id));
				const { handlers, reached } = harness(NO_ORG, service);
				const res = await handlers.get(tool.name)?.(tool.args(id));
				expect(res?.isError, res?.content[0]?.text).toBe(true);
				expect(res?.content[0]?.text).toMatch(/RBAC_DENIED/);
				expect(res?.content[0]?.text).toMatch(/verified-org-unresolved/);
				expect(reached()).toBe(0);
				expect(JSON.stringify(await read(id))).toBe(before);
			}
		});

		it(`MASTER ${tool.name}: unchanged`, async () => {
			const id = await seed("org-b", tool.status);
			const { handlers, reached } = harness(MASTER, service);
			const res = await handlers.get(tool.name)?.(tool.args(id));
			expect(res?.isError, res?.content[0]?.text).not.toBe(true);
			expect(reached()).toBeGreaterThan(0);
			if (tool.name !== "add_task_dependency")
				expect(tool.landed(await read(id))).toBe(true);
		});
	}

	it("REFUSED bulk_complete_tasks: refused before Convex; MASTER unchanged", async () => {
		const args = {
			filter: { assignedTo: "eta" },
			dryRun: false,
			callerOrchestrator: "eta",
		};
		const denied = harness(NO_ORG, service);
		const res = await denied.handlers.get("bulk_complete_tasks")?.(args);
		expect(res?.isError, res?.content[0]?.text).toBe(true);
		expect(res?.content[0]?.text).toMatch(/RBAC_DENIED/);
		expect(res?.content[0]?.text).toMatch(/verified-org-unresolved/);
		expect(denied.reached()).toBe(0);
		const ok = harness(MASTER, service);
		const out = await ok.handlers.get("bulk_complete_tasks")?.({
			...args,
			dryRun: true,
			callerOrchestrator: "system",
		});
		expect(out?.isError, out?.content[0]?.text).not.toBe(true);
		expect(ok.reached()).toBeGreaterThan(0);
	});

	it("CLERK-JWT: scoped by Convex's own org scope (own org allowed, foreign org refused), no verifiedOrg forwarded", async () => {
		const member = t.withIdentity({
			subject: "member-a",
			org_slug: "org-a",
			org_id: testClerkOrgId("org-a"),
			org_role: "org:admin",
		} as never);
		const clerkCtx: OAuthContext = {
			...NO_ORG,
			clerkJwt: "verified.jwt.token",
			clerkOrgSlug: "org-a",
			actor: { orgSlug: "org-a", agentName: "eta" },
		};
		await t.run(async (ctx) => {
			await ctx.db.insert("memberWriterRoles", {
				roles: ["org:admin", "org:editor"],
				updatedAt: Date.now(),
			});
		});
		const mine = await seed("org-a", "in_progress");
		const theirs = await seed("org-b", "in_progress");
		const { handlers } = harness(clerkCtx, member);
		const note = "closing, evidence abc1234 and more words here";
		const denied = await handlers.get("complete_task")?.({
			taskId: theirs,
			completionNote: note,
			callerOrchestrator: "eta",
		});
		expect(denied?.isError, denied?.content[0]?.text).toBe(true);
		expect(denied?.content[0]?.text).toMatch(/RBAC_DENIED/);
		expect((await read(theirs))?.status).toBe("in_progress");
		const ok = await handlers.get("complete_task")?.({
			taskId: mine,
			completionNote: note,
			callerOrchestrator: "eta",
		});
		expect(ok?.isError, ok?.content[0]?.text).not.toBe(true);
		expect((await read(mine))?.status).toBe("done");
	});
});
