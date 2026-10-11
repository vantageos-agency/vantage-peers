/// <reference types="vite/client" />
/**
 * orgRoster:getMyOrgRoster — the READ must say what the WRITE will enforce.
 *
 * Defect: the operator's own org admin resolved the read-only master grant in
 * the query (allowedOrchestrators ["*"]) so the dashboard task-create picker
 * had no assignee, while tasks:create (a mutation) resolves the same human as
 * an ordinary member of the operator org with the mapping's REAL roster.
 *
 * Rule: for `masterSource === "operator-admin"` the query re-resolves with
 * `operatorAsMember: true` and returns the member roster, "*" removed (the
 * write treats "*" as naming nobody, so it is never an assignable name).
 */

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { afterEach, describe, expect, test, vi } from "vitest";
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

const SA = "roster-test-service-account";
const OPERATOR_ORG = "operator-org-slug";
const CLIENT_ORG = "client-org-slug";
const OP_ADMIN = { subject: "op", org_slug: OPERATOR_ORG, org_id: testClerkOrgId(OPERATOR_ORG), org_role: "org:admin" };
const OP_MEMBER = { subject: "om", org_slug: OPERATOR_ORG, org_id: testClerkOrgId(OPERATOR_ORG), org_role: "org:member" };
const CLIENT_ADMIN = { subject: "ca", org_slug: CLIENT_ORG, org_id: testClerkOrgId(CLIENT_ORG), org_role: "org:admin" };

async function seed(t: T, operatorRoster: string[] = ["sigma", "eta"]) {
	const row = (
		clerkOrgSlug: string,
		allowedOrchestrators: string[],
		orgKind: "operator" | "client",
	) => ({
		clerkOrgSlug,
		clerkOrgId: testClerkOrgId(clerkOrgSlug),
		allowedOrchestrators,
		scopes: ["view-own-tasks"],
		displayName: clerkOrgSlug,
		isActive: true,
		createdAt: Date.now(),
		orgKind,
	});
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", row(OPERATOR_ORG, operatorRoster, "operator"));
		await ctx.db.insert("client_org_mapping", row(CLIENT_ORG, ["acme-bot"], "client"));
		// writer roles are DATA; without a row the human create path refuses every role
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
	});
}

const as = (t: T, identity: Record<string, unknown>) =>
	t.withIdentity(identity as Identity);

async function canCreate(t: T, identity: Record<string, unknown>, assignedTo: string) {
	try {
		await as(t, identity).mutation(api.tasks.create, {
			title: "t",
			assignedTo,
			priority: "medium",
			status: "todo",
		} as never);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("getMyOrgRoster answers the operator admin with the roster the write enforces", () => {
	test("operator-org admin -> the real roster, not [\"*\"]", async () => {
		const t = createT();
		await seed(t);
		expect(await as(t, OP_ADMIN).query(api.orgRoster.getMyOrgRoster, {})).toEqual([
			"sigma",
			"eta",
		]);
	});

	test("operator mapping roster that itself carries \"*\" -> concrete names only, never \"*\"", async () => {
		const t = createT();
		await seed(t, ["*", "sigma"]);
		expect(await as(t, OP_ADMIN).query(api.orgRoster.getMyOrgRoster, {})).toEqual(["sigma"]);
	});

	test("operator mapping roster [\"*\"] alone -> [] (the write accepts nobody either)", async () => {
		const t = createT();
		await seed(t, ["*"]);
		expect(await as(t, OP_ADMIN).query(api.orgRoster.getMyOrgRoster, {})).toEqual([]);
		expect(await canCreate(t, OP_ADMIN, "sigma")).toBe(false);
	});

	test("ordinary operator-org member -> its roster (unchanged)", async () => {
		const t = createT();
		await seed(t);
		expect(await as(t, OP_MEMBER).query(api.orgRoster.getMyOrgRoster, {})).toEqual([
			"sigma",
			"eta",
		]);
	});

	test("client-org admin -> its own roster (unchanged)", async () => {
		const t = createT();
		await seed(t);
		expect(await as(t, CLIENT_ADMIN).query(api.orgRoster.getMyOrgRoster, {})).toEqual([
			"acme-bot",
		]);
	});

	test("service account -> [\"*\"] (unchanged)", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", SA);
		const t = createT();
		await seed(t);
		expect(await as(t, { subject: SA }).query(api.orgRoster.getMyOrgRoster, {})).toEqual(["*"]);
	});

	test("anonymous -> same refusal shape as before (no identity is never a roster)", async () => {
		const t = createT();
		await seed(t);
		let outcome: unknown;
		try {
			outcome = await t.query(api.orgRoster.getMyOrgRoster, {});
		} catch (e) {
			outcome = { threw: String(e) };
		}
		expect(outcome).toEqual([]);
	});

	test("consistency: every name returned to the operator admin is accepted by tasks:create, a name not returned is refused", async () => {
		const t = createT();
		await seed(t);
		const names = await as(t, OP_ADMIN).query(api.orgRoster.getMyOrgRoster, {});
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(await canCreate(t, OP_ADMIN, name)).toBe(true);
		}
		for (const outside of ["acme-bot", "pi", "*"]) {
			expect(names).not.toContain(outside);
			expect(await canCreate(t, OP_ADMIN, outside)).toBe(false);
		}
	});
});
