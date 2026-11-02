/// <reference types="vite/client" />
/**
 * tokenRightsDerivation.test.ts - VantagePeers Cloud (multi-tenant).
 * task k17dhntq3m2w5x3x1jtdmkkba18hek7m.
 *
 * Rule authority-attached-to-anonymous-object.md: a token's rights are read from
 * the scope profile row AS IT IS NOW, never from the copy made at mint. A token
 * minted under an older profile must lose a right the profile removed and gain one
 * it added; a profile that is gone or re-pointed to another organisation grants
 * nothing. A token whose mint narrowed it below its profile keeps that narrowing
 * (intersect, never widen).
 *
 *   FOLLOWS   profile gains a right -> token has it; profile loses one -> token lost it
 *   DENY      profile deleted -> null; profile re-pointed to another org -> null
 *   NARROWS   admin mint below the profile stays below; never above the profile
 *   PERSON    a person token follows the organisation's live mapping
 *   IDENTICAL two tokens of one profile with different snapshots resolve identically
 */
import { createHash } from "node:crypto";
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
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

const SLUG = "org-a";
const OLD_READ = ["team/org-a", "project/org-a"];
const NEW_READ = [...OLD_READ, "orchestrator/agent-x"];

async function seedOrg(t: T, slug = SLUG, allowed = ["clio"]): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: allowed,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedProfile(
	t: T,
	profileId: string,
	read: string[],
	write: string[],
	from: string[] = ["clio"],
	slug = SLUG,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: profileId,
			fromAllowList: from,
			namespaceReadPrefixes: read,
			namespaceWritePrefixes: write,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
		});
	});
}

async function patchProfile(
	t: T,
	profileId: string,
	patch: {
		fromAllowList?: string[];
		namespaceReadPrefixes?: string[];
		namespaceWritePrefixes?: string[];
		clerkOrgSlug?: string;
		clerkOrgId?: string;
	},
): Promise<void> {
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique();
		if (row) await ctx.db.patch(row._id, patch);
	});
}

async function deleteProfile(t: T, profileId: string): Promise<void> {
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique();
		if (row) await ctx.db.delete(row._id);
	});
}

const mint = (
	t: T,
	raw: string,
	profileId: string,
	snapshot: { from: string[]; read: string[]; write: string[] },
	clientId = "seat-client",
) =>
	asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash: sha(raw),
		clientId,
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile: profileId,
		fromAllowList: snapshot.from,
		namespaceReadPrefixes: snapshot.read,
		namespaceWritePrefixes: snapshot.write,
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug: SLUG,
	});

const lookup = (t: T, raw: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash: sha(raw) });

const OLD = { from: ["clio"], read: OLD_READ, write: ["team/org-a"] };
const NEW_WRITE = ["team/org-a", "orchestrator/agent-x"];

describe("a token's rights follow its scope profile as it is now", () => {
	test("FOLLOWS: the profile gains orchestrator/<agent> -> a token minted before has it", async () => {
		const t = createT();
		await seedOrg(t);
		await seedProfile(t, "p-a", OLD_READ, ["team/org-a"]);
		await mint(t, "tok", "p-a", OLD);
		expect((await lookup(t, "tok"))?.namespaceReadPrefixes).toEqual(OLD_READ);
		await patchProfile(t, "p-a", {
			namespaceReadPrefixes: NEW_READ,
			namespaceWritePrefixes: NEW_WRITE,
		});
		const after = await lookup(t, "tok");
		expect(after?.namespaceReadPrefixes).toEqual(NEW_READ);
		expect(after?.namespaceWritePrefixes).toEqual(NEW_WRITE);
	});

	test("FOLLOWS: the profile loses a right -> a token minted before no longer has it", async () => {
		const t = createT();
		await seedOrg(t);
		await seedProfile(t, "p-a", NEW_READ, NEW_WRITE, ["clio", "nova"]);
		await mint(t, "tok", "p-a", {
			from: ["clio", "nova"],
			read: NEW_READ,
			write: NEW_WRITE,
		});
		await patchProfile(t, "p-a", {
			fromAllowList: ["clio"],
			namespaceReadPrefixes: OLD_READ,
			namespaceWritePrefixes: ["team/org-a"],
		});
		const after = await lookup(t, "tok");
		expect(after?.fromAllowList).toEqual(["clio"]);
		expect(after?.namespaceReadPrefixes).toEqual(OLD_READ);
		expect(after?.namespaceWritePrefixes).toEqual(["team/org-a"]);
	});

	test("IDENTICAL: two tokens of one profile with different snapshots resolve identically", async () => {
		const t = createT();
		await seedOrg(t);
		await seedProfile(t, "p-a", OLD_READ, ["team/org-a"]);
		await mint(t, "stale", "p-a", OLD);
		await patchProfile(t, "p-a", {
			namespaceReadPrefixes: NEW_READ,
			namespaceWritePrefixes: NEW_WRITE,
		});
		await mint(t, "fresh", "p-a", { from: ["clio"], read: NEW_READ, write: NEW_WRITE });
		const a = await lookup(t, "stale");
		const b = await lookup(t, "fresh");
		expect(a).not.toBeNull();
		expect(a?.namespaceReadPrefixes).toEqual(b?.namespaceReadPrefixes);
		expect(a?.namespaceWritePrefixes).toEqual(b?.namespaceWritePrefixes);
		expect(a?.fromAllowList).toEqual(b?.fromAllowList);
	});

	test("DENY: the profile row deleted -> the token resolves to nothing", async () => {
		const t = createT();
		await seedOrg(t);
		await seedProfile(t, "p-a", OLD_READ, ["team/org-a"]);
		await mint(t, "tok", "p-a", OLD);
		expect(await lookup(t, "tok")).not.toBeNull();
		await deleteProfile(t, "p-a");
		expect(await lookup(t, "tok")).toBeNull();
	});

	test("DENY: the profile re-pointed to another organisation -> the token resolves to nothing", async () => {
		const t = createT();
		await seedOrg(t);
		await seedOrg(t, "org-b");
		await seedProfile(t, "p-a", OLD_READ, ["team/org-a"]);
		await mint(t, "tok", "p-a", OLD);
		await patchProfile(t, "p-a", {
			clerkOrgSlug: "org-b",
			clerkOrgId: testClerkOrgId("org-b"),
		});
		expect(await lookup(t, "tok")).toBeNull();
	});
});

