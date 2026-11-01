/// <reference types="vite/client" />
/**
 * Task k17cbr6y6da096t5e1k869kgb18hd0ht: which MCP tools a caller has called,
 * per organisation. Mechanism only: tool name, first/last timestamp, count.
 *
 * Poles:
 *   PRESENT   rows exist after a recorded call, count/lastAt move, firstAt stays;
 *   ABSENT    a scoped caller with no rows is served an empty SUCCESS;
 *   REFUSED   another organisation's rows, or another caller's rows without admin
 *             standing, or no credential at all, RAISE RBAC_DENIED;
 *   IDENTITY  the recorder writes nothing for a missing identity, a fleet caller
 *             with no acting org, or a malformed key; and a member cannot file
 *             a row under another caller's key.
 */

import { anyApi } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("search") && !path.includes("backfill"),
	),
);
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const toolUsage = anyApi.toolUsage;
const A = "usage-org-a";
const B = "usage-org-b";
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);

async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const org of [A, B]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: 1,
			});
		}
	});
}

const member = (t: T, org: string, sub: string, role = "org:member") =>
	t.withIdentity({
		subject: sub,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	});
const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

type Row = { tool: string; firstAt: number; lastAt: number; count: number };

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		const m = /([A-Z][A-Z_]{3,}):/.exec(text);
		return m ? m[1] : `OTHER(${text.slice(0, 100)})`;
	}
}

const rowsOf = (t: T) =>
	t.run(async (ctx) => await ctx.db.query("tool_usage").collect());

