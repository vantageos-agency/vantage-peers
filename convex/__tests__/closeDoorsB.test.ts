/**
 * closeDoorsB — public reads that never consulted the verified caller, or
 * consulted it and let any caller through. One file, per door:
 *   - ANONYMOUS + valid args  -> refused, the code asserted BY CONTENT
 *   - ordinary org MEMBER (never master) -> STILL SERVED its own data   (a)
 *   - member of another org / not on the channel -> does not get the rows (a)
 *   - master-only doors (b): an ordinary member is refused `not-fleet-master`
 *
 * Master identity is used ONLY as an ALLOW pole, never to prove a denial.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Ident = Parameters<ReturnType<typeof createT>["withIdentity"]>[0];

const asMemberA = (t: T) =>
	t.withIdentity({
		subject: "member-of-org-a",
		organizationId: "org-a",
		organizationSlug: "org-a",
	} as Ident);
const asMemberB = (t: T) =>
	t.withIdentity({
		subject: "member-of-org-b",
		organizationId: "org-b",
		organizationSlug: "org-b",
	} as Ident);
const asPreOrg = (t: T) =>
	t.withIdentity({ subject: "signed-in-no-org" } as Ident);
const asMaster = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Ident);

const seedMappings = (t: T) =>
	t.run(async (ctx) => {
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: slug === "org-a" ? ["sigma"] : ["iris"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});

/** Error content a caller can branch on (ConvexError data, else message). */
async function failure(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const err = e as { data?: unknown; message?: string };
		return typeof err.data === "string" ? err.data : String(err.message ?? e);
	}
	return "";
}

const refusedAs = (msg: string, door: string, reason?: string) => {
	expect(msg).toContain("RBAC_DENIED");
	expect(msg).toContain(door);
	if (reason !== undefined) expect(msg).toContain(reason);
};

const seedMsg = (t: T, channel: string, tenantId: string | undefined) =>
	t.run(async (ctx) =>
		ctx.db.insert("messages", {
			from: "sigma",
			channel,
			content: `row on ${channel} / ${tenantId ?? "fleet"}`,
			createdAt: Date.now(),
			...(tenantId !== undefined ? { tenantId } : {}),
		}),
	);

// ───────────────────────── messages:listByChannel ─────────────────────────
describe("messages:listByChannel — broadcast is tenant-scoped, not a universal grant", () => {
	test("anonymous refused; member A served own broadcast; member B NOT served A's; master sees all", async () => {
		const t = createT();
		await seedMappings(t);
		await seedMsg(t, "broadcast", "org-a");
		await seedMsg(t, "broadcast", "org-b");
		await seedMsg(t, "broadcast", undefined); // fleet-internal broadcast

		refusedAs(
			await failure(t.query(api.messages.listByChannel, { channel: "broadcast" })),
			"messages:listByChannel",
			"no-credential",
		);

		const a = (await asMemberA(t).query(api.messages.listByChannel, {
			channel: "broadcast",
		})) as Array<{ content: string; tenantId?: string }>;
		expect(a.map((r) => r.tenantId)).toEqual(["org-a"]);

		const b = (await asMemberB(t).query(api.messages.listByChannel, {
			channel: "broadcast",
		})) as Array<{ tenantId?: string }>;
		expect(b.map((r) => r.tenantId)).toEqual(["org-b"]);

		// unspecified channel: still own tenant only
		const aAll = (await asMemberA(t).query(api.messages.listByChannel, {})) as Array<{
			tenantId?: string;
		}>;
		expect(aAll.map((r) => r.tenantId)).toEqual(["org-a"]);

		const m = (await asMaster(t).query(api.messages.listByChannel, {
			channel: "broadcast",
		})) as unknown[];
		expect(m).toHaveLength(3);
	});

	test("member is not served a channel outside its roster; pre-org gets the typed envelope, never a throw", async () => {
		const t = createT();
		await seedMappings(t);
		await seedMsg(t, "iris", "org-a"); // org-a row on a channel NOT on org-a's roster
		await seedMsg(t, "sigma", "org-a");
		const own = (await asMemberA(t).query(api.messages.listByChannel, {
			channel: "sigma",
		})) as unknown[];
		expect(own).toHaveLength(1);
		const off = await asMemberA(t).query(api.messages.listByChannel, { channel: "iris" });
		expect(off).toEqual([]);
		const pre = await asPreOrg(t).query(api.messages.listByChannel, {});
		expect(pre).toEqual({ refused: true, items: [] });
	});
});

// ─────────────────────────── messages:getById ───────────────────────────
describe("messages:getById", () => {
	test("anonymous refused; member A served own; member B refused cross-tenant; fleet-tenantless row refused to member; master served", async () => {
		const t = createT();
		await seedMappings(t);
		const idA = await seedMsg(t, "broadcast", "org-a");
		const idFleet = await seedMsg(t, "broadcast", undefined);

		refusedAs(
			await failure(t.query(api.messages.getById, { messageId: idA })),
			"messages:getById",
			"no-credential",
		);
		const own = await asMemberA(t).query(api.messages.getById, { messageId: idA });
		expect(own?.tenantId).toBe("org-a");
		refusedAs(
			await failure(asMemberB(t).query(api.messages.getById, { messageId: idA })),
			"messages:getById",
			"cross-tenant",
		);
		refusedAs(
			await failure(asMemberA(t).query(api.messages.getById, { messageId: idFleet })),
			"messages:getById",
			"cross-tenant",
		);
		expect(
			(await asMaster(t).query(api.messages.getById, { messageId: idFleet }))?._id,
		).toBe(idFleet);
	});
});