describe("a mint that narrowed below its profile stays narrowed, never widened", () => {
	test("NARROWS: a mint below the profile stays below it when the profile later gains", async () => {
		const t = createT();
		await seedOrg(t);
		await seedProfile(t, "p-a", OLD_READ, ["team/org-a"]);
		await mint(t, "narrow", "p-a", { from: ["clio"], read: ["team/org-a"], write: [] });
		await patchProfile(t, "p-a", { namespaceReadPrefixes: NEW_READ });
		const row = await lookup(t, "narrow");
		expect(row?.namespaceReadPrefixes).toEqual(["team/org-a"]);
		expect(row?.namespaceWritePrefixes).toEqual([]);
	});

	test("NARROWS: ...and loses a right the profile removed", async () => {
		const t = createT();
		await seedOrg(t);
		await seedProfile(t, "p-a", OLD_READ, ["team/org-a"]);
		await mint(t, "narrow", "p-a", { from: ["clio"], read: OLD_READ, write: [] });
		await patchProfile(t, "p-a", { namespaceReadPrefixes: ["team/org-a"] });
		expect((await lookup(t, "narrow"))?.namespaceReadPrefixes).toEqual(["team/org-a"]);
	});

	test("NEVER WIDENS: a mint above the profile gets the profile, not its own arrays", async () => {
		const t = createT();
		await seedOrg(t);
		await seedProfile(t, "p-a", OLD_READ, ["team/org-a"]);
		await mint(t, "wide", "p-a", {
			from: ["clio", "zeta"],
			read: [...OLD_READ, "global"],
			write: ["global"],
		});
		const row = await lookup(t, "wide");
		expect(row?.fromAllowList).toEqual(["clio"]);
		expect(row?.namespaceReadPrefixes).toEqual(OLD_READ);
		expect(row?.namespaceWritePrefixes).toEqual([]);
	});

	test("LEGACY: a row with no pin marker minted by admin-mint: is read as pinned", async () => {
		const t = createT();
		await seedOrg(t);
		await seedProfile(t, "p-a", NEW_READ, ["team/org-a"]);
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: sha("legacy"),
				clientId: "admin-mint:44444444",
				userId: "u",
				scopes: ["mcp:full"],
				scopeProfile: "p-a",
				fromAllowList: ["clio"],
				namespaceReadPrefixes: ["team/org-a"],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: SLUG,
				clerkOrgId: testClerkOrgId(SLUG),
			});
		});
		expect((await lookup(t, "legacy"))?.namespaceReadPrefixes).toEqual(["team/org-a"]);
	});
});

describe("a person token follows the organisation's live mapping", () => {
	test("PERSON: the mapping's allowed orchestrators changed -> the token follows", async () => {
		const t = createT();
		await seedOrg(t, SLUG, ["clio"]);
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: sha("person"),
				clientId: "chatgpt",
				userId: "user_1",
				scopes: ["view-own-tasks"],
				scopeProfile: "team-member",
				fromAllowList: ["clio"],
				namespaceReadPrefixes: [`team/${SLUG}`, `project/${SLUG}`],
				namespaceWritePrefixes: [`team/${SLUG}`],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: SLUG,
				clerkOrgId: testClerkOrgId(SLUG),
				principal: "person",
				orgRole: "org:member",
			});
		});
		expect((await lookup(t, "person"))?.fromAllowList).toEqual(["clio"]);
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.filter((q) => q.eq(q.field("clerkOrgSlug"), SLUG))
				.unique();
			if (m) await ctx.db.patch(m._id, { allowedOrchestrators: ["clio", "nova"] });
		});
		const after = await lookup(t, "person");
		expect(after?.fromAllowList).toEqual(["clio", "nova"]);
		expect(after?.namespaceWritePrefixes).toEqual([`team/${SLUG}`]);
	});
});
