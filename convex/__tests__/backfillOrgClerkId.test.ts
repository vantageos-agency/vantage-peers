/// <reference types="vite/client" />
//
// Org identity by Clerk org ID (Pi ruling (d), task k174d95s5qqy8t2r5rdrz3pr3d8fqv82),
// EXPAND phase. Three things are pinned, each in both directions:
//   1. backfill_org_clerk_id fills a row's id column from its slug's mapping, in a dry
//      run (counts only) and a real run (writes), and leaves an undecidable row
//      unfilled and listed by id (never guessed);
//   2. a NEW write stamps the slug AND the id, from the mapping of the verified org;
//   3. the operator org maps like any other org.
// Hermetic: no deployment is touched. Fictitious identifiers only.

import type { FunctionReturnType } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
	type OrgIdTable,
	ORG_COLUMNS,
	TABLE_ORDER,
} from "../migrations/backfill_org_clerk_id";
import schema from "../schema";
import { agentIdOf } from "../../tests/lib/agentIdOf";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const run = internal.migrations.backfill_org_clerk_id.run;
const NOW = 1_700_000_000_000;
const SEAT = "seat-x";

const OPERATOR = { slug: "fleet-org", id: "org_FLEET1" };
const ACME = { slug: "acme-hr", id: "org_ACME1" };

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Result = FunctionReturnType<typeof run>;

const asOrg = (t: T, slug: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
	} as Parameters<T["withIdentity"]>[0]);
const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_role: "org:admin",
	} as Parameters<T["withIdentity"]>[0]);

async function seedMappings(t: T) {
	await t.run(async (ctx) => {
		const mapping = (
			slug: string,
			extra: { clerkOrgId?: string; operator?: boolean } = {},
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [SEAT],
				scopes: ["view-own-tasks", "view-own-missions"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(extra.clerkOrgId !== undefined
					? { clerkOrgId: extra.clerkOrgId }
					: {}),
				...(extra.operator ? { orgKind: "operator" as const } : {}),
			});
		await mapping(OPERATOR.slug, { clerkOrgId: OPERATOR.id, operator: true });
		await mapping(ACME.slug, { clerkOrgId: ACME.id });
		// A mapping whose id has not been filled yet.
		await mapping("not-filled-yet");
		// Two mapping rows for one slug: ambiguous, never decided.
		await mapping("twice", { clerkOrgId: "org_TWICE1" });
		await mapping("twice", { clerkOrgId: "org_TWICE2" });
	});
}

const mission = (orgId: string | undefined, name: string) => ({
	name,
	project: "p",
	status: "execute" as const,
	priority: "medium" as const,
	pilot: "x",
	agents: [],
	createdBy: SEAT,
	...(orgId === undefined ? {} : { orgId }),
	createdAt: NOW,
	updatedAt: NOW,
});

async function seedMissions(t: T) {
	return await t.run(async (ctx) => ({
		acme: await ctx.db.insert("missions", mission(ACME.slug, "acme")),
		operator: await ctx.db.insert(
			"missions",
			mission(OPERATOR.slug, "operator"),
		),
		ghost: await ctx.db.insert("missions", mission("ghost-org", "ghost")),
		notFilled: await ctx.db.insert("missions", mission("not-filled-yet", "nf")),
		twice: await ctx.db.insert("missions", mission("twice", "twice")),
		fleet: await ctx.db.insert("missions", mission(undefined, "fleet")),
		already: await ctx.db.insert("missions", {
			...mission(ACME.slug, "already"),
			clerkOrgId: "org_KEPT1",
		}),
	}));
}

// One table, to the end.
async function walkTable(
	t: T,
	table: OrgIdTable,
	dryRun: boolean,
	pageSize?: number,
) {
	const total = {
		examined: 0,
		alreadyFilled: 0,
		noSlug: 0,
		toFill: 0,
		filled: 0,
		undecidableRows: [] as Result["undecidableRows"],
		byReason: { orgUnmapped: 0, ambiguousMapping: 0, mappingHasNoClerkId: 0 },
	};
	let cursor: string | null = null;
	let guard = 0;
	for (;;) {
		if (++guard > 100) throw new Error("walk did not terminate");
		const r: Result = await t.mutation(run, {
			table,
			dryRun,
			cursor,
			pageSize,
		});
		total.examined += r.examined;
		total.alreadyFilled += r.alreadyFilled;
		total.noSlug += r.noSlug;
		total.toFill += r.toFill;
		total.filled += r.filled;
		total.undecidableRows.push(...r.undecidableRows);
		total.byReason.orgUnmapped += r.undecidableByReason.orgUnmapped;
		total.byReason.ambiguousMapping += r.undecidableByReason.ambiguousMapping;
		total.byReason.mappingHasNoClerkId +=
			r.undecidableByReason.mappingHasNoClerkId;
		if (r.isDone) return total;
		cursor = r.nextCursor;
	}
}

