/// <reference types="vite/client" />
/**
 * BATCH E, improvisation digest: each source (tasks, messages, memories) is
 * read through its range and narrowed WHILE it is read (R-55): the window and
 * the orchestrator filter are applied to each row as it streams, and the scan cap
 * bounds how many rows a source READS.
 *
 * Callers, said apart: the fleet service account (every tenant's tasks and
 * messages, and the memories), an ordinary org member (its OWN tenant's tasks and
 * messages only, and NO memory: the table carries no tenant stamp, so absence of
 * a stamp asserts nothing and grants nothing), another org's member (never sees
 * these rows), a caller with no credential (the typed-empty digest, as before).
 */
import { describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { agentIdInCtx } from "../../tests/lib/agentIdOf";
import { api } from "../_generated/api";
import schema from "../schema";

// The first test of a file pays the cold start of the whole Convex module graph.
vi.setConfig({ testTimeout: 30_000 });

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

const A = "org-a";
const B = "org-b";
const NOW = Date.now();
const NOTE = "Merged PR #1234 and deployed, tests 12/12 pass";

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `user-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
	} as Identity);

async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const slug of [A, B]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [`seat-${slug}`],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
			});
			await seedRosterAgent(ctx, slug, `seat-${slug}`);
		}
		// One closed task per tenant, assigned to that tenant's own seat, with a
		// durable-artifact note and no VP-Sources footer; one fleet task.
		for (const [orgId, assignedTo] of [
			[A, `seat-${A}`],
			[B, `seat-${B}`],
			[undefined, "sigma"],
		] as const) {
			const assignee =
				orgId === undefined ? undefined : await agentIdInCtx(ctx, orgId, assignedTo);
			await ctx.db.insert("tasks", {
				...(assignee !== undefined ? { assignedToId: assignee } : {}),
				title: `task ${orgId ?? "fleet"}`,
				project: "p",
				assignedTo,
				priority: "medium",
				status: "done",
				createdBy: assignedTo,
				createdAt: NOW,
				updatedAt: NOW,
				completionNote: NOTE,
				...(orgId !== undefined
					? { orgId, clerkOrgId: testClerkOrgId(orgId) }
					: {}),
			});
		}
		// One message per tenant (+ a fleet one), same artifact shape.
		for (const [tenantId, from] of [
			[A, `seat-${A}`],
			[B, `seat-${B}`],
			[undefined, "sigma"],
		] as const) {
			await ctx.db.insert("messages", {
				from,
				channel: "general",
				content: `[STATUS] ${NOTE}`,
				createdAt: NOW,
				...(tenantId !== undefined
					? { tenantId, tenantOrgId: testClerkOrgId(tenantId) }
					: {}),
			});
		}
		// Memories carry no tenant stamp.
		await ctx.db.insert("memories", {
			content: NOTE,
			type: "reference",
			namespace: "global",
			createdBy: "sigma",
			relations: [],
			createdAt: NOW,
			updatedAt: NOW,
			isLatest: true,
		});
	});
}

describe("improvisationDigest:scanWindow", () => {
	test("PRESENT: the fleet service account reads every tenant's tasks and messages and the memories", async () => {
		const t = createT();
		await seed(t);
		const out = await asService(t).query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});
		expect(out.countsByCategory).toEqual({
			complete_task: 3,
			send_message: 3,
			store_memory: 1,
		});
	});

	test("PRESENT: the orchestrator filter is applied while each source is read", async () => {
		const t = createT();
		await seed(t);
		const out = await asService(t).query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
			orchestrators: ["sigma"],
		});
		expect(out.countsByOrch).toEqual({ sigma: 3 });
		expect(out.countsByCategory).toEqual({
			complete_task: 1,
			send_message: 1,
			store_memory: 1,
		});
	});

	test("CROSS-ORG: an org member reads its own tenant's tasks and messages only, and no memory", async () => {
		const t = createT();
		await seed(t);
		const out = await asMember(t, A).query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});
		expect(out.countsByCategory).toEqual({
			complete_task: 1,
			send_message: 1,
			store_memory: 0,
		});
		expect(out.countsByOrch).toEqual({ [`seat-${A}`]: 2 });
	});

	test("ABSENT: a member of an org with no artifact reads a real empty digest", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: A,
				clerkOrgId: testClerkOrgId(A),
				allowedOrchestrators: [`seat-${A}`],
				scopes: [],
				displayName: A,
				isActive: true,
				createdAt: NOW,
			});
		});
		const out = await asMember(t, A).query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});
		expect(out).toEqual({
			countsByOrch: {},
			countsByCategory: { complete_task: 0, send_message: 0, store_memory: 0 },
			samples: [],
		});
	});

	test("REFUSED: a caller with no credential is served the typed-empty digest", async () => {
		const t = createT();
		await seed(t);
		const out = await t.query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});
		expect(out.countsByCategory).toEqual({
			complete_task: 0,
			send_message: 0,
			store_memory: 0,
		});
		expect(out.samples).toEqual([]);
	});
});
