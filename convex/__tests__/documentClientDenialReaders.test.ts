/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// A listed Client ID Metadata Document client holds no access at EVERY reader of
// an access-token row, not only at oauth:getAccessTokenByHash
// (.claude/rules/rights-change-migrates-live-connections.md, rule 5: a path is
// not a connection). The readers: oauth:getAccessTokenByHash,
// resolveVerifiedPerson (convex/lib/personPrincipal.ts), and the two orgRoster
// token readers. All four ask ONE helper (convex/lib/documentClientDenial.ts).
//
// PRESENT  the token answers before the listing.
// REFUSED  the same token is refused after it, at each reader.
// ABSENT   a token of a client that was never listed is untouched.
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
const service = (t: T) =>
	t.withIdentity({
		subject: process.env.CLERK_SERVICE_ACCOUNT_USER_ID,
	} as Identity);

const LISTED = "https://app.example.com/oauth/client-metadata.json";
const OTHER = "https://other.example.com/oauth/client-metadata.json";
const ORG = "org-a";

async function seed(t: T) {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			allowedOrchestrators: ["agent-a"],
			scopes: ["vantage:read", "vantage:write"],
			displayName: ORG,
			isActive: true,
			createdAt: now,
		});
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		await ctx.db.insert("agents", {
			orgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			name: "agent-a",
			normalizedName: "agent-a",
			isActive: true,
			createdAt: now,
		});
		const row = {
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "person",
			fromAllowList: ["agent-a"],
			namespaceReadPrefixes: [`team/${ORG}`],
			namespaceWritePrefixes: [`team/${ORG}`],
			expiresAt: now + 3_600_000,
			createdAt: now,
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			userId: "user_editor",
			orgRole: "org:editor",
			principal: "person" as const,
		};
		await ctx.db.insert("oauth_access_tokens", {
			...row,
			clientId: LISTED,
			tokenHash: "a".repeat(64),
		});
		await ctx.db.insert("oauth_access_tokens", {
			...row,
			clientId: OTHER,
			tokenHash: "b".repeat(64),
		});
	});
}

const LISTED_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

const list = (t: T) =>
	service(t).mutation(api.oauth.deleteClient, {
		clientId: LISTED,
		reason: "abuse report 2026-11-10, operator audit trail",
		operator: "laurent",
	});

// The four readers, each as the call that reaches it.
const readers: [string, (t: T, hash: string) => Promise<unknown>][] = [
	[
		"oauth:getAccessTokenByHash",
		async (t, hash) =>
			(await service(t).query(api.oauth.getAccessTokenByHash, { tokenHash: hash })) ??
			Promise.reject(new Error("TOKEN_NOT_LIVE")),
	],
	[
		"resolveVerifiedPerson (a person door)",
		(t, hash) =>
			service(t).mutation(api.tasks.create, {
				title: "t",
				project: "test-project",
				assignedTo: "agent-a",
				priority: "high",
				status: "todo",
				verifiedPerson: { accessTokenHash: hash },
			}),
	],
	[
		"orgRoster:getAgentDirectoryForAccessToken",
		(t, hash) =>
			service(t).query(api.orgRoster.getAgentDirectoryForAccessToken, {
				tokenHash: hash,
			}),
	],
	[
		"orgRoster:getForAccessToken",
		(t, hash) =>
			service(t).query(api.orgRoster.getForAccessToken, { tokenHash: hash }),
	],
];

describe("a listed client's token is refused at every reader", () => {
	for (const [name, call] of readers) {
		test(`${name}: PRESENT before the listing, REFUSED after, ABSENT for another client`, async () => {
			const t = createT();
			await seed(t);
			await expect(call(t, LISTED_HASH)).resolves.toBeDefined();
			await list(t);
			await expect(call(t, LISTED_HASH)).rejects.toThrow();
			await expect(call(t, OTHER_HASH)).resolves.toBeDefined();
		});
	}

	test("the readers share one helper and no reader copies its query", async () => {
		const { readFileSync } = await import("node:fs");
		const read = (p: string) =>
			readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
		for (const p of ["oauth.ts", "orgRoster.ts", "lib/personPrincipal.ts"]) {
			const src = read(p);
			expect(src, p).toContain("isDocumentClientDenied");
			expect(src, `${p} must not query the table itself`).not.toContain(
				'query("oauth_denied_document_clients")',
			);
		}
	});
});
