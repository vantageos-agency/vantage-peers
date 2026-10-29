/**
 * Module M3 (task k177pske4qj37sfw7nw2787msd8fzp0e) -- the OAuth admin doors and
 * the Clerk bearer revocation decide WHO MAY CALL by the @vantageos/cloud-identity
 * standing gates, not by a comparison written in this repository.
 *
 *   oauth:*  (service-account-only doors)  -> requireServiceAccountStanding
 *   oauth:getClientByClientId, getScopeProfile (fleet-only reads) -> requireFleetStanding
 *   credentials:revokeMyBearers            -> requireSubjectFromIdentity
 *
 * The refusal the package raises is relayed to the wire unchanged: its code
 * (RBAC_DENIED), its reason and its door survive in errorData. Poles run as a
 * SCOPED org identity (an ordinary member), never as master.
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

const SERVICE_ACCOUNT_ID = "test-service-account-user-id";
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
const asMemberOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		org_id: testClerkOrgId(org),
		org_role: "org:member",
	} as Parameters<T["withIdentity"]>[0]);

async function seedOrg(t: T, slug: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: ["clio"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data : String((e as Error).message);
	}
	throw new Error("expected a refusal, the call was served");
}

describe("service-account-only doors are judged by the package standing gate", () => {
	test("DENY: an ordinary member is refused with the package reason and the door", async () => {
		const t = createT();
		await seedOrg(t, "acme");
		const text = await refusalOf(
			asMemberOf(t, "acme").query(api.oauth.listClients, {}),
		);
		expect(text).toContain("RBAC_DENIED");
		expect(text).toContain("standing-not-allowed");
		expect(text).toContain("oauth:listClients");
	});

	test("DENY: an anonymous caller is refused with the package reason and the door", async () => {
		const t = createT();
		const text = await refusalOf(t.query(api.oauth.listClients, {}));
		expect(text).toContain("RBAC_DENIED");
		expect(text).toContain("scope-not-resolved");
		expect(text).toContain("oauth:listClients");
	});

	test("DENY: a signed-in caller with no organisation is refused naming the door", async () => {
		const t = createT();
		const text = await refusalOf(
			t.withIdentity({ subject: "no-org-user" }).query(api.oauth.listClients, {}),
		);
		expect(text).toContain("RBAC_DENIED");
		expect(text).toContain("oauth:listClients");
	});

	test("PRESENT: the fleet service account is served", async () => {
		const t = createT();
		expect(await asService(t).query(api.oauth.listClients, {})).toEqual([]);
	});
});

describe("fleet-only OAuth reads are judged by the package standing gate", () => {
	test("DENY: a member cannot read a client or a scope profile", async () => {
		const t = createT();
		await seedOrg(t, "acme");
		const client = await refusalOf(
			asMemberOf(t, "acme").query(api.oauth.getClientByClientId, {
				clientId: "c1",
			}),
		);
		expect(client).toContain("RBAC_DENIED");
		expect(client).toContain("standing-not-allowed");
		expect(client).toContain("oauth:getClientByClientId");
		const profile = await refusalOf(
			asMemberOf(t, "acme").query(api.oauth.getScopeProfile, {
				profileId: "p1",
			}),
		);
		expect(profile).toContain("RBAC_DENIED");
		expect(profile).toContain("standing-not-allowed");
		expect(profile).toContain("oauth:getScopeProfile");
	});

	test("DENY: anonymous is refused as an unresolved scope", async () => {
		const t = createT();
		const text = await refusalOf(
			t.query(api.oauth.getClientByClientId, { clientId: "c1" }),
		);
		expect(text).toContain("scope-not-resolved");
		expect(text).toContain("oauth:getClientByClientId");
	});

	test("ABSENT: the service account reading an unknown client gets null, not a refusal", async () => {
		const t = createT();
		expect(
			await asService(t).query(api.oauth.getClientByClientId, {
				clientId: "nope",
			}),
		).toBeNull();
		expect(
			await asService(t).query(api.oauth.getScopeProfile, { profileId: "nope" }),
		).toBeNull();
	});
});

describe("credentials:revokeMyBearers takes its subject from the package", () => {
	test("DENY: anonymous is refused with the package reason and the door", async () => {
		const t = createT();
		const text = await refusalOf(t.mutation(api.credentials.revokeMyBearers, {}));
		expect(text).toContain("RBAC_DENIED");
		expect(text).toContain("no-verified-subject");
		expect(text).toContain("credentials:revokeMyBearers");
	});

	test("PRESENT: a signed-in user with no bearer revokes none", async () => {
		const t = createT();
		expect(
			await t
				.withIdentity({ subject: "user_x" })
				.mutation(api.credentials.revokeMyBearers, {}),
		).toEqual({ revoked: 0 });
	});
});