const idOf = (t: T, id: string) =>
	t.run(
		async (ctx) =>
			(await ctx.db.get(id as never)) as unknown as Record<string, unknown>,
	);

describe("backfill_org_clerk_id", () => {
	test("DRY RUN counts what it would fill and writes nothing", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedMissions(t);
		const r = await walkTable(t, "missions", true, 3);
		expect(r).toMatchObject({
			examined: 7,
			alreadyFilled: 1,
			noSlug: 1,
			toFill: 2,
			filled: 0,
		});
		expect(r.undecidableRows).toHaveLength(3);
		for (const id of [
			ids.acme,
			ids.operator,
			ids.ghost,
			ids.notFilled,
			ids.twice,
			ids.fleet,
		]) {
			expect((await idOf(t, id)).clerkOrgId).toBeUndefined();
		}
	});

	test("REAL RUN fills a mapped slug; an unmapped one stays undecidable and is listed by id", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedMissions(t);
		const r = await walkTable(t, "missions", false, 3);
		expect(r.filled).toBe(2);
		// mapped -> filled, with the mapping's id (not the slug)
		expect((await idOf(t, ids.acme)).clerkOrgId).toBe(ACME.id);
		// the OPERATOR org maps the same way
		expect((await idOf(t, ids.operator)).clerkOrgId).toBe(OPERATOR.id);
		// unmapped / mapping-without-id / ambiguous: unfilled, listed by id with the reason
		for (const [key, reason] of [
			["ghost", "orgUnmapped"],
			["notFilled", "mappingHasNoClerkId"],
			["twice", "ambiguousMapping"],
		] as const) {
			expect((await idOf(t, ids[key])).clerkOrgId).toBeUndefined();
			expect(r.undecidableRows).toContainEqual({
				id: ids[key],
				slug: (await idOf(t, ids[key])).orgId,
				reason,
			});
		}
		expect(r.byReason).toEqual({
			orgUnmapped: 1,
			ambiguousMapping: 1,
			mappingHasNoClerkId: 1,
		});
		// a row with no slug is left alone, and a row already carrying an id is never overwritten
		expect((await idOf(t, ids.fleet)).clerkOrgId).toBeUndefined();
		expect((await idOf(t, ids.already)).clerkOrgId).toBe("org_KEPT1");
	});

	test("a second real run writes nothing (idempotent)", async () => {
		const t = createT();
		await seedMappings(t);
		await seedMissions(t);
		await walkTable(t, "missions", false);
		const again = await walkTable(t, "missions", false);
		expect(again.filled).toBe(0);
		expect(again.toFill).toBe(0);
		expect(again.alreadyFilled).toBe(3);
	});

	test("the id column sits next to the slug column in every walked table", async () => {
		expect(TABLE_ORDER.length).toBe(Object.keys(ORG_COLUMNS).length);
		const inv = await createT().query(
			internal.migrations.backfill_org_clerk_id.inventory,
			{},
		);
		expect(inv.tables.map((x) => x.table).sort()).toEqual(
			[...TABLE_ORDER].sort(),
		);
		expect(inv.operatorSlug).toBeNull();
	});

	test("INVENTORY names the operator org and the mappings still without an id", async () => {
		const t = createT();
		await seedMappings(t);
		const inv = await t.query(
			internal.migrations.backfill_org_clerk_id.inventory,
			{},
		);
		expect(inv.operatorSlug).toBe(OPERATOR.slug);
		expect(inv.operatorClerkOrgId).toBe(OPERATOR.id);
		expect(inv.mappingsWithoutClerkId).toEqual(["not-filled-yet"]);
	});

	test("messages and receipts use tenantId -> tenantOrgId", async () => {
		const t = createT();
		await seedMappings(t);
		const { m, r } = await t.run(async (ctx) => {
			const m = await ctx.db.insert("messages", {
				from: SEAT,
				channel: "x",
				content: "c",
				tenantId: ACME.slug,
				createdAt: NOW,
			});
			const r = await ctx.db.insert("messageReceipts", {
				messageId: m,
				recipient: "x",
				tenantId: ACME.slug,
			});
			return { m, r };
		});
		await walkTable(t, "messages", false);
		await walkTable(t, "messageReceipts", false);
		expect((await idOf(t, m)).tenantOrgId).toBe(ACME.id);
		expect((await idOf(t, r)).tenantOrgId).toBe(ACME.id);
	});

	test("a mapped slug in agents (orgSlug) is filled; an unmapped one is listed", async () => {
		const t = createT();
		await seedMappings(t);
		const { good, bad } = await t.run(async (ctx) => {
			const agent = (orgSlug: string) =>
				ctx.db.insert("agents", {
					orgSlug,
					name: `a-${orgSlug}`,
					isActive: true,
					createdAt: NOW,
				});
			return { good: await agent(ACME.slug), bad: await agent("ghost-org") };
		});
		const r = await walkTable(t, "agents", false);
		expect((await idOf(t, good)).clerkOrgId).toBe(ACME.id);
		expect((await idOf(t, bad)).clerkOrgId).toBeUndefined();
		expect(r.undecidableRows.map((x) => x.id)).toEqual([bad]);
	});
});

