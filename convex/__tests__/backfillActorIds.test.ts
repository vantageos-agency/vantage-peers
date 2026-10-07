/// <reference types="vite/client" />
//
// R-53 identity-by-ID (Pi ruling (b)/(f), task k174d95s5qqy8t2r5rdrz3pr3d8fqv82):
// tasks.createdById/assignedToId/lastAssignedToId, messages.fromId and
// messageReceipts.recipientId.
//   - backfill_actor_ids fills a same-org name, leaves unknown / ambiguous names
//     undecidable (listed by row ID), and NEVER matches another org's agent (the
//     clio / iris-rh case);
//   - new writes stamp the IDs from the resolved principal and target rows.
// Hermetic: no deployment is touched.

import type { FunctionReturnType } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	type ActorTable,
	TABLE_ORDER,
} from "../migrations/backfill_actor_ids";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);
const run = internal.migrations.backfill_actor_ids.run;
const NOW = 1_700_000_000_000;
const createT = () => convexTest({ schema, modules });
type T = ReturnType<typeof createT>;

type World = {
	fleetClio: Id<"agents">;
	irisClio: Id<"agents">;
	sigma: Id<"agents">;
	irisOnly: Id<"agents">;
	dup1: Id<"agents">;
	dup2: Id<"agents">;
};

// fleet-org (operator): sigma, clio, dup, dup.   iris-rh (client): clio, irisonly.
async function seed(t: T): Promise<World> {
	return await t.run(async (ctx) => {
		const mapping = (slug: string, operator: boolean) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(operator ? { orgKind: "operator" as const } : {}),
			});
		await mapping("fleet-org", true);
		await mapping("iris-rh", false);
		const agent = (name: string, orgSlug: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: name.toLowerCase(),
				isActive: true,
				createdAt: NOW,
			});
		return {
			sigma: await agent("sigma", "fleet-org"),
			fleetClio: await agent("clio", "fleet-org"),
			dup1: await agent("dup", "fleet-org"),
			dup2: await agent("Dup", "fleet-org"),
			irisClio: await agent("clio", "iris-rh"),
			irisOnly: await agent("irisonly", "iris-rh"),
		};
	});
}

const task = (t: T, extra: Record<string, unknown>) =>
	t.run((ctx) =>
		ctx.db.insert("tasks", {
			title: "t",
			assignedTo: "sigma",
			priority: "medium" as const,
			status: "todo" as const,
			createdBy: "sigma",
			createdAt: NOW,
			updatedAt: NOW,
			...extra,
		}),
	);
const message = (t: T, from: string, tenantId?: string) =>
	t.run((ctx) =>
		ctx.db.insert("messages", {
			from,
			channel: "c",
			content: "hi",
			createdAt: NOW,
			...(tenantId === undefined ? {} : { tenantId }),
		}),
	);
const receipt = (
	t: T,
	messageId: Id<"messages">,
	recipient: string,
	tenantId?: string,
) =>
	t.run((ctx) =>
		ctx.db.insert("messageReceipts", {
			messageId,
			recipient,
			...(tenantId === undefined ? {} : { tenantId }),
		}),
	);

type Result = FunctionReturnType<typeof run>;
async function walkAll(t: T, dryRun?: boolean): Promise<Result[]> {
	const out: Result[] = [];
	let table: ActorTable | null = TABLE_ORDER[0];
	let cursor: string | null = null;
	let guard = 0;
	while (table !== null) {
		if (++guard > 100) throw new Error("walk did not terminate");
		const r: Result = await t.mutation(run, {
			table,
			...(dryRun === undefined ? {} : { dryRun }),
			cursor,
			pageSize: 2,
		});
		out.push(r);
		table = r.nextTable;
		cursor = r.nextCursor;
	}
	return out;
}

