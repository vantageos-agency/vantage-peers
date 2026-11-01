/// <reference types="vite/client" />
//
// Task k1703qfycdce9dj7hc1dn28nsh8hd5qj: rows a client seat filed in its own
// `project/<slug>` before #1640 (the master path stamped them nothing, so no member
// read serves them back). backfill_seat_memory_org_stamp stamps `clerkOrgId` ONLY
// when the creator is an agent of the org the slug names.
//   - OWN SEAT   a row by an agent of the org named by the slug  -> stamped;
//   - OTHER ORG  a row by another org's agent in that namespace   -> untouched;
//   - NON SEAT   a fleet agent's row, a person's row              -> untouched;
//   - SECOND RUN stamps 0; the DRY RUN writes nothing;
//   - the inventory prints counts and ids only, no content.
// Hermetic: no deployment is touched.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);
const mig = internal.migrations.backfill_seat_memory_org_stamp;
const NOW = 1_700_000_000_000;
const createT = () => convexTest({ schema, modules });
type T = ReturnType<typeof createT>;

const A = "bf-org-a";
const B = "bf-org-b";

type World = Record<
	"own" | "otherOrgCreator" | "fleetCreator" | "person" | "stamped" | "ownB" | "sub" | "teamNs",
	Id<"memories">
>;

async function seed(t: T): Promise<World> {
	return await t.run(async (ctx) => {
		const mapping = (slug: string, operator: boolean) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(operator ? { orgKind: "operator" as const } : {}),
			});
		await mapping("bf-fleet", true);
		await mapping(A, false);
		await mapping(B, false);
		const agent = (name: string, orgSlug: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: name.toLowerCase(),
				isActive: true,
				createdAt: NOW,
			});
		await agent("sigma", "bf-fleet");
		await agent("alice", A);
		await agent("bob", B);
		const row = (
			namespace: string,
			createdBy: string,
			extra: Record<string, unknown> = {},
		) =>
			ctx.db.insert("memories", {
				namespace,
				type: "project",
				content: `SECRET content of ${namespace} by ${createdBy}`,
				createdBy,
				relations: [],
				isLatest: true,
				createdAt: NOW + 10,
				updatedAt: NOW + 10,
				...extra,
			});
		return {
			own: await row(`project/${A}`, "alice"),
			sub: await row(`project/${A}/notes`, "alice"),
			otherOrgCreator: await row(`project/${A}`, "bob"),
			fleetCreator: await row(`project/${A}`, "sigma"),
			person: await row(`project/${A}`, "user:u1"),
			stamped: await row(`project/${A}`, "alice", { clerkOrgId: testClerkOrgId(A) }),
			ownB: await row(`project/${B}`, "bob"),
			teamNs: await row(`team/${testClerkOrgId(A)}`, "alice"),
		};
	});
}

const stampOf = (t: T, id: Id<"memories">) =>
	t.run(async (ctx) => (await ctx.db.get(id))?.clerkOrgId ?? null);