describe("new writes stamp the slug AND the Clerk org id", () => {
	async function seedWorld(t: T) {
		await seedMappings(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: 0,
			});
			await ctx.db.insert("profiles", {
				orchestratorId: "recipient-role",
				name: "recipient-role",
				static: { role: "recipient-role", workspace: "w", capabilities: [] },
				dynamic: { lastSeen: NOW, sessionCount: 1 },
			});
		});
	}

	test("diary:write by an org member", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await asOrg(t, ACME.slug).mutation(api.diary.write, {
			date: "2026-10-01",
			orchestrator: SEAT,
			content: "v1",
		});
		const row = await idOf(t, id);
		expect(row.orgId).toBe(ACME.slug);
		expect(row.clerkOrgId).toBe(ACME.id);
	});

	test("the OPERATOR org's member stamps the operator org's id", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await asOrg(t, OPERATOR.slug).mutation(api.diary.write, {
			date: "2026-10-01",
			orchestrator: SEAT,
			content: "operator",
		});
		const row = await idOf(t, id);
		expect(row.orgId).toBe(OPERATOR.slug);
		expect(row.clerkOrgId).toBe(OPERATOR.id);
	});

	test("tasks:create by an org member", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await asOrg(t, ACME.slug).mutation(api.tasks.create, {
			title: "Stamp me",
			assignedTo: SEAT,
			priority: "high",
			status: "todo",
			createdBy: SEAT,
		});
		const row = await idOf(t, id);
		expect(row.orgId).toBe(ACME.slug);
		expect(row.clerkOrgId).toBe(ACME.id);
	});

	test("a mapping whose id is not filled yet stamps the slug only; no id is invented", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await asOrg(t, "not-filled-yet").mutation(api.tasks.create, {
			title: "Slug only",
			assignedTo: SEAT,
			priority: "high",
			status: "todo",
			createdBy: SEAT,
		});
		const row = await idOf(t, id);
		expect(row.orgId).toBe("not-filled-yet");
		expect(row.clerkOrgId).toBeUndefined();
	});

	test("a fleet-master write stays unstamped on both columns", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await t
			.withIdentity({ subject: "test-service-account-user-id" } as Parameters<
				T["withIdentity"]
			>[0])
			.mutation(api.diary.write, {
				date: "2026-10-01",
				orchestrator: SEAT,
				content: "fleet",
			});
		const row = await idOf(t, id);
		expect(row.orgId).toBeUndefined();
		expect(row.clerkOrgId).toBeUndefined();
	});

	test("a message to a tenant stamps tenantId and tenantOrgId on the message and its receipt", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await t.mutation(internal.messages.sendMessageInternal, {
			from: "pi",
			channel: "recipient-role",
			content: "hello",
			tenantId: ACME.slug,
		});
		const msg = await idOf(t, id);
		expect(msg.tenantId).toBe(ACME.slug);
		expect(msg.tenantOrgId).toBe(ACME.id);
		const receipts = await t.run((ctx) =>
			ctx.db
				.query("messageReceipts")
				.withIndex("by_message", (q) => q.eq("messageId", id))
				.collect(),
		);
		expect(receipts.length).toBeGreaterThan(0);
		for (const r of receipts) {
			expect(r.tenantId).toBe(ACME.slug);
			expect(r.tenantOrgId).toBe(ACME.id);
		}
	});

	test("registerAgent and mintAgentCredential stamp the org id on the agent and its credential", async () => {
		const t = createT();
		await seedWorld(t);
		const agentId = await adminOf(t, ACME.slug).mutation(
			api.agents.registerAgent,
			{
				orgSlug: ACME.slug,
				name: "neo",
			},
		);
		await adminOf(t, ACME.slug).mutation(
			api.agentCredentials.mintAgentCredential,
			{
				orgSlug: ACME.slug,
				agentId: await agentIdOf(t, ACME.slug, "neo"),
			},
		);
		expect((await idOf(t, agentId)).clerkOrgId).toBe(ACME.id);
		const creds = await t.run((ctx) =>
			ctx.db.query("agent_credentials").collect(),
		);
		expect(creds).toHaveLength(1);
		expect(creds[0].orgSlug).toBe(ACME.slug);
		expect(creds[0].clerkOrgId).toBe(ACME.id);
	});
});