describe("backfill_actor_ids", () => {
	test("fills a same-org name (agent -> agents _id, person -> its own subject ID)", async () => {
		const t = createT();
		const w = await seed(t);
		const tFleet = await task(t, { createdBy: "sigma", assignedTo: "clio" });
		const tIris = await task(t, {
			orgId: "iris-rh",
			createdBy: "clio",
			assignedTo: "irisonly",
			lastAssignedTo: "clio",
		});
		const tCancelled = await task(t, {
			orgId: "iris-rh",
			status: "cancelled",
			cancelledBy: "clio",
			reviewArtifactAttachedBy: "irisonly",
		});
		const tPerson = await task(t, {
			orgId: "iris-rh",
			createdBy: "user:abc123",
			assignedTo: "irisonly",
		});
		const m = await message(t, "sigma");
		const mp = await message(t, "user:abc123", "iris-rh");
		const r = await receipt(t, m, "clio");
		const rp = await receipt(t, mp, "irisonly", "iris-rh");

		await walkAll(t, false);

		const get = <D extends "tasks" | "messages" | "messageReceipts">(
			table: D,
			id: Id<D>,
		) => t.run((ctx) => ctx.db.get(table, id));
		expect(await get("tasks", tFleet)).toMatchObject({
			createdById: w.sigma,
			assignedToId: w.fleetClio,
		});
		expect(await get("tasks", tIris)).toMatchObject({
			createdById: w.irisClio,
			assignedToId: w.irisOnly,
			lastAssignedToId: w.irisClio,
		});
		expect(await get("tasks", tCancelled)).toMatchObject({
			cancelledById: w.irisClio,
			reviewArtifactAttachedById: w.irisOnly,
		});
		const person = await get("tasks", tPerson);
		expect(person?.createdById).toBe("user:abc123");
		expect(person?.assignedToId).toBe(w.irisOnly);
		expect((await get("messages", m))?.fromId).toBe(w.sigma);
		expect((await get("messages", mp))?.fromId).toBe("user:abc123");
		expect((await get("messageReceipts", r))?.recipientId).toBe(w.fleetClio);
		expect((await get("messageReceipts", rp))?.recipientId).toBe(w.irisOnly);
	});

	test("the same name in two orgs resolves to each org's OWN agent, never the other's (clio / iris-rh)", async () => {
		const t = createT();
		const w = await seed(t);
		const fleet = await task(t, { createdBy: "clio" });
		const iris = await task(t, { createdBy: "clio", orgId: "iris-rh" });
		await walkAll(t, false);
		const f = await t.run((ctx) => ctx.db.get("tasks", fleet));
		const i = await t.run((ctx) => ctx.db.get("tasks", iris));
		expect(f?.createdById).toBe(w.fleetClio);
		expect(i?.createdById).toBe(w.irisClio);
		expect(f?.createdById).not.toBe(i?.createdById);
	});

	test("an other-org name is NEVER matched: a name only the other org has stays undecidable", async () => {
		const t = createT();
		await seed(t);
		// "irisonly" exists only in iris-rh; a fleet-owned row naming it must not match.
		const fleetRow = await task(t, { createdBy: "irisonly" });
		// "sigma" exists only in fleet-org; an iris-rh row naming it must not match.
		const irisRow = await task(t, { createdBy: "sigma", orgId: "iris-rh" });
		const results = await walkAll(t, false);
		const rows = await t.run(async (ctx) => [
			await ctx.db.get("tasks", fleetRow),
			await ctx.db.get("tasks", irisRow),
		]);
		expect(rows[0]?.createdById).toBeUndefined();
		expect(rows[1]?.createdById).toBeUndefined();
		const und = results.flatMap((x) => x.undecidable);
		expect(und).toContainEqual({
			rowId: fleetRow,
			column: "createdBy",
			name: "irisonly",
			reason: "unknownAgent",
		});
		expect(und).toContainEqual({
			rowId: irisRow,
			column: "createdBy",
			name: "sigma",
			reason: "unknownAgent",
		});
	});

	test("an unknown or ambiguous name stays undecidable, is listed by row ID, and is not written", async () => {
		const t = createT();
		await seed(t);
		const unknown = await task(t, { createdBy: "stranger" });
		const ambiguous = await task(t, { createdBy: "dup" }); // two "dup" rows in fleet-org
		const ok = await task(t, { createdBy: "sigma" });
		const results = await walkAll(t, false);
		const und = results.flatMap((x) => x.undecidable);
		expect(und).toContainEqual({
			rowId: unknown,
			column: "createdBy",
			name: "stranger",
			reason: "unknownAgent",
		});
		expect(und).toContainEqual({
			rowId: ambiguous,
			column: "createdBy",
			name: "dup",
			reason: "ambiguousAgent",
		});
		const rows = await t.run(async (ctx) => [
			await ctx.db.get("tasks", unknown),
			await ctx.db.get("tasks", ambiguous),
			await ctx.db.get("tasks", ok),
		]);
		expect(rows[0]?.createdById).toBeUndefined();
		expect(rows[1]?.createdById).toBeUndefined();
		expect(rows[2]?.createdById).toBeDefined();
		const tasksPages = results.filter((x) => x.table === "tasks");
		const col = (c: string, k: "unknownAgent" | "ambiguousAgent") =>
			tasksPages.reduce(
				(n, p) => n + (p.columns.find((x) => x.column === c)?.[k] ?? 0),
				0,
			);
		expect(col("createdById", "unknownAgent")).toBe(1);
		expect(col("createdById", "ambiguousAgent")).toBe(1);
	});

	test("DRY RUN is the default and writes nothing; the inventory is printed first", async () => {
		const t = createT();
		await seed(t);
		const id = await task(t, { createdBy: "sigma" });
		const results = await walkAll(t); // no dryRun argument
		expect(results.every((r) => r.dryRun)).toBe(true);
		const row = await t.run((ctx) => ctx.db.get("tasks", id));
		expect(row?.createdById).toBeUndefined();
		const first = results.find((r) => r.table === "tasks");
		expect(first?.inventory).toEqual([
			"tasks.createdBy -> createdById",
			"tasks.assignedTo -> assignedToId",
			"tasks.lastAssignedTo -> lastAssignedToId",
			"tasks.cancelledBy -> cancelledById",
			"tasks.reviewArtifactAttachedBy -> reviewArtifactAttachedById",
		]);
		const planned = results
			.filter((r) => r.table === "tasks")
			.flatMap((r) => r.columns)
			.filter((c) => c.column === "createdById")
			.reduce((n, c) => n + c.toFill, 0);
		expect(planned).toBe(1);
	});

	test("idempotent: a column already holding an ID is never rewritten", async () => {
		const t = createT();
		const w = await seed(t);
		const id = await task(t, { createdBy: "sigma", createdById: "preset" });
		await walkAll(t, false);
		const row = await t.run((ctx) => ctx.db.get("tasks", id));
		expect(row?.createdById).toBe("preset");
		expect(row?.assignedToId).toBe(w.sigma);
	});

	test("REFUSES the run when there is no single active operator org", async () => {
		const t = createT();
		await expect(
			t.mutation(run, { table: "tasks" }),
		).rejects.toThrow(/operator organisation/);
	});
});

