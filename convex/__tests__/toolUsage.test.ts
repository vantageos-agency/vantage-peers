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
			await code(bob.query(toolUsage.getToolUsage, { verifiedOrg: { orgSlug: A } })),
		).toBe("RBAC_DENIED");
		// An admin of B naming alice's key reads B's rows for that key: none.
		expect(
			await bob.query(toolUsage.getToolUsage, { caller: "user:alice-sub" }),
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
			caller: "user:alice-sub",
		})) as Row[];
		expect(got.map((r) => r.tool)).toEqual(["store_memory"]);
		const peer = member(t, A, "carol-sub");
		expect(
			await code(
				peer.query(toolUsage.getToolUsage, { caller: "user:alice-sub" }),
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
			verifiedOrg: { orgSlug: A },
			caller: "user:alice-sub",
		})) as Row[];
		expect(got).toHaveLength(1);
		// A master naming no organisation is told so, not served a guess.
		expect(
			await code(
				service(t).query(toolUsage.getToolUsage, {
					caller: "user:alice-sub",
				}),
			),
		).not.toBe("SERVED");
	});

	test("service account acting for org A: records an agent seat, reads its own rows", async () => {
		const t = createT();
		await seed(t);
		const [seatId] = await seedOwner(t, A, "seat-owner", ["seat"]);
		const seat = `agent:${seatId}`;
		expect(
			await service(t).mutation(toolUsage.record, {
				toolName: "list_tasks",
				caller: seat,
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
					caller: "user:alice-sub",
				}),
			),
		).toBe("RBAC_DENIED");
		// Acting for org B, org A's seat key is refused (not an empty list).
		expect(
			await code(
				service(t).query(toolUsage.getToolUsage, {
					__actingOrg: B_ID,
					selfKey: seat,
				}),
			),
		).toBe("RBAC_DENIED");
	});

	test("IDENTITY: the recorder writes nothing for a missing identity or an unscoped fleet call", async () => {
		const t = createT();
		await seed(t);
		expect(
			await t.mutation(toolUsage.record, { toolName: "store_memory" }),
		).toEqual({ recorded: false });
		// R-54: the service account that names no organisation is REFUSED, never
		// recorded under a guess and never served as master.
		expect(
			await code(
				service(t).mutation(toolUsage.record, {
					toolName: "store_memory",
					caller: "agent:x",
				}),
			),
		).toBe("RBAC_DENIED");
		expect(await rowsOf(t)).toHaveLength(0);
	});

	test("IDENTITY: a malformed tool name or caller key records nothing", async () => {
		const t = createT();
		await seed(t);
		for (const bad of [
			{ toolName: "", caller: "agent:x" },
			{ toolName: "has space", caller: "agent:x" },
			{ toolName: "x".repeat(200), caller: "agent:x" },
			{ toolName: "ok_tool", caller: "nokind" },
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
			caller: "user:alice-sub",
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

// ─────────────────────────────────────────────────────────────────────────────
// usageByOwner: a person owns several agents (one per AI client); the onboarding
// engine reads the person's combined usage. Requirement update from angelia.
// ─────────────────────────────────────────────────────────────────────────────

async function seedOwner(t: T, org: string, owner: string, names: string[]) {
	return await t.run(async (ctx) => {
		const ids: string[] = [];
		for (const name of names) {
			ids.push(
				await ctx.db.insert("agents", {
					orgSlug: org,
					clerkOrgId: testClerkOrgId(org),
					name,
					normalizedName: name,
					isActive: true,
					personalAgentOf: owner,
					createdAt: 0,
				}),
			);
		}
		return ids;
	});
}

const addMember = (t: T, org: string, user: string) =>
	t.run(async (ctx) => {
		await ctx.db.insert("orgMembership", {
			clerkOrgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			clerkUserId: user,
			role: "member",
			createdAt: 1,
			updatedAt: 1,
		});
	});

const engine = (t: T, org: string, args: Record<string, unknown>) =>
	service(t).query(toolUsage.usageByOwner, {
		...args,
		__actingOrg: testClerkOrgId(org),
	});

describe("toolUsage:usageByOwner", () => {
	test("PRESENT: an owner with 2 agents plus direct calls is aggregated (min/max/sum)", async () => {
		const t = createT();
		await seed(t);
		const [a1, a2] = await seedOwner(t, A, "owner-sub", ["claude", "chatgpt"]);
		vi.setSystemTime(1_000);
		await service(t).mutation(toolUsage.record, {
			toolName: "store_memory",
			caller: `agent:${a1}`,
			__actingOrg: A_ID,
		});
		vi.setSystemTime(3_000);
		await service(t).mutation(toolUsage.record, {
			toolName: "store_memory",
			caller: `agent:${a2}`,
			__actingOrg: A_ID,
		});
		await service(t).mutation(toolUsage.record, {
			toolName: "check_messages",
			caller: `agent:${a2}`,
			__actingOrg: A_ID,
		});
		vi.setSystemTime(2_000);
		await member(t, A, "owner-sub").mutation(toolUsage.record, {
			toolName: "store_memory",
		});
		const got = (await engine(t, A, { ownerUserId: "owner-sub" })) as Row[];
		const by = Object.fromEntries(got.map((r) => [r.tool, r]));
		expect(by.store_memory).toEqual({
			tool: "store_memory",
			firstAt: 1_000,
			lastAt: 3_000,
			count: 3,
		});
		expect(by.check_messages.count).toBe(1);
	});

	test("ABSENT: a member of the org with no agents and no calls is an empty SUCCESS", async () => {
		const t = createT();
		await seed(t);
		await addMember(t, A, "quiet-sub");
		expect(await engine(t, A, { ownerUserId: "quiet-sub" })).toEqual([]);
	});

	test("REFUSED: an owner who is not in the organisation in scope is RBAC_DENIED", async () => {
		const t = createT();
		await seed(t);
		await seedOwner(t, B, "b-owner", ["claude"]);
		await addMember(t, B, "b-owner");
		expect(await code(engine(t, A, { ownerUserId: "b-owner" }))).toBe(
			"RBAC_DENIED",
		);
		// The org-scoped caller of B naming org A is refused too.
		expect(
			await code(engine(t, B, { ownerUserId: "b-owner", verifiedOrg: { orgSlug: A } })),
		).toBe("RBAC_DENIED");
	});

	test("REFUSED: no credential raises RBAC_DENIED", async () => {
		const t = createT();
		await seed(t);
		expect(
			await code(t.query(toolUsage.usageByOwner, { ownerUserId: "x" })),
		).toBe("RBAC_DENIED");
	});

	test("members do not read each other; the owner reads itself; an admin reads a member", async () => {
		const t = createT();
		await seed(t);
		await seedOwner(t, A, "owner-sub", ["claude"]);
		await addMember(t, A, "owner-sub");
		expect(
			await code(
				member(t, A, "peer-sub").query(toolUsage.usageByOwner, {
					ownerUserId: "owner-sub",
				}),
			),
		).toBe("RBAC_DENIED");
		expect(
			await member(t, A, "owner-sub").query(toolUsage.usageByOwner, {
				ownerUserId: "owner-sub",
			}),
		).toEqual([]);
		expect(
			await member(t, A, "boss-sub", "org:admin").query(
				toolUsage.usageByOwner,
				{ ownerUserId: "owner-sub" },
			),
		).toEqual([]);
	});

	test("the engine may name its organisation by claim instead of the acting org; the claim of another organisation is refused", async () => {
		const t = createT();
		await seed(t);
		await seedOwner(t, A, "owner-sub", ["claude"]);
		expect(
			await service(t).query(toolUsage.usageByOwner, {
				ownerUserId: "owner-sub",
				verifiedOrg: { orgSlug: A },
			}),
		).toEqual([]);
		expect(
			await code(
				service(t).query(toolUsage.usageByOwner, {
					ownerUserId: "owner-sub",
					verifiedOrg: { orgSlug: B },
					__actingOrg: A_ID,
				}),
			),
		).toBe("RBAC_DENIED");
		// A Clerk session cannot name an organisation by claim.
		expect(
			await code(
				member(t, A, "boss-sub", "org:admin").query(toolUsage.usageByOwner, {
					ownerUserId: "owner-sub",
					verifiedOrg: { orgSlug: B },
				}),
			),
		).toBe("RBAC_DENIED");
	});

	test("a seat (acting-org service WITH its own key) is not the engine: it cannot read its owner", async () => {
		const t = createT();
		await seed(t);
		const [a1] = await seedOwner(t, A, "owner-sub", ["claude"]);
		expect(
			await code(
				service(t).query(toolUsage.usageByOwner, {
					ownerUserId: "owner-sub",
					selfKey: `agent:${a1}`,
					__actingOrg: A_ID,
				}),
			),
		).toBe("RBAC_DENIED");
	});

	test("the fleet master names the organisation", async () => {
		const t = createT();
		await seed(t);
		await seedOwner(t, A, "owner-sub", ["claude"]);
		expect(
			await service(t).query(toolUsage.usageByOwner, {
				ownerUserId: "owner-sub",
				verifiedOrg: { orgSlug: A },
			}),
		).toEqual([]);
		expect(
			await code(
				service(t).query(toolUsage.usageByOwner, { ownerUserId: "owner-sub" }),
			),
		).not.toBe("SERVED");
	});
});

describe("a person token (verifiedPerson) records and reads as the person", () => {
	const HASH = "p".repeat(64);
	async function seedPersonToken(t: T, org: string, role: string) {
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: HASH,
				clientId: "c",
				userId: "user_person",
				scopes: ["vantage:read", "vantage:write"],
				scopeProfile: "person",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: 4_000_000_000_000,
				createdAt: 1,
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				orgRole: role,
				principal: "person",
			});
		});
	}

	test("the recorder files under user:<token subject>, ignoring a typed key", async () => {
		const t = createT();
		await seed(t);
		await seedPersonToken(t, A, "org:member");
		expect(
			await service(t).mutation(toolUsage.record, {
				toolName: "store_memory",
				caller: "agent:spoofed",
				verifiedPerson: { accessTokenHash: HASH },
				verifiedOrg: { orgSlug: A },
				__actingOrg: A_ID,
			}),
		).toEqual({ recorded: true });
		expect((await rowsOf(t)).map((r) => r.callerKey)).toEqual([
			"user:user_person",
		]);
		// The person reads itself back with the same proof.
		const got = (await service(t).query(toolUsage.getToolUsage, {
			verifiedPerson: { accessTokenHash: HASH },
			verifiedOrg: { orgSlug: A },
			__actingOrg: A_ID,
		})) as Row[];
		expect(got.map((r) => r.tool)).toEqual(["store_memory"]);
	});

	test("a verifiedOrg naming another organisation than the token's is RBAC_DENIED", async () => {
		const t = createT();
		await seed(t);
		await seedPersonToken(t, A, "org:member");
		expect(
			await code(
				service(t).query(toolUsage.getToolUsage, {
					verifiedPerson: { accessTokenHash: HASH },
					verifiedOrg: { orgSlug: B },
				}),
			),
		).toBe("RBAC_DENIED");
	});

	test("an admin person token reads another member; a member person token does not", async () => {
		const t = createT();
		await seed(t);
		await member(t, A, "alice-sub").mutation(toolUsage.record, {
			toolName: "store_memory",
		});
		await seedPersonToken(t, A, "org:admin");
		const asAdmin = (await service(t).query(toolUsage.getToolUsage, {
			verifiedPerson: { accessTokenHash: HASH },
			verifiedOrg: { orgSlug: A },
			caller: "user:alice-sub",
		})) as Row[];
		expect(asAdmin).toHaveLength(1);
		const t2 = createT();
		await seed(t2);
		await seedPersonToken(t2, A, "org:member");
		expect(
			await code(
				service(t2).query(toolUsage.getToolUsage, {
					verifiedPerson: { accessTokenHash: HASH },
					verifiedOrg: { orgSlug: A },
					caller: "user:alice-sub",
				}),
			),
		).toBe("RBAC_DENIED");
	});
});