describe("toolUsage:record + toolUsage:getToolUsage", () => {
	test("PRESENT: rows after a recorded call; count and lastAt move, firstAt stays", async () => {
		const t = createT();
		await seed(t);
		const alice = member(t, A, "alice-sub");
		vi.setSystemTime(1_000);
		expect(
			await alice.mutation(toolUsage.record, { toolName: "store_memory" }),
		).toEqual({ recorded: true });
		vi.setSystemTime(5_000);
		await alice.mutation(toolUsage.record, { toolName: "store_memory" });
		await alice.mutation(toolUsage.record, { toolName: "check_messages" });
		const got = (await alice.query(toolUsage.getToolUsage, {})) as Row[];
		const byTool = Object.fromEntries(got.map((r) => [r.tool, r]));
		expect(byTool.store_memory).toEqual({
			tool: "store_memory",
			firstAt: 1_000,
			lastAt: 5_000,
			count: 2,
		});
		expect(byTool.check_messages.count).toBe(1);
		expect(Object.keys(got[0]).sort()).toEqual([
			"count",
			"firstAt",
			"lastAt",
			"tool",
		]);
		const stored = await rowsOf(t);
		expect(stored).toHaveLength(2);
		expect(stored.every((r) => r.clerkOrgId === A_ID)).toBe(true);
		expect(stored.every((r) => r.callerKey === "user:alice-sub")).toBe(true);
	});

	test("ABSENT: a scoped caller with no rows gets an empty SUCCESS", async () => {
		const t = createT();
		await seed(t);
		const got = await member(t, A, "nobody-sub").query(
			toolUsage.getToolUsage,
			{},
		);
		expect(got).toEqual([]);
	});

	test("REFUSED: another organisation is RBAC_DENIED, and its rows are not served", async () => {
		const t = createT();
		await seed(t);
		await member(t, A, "alice-sub").mutation(toolUsage.record, {
			toolName: "store_memory",
		});
		const bob = member(t, B, "bob-sub", "org:admin");
		expect(
			await code(bob.query(toolUsage.getToolUsage, { orgId: A_ID })),
		).toBe("RBAC_DENIED");
		// An admin of B naming alice's key reads B's rows for that key: none.
		expect(
			await bob.query(toolUsage.getToolUsage, { callerKey: "user:alice-sub" }),
		).toEqual([]);
	});

	test("an org admin reads another caller of its own org; a plain member does not", async () => {
		const t = createT();
		await seed(t);
		await member(t, A, "alice-sub").mutation(toolUsage.record, {
			toolName: "store_memory",
		});
		const admin = member(t, A, "boss-sub", "org:admin");
		const got = (await admin.query(toolUsage.getToolUsage, {
			callerKey: "user:alice-sub",
		})) as Row[];
		expect(got.map((r) => r.tool)).toEqual(["store_memory"]);
		const peer = member(t, A, "carol-sub");
		expect(
			await code(
				peer.query(toolUsage.getToolUsage, { callerKey: "user:alice-sub" }),
			),
		).toBe("RBAC_DENIED");
	});

	test("REFUSED: no credential at all raises RBAC_DENIED (not an empty success)", async () => {
		const t = createT();
		await seed(t);
		expect(await code(t.query(toolUsage.getToolUsage, {}))).toBe("RBAC_DENIED");
	});

	test("the fleet master reads any org's caller, naming the org", async () => {
		const t = createT();
		await seed(t);
		await member(t, A, "alice-sub").mutation(toolUsage.record, {
			toolName: "store_memory",
		});
		const got = (await service(t).query(toolUsage.getToolUsage, {
			orgId: A_ID,
			callerKey: "user:alice-sub",
		})) as Row[];
		expect(got).toHaveLength(1);
		// A master naming no organisation is told so, not served a guess.
		expect(
			await code(
				service(t).query(toolUsage.getToolUsage, {
					callerKey: "user:alice-sub",
				}),
			),
		).not.toBe("SERVED");
	});

	test("service account acting for org A: records an agent seat, reads its own rows", async () => {
		const t = createT();
		await seed(t);
		const seat = "agent:k1seatagentid";
		expect(
			await service(t).mutation(toolUsage.record, {
				toolName: "list_tasks",
				callerKey: seat,
				__actingOrg: A_ID,
			}),
		).toEqual({ recorded: true });
		const stored = await rowsOf(t);
		expect(stored).toHaveLength(1);
		expect(stored[0].clerkOrgId).toBe(A_ID);
		const own = (await service(t).query(toolUsage.getToolUsage, {
			__actingOrg: A_ID,
			selfKey: seat,
		})) as Row[];
		expect(own.map((r) => r.tool)).toEqual(["list_tasks"]);
		// The same seat naming another caller is not an admin: refused.
		expect(
			await code(
				service(t).query(toolUsage.getToolUsage, {
					__actingOrg: A_ID,
					selfKey: seat,
					callerKey: "user:alice-sub",
				}),
			),
		).toBe("RBAC_DENIED");
		// Acting for org B it sees nothing of A.
		expect(
			await service(t).query(toolUsage.getToolUsage, {
				__actingOrg: B_ID,
				selfKey: seat,
			}),
		).toEqual([]);
	});

	test("IDENTITY: the recorder writes nothing for a missing identity or an unscoped fleet call", async () => {
		const t = createT();
		await seed(t);
		expect(
			await t.mutation(toolUsage.record, { toolName: "store_memory" }),
		).toEqual({ recorded: false });
		expect(
			await service(t).mutation(toolUsage.record, {
				toolName: "store_memory",
				callerKey: "agent:x",
			}),
		).toEqual({ recorded: false });
		expect(await rowsOf(t)).toHaveLength(0);
	});

	test("IDENTITY: a malformed tool name or caller key records nothing", async () => {
		const t = createT();
		await seed(t);
		for (const bad of [
			{ toolName: "", callerKey: "agent:x" },
			{ toolName: "has space", callerKey: "agent:x" },
			{ toolName: "x".repeat(200), callerKey: "agent:x" },
			{ toolName: "ok_tool", callerKey: "nokind" },
			{ toolName: "ok_tool", callerKey: `agent:${"y".repeat(400)}` },
		]) {
			expect(
				await service(t).mutation(toolUsage.record, {
					...bad,
					__actingOrg: A_ID,
				}),
			).toEqual({ recorded: false });
		}
		expect(await rowsOf(t)).toHaveLength(0);
	});

	test("IDENTITY: a member cannot file a row under another caller's key", async () => {
		const t = createT();
		await seed(t);
		await member(t, A, "mallory-sub").mutation(toolUsage.record, {
			toolName: "store_memory",
			callerKey: "user:alice-sub",
		});
		const stored = await rowsOf(t);
		expect(stored.map((r) => r.callerKey)).toEqual(["user:mallory-sub"]);
	});

	test("a caller's distinct-tool rows are bounded", async () => {
		const t = createT();
		await seed(t);
		const m = member(t, A, "busy-sub");
		const { MAX_TOOLS_PER_CALLER } = await import("../toolUsage");
		for (let i = 0; i < MAX_TOOLS_PER_CALLER + 3; i++) {
			await m.mutation(toolUsage.record, { toolName: `tool_${i}` });
		}
		expect(await rowsOf(t)).toHaveLength(MAX_TOOLS_PER_CALLER);
	});
});
