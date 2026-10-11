/// <reference types="vite/client" />
/**
 * migrations/linkServiceAccountAgent: the backfill that reads the env value once
 * and writes the service account into data (module M2 part 2).
 *
 *   - dry run (the default) writes nothing and reports the pre-state;
 *   - dryRun:false creates the operator org's service agent and the column, and
 *     the doors then admit the subject from DATA (env var unset to prove it);
 *   - a replay is "already-linked" and writes nothing;
 *   - a column naming something else is never overwritten;
 *   - no operator org / no subject are reported "blocked", not thrown.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
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

const SUBJECT = "test-service-account-user-id";
const OPERATOR = "m2b-migration-operator";

async function seedOperator(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: OPERATOR,
			clerkOrgId: testClerkOrgId(OPERATOR),
			allowedOrchestrators: [],
			scopes: [],
			displayName: OPERATOR,
			isActive: true,
			createdAt: Date.now(),
			orgKind: "operator",
		});
	});
}

const counts = (t: T) =>
	t.run(async (ctx) => ({
		agents: (await ctx.db.query("agents").collect()).length,
		columns: (await ctx.db.query("client_org_mapping").collect()).filter(
			(r) => r.serviceAccountAgentId !== undefined,
		).length,
	}));

const run = (t: T, args: { dryRun?: boolean; subject?: string } = {}) =>
	t.mutation(internal.migrations.linkServiceAccountAgent.linkServiceAccountAgent, args);

beforeEach(() => {
	vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", SUBJECT);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("linkServiceAccountAgent", () => {
	test("dry run is the default: reports the pre-state, writes nothing", async () => {
		const t = createT();
		await seedOperator(t);
		const out = await run(t);
		expect(out.dryRun).toBe(true);
		expect(out.status).toBe("would-link");
		expect(out.createsAgent).toBe(true);
		expect(out.preState.subject).toBe(SUBJECT);
		expect(out.preState.operatorSlug).toBe(OPERATOR);
		expect(out.preState.column).toBeNull();
		expect(await counts(t)).toEqual({ agents: 0, columns: 0 });
	});

	test("write run links the account; the doors admit it from data alone", async () => {
		const t = createT();
		await seedOperator(t);
		const out = await run(t, { dryRun: false });
		expect(out.status).toBe("linked");
		expect(await counts(t)).toEqual({ agents: 1, columns: 1 });
		// The env value is gone: only the stored rows can admit the subject now.
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", "");
		const c = t.withIdentity({ subject: SUBJECT });
		expect(await c.query(api.oauth.listClients, {})).toEqual([]);
	});

	test("a replay is already-linked and writes nothing", async () => {
		const t = createT();
		await seedOperator(t);
		await run(t, { dryRun: false });
		const again = await run(t, { dryRun: false });
		expect(again.status).toBe("already-linked");
		expect(again.createsAgent).toBe(false);
		expect(await counts(t)).toEqual({ agents: 1, columns: 1 });
	});

	test("a column that names another subject is never overwritten", async () => {
		const t = createT();
		await seedOperator(t);
		await run(t, { dryRun: false });
		const out = await run(t, { dryRun: false, subject: "someone-else" });
		expect(out.status).toBe("blocked");
		expect(out.reason).toBe("column-names-another-agent");
		expect(await counts(t)).toEqual({ agents: 1, columns: 1 });
	});

	test("no operator org: blocked, not thrown, nothing written", async () => {
		const t = createT();
		const out = await run(t, { dryRun: false });
		expect(out.status).toBe("blocked");
		expect(out.reason).toBe("operator-org-none");
		expect(await counts(t)).toEqual({ agents: 0, columns: 0 });
	});

	test("no subject (env empty, no argument): blocked", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", "");
		const t = createT();
		await seedOperator(t);
		const out = await run(t, { dryRun: false });
		expect(out.status).toBe("blocked");
		expect(out.reason).toBe("subject-absent");
		expect(await counts(t)).toEqual({ agents: 0, columns: 0 });
	});
});