describe("a stamped row is still READABLE through its returns validator", () => {
	// A returns validator that enumerates a document rejects an extra field: a row that
	// carries clerkOrgId must be returned by the doors that return it whole.
	test("tasks:get, diary:get and agents:getAgent return a row that carries the org id", async () => {
		const t = createT();
		await seedMappings(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: 0,
			});
		});
		const member = asOrg(t, ACME.slug);
		const taskId = await member.mutation(api.tasks.create, {
			title: "Readable",
			assignedTo: SEAT,
			priority: "high",
			status: "todo",
			createdBy: SEAT,
		});
		const task = await member.query(api.tasks.get, { taskId });
		expect(task?.clerkOrgId).toBe(ACME.id);
		await member.mutation(api.diary.write, {
			date: "2026-10-01",
			orchestrator: SEAT,
			content: "d",
		});
		const entry = await member.query(api.diary.get, {
			date: "2026-10-01",
			orchestrator: SEAT,
		});
		expect(entry?.clerkOrgId).toBe(ACME.id);
		await adminOf(t, ACME.slug).mutation(api.agents.registerAgent, {
			orgSlug: ACME.slug,
			name: "neo",
		});
		const agent = await adminOf(t, ACME.slug).query(api.agents.getAgent, {
			orgSlug: ACME.slug,
			agentId: await agentIdOf(t, ACME.slug, "neo"),
		});
		expect(agent?.clerkOrgId).toBe(ACME.id);
	});
});

describe("clientOrgMapping:setClerkOrgId", () => {
	const set = internal.clientOrgMapping.setClerkOrgId;

	test("sets the id on a mapping that has none, and replays idempotently", async () => {
		const t = createT();
		await seedMappings(t);
		const first = await t.mutation(set, {
			clerkOrgSlug: "not-filled-yet",
			clerkOrgId: "org_NEW1",
		});
		expect(first).toEqual({
			clerkOrgSlug: "not-filled-yet",
			previous: null,
			current: "org_NEW1",
		});
		const again = await t.mutation(set, {
			clerkOrgSlug: "not-filled-yet",
			clerkOrgId: "org_NEW1",
		});
		expect(again.previous).toBe("org_NEW1");
	});

	test("refuses a malformed id, an id owned by another mapping, and a silent change", async () => {
		const t = createT();
		await seedMappings(t);
		await expect(
			t.mutation(set, {
				clerkOrgSlug: "not-filled-yet",
				clerkOrgId: "acme-hr",
			}),
		).rejects.toThrow(/CLERK_ORG_ID_INVALID/);
		await expect(
			t.mutation(set, { clerkOrgSlug: "not-filled-yet", clerkOrgId: ACME.id }),
		).rejects.toThrow(/CLERK_ORG_ID_TAKEN/);
		await expect(
			t.mutation(set, { clerkOrgSlug: ACME.slug, clerkOrgId: "org_OTHER1" }),
		).rejects.toThrow(/CLERK_ORG_ID_CONFLICT/);
		await expect(
			t.mutation(set, { clerkOrgSlug: "missing", clerkOrgId: "org_X1" }),
		).rejects.toThrow(/ORG_MAPPING_NOT_FOUND/);
		const corrected = await t.mutation(set, {
			clerkOrgSlug: ACME.slug,
			clerkOrgId: "org_OTHER1",
			replace: true,
		});
		expect(corrected.previous).toBe(ACME.id);
	});
});