describe("a forwarded agent key must belong to the verified organisation", () => {
	test("seat of org A presenting org B is refused and nothing is recorded", async () => {
		const t = createT();
		await seed(t);
		const [aSeat] = await seedOwner(t, A, "a-owner", ["a-seat"]);
		// Acting for org B with org A's agent key.
		expect(
			await code(
				service(t).mutation(toolUsage.record, {
					toolName: "store_memory",
					caller: `agent:${aSeat}`,
					verifiedOrg: { orgSlug: B },
					__actingOrg: B_ID,
				}),
			),
		).toBe("RBAC_DENIED");
		expect(await rowsOf(t)).toHaveLength(0);
		// The same key presented for its own org is recorded.
		expect(
			await service(t).mutation(toolUsage.record, {
				toolName: "store_memory",
				caller: `agent:${aSeat}`,
				verifiedOrg: { orgSlug: A },
				__actingOrg: A_ID,
			}),
		).toEqual({ recorded: true });
		// Reading as that seat from org B is refused too.
		expect(
			await code(
				service(t).query(toolUsage.getToolUsage, {
					selfKey: `agent:${aSeat}`,
					__actingOrg: B_ID,
				}),
			),
		).toBe("RBAC_DENIED");
	});

	test("an agent id that is not a row, or is malformed, is refused", async () => {
		const t = createT();
		await seed(t);
		for (const key of ["agent:nosuchrow", `agent:${"y".repeat(400)}`]) {
			expect(
				await code(
					service(t).mutation(toolUsage.record, {
						toolName: "store_memory",
						caller: key,
						__actingOrg: A_ID,
					}),
				),
			).toBe("RBAC_DENIED");
		}
		expect(await rowsOf(t)).toHaveLength(0);
	});
});
