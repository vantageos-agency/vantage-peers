/// <reference types="vite/client" />
/**
 * THE SERVICE ACCOUNT IS DECIDED BY SUBJECT FIRST, NEVER BY THE ABSENCE OF AN ORG.
 *
 * Incident: the MCP service account is also a Clerk member (org:admin) of some
 * organisations. When the Clerk "convex" JWT template carried org claims, a
 * fresh service-account session auto-activated one of them, its token carried
 * `org_slug`, and `withOrgScope` (which granted master only when NO org claim
 * was present) resolved the whole fleet's MCP traffic as an ordinary member.
 * Master-only reads were refused and the fleet's own tasks became unreadable.
 *
 * Poles (master-only read: fixPatterns:listByStack):
 *   - SA, no org claim                     -> master (served)
 *   - SA + org_slug of an active mapped org -> master (served)   [RED before fix]
 *   - SA + organizationSlug claim           -> master (served)   [RED before fix]
 *   - SA + organizationId claim             -> master (served)   [RED before fix]
 *   - DIFFERENT subject, same org claims    -> ordinary member (refused)
 *   - env var unset                         -> SA subject is NOT master
 *   - env var empty                         -> empty subject-less match is NOT master
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
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

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const OTHER_SUBJECT = "ordinary-member-of-the-test-org";
const ORG = "sa-first-test-org";

async function seed(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: ORG,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const as = (t: T, identity: Record<string, unknown>) =>
	t.withIdentity(identity as Identity);

const read = (c: ReturnType<typeof as>) =>
	c.query(api.fixPatterns.listByStack, { stack: "convex" });

async function expectRefused(p: Promise<unknown>) {
	let caught: unknown;
	try {
		await p;
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(ConvexError);
	expect(JSON.stringify((caught as ConvexError<string>).data)).toContain(
		"RBAC_DENIED",
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("service account is master by subject, regardless of org claims", () => {
	test("SA with NO org claim -> master", async () => {
		const t = createT();
		await seed(t);
		expect(await read(as(t, { subject: SERVICE_ACCOUNT_USER_ID }))).toEqual([]);
	});

	test("SA with org_slug of an active mapped org -> still master", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, {
			subject: SERVICE_ACCOUNT_USER_ID,
			org_slug: ORG,
			org_id: testClerkOrgId(ORG),
			org_role: "org:admin",
		});
		expect(await read(c)).toEqual([]);
	});

	test("SA with organizationSlug claim -> still master", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, {
			subject: SERVICE_ACCOUNT_USER_ID,
			organizationSlug: ORG,
			org_id: testClerkOrgId(ORG),
		});
		expect(await read(c)).toEqual([]);
	});

	test("SA with an org claim for an UNMAPPED org -> still master (no mapping miss)", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, {
			subject: SERVICE_ACCOUNT_USER_ID,
			org_slug: "unmapped-org",
			org_id: testClerkOrgId("unmapped-org"),
		});
		expect(await read(c)).toEqual([]);
	});

	test("a DIFFERENT subject carrying the same org claims -> ordinary member, refused", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, {
			subject: OTHER_SUBJECT,
			org_slug: ORG,
			org_id: testClerkOrgId(ORG),
			org_role: "org:admin",
			organizationSlug: ORG,
		});
		await expectRefused(read(c));
	});

	test("an ordinary member of the SAME org as the SA's claim -> member scope, NOT master", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, {
			subject: OTHER_SUBJECT,
			org_slug: ORG,
			org_id: testClerkOrgId(ORG),
			org_role: "org:admin",
		});
		let caught: unknown;
		try {
			await read(c);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ConvexError);
		const data = JSON.stringify((caught as ConvexError<string>).data);
		// Resolved as a member of the mapped org (orgSlug carried), refused as non-master.
		expect(data).toContain("not-fleet-master");
		expect(data).toContain(ORG);
	});

	for (const [label, subject] of [
		["prefix", SERVICE_ACCOUNT_USER_ID.slice(0, -1)],
		["suffix", `${SERVICE_ACCOUNT_USER_ID}x`],
		["case", SERVICE_ACCOUNT_USER_ID.toUpperCase()],
		["leading char", `x${SERVICE_ACCOUNT_USER_ID}`],
	] as const) {
		for (const claims of [{}, { org_slug: ORG }]) {
			test(`near-miss subject (${label}) ${
				Object.keys(claims).length ? "with" : "without"
			} an org claim -> not master`, async () => {
				expect(subject).not.toBe(SERVICE_ACCOUNT_USER_ID);
				const t = createT();
				await seed(t);
				await expectRefused(read(as(t, { subject, ...claims })));
			});
		}
	}

	test("env var unset -> the SA subject is NOT master", async () => {
		// Truly unset, restored afterwards.
		const saved = process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
		delete process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
		try {
			const t = createT();
			await seed(t);
			await expectRefused(read(as(t, { subject: SERVICE_ACCOUNT_USER_ID })));
			await expectRefused(
				read(
					as(t, {
						subject: SERVICE_ACCOUNT_USER_ID,
						org_slug: ORG,
						org_id: testClerkOrgId(ORG),
					}),
				),
			);
		} finally {
			if (saved !== undefined) {
				process.env.CLERK_SERVICE_ACCOUNT_USER_ID = saved;
			}
		}
	});

	test("env var empty string -> nobody is master through the carve-out", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", "");
		const t = createT();
		await seed(t);
		await expectRefused(
			read(as(t, { subject: "", org_slug: ORG, org_id: testClerkOrgId(ORG) })),
		);
		await expectRefused(read(as(t, { subject: OTHER_SUBJECT })));
	});
});
