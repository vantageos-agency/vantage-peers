/// <reference types="vite/client" />
/**
 * THREE DOORS THAT RUN BEFORE A CALLER HAS AN IDENTITY.
 *
 * `agentCredentials:resolveAgentCredential`, `licenses:activate` and
 * `licenses:validate` are how a caller OBTAINS an identity, so "check who
 * calls" cannot be applied to them the usual way. Each one ends in a decided
 * state, pinned here:
 *
 *  - resolveAgentCredential — CLOSED to everyone but the fleet's service
 *    account (the MCP server, its only caller, always speaks as that account).
 *    An anonymous caller or an ordinary member holding a VALID secret is
 *    refused: it can no longer be used as an oracle for "is this secret live".
 *  - licenses:activate — public by decision. The presented key plus the
 *    licensee's email IS the authorisation; every failure is the same bytes.
 *  - licenses:validate — public by decision, but answers only what possession
 *    of the key entitles: a status and an expiry. It no longer echoes the
 *    licensee's email, which is the SECOND factor `activate` checks.
 *
 * Every DENY pole below is an ORDINARY or ANONYMOUS caller. `asMaster` only
 * appears in an ALLOW pole.
 */
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const DOOR = "agentCredentials:resolveAgentCredential";

const asMaster = (t: T) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Parameters<
		typeof t.withIdentity
	>[0]);
const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

async function seedOrg(t: T, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
			allowedOrchestrators: ["b"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function mint(t: T, org: string, name: string): Promise<string> {
	await seedOrg(t, org);
	await adminOf(t, org).mutation(api.agents.registerAgent, {
		orgSlug: org,
		name,
	});
	const minted = await adminOf(t, org).mutation(
		api.agentCredentials.mintAgentCredential,
		{ orgSlug: org, agentId: await agentIdOf(t, org, name) },
	);
	return minted.secret;
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		if (typeof data === "string") return data;
		throw new Error(`raised without a structured ConvexError: ${String(e)}`);
	}
	throw new Error("expected a refusal, got a success");
}

describe("agentCredentials:resolveAgentCredential — closed to a non-service caller", () => {
	test("DENY: anonymous caller with a VALID secret is refused, nothing resolved", async () => {
		const t = createT();
		const secret = await mint(t, "acme", "sigma");
		const data = await refusalOf(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secret,
			}),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain(DOOR);
		expect(data).not.toContain("acme");
		expect(data).not.toContain("sigma");
	});

	test("DENY: an ordinary member (own org, other org) holding a VALID secret is refused", async () => {
		const t = createT();
		const secret = await mint(t, "acme", "sigma");
		await seedOrg(t, "rival");
		for (const org of ["acme", "rival"]) {
			const data = await refusalOf(
				adminOf(t, org).query(api.agentCredentials.resolveAgentCredential, {
					presentedSecret: secret,
				}),
			);
			expect(data).toContain("RBAC_DENIED");
			expect(data).toContain(DOOR);
		}
	});

	test("DENY: no oracle — a made-up secret and a live secret are the SAME bytes to an anonymous caller", async () => {
		const t = createT();
		const secret = await mint(t, "acme", "sigma");
		const live = await refusalOf(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secret,
			}),
		);
		const fake = await refusalOf(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: "made-up-secret-value",
			}),
		);
		expect(fake).toBe(live);
	});

	test("ALLOW: the service account (the MCP login path) still resolves a live secret", async () => {
		const t = createT();
		const secret = await mint(t, "acme", "sigma");
		const resolved = await asMaster(t).query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: secret },
		);
		expect(resolved).toMatchObject({ orgSlug: "acme", agentName: "sigma" });
	});

	test("ALLOW-side refusal: the service account with a made-up secret is still refused with its code", async () => {
		const t = createT();
		await mint(t, "acme", "sigma");
		const data = await refusalOf(
			asMaster(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: "made-up-secret-value",
			}),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("credential-not-recognised");
	});
});

const EMAIL = "licensee@example.com";

async function newLicense(t: T) {
	return await t.mutation(internal.licenses.generate, {
		customerEmail: EMAIL,
		productCode: "vantage-peers-self-host",
		tier: "open-core-99-eur-yr",
	});
}

describe("licenses:validate — answers only what the key entitles", () => {
	test("PRESENT: a live key gets status + expiry and NOT the licensee's email", async () => {
		const t = createT();
		const { licenseKey } = await newLicense(t);
		const r = await t.query(api.licenses.validate, { licenseKey });
		expect(r.status).toBe("active");
		expect(typeof r.expiresAt).toBe("number");
		expect(r).not.toHaveProperty("customerEmail");
		expect(JSON.stringify(r)).not.toContain(EMAIL);
	});

	test("ABSENT: a made-up key gets exactly { status: unknown }", async () => {
		const t = createT();
		await newLicense(t);
		const r = await t.query(api.licenses.validate, {
			licenseKey: "made-up-license-key",
		});
		expect(r).toEqual({ status: "unknown" });
	});

	test("an oversize key is refused as unknown, same bytes as any unknown key", async () => {
		const t = createT();
		await newLicense(t);
		const r = await t.query(api.licenses.validate, {
			licenseKey: "x".repeat(100_000),
		});
		expect(r).toEqual({ status: "unknown" });
	});
});

describe("licenses:activate — key + email is the authorisation, every failure is the same", () => {
	const REFUSAL = "License invalid or expired";

	test("DENY: unknown key, wrong email, revoked key all raise the SAME message", async () => {
		const t = createT();
		const { licenseId, licenseKey } = await newLicense(t);
		const other = await newLicense(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(other.licenseId, { status: "revoked" });
		});
		const probes = [
			{ licenseKey: "made-up-license-key", customerEmail: EMAIL },
			{ licenseKey, customerEmail: "someone-else@example.com" },
			{ licenseKey: other.licenseKey, customerEmail: EMAIL },
			{ licenseKey: "x".repeat(100_000), customerEmail: EMAIL },
		];
		for (const p of probes) {
			await expect(t.mutation(api.licenses.activate, p)).rejects.toThrow(
				REFUSAL,
			);
		}
		// no failed probe wrote anything
		const row = await t.run(async (ctx) => ctx.db.get(licenseId));
		expect(row?.activatedAt).toBeUndefined();
	});

	test("PRESENT: the licensee activates, and only THEIR row is written", async () => {
		const t = createT();
		const mine = await newLicense(t);
		const theirs = await newLicense(t);
		const r = await t.mutation(api.licenses.activate, {
			licenseKey: mine.licenseKey,
			customerEmail: EMAIL,
		});
		expect(r.ok).toBe(true);
		const rows = await t.run(async (ctx) => ({
			mine: await ctx.db.get(mine.licenseId),
			theirs: await ctx.db.get(theirs.licenseId),
		}));
		expect(rows.mine?.activatedAt).toBeDefined();
		expect(rows.theirs?.activatedAt).toBeUndefined();
	});
});