// ─────────────────────────── messages:getUnreadCount ───────────────────────────
describe("messages:getUnreadCount", () => {
	test("anonymous refused; member A counts only its own tenant; member B does not see A's; master counts the fleet only", async () => {
		const t = createT();
		await seedMappings(t);
		const mA = await seedMsg(t, "sigma", "org-a");
		const mB = await seedMsg(t, "sigma", "org-b");
		await t.run(async (ctx) => {
			await ctx.db.insert("messageReceipts", { messageId: mA, recipient: "sigma", tenantId: "org-a" });
			await ctx.db.insert("messageReceipts", { messageId: mA, recipient: "sigma", tenantId: "org-a" });
			await ctx.db.insert("messageReceipts", { messageId: mB, recipient: "sigma", tenantId: "org-b" });
			await ctx.db.insert("messageReceipts", { messageId: mB, recipient: "iris", tenantId: "org-b" });
		});

		refusedAs(
			await failure(t.query(api.messages.getUnreadCount, { orchestratorId: "sigma" })),
			"messages:getUnreadCount",
			"no-credential",
		);
		expect(await asMemberA(t).query(api.messages.getUnreadCount, { orchestratorId: "sigma" })).toBe(2);
		// own roster -> a number (member B's roster is ["iris"]); a differently
		// spelled own-roster name binds on the normalised form
		expect(await asMemberB(t).query(api.messages.getUnreadCount, { orchestratorId: "iris" })).toBe(1);
		expect(await asMemberB(t).query(api.messages.getUnreadCount, { orchestratorId: " IRIS " })).toBe(1);
		// off-roster: B's own tenant holds a "sigma" receipt, yet "sigma" is not on
		// B's roster -> the typed envelope, not a bare 0 and not that receipt's 1
		expect(await asMemberB(t).query(api.messages.getUnreadCount, { orchestratorId: "sigma" })).toEqual({
			refused: true,
			count: 0,
		});
		// The service account by NAME counts the FLEET's tenant only (task
		// k17c5q842gm1gbh0j2qjtc80g18fx5kb): neither org's receipts are the fleet's.
		expect(await asMaster(t).query(api.messages.getUnreadCount, { orchestratorId: "sigma" })).toBe(0);
		// A client org's count is taken through its VERIFIED org, not through a name.
		expect(
			await asMaster(t).query(api.messages.getUnreadCount, {
				orchestratorId: "sigma",
				verifiedOrg: { orgSlug: "org-a" },
			}),
		).toBe(2);
		// pre-org: a mounted sidebar cannot take a throw, and a bare 0 would be the
		// bytes of an absence, so the refusal is the typed envelope.
		expect(await asPreOrg(t).query(api.messages.getUnreadCount, { orchestratorId: "sigma" })).toEqual({
			refused: true,
			count: 0,
		});
	});
});

describe("messages:getUnreadCount served zero", () => {
	test("a SERVED caller with nothing unread gets a bare 0, never the refusal envelope", async () => {
		const t = createT();
		await seedMappings(t);
		const mA = await seedMsg(t, "sigma", "org-a");
		await t.run(async (ctx) => {
			// a receipt that is already read: present in the table, not unread
			await ctx.db.insert("messageReceipts", {
				messageId: mA,
				recipient: "sigma",
				tenantId: "org-a",
				readAt: 1,
			});
		});
		// member, own roster, all read -> 0
		expect(await asMemberA(t).query(api.messages.getUnreadCount, { orchestratorId: "sigma" })).toBe(0);
		// member, own roster, no receipts at all -> 0 (member B's roster is ["iris"])
		expect(await asMemberB(t).query(api.messages.getUnreadCount, { orchestratorId: "iris" })).toBe(0);
		// fleet master, nothing unread for that recipient -> 0
		expect(await asMaster(t).query(api.messages.getUnreadCount, { orchestratorId: "nobody" })).toBe(0);
	});
});

