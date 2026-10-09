/**
 * AUDIT RED reproduction, group R2 — MCP tools over tasks / missions /
 * recurring tasks / mandates / templates.
 *
 * Identity for every case: an OAuth SEAT of org-a (OAuthContext: isMaster false,
 * clerkOrgSlug "org-a", fromAllowList ["eta"], userId "eta", no agent credential,
 * no actor). The real tool handlers (registerTools) reach the REAL Convex
 * functions (convex-test) as the fleet service account, as production does.
 * org-b carries a SAME-NAMED "eta" so only the tenant stamp separates them.
 * Each case asserts what the tool MUST do; FAIL = defect reproduced.
 */
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";
import schema from "../../../convex/schema";
import type { OAuthContext } from "../../src/auth.js";
import { registerTools } from "../../src/tools.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../../convex/**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill") &&
			!path.includes("__tests__") &&
			!path.endsWith(".test.ts"),
	),
);
const SA = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
type T = ReturnType<typeof convexTest<typeof schema>>;
type Res = { isError?: boolean; content: { text: string }[] };
type Tool = (a: Record<string, unknown>) => Promise<Res>;

let t: T;
let tools: Map<string, Tool>;

const seat: OAuthContext = {
	clientId: "seat-a",
	userId: "eta",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "p",
	fromAllowList: ["eta"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	accessTokenHash: "hash-a",
	clerkOrgSlug: "org-a",
	seatAgent: null,
};

let reg: (ctx: OAuthContext) => void = () => {};

beforeEach(async () => {
	t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", { roles: ["org:admin", "org:editor"], updatedAt: 1 });
		await ctx.db.insert("taskClosureConfig", { key: "billableProjects", value: [], updatedAt: 1 });
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: ["eta"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
		}
	});
	const sa = t.withIdentity({ subject: SA });
	const client = {
		query: (n: string, a: Record<string, unknown>) =>
			sa.query(makeFunctionReference<"query">(n) as never, a as never),
		mutation: (n: string, a: Record<string, unknown>) =>
			sa.mutation(makeFunctionReference<"mutation">(n) as never, a as never),
		action: async () => null,
	};
	reg = (ctx) => {
		tools = new Map();
		const server = {
			tool() {},
			registerTool: (name: string, _c: unknown, h: Tool) => {
				tools.set(name, h);
			},
		} as never;
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		registerTools(server, client as any, ctx);
	};
	reg(seat);
});

/** Re-register the tools for an org-a seat that resolved to its agent by ID (a credentialed seat). */
async function useCredentialedSeat() {
	const agentId = await t.run((ctx) =>
		ctx.db.insert("agents", { orgSlug: "org-a", name: "eta", normalizedName: "eta", isActive: true, createdAt: 1 }),
	);
	await t.run((ctx) =>
		ctx.db.insert("oauth_access_tokens", {
			tokenHash: "hash-a", clientId: "seat-a", userId: "eta", scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "p", fromAllowList: ["eta"], namespaceReadPrefixes: ["*"], namespaceWritePrefixes: ["*"],
			expiresAt: Date.now() + 3_600_000, createdAt: 1, clerkOrgSlug: "org-a", agentId, agentOrgId: "org-a",
		}),
	);
	reg({
		...seat,
		seatAgent: { agentId, orgId: "org-a", agentName: "eta" },
		actor: { orgSlug: "org-a", agentName: "eta", agentId },
	} as OAuthContext);
}

async function call(name: string, args: Record<string, unknown>) {
	const h = tools.get(name);
	expect(h, `tool ${name} registered`).toBeDefined();
	return (await h?.(args)) as Res;
}
const text = (r: Res) => r.content?.[0]?.text ?? "";
const mission = (orgId: string, pilot = "eta") =>
	t.run((ctx) =>
		ctx.db.insert("missions", {
			name: `m-${orgId}`, project: "p", status: "execute", priority: "low",
			pilot, agents: [pilot], createdBy: pilot, createdAt: 1, updatedAt: 1, orgId,
		}),
	);
