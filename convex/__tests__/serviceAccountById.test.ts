/// <reference types="vite/client" />
/**
 * THE FLEET SERVICE ACCOUNT IS AN AGENTS ROW, NAMED BY DATA (M2 part 2).
 *
 * The authority is no longer the env var CLERK_SERVICE_ACCOUNT_USER_ID. It is:
 *   verified subject -> the operator org's mapping row (orgKind "operator")
 *   -> `serviceAccountAgentId` -> the agents row (kind "service", active,
 *   `authSubject` equal to the subject) -> a `fleet` principal judged by
 *   @vantageos/cloud-identity. Absent column, absent row, inactive row or a
 *   subject the row does not carry REFUSES; nothing falls back to the env var.
 *
 * Poles, each at two doors (a master-only read through `withOrgScope`, and an
 * `oauth` registration through `requireServiceAccount`):
 *   (a) seeded agent + column                        -> admitted
 *   (b) column absent                                 -> refused
 *   (c) subject == env var, row carries another one   -> refused
 *   (d) an ordinary member of a client org            -> refused
 *   (e) inactive service agent                        -> refused
 *   (f) agent row of the wrong kind                   -> refused
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

const ENV_SUBJECT = "test-service-account-user-id";
const ROW_SUBJECT = "service-subject-carried-by-the-row";
const OPERATOR = "m2b-operator-org";
const CLIENT = "m2b-client-org";
const MEMBER = "m2b-client-member";

type SeedOpts = {
	column?: boolean;
	active?: boolean;
	kind?: "service" | "agent";
	authSubject?: string;
};

async function seed(t: T, opts: SeedOpts = {}) {
	const { column = true, active = true, kind = "service" } = opts;
	const authSubject = opts.authSubject ?? ENV_SUBJECT;
	await t.run(async (ctx) => {
		const agentId = await ctx.db.insert("agents", {
			orgSlug: OPERATOR,
			clerkOrgId: testClerkOrgId(OPERATOR),
			name: "fleet-service-account",
			normalizedName: "fleet-service-account",
			kind,
			authSubject,
			isActive: active,
			createdAt: Date.now(),
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: OPERATOR,
			clerkOrgId: testClerkOrgId(OPERATOR),
			allowedOrchestrators: [],
			scopes: [],
			displayName: OPERATOR,
			isActive: true,
			createdAt: Date.now(),
			orgKind: "operator",
			...(column ? { serviceAccountAgentId: agentId } : {}),
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: CLIENT,
			clerkOrgId: testClerkOrgId(CLIENT),
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: CLIENT,
			isActive: true,
			createdAt: Date.now(),
			orgKind: "client",
		});
	});
}

const as = (t: T, identity: Record<string, unknown>) =>
	t.withIdentity(identity as Identity);

// Door 1: master-only read through withOrgScope.
const readMasterOnly = (c: ReturnType<typeof as>) =>
	c.query(api.fixPatterns.listByStack, { stack: "convex" });
// Door 2: a registration that calls requireServiceAccount.
const listClients = (c: ReturnType<typeof as>) =>
	c.query(api.oauth.listClients, {});

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

beforeEach(() => {
	vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", ENV_SUBJECT);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("(a) seeded service agent + column -> service doors admitted", () => {
	test("master-only read is served", async () => {
		const t = createT();
		await seed(t);
		expect(await readMasterOnly(as(t, { subject: ENV_SUBJECT }))).toEqual([]);
	});

	test("service-account registration is served", async () => {
		const t = createT();
		await seed(t);
		expect(await listClients(as(t, { subject: ENV_SUBJECT }))).toEqual([]);
	});

	test("the subject the ROW carries is admitted although it is not the env var", async () => {
		const t = createT();
		await seed(t, { authSubject: ROW_SUBJECT });
		expect(await readMasterOnly(as(t, { subject: ROW_SUBJECT }))).toEqual([]);
		expect(await listClients(as(t, { subject: ROW_SUBJECT }))).toEqual([]);
	});

	test("an org claim on the service token does not downgrade it", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, {
			subject: ENV_SUBJECT,
			org_slug: CLIENT,
			org_id: testClerkOrgId(CLIENT),
			org_role: "org:admin",
		});
		expect(await readMasterOnly(c)).toEqual([]);
		expect(await listClients(c)).toEqual([]);
	});
});

describe("(b) the operator mapping row carries no serviceAccountAgentId -> refused", () => {
	test("master-only read", async () => {
		const t = createT();
		await seed(t, { column: false });
		await expectRefused(readMasterOnly(as(t, { subject: ENV_SUBJECT })));
	});

	test("service-account registration", async () => {
		const t = createT();
		await seed(t, { column: false });
		await expectRefused(listClients(as(t, { subject: ENV_SUBJECT })));
	});

	test("no operator org at all", async () => {
		const t = createT();
		await expectRefused(readMasterOnly(as(t, { subject: ENV_SUBJECT })));
		await expectRefused(listClients(as(t, { subject: ENV_SUBJECT })));
	});
});

describe("(c) the subject matches the env var but not the row -> refused", () => {
	test("master-only read", async () => {
		const t = createT();
		await seed(t, { authSubject: ROW_SUBJECT });
		await expectRefused(readMasterOnly(as(t, { subject: ENV_SUBJECT })));
	});

	test("service-account registration", async () => {
		const t = createT();
		await seed(t, { authSubject: ROW_SUBJECT });
		await expectRefused(listClients(as(t, { subject: ENV_SUBJECT })));
	});

	test("an unset env var changes nothing: the row still decides", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", "");
		const t = createT();
		await seed(t);
		expect(await readMasterOnly(as(t, { subject: ENV_SUBJECT }))).toEqual([]);
	});
});

describe("(d) an ordinary member of a client org -> refused", () => {
	const member = {
		subject: MEMBER,
		org_slug: CLIENT,
		org_id: testClerkOrgId(CLIENT),
		org_role: "org:admin",
	};

	test("master-only read", async () => {
		const t = createT();
		await seed(t);
		await expectRefused(readMasterOnly(as(t, member)));
	});

	test("service-account registration", async () => {
		const t = createT();
		await seed(t);
		await expectRefused(listClients(as(t, member)));
	});
});

describe("(e) inactive service agent -> refused", () => {
	test("master-only read", async () => {
		const t = createT();
		await seed(t, { active: false });
		await expectRefused(readMasterOnly(as(t, { subject: ENV_SUBJECT })));
	});

	test("service-account registration", async () => {
		const t = createT();
		await seed(t, { active: false });
		await expectRefused(listClients(as(t, { subject: ENV_SUBJECT })));
	});
});

describe("(f) the linked agents row is not of kind service -> refused", () => {
	test("master-only read", async () => {
		const t = createT();
		await seed(t, { kind: "agent" });
		await expectRefused(readMasterOnly(as(t, { subject: ENV_SUBJECT })));
	});

	test("service-account registration", async () => {
		const t = createT();
		await seed(t, { kind: "agent" });
		await expectRefused(listClients(as(t, { subject: ENV_SUBJECT })));
	});
});

const clientClaim = (subject: string) => ({
	subject,
	org_slug: CLIENT,
	org_id: testClerkOrgId(CLIENT),
	org_role: "org:admin",
});

describe("(g) a service account of a CLIENT org is not the fleet -> refused", () => {
	// Pins the `principal.kind !== "fleet"` check in resolveServiceAccount: the
	// client's own mapping names its own kind:"service" row, the chain is intact,
	// and the package resolves it as `service`, never `fleet`.
	const CLIENT_SVC = "client-org-own-service-subject";

	async function seedClientService(t: T) {
		await seed(t);
		await t.run(async (ctx) => {
			const agentId = await ctx.db.insert("agents", {
				orgSlug: CLIENT,
				clerkOrgId: testClerkOrgId(CLIENT),
				name: "client-service-account",
				normalizedName: "client-service-account",
				kind: "service",
				authSubject: CLIENT_SVC,
				isActive: true,
				createdAt: Date.now(),
			});
			const mapping = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", CLIENT))
				.unique();
			if (mapping === null) throw new Error("client mapping not seeded");
			await ctx.db.patch(mapping._id, { serviceAccountAgentId: agentId });
		});
	}

	test("master-only read", async () => {
		const t = createT();
		await seedClientService(t);
		await expectRefused(readMasterOnly(as(t, { subject: CLIENT_SVC })));
	});

	test("service-account registration", async () => {
		const t = createT();
		await seedClientService(t);
		await expectRefused(listClients(as(t, { subject: CLIENT_SVC })));
	});

	test("the real operator service account is still served beside it", async () => {
		const t = createT();
		await seedClientService(t);
		expect(await readMasterOnly(as(t, { subject: ENV_SUBJECT }))).toEqual([]);
	});
});

describe("(h) a claimed service subject with a broken chain RAISES, never an ordinary caller", () => {
	// Pins the claimsServiceAccount branch in withOrgScope: the subject is a
	// service row's authSubject, the row is inactive, and the token also carries a
	// client-org admin claim that WOULD be served on the ordinary path.
	test("pole: an ordinary client admin is served (the door is open to that claim)", async () => {
		const t = createT();
		await seed(t);
		const served = await as(t, clientClaim(MEMBER)).query(
			api.missions.list,
			{},
		);
		expect(Array.isArray(served)).toBe(true);
	});

	test("the broken-chain service subject with that same claim is refused", async () => {
		const t = createT();
		await seed(t, { active: false });
		await expectRefused(
			as(t, clientClaim(ENV_SUBJECT)).query(api.missions.list, {}),
		);
	});
});