// ───────────────────────────── profiles:getProfile ─────────────────────────────
describe("profiles:getProfile", () => {
	test("anonymous + pre-org refused; member served a rostered orchestrator, refused an off-roster one; master served", async () => {
		const t = createT();
		await seedMappings(t);
		await t.run(async (ctx) => {
			for (const id of ["sigma", "iris"]) {
				await ctx.db.insert("profiles", {
					orchestratorId: id,
					name: id,
					static: { role: "x", workspace: "/x", capabilities: [] },
					dynamic: { lastSeen: 1, sessionCount: 1 },
				});
			}
		});
		refusedAs(
			await failure(t.query(api.profiles.getProfile, { orchestratorId: "sigma" })),
			"profiles:getProfile",
			"no-credential",
		);
		refusedAs(
			await failure(asPreOrg(t).query(api.profiles.getProfile, { orchestratorId: "sigma" })),
			"profiles:getProfile",
			"no-verified-organisation",
		);
		const own = await asMemberA(t).query(api.profiles.getProfile, { orchestratorId: "sigma" });
		expect(own?.orchestratorId).toBe("sigma");
		refusedAs(
			await failure(asMemberA(t).query(api.profiles.getProfile, { orchestratorId: "iris" })),
			"profiles:getProfile",
			"not-on-roster",
		);
		expect(
			(await asMaster(t).query(api.profiles.getProfile, { orchestratorId: "iris" }))?.orchestratorId,
		).toBe("iris");
	});
});

// ───────────────────── mandates:get / validateSpending (b) ─────────────────────
describe("mandates:get and mandates:validateSpending — master-only", () => {
	test("anonymous refused; ordinary member refused not-fleet-master; master served", async () => {
		const t = createT();
		await seedMappings(t);
		const id = await t.run(async (ctx) =>
			ctx.db.insert("mandates", {
				requestedBy: "pi",
				fulfilledBy: "sigma",
				service: "spend",
				budget: 1000,
				status: "requested",
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		for (const [fn, args, door] of [
			[api.mandates.get, { mandateId: id as string }, "mandates:get"],
			[api.mandates.validateSpending, { mandateId: id, proposedAmount: 5 }, "mandates:validateSpending"],
		] as const) {
			// biome-ignore lint/suspicious/noExplicitAny: two distinct query refs in one loop
			const q = fn as any;
			refusedAs(await failure(t.query(q, args)), door, "no-credential");
			refusedAs(await failure(asMemberA(t).query(q, args)), door, "not-fleet-master");
			refusedAs(await failure(asPreOrg(t).query(q, args)), door, "not-fleet-master");
		}
		expect((await asMaster(t).query(api.mandates.get, { mandateId: id }))?._id).toBe(id);
		const v = await asMaster(t).query(api.mandates.validateSpending, { mandateId: id, proposedAmount: 5 });
		expect(v.withinLimits).toBe(true);
	});
});

// ─────────────────────── okfBundleNode:validateOkfBundle ───────────────────────
describe("okfBundleNode:validateOkfBundle — an absent identity is refused, not waved through", () => {
	test("anonymous refused; an org member passes the gate (reaches input validation)", async () => {
		const t = createT();
		const args = { bundleUrl: null, storageId: null };
		refusedAs(
			await failure(t.action(api.okfBundleNode.validateOkfBundle, args)),
			"okfBundleNode:validateOkfBundle",
			"no-credential",
		);
		const member = await failure(asMemberA(t).action(api.okfBundleNode.validateOkfBundle, args));
		expect(member).toContain("OKF_VALIDATE_INPUT_MISSING");
		expect(member).not.toContain("RBAC_DENIED");
	});
});

// ───────────── okfBundleDurable:getOkfBundleExportDurableStatus ─────────────
describe("okfBundleDurable:getOkfBundleExportDurableStatus", () => {
	const seedJob = (t: T) =>
		t.run(async (ctx) =>
			ctx.db.insert("okfDurableExportProgress", {
				jobId: "job-org-a",
				orgId: "team/org-a",
				namespace: "team/org-a",
				memoriesCursor: null,
				memoriesDone: false,
				briefingsCursor: null,
				briefingsDone: false,
				tasksCursor: null,
				tasksDone: false,
				memoryCount: 0,
				briefingCount: 0,
				taskCount: 0,
				stepsCompleted: 0,
				status: "running",
				createdAt: 1,
				updatedAt: 1,
			}),
		);

	test("anonymous refused; member of ANOTHER org refused; unknown job refused; owner passes the gate", async () => {
		const t = createT();
		await seedMappings(t);
		await seedJob(t);
		const args = { jobId: "job-org-a" };
		refusedAs(
			await failure(t.query(api.okfBundleDurable.getOkfBundleExportDurableStatus, args)),
			"okfBundleDurable:getOkfBundleExportDurableStatus",
			"no-credential",
		);
		expect(
			await failure(asMemberB(t).query(api.okfBundleDurable.getOkfBundleExportDurableStatus, args)),
		).toContain("RBAC_DENIED");
		expect(
			await failure(
				asMemberA(t).query(api.okfBundleDurable.getOkfBundleExportDurableStatus, { jobId: "nope" }),
			),
		).toContain("OKF_DURABLE_JOB_NOT_FOUND");
		// Owner clears every gate; the engine component boundary is then the only
		// thing left to fail in convex-test (see okfBundleDurable.test.ts), and it
		// is not an authorisation failure.
		const owner = await failure(
			asMemberA(t).query(api.okfBundleDurable.getOkfBundleExportDurableStatus, args),
		);
		expect(owner).not.toMatch(/RBAC_DENIED|AUTH_|OKF_DURABLE_JOB_NOT_FOUND/);
	});
});