const task = (orgId: string, o: Record<string, unknown> = {}) =>
	t.run((ctx) =>
		ctx.db.insert("tasks", {
			title: `T-${orgId}-SECRET`, assignedTo: "eta", createdBy: "eta", priority: "low",
			status: "todo", orgId, createdAt: 1, updatedAt: 1, ...o,
		} as never),
	);
const recurring = (orgId: string) =>
	t.run((ctx) =>
		ctx.db.insert("recurringTasks", {
			title: `R-${orgId}`, assignedTo: "eta", priority: "low", cronExpression: "0 9 * * *",
			nextRunAt: Date.now() + 1000, active: true, createdBy: "eta", orgId, createdAt: 1, updatedAt: 1,
		}),
	);

describe("MCP seat of org-a (credentialed where the case says so)", () => {
	it("create_task — the task a seat creates is stamped org-a, so the seat can then complete it", async () => {
		await useCredentialedSeat();
		const r = await call("create_task", { title: "t", assignedTo: "eta", priority: "low", status: "todo", project: "p", createdBy: "eta" });
		const rows = await t.run((ctx) => ctx.db.query("tasks").collect());
		expect({ err: r.isError ?? false, orgs: rows.map((x) => x.orgId) }, text(r).slice(0, 200)).toEqual({ err: false, orgs: ["org-a"] });
	});

	it("list_tasks — org-b's task assigned to the same-named 'eta' is absent for an org-a seat", async () => {
		await task("org-b");
		const r = await call("list_tasks", { assignedTo: "eta" });
		expect(text(r), "org-b task returned to org-a seat").not.toContain("T-org-b-SECRET");
	});

	it("list_tasks — org-a's own task is served (positive control)", async () => {
		await task("org-a");
		const r = await call("list_tasks", { assignedTo: "eta" });
		expect(text(r)).toContain("T-org-a-SECRET");
	});

	it("get_task — org-b's task is not found for an org-a seat", async () => {
		const id = await task("org-b");
		const r = await call("get_task", { taskId: id });
		expect(text(r), "org-b task returned by id").not.toContain("T-org-b-SECRET");
	});

	it("search_tasks_by_keyword — org-b's task is not returned to an org-a seat", async () => {
		await task("org-b", { title: "secretplan" });
		const r = await call("search_tasks_by_keyword", { query: "secretplan" });
		expect(text(r), "org-b task found by keyword").not.toContain("secretplan");
	});

	it("list_tasks_by_mission — org-b's mission tasks are not returned to an org-a seat", async () => {
		const m = await mission("org-b");
		await task("org-b", { missionId: m });
		const r = await call("list_tasks_by_mission", { missionId: m });
		expect(text(r), "org-b mission task returned").not.toContain("T-org-b-SECRET");
	});

	it("create_mission — the mission a seat creates is stamped org-a", async () => {
		await useCredentialedSeat();
		const r = await call("create_mission", { name: "m", project: "p", status: "plan", priority: "low", pilot: "eta", agents: ["eta"], createdBy: "eta" });
		const rows = await t.run((ctx) => ctx.db.query("missions").collect());
		expect({ err: r.isError ?? false, orgs: rows.map((x) => x.orgId) }, text(r).slice(0, 200)).toEqual({ err: false, orgs: ["org-a"] });
	});

	it("list_missions — org-b's mission piloted by the same-named 'eta' is absent for an org-a seat", async () => {
		await mission("org-b");
		const r = await call("list_missions", { pilot: "eta" });
		expect(text(r), "org-b mission returned").not.toContain("m-org-b");
	});

	it("get_mission — org-b's mission is not returned by id to an org-a seat", async () => {
		const m = await mission("org-b");
		const r = await call("get_mission", { missionId: m });
		expect(text(r), "org-b mission returned by id").not.toContain("m-org-b");
	});

	it("update_mission — an org-a seat cannot overwrite org-b's mission brief", async () => {
		const m = await mission("org-b");
		await useCredentialedSeat();
		const r = await call("update_mission", { missionId: m, callerOrchestrator: "eta", brief: "overwritten" });
		const row = await t.run((ctx) => ctx.db.get(m));
		expect(row?.brief, "org-b brief overwritten by org-a seat").toBeUndefined();
	});

	it("instantiate_template_into_mission — an org-a seat cannot fan tasks into org-b's mission", async () => {
		await t.withIdentity({ subject: SA }).mutation(makeFunctionReference<"mutation">("missionTemplates:upsert") as never, {
			name: "tpl", steps: [{ title: "s", description: "d" }], createdBy: "pi",
		} as never);
		const m = await mission("org-b");
		await useCredentialedSeat();
		const r = await call("instantiate_template_into_mission", { templateName: "tpl", missionId: m, callerOrchestrator: "eta" });
		const rows = (await t.run((ctx) => ctx.db.query("tasks").collect())).filter((x) => x.missionId === m);
		expect(rows.length, "tasks created in org-b's mission").toBe(0);
	});

	it("create_recurring_task — the schedule a seat creates is stamped org-a", async () => {
		await useCredentialedSeat();
		const r = await call("create_recurring_task", { title: "r", assignedTo: "eta", priority: "low", cronExpression: "0 9 * * *", createdBy: "eta" });
		const rows = await t.run((ctx) => ctx.db.query("recurringTasks").collect());
		expect({ err: r.isError ?? false, orgs: rows.map((x) => x.orgId) }, text(r).slice(0, 200)).toEqual({ err: false, orgs: ["org-a"] });
	});

	it("list_recurring_tasks — org-b's schedule is absent for an org-a seat", async () => {
		await recurring("org-b");
		const r = await call("list_recurring_tasks", {});
		expect(text(r), "org-b schedule returned").not.toContain("R-org-b");
	});

	it("update_recurring_task — an org-a seat cannot rewrite org-b's schedule", async () => {
		const id = await recurring("org-b");
		await call("update_recurring_task", { recurringTaskId: id, title: "hijacked" });
		expect((await t.run((ctx) => ctx.db.get(id)))?.title, "org-b schedule rewritten").toBe("R-org-b");
	});

	it("get_recurring_task — org-b's schedule is not returned by id to an org-a seat", async () => {
		const id = await recurring("org-b");
		const r = await call("get_recurring_task", { recurringTaskId: id });
		expect(text(r), "org-b schedule returned by id").not.toContain("R-org-b");
	});

	it("validate_mandate_spending — an org-a seat cannot read a fleet mandate's budget", async () => {
		const id = await t.run((ctx) =>
			ctx.db.insert("mandates", { requestedBy: "pi", fulfilledBy: "sigma", service: "x", budget: 424242, status: "requested", createdAt: 1, updatedAt: 1 }),
		);
		const r = await call("validate_mandate_spending", { mandateId: id, proposedAmount: 0 });
		expect(text(r), "fleet mandate figures returned to a seat").not.toContain("424242");
	});

	it("update_mission_template — an org-a seat cannot overwrite the shared template catalog", async () => {
		const sa = t.withIdentity({ subject: SA });
		await sa.mutation(makeFunctionReference<"mutation">("missionTemplates:upsert") as never, {
			name: "shared-tpl", steps: [{ title: "orig", description: "d" }], createdBy: "pi",
		} as never);
		await useCredentialedSeat();
		const r = await call("update_mission_template", { name: "shared-tpl", description: "d", steps: [{ title: "EVIL", description: "d" }], createdBy: "eta" });
		const row = (await t.run((ctx) => ctx.db.query("missionTemplates").collect()))[0];
		expect(row?.steps[0].title, "shared template overwritten by seat").toBe("orig");
	});
});