describe("backfill_seat_memory_org_stamp:run", () => {
	test("DRY RUN is the default and writes nothing", async () => {
		const t = createT();
		const w = await seed(t);
		const r = await t.mutation(mig.run, {});
		expect(r.dryRun).toBe(true);
		expect(r.toFill).toBe(3);
		expect(r.filled).toBe(0);
		expect(await stampOf(t, w.own)).toBeNull();
	});

	test("stamps the own-org seat rows only; other-org creator, fleet and person rows are untouched", async () => {
		const t = createT();
		const w = await seed(t);
		const r = await t.mutation(mig.run, { dryRun: false });
		expect(r.filled).toBe(3);
		expect(await stampOf(t, w.own)).toBe(testClerkOrgId(A));
		expect(await stampOf(t, w.sub)).toBe(testClerkOrgId(A));
		expect(await stampOf(t, w.ownB)).toBe(testClerkOrgId(B));
		expect(await stampOf(t, w.otherOrgCreator)).toBeNull();
		expect(await stampOf(t, w.fleetCreator)).toBeNull();
		expect(await stampOf(t, w.person)).toBeNull();
		expect(await stampOf(t, w.teamNs)).toBeNull();
		expect(r.skipped.creatorNotInOrg).toBe(2);
		expect(r.skipped.notSeat).toBe(1);
		expect(r.alreadyFilled).toBe(1);
	});

	test("the operator org's own project/ rows are fleet rows and are never stamped", async () => {
		const t = createT();
		await seed(t);
		const fleetRow = await t.run((ctx) =>
			ctx.db.insert("memories", {
				namespace: "project/bf-fleet",
				type: "project",
				content: "fleet",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: NOW + 10,
				updatedAt: NOW + 10,
			}),
		);
		const r = await t.mutation(mig.run, { dryRun: false });
		expect(r.skipped.operatorOrg).toBe(1);
		expect(await stampOf(t, fleetRow)).toBeNull();
	});

	test("a label that also names an agent of the operator org or another org is ambiguous and never stamped", async () => {
		const t = createT();
		await seed(t);
		const rows = await t.run(async (ctx) => {
			const agent = (name: string, orgSlug: string) =>
				ctx.db.insert("agents", {
					orgSlug,
					clerkOrgId: testClerkOrgId(orgSlug),
					name,
					normalizedName: name.toLowerCase(),
					isActive: true,
					createdAt: NOW,
				});
			await agent("neo", "bf-fleet");
			await agent("neo", A);
			await agent("zed", A);
			await agent("zed", B);
			const row = (createdBy: string) =>
				ctx.db.insert("memories", {
					namespace: `project/${A}`,
					type: "project",
					content: "x",
					createdBy,
					relations: [],
					isLatest: true,
					createdAt: NOW + 10,
					updatedAt: NOW + 10,
				});
			return { fleetNeo: await row("neo"), zedRow: await row("zed") };
		});
		const dry = await t.mutation(mig.run, {});
		expect(dry.skipped.creatorAmbiguous).toBe(2);
		const r = await t.mutation(mig.run, { dryRun: false });
		expect(r.skipped.creatorAmbiguous).toBe(2);
		expect(await stampOf(t, rows.fleetNeo)).toBeNull();
		expect(await stampOf(t, rows.zedRow)).toBeNull();
		const inv = await t.query(mig.inventory, {});
		const names = inv.orgs.find((o) => o.slug === A)?.creators ?? [];
		expect(names.find((c) => c.name === "neo")?.count).toBe(1);
		expect(JSON.stringify(inv)).not.toContain("SECRET");
	});

	test("a second run stamps 0", async () => {
		const t = createT();
		await seed(t);
		await t.mutation(mig.run, { dryRun: false });
		const again = await t.mutation(mig.run, { dryRun: false });
		expect(again.toFill).toBe(0);
		expect(again.filled).toBe(0);
	});

	test("batched: a pageSize of 2 walks every row once and reaches the same result", async () => {
		const t = createT();
		const w = await seed(t);
		let cursor: string | null = null;
		let filled = 0;
		for (let i = 0; i < 20; i++) {
			const r: { filled: number; isDone: boolean; nextCursor: string | null } =
				await t.mutation(mig.run, { dryRun: false, pageSize: 2, cursor });
			filled += r.filled;
			if (r.isDone) break;
			cursor = r.nextCursor;
		}
		expect(filled).toBe(3);
		expect(await stampOf(t, w.own)).toBe(testClerkOrgId(A));
	});
});

describe("backfill_seat_memory_org_stamp:inventory", () => {
	test("prints per org the counts and at most 3 ids, and no content", async () => {
		const t = createT();
		const w = await seed(t);
		const inv = await t.query(mig.inventory, {});
		const a = inv.orgs.find((o) => o.slug === A);
		expect(a?.unstamped).toBe(5);
		expect(a?.wouldStamp).toBe(2);
		expect(a?.sampleIds.length).toBe(3);
		expect(inv.orgs.find((o) => o.slug === B)?.wouldStamp).toBe(1);
		expect(inv.alreadyStamped).toBe(1);
		expect(JSON.stringify(inv)).not.toContain("SECRET");
		expect(await stampOf(t, w.own)).toBeNull();
	});
});
