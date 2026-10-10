/// <reference types="vite/client" />
/**
 * messages:listByChannel for the operator, in both shapes the dashboard
 * produces: the Clerk template WITHOUT an org claim (today) and WITH one
 * (org admin of the operator org, once the template carries org_slug/org_role).
 * Dashboard call: useQuery(api.messages.listByChannel, {}) — measured at
 * vantage-peers-dashboard origin/main e2dc58f, unified-activity-feed.tsx:153.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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
type Identity = Parameters<T["withIdentity"]>[0];
const ORG = "operator-lbc-org";

async function seed(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			allowedOrchestrators: ["prometheus", "sigma", "pi"],
			scopes: ["view-own-tasks"],
			displayName: ORG,
			isActive: true,
			createdAt: Date.now(),
			orgKind: "operator",
		});
		await ctx.db.insert("messages", {
			from: "sigma",
			channel: "pi",
			content: "fleet row without tenant",
			createdAt: Date.now(),
		});
		await ctx.db.insert("messages", {
			from: "sigma",
			channel: "broadcast",
			tenantId: ORG,
			tenantOrgId: testClerkOrgId(ORG),
			content: "tenant row",
			createdAt: Date.now() + 1,
		});
	});
}

describe("messages.listByChannel {} for the operator", () => {
	test("org admin of the operator org (org claim present) -> master, every row served", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const rows = await t
			.withIdentity({
				subject: "op",
				org_slug: ORG,
				org_id: testClerkOrgId(ORG),
				org_role: "org:admin",
			} as Identity)
			.query(api.messages.listByChannel, {});
		expect(Array.isArray(rows) ? rows : rows.items).toHaveLength(2);
	});

	test("signed in, template carries NO org claim -> typed refusal envelope, not a Server Error", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const r = await t
			.withIdentity({ subject: "op" } as Identity)
			.query(api.messages.listByChannel, {});
		expect(r).toEqual({ refused: true, items: [] });
	});

	test("CAUSE: listByChannel rejects the paginationOpts usePaginatedQuery injects, before its handler runs", async () => {
		const t = createT();
		await seed(t);
		let message = "";
		try {
			await t
				.withIdentity({
					subject: "op",
					org_slug: ORG,
					org_id: testClerkOrgId(ORG),
					org_role: "org:admin",
				} as Identity)
				.query(api.messages.listByChannel, {
					paginationOpts: { numItems: 25, cursor: null },
					from: "sigma",
				} as never);
		} catch (e) {
			message = e instanceof Error ? e.message : String(e);
		}
		expect(message).toContain("paginationOpts");
	});
});

const OTHER_ORG = "other-lbc-org";
const MEMBER_ORG = "member-lbc-org";

async function seedHistory(t: T) {
	await t.run(async (ctx) => {
		const base = {
			scopes: ["view-own-tasks"],
			isActive: true,
			createdAt: Date.now(),
		};
		await ctx.db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: MEMBER_ORG,
			clerkOrgId: testClerkOrgId(MEMBER_ORG),
			displayName: MEMBER_ORG,
			allowedOrchestrators: ["phi"],
			orgKind: "client",
		});
		const row = (
			from: string,
			channel: string,
			tenantId: string | undefined,
			createdAt: number,
		) =>
			ctx.db.insert("messages", {
				from,
				channel,
				content: `${from}->${channel}@${createdAt}`,
				createdAt,
				...(tenantId ? { tenantId } : {}),
			});
		await row("sigma", "pi", undefined, 100);
		await row("sigma", "broadcast", ORG, 200);
		await row("pi", "phi", MEMBER_ORG, 300);
		await row("phi", "broadcast", MEMBER_ORG, 400);
		await row("pi", "sigma", MEMBER_ORG, 500); // off the member's roster
		await row("sigma", "broadcast", OTHER_ORG, 600); // another tenant
	});
}

const opId = {
	subject: "op",
	org_slug: ORG,
	org_id: testClerkOrgId(ORG),
	org_role: "org:admin",
} as Identity;
const memberId = {
	subject: "mem",
	org_slug: MEMBER_ORG,
	org_id: testClerkOrgId(MEMBER_ORG),
	org_role: "org:member",
} as Identity;

describe("messages.listByChannelPaginated — the history table's read", () => {
	test("operator-org admin (master): from + since/until in the index range", async () => {
		const t = createT();
		await seed(t);
		await seedHistory(t);
		const r = await t.withIdentity(opId).query(api.messages.listByChannelPaginated, {
			paginationOpts: { numItems: 25, cursor: null },
			from: "sigma",
			since: 150,
			until: 700,
		});
		expect(r.page.map((m) => m.createdAt).sort()).toEqual([200, 600]);
		expect(r.isDone).toBe(true);
		expect((r as { refused?: true }).refused).toBeUndefined();
	});

	test("operator-org admin: no filter walks every row across pages, none lost", async () => {
		const t = createT();
		await seed(t);
		await seedHistory(t);
		const seen: number[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 10; i++) {
			const r: { page: { createdAt: number }[]; isDone: boolean; continueCursor: string } =
				await t.withIdentity(opId).query(api.messages.listByChannelPaginated, {
					paginationOpts: { numItems: 2, cursor },
				});
			seen.push(...r.page.map((m) => m.createdAt));
			if (r.isDone) break;
			cursor = r.continueCursor;
		}
		// 2 rows from seed() + 6 from seedHistory()
		expect(seen).toHaveLength(8);
	});

	test("client-org member: own tenant, on its roster only, never another tenant", async () => {
		const t = createT();
		await seed(t);
		await seedHistory(t);
		const r = await t.withIdentity(memberId).query(api.messages.listByChannelPaginated, {
			paginationOpts: { numItems: 25, cursor: null },
		});
		expect(r.page.map((m) => m.createdAt).sort()).toEqual([300, 400]);
	});

	test("client-org member + from filter narrows within its tenant", async () => {
		const t = createT();
		await seed(t);
		await seedHistory(t);
		const r = await t.withIdentity(memberId).query(api.messages.listByChannelPaginated, {
			paginationOpts: { numItems: 25, cursor: null },
			from: "phi",
		});
		expect(r.page.map((m) => m.createdAt)).toEqual([400]);
	});

	test("signed in with no organisation -> empty page that SAYS it was refused", async () => {
		const t = createT();
		await seed(t);
		const r = await t.withIdentity({ subject: "x" } as Identity).query(
			api.messages.listByChannelPaginated,
			{ paginationOpts: { numItems: 25, cursor: null } },
		);
		expect(r).toEqual({
			page: [],
			isDone: true,
			continueCursor: "",
			refused: true,
		});
	});

	test("anonymous caller -> RBAC_DENIED, never an empty success", async () => {
		const t = createT();
		await seed(t);
		await expect(
			t.query(api.messages.listByChannelPaginated, {
				paginationOpts: { numItems: 25, cursor: null },
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