describe("new writes stamp the IDs", () => {
	const asOrg = (t: T, slug: string) =>
		t.withIdentity({
			subject: `user-${slug}`,
			organizationId: slug,
		} as Parameters<T["withIdentity"]>[0]);
	const adminOf = (t: T, slug: string) =>
		t.withIdentity({
			subject: `admin-of-${slug}`,
			org_slug: slug,
			org_role: "org:admin",
		} as Parameters<T["withIdentity"]>[0]);

	// iris-rh registers clio + irisonly through the real door and mints clio a
	// credential; fleet-org (operator) ALSO has an agent named clio, a different
	// agents row that must never be the one stamped.
	async function seedIris(t: T) {
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "iris-rh",
				allowedOrchestrators: ["clio", "irisonly"],
				scopes: ["view-own-tasks", "view-own-missions"],
				displayName: "iris-rh",
				isActive: true,
				createdAt: NOW,
			});
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "fleet-org",
				allowedOrchestrators: [],
				scopes: [],
				displayName: "fleet-org",
				isActive: true,
				createdAt: NOW,
				orgKind: "operator" as const,
			});
			await ctx.db.insert("agents", {
				orgSlug: "fleet-org",
				name: "clio",
				normalizedName: "clio",
				isActive: true,
				createdAt: NOW,
			});
			for (const o of ["clio", "irisonly"]) {
				await ctx.db.insert("profiles", {
					orchestratorId: o,
					name: o,
					static: { role: o, workspace: "test", capabilities: [] },
					dynamic: { lastSeen: NOW, sessionCount: 1 },
				});
			}
		});
		for (const name of ["clio", "irisonly"]) {
			await adminOf(t, "iris-rh").mutation(api.agents.registerAgent, {
				orgSlug: "iris-rh",
				name,
			});
		}
		const minted = await adminOf(t, "iris-rh").mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "iris-rh", agentName: "clio" },
		);
		const agentId = (name: string) =>
			t.run(async (ctx) => {
				const row = await ctx.db
					.query("agents")
					.withIndex("by_org_name", (q) =>
						q.eq("orgSlug", "iris-rh").eq("name", name),
					)
					.unique();
				return row?._id;
			});
		return {
			secret: minted.secret,
			clio: await agentId("clio"),
			irisOnly: await agentId("irisonly"),
		};
	}

	test("tasks.create stamps createdById / assignedToId from the caller's own org (not the same-named agent of another org)", async () => {
		const t = createT();
		const ids = await seedIris(t);
		const taskId = await asOrg(t, "iris-rh").mutation(api.tasks.create, {
			title: "t",
			assignedTo: "irisonly",
			priority: "high",
			status: "todo",
			createdBy: "clio",
			agentCredentialSecret: ids.secret,
		});
		const row = await t.run((ctx) => ctx.db.get("tasks", taskId));
		expect(ids.clio).toBeDefined();
		expect(row?.createdById).toBe(ids.clio);
		expect(row?.assignedToId).toBe(ids.irisOnly);
	});

	test("tasks.update stamps the reassignment: assignedToId follows, lastAssignedToId is the prior assignee", async () => {
		const t = createT();
		const ids = await seedIris(t);
		const taskId = await asOrg(t, "iris-rh").mutation(api.tasks.create, {
			title: "t",
			assignedTo: "irisonly",
			priority: "high",
			status: "todo",
			createdBy: "clio",
			agentCredentialSecret: ids.secret,
		});
		await asOrg(t, "iris-rh").mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "clio",
			agentCredentialSecret: ids.secret,
			assignedTo: "clio",
		});
		const row = await t.run((ctx) => ctx.db.get("tasks", taskId));
		expect(row?.assignedTo).toBe("clio");
		expect(row?.assignedToId).toBe(ids.clio);
		expect(row?.lastAssignedTo).toBe("irisonly");
		expect(row?.lastAssignedToId).toBe(ids.irisOnly);
	});

	test("messages.sendMessage stamps fromId and the receipt's recipientId", async () => {
		const t = createT();
		const ids = await seedIris(t);
		const messageId = await asOrg(t, "iris-rh").mutation(
			api.messages.sendMessage,
			{
				from: "clio",
				channel: "irisonly",
				content: "hello",
				agentCredentialSecret: ids.secret,
			},
		);
		const msg = await t.run((ctx) => ctx.db.get("messages", messageId));
		expect(msg?.fromId).toBe(ids.clio);
		const receipts = await t.run((ctx) =>
			ctx.db
				.query("messageReceipts")
				.withIndex("by_message", (q) => q.eq("messageId", messageId))
				.collect(),
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].recipientId).toBe(ids.irisOnly);
	});
});
