/// <reference types="vite/client" />
/**
 * The PERSON path of the task doors that serve persons (start, update, complete)
 * together with `verifiedOrg`. The MCP layer forwards BOTH for a person bearer
 * (its token row's org as `verifiedOrg`, its token hash as `verifiedPerson`), so
 * the two proofs must coexist: the person is resolved from its token, the row's
 * org must equal the verified org, and the person's own tenant gate still holds.
 *
 * POLES (both directions, per door)
 *   OWN       person of org-a + verifiedOrg org-a, org-a task -> lands, acting as user:<sub>
 *   FOREIGN   person of org-a + verifiedOrg org-a, org-b task -> RBAC_DENIED, row untouched
 *   MISMATCH  person of org-a + verifiedOrg org-b, org-a task -> RBAC_DENIED (the row is not in
 *             the verified org), row untouched
 *   ABSENT    person of org-a, no verifiedOrg, org-a task    -> unchanged (lands)
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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
const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const EDITOR = "a".repeat(64);

let t: T;
const service = () => t.withIdentity({ subject: SERVICE });
const person = { verifiedPerson: { accessTokenHash: EDITOR } };
const org = (orgSlug: string) => ({ verifiedOrg: { orgSlug } });

beforeEach(async () => {
	t = createT();
	const now = Date.now();
	await t.run(async (ctx) => {
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["agent-a"],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		}
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: now,
		});
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash: EDITOR,
			clientId: "c",
			userId: "user_editor",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "person",
			fromAllowList: ["agent-a"],
			namespaceReadPrefixes: ["team/org-a"],
			namespaceWritePrefixes: ["team/org-a"],
			expiresAt: now + 3_600_000,
			createdAt: now,
			clerkOrgSlug: "org-a",
			clerkOrgId: testClerkOrgId("org-a"),
			orgRole: "org:editor",
			principal: "person",
		});
	});
});

async function taskIn(orgId: string): Promise<Id<"tasks">> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("tasks", {
			title: "seeded",
			assignedTo: "agent-a",
			createdBy: "agent-a",
			priority: "high",
			status: "todo",
			orgId,
			clerkOrgId: testClerkOrgId(orgId),
			createdAt: now,
			updatedAt: now,
		});
	});
}

type Door = "start" | "update" | "complete";
const call = (
	door: Door,
	taskId: Id<"tasks">,
	extra: Record<string, unknown>,
) => {
	const as = service();
	if (door === "start")
		return as.mutation(api.tasks.start, { taskId, ...person, ...extra });
	if (door === "update")
		return as.mutation(api.tasks.update, {
			taskId,
			title: "PERSON-EDIT",
			...person,
			...extra,
		});
	return as.mutation(api.tasks.complete, {
		taskId,
		completionNote: "closed by a person, 1 row",
		...person,
		...extra,
	});
};
const landed = (door: Door, r: { status: string; title: string } | null) =>
	door === "start"
		? r?.status === "in_progress"
		: door === "update"
			? r?.title === "PERSON-EDIT"
			: r?.status === "done";
const read = (id: Id<"tasks">) => t.run((ctx) => ctx.db.get(id));

async function refusal(p: Promise<unknown>): Promise<string> {
	const err = await p.then(
		() => null,
		(e: Error) => e,
	);
	expect(err, "expected a refusal").not.toBeNull();
	return `${(err as Error).message} ${JSON.stringify((err as { data?: unknown }).data ?? "")}`;
}

for (const door of ["start", "update", "complete"] as const) {
	describe(`${door}: person + verifiedOrg`, () => {
		test("OWN: a person of org-a with verifiedOrg org-a acts on its org-a task, in its own name", async () => {
			const id = await taskIn("org-a");
			await call(door, id, org("org-a"));
			const row = await read(id);
			expect(landed(door, row)).toBe(true);
			expect(row?.lastActedBy).toBe("user:user_editor");
		});

		test("FOREIGN: the same person cannot touch an org-b task", async () => {
			const id = await taskIn("org-b");
			const before = JSON.stringify(await read(id));
			expect(await refusal(call(door, id, org("org-a")))).toContain(
				"RBAC_DENIED",
			);
			expect(JSON.stringify(await read(id))).toBe(before);
		});

		test("MISMATCH: a verifiedOrg that is not the row's org refuses even for the person's own task", async () => {
			const id = await taskIn("org-a");
			const before = JSON.stringify(await read(id));
			expect(await refusal(call(door, id, org("org-b")))).toContain(
				"RBAC_DENIED",
			);
			expect(JSON.stringify(await read(id))).toBe(before);
		});

		test("ABSENT: without verifiedOrg the person path is byte-unchanged", async () => {
			const id = await taskIn("org-a");
			await call(door, id, {});
			expect(landed(door, await read(id))).toBe(true);
		});
	});
}
