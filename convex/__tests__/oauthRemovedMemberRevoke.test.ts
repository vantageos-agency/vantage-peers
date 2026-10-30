/// <reference types="vite/client" />
/**
 * oauthRemovedMemberRevoke.test.ts - task k17fxe8feeq1k2rb1ggj76e97s8h7m7k.
 *
 * A person who is removed from an organisation must lose the access tokens the
 * person-flow minted for that organisation. The membership delete used to write a
 * tombstone and touch no token, so the removed member kept a live bearer for up
 * to the 1 h access TTL.
 *
 * Two doors write a tombstone: the Clerk webhook (`applyClerkMembershipEvent`,
 * kind delete) and the reconcile (`reconcileOrgFromClerk`, a member Clerk no longer
 * lists). Both must revoke, scoped to (person, organisation): the same person's
 * tokens for another organisation, and another member's tokens, stay live.
 *
 * Poles: REVOKED (webhook, reconcile, absent row, unstamped legacy row, over a
 * batch), KEPT (other org, other member, stale delete, dry run, re-added member).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { MEMBER_REVOKE_BATCH } from "../orgMembership";
import schema from "../schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";

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
const ORG_A = "org_AAA111";
const SLUG_A = "acme-inc";
const ORG_B = "org_BBB222";
const SLUG_B = "globex";
const ALICE = "user_alice";
const BOB = "user_bob";
const T0 = 1_000_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

const seedMember = (t: T, orgId: string, slug: string, userId: string) =>
	t.run((ctx) =>
		ctx.db.insert("orgMembership", {
			clerkOrgSlug: slug,
			clerkOrgId: orgId,
			clerkUserId: userId,
			role: "member",
			createdAt: T0,
			updatedAt: T0,
			lastEventAt: T0,
		}),
	);

/** A person-flow access token, as /token mints it (userId = the Clerk subject). */
const seedPersonToken = (
	t: T,
	raw: string,
	o: { userId: string; orgId?: string; slug: string },
) =>
	t.run((ctx) =>
		ctx.db.insert("oauth_access_tokens", {
			tokenHash: sha(raw),
			clientId: "dcr-claude",
			userId: o.userId,
			scopes: ["mcp:full"],
			scopeProfile: "person",
			fromAllowList: [],
			namespaceReadPrefixes: [`team/${o.slug}`],
			namespaceWritePrefixes: [`team/${o.slug}`],
			expiresAt: Date.now() + 3_600_000,
			createdAt: Date.now(),
			clerkOrgSlug: o.slug,
			...(o.orgId !== undefined ? { clerkOrgId: o.orgId } : {}),
			orgRole: "org:member",
			principal: "person",
		}),
	);

const isLive = async (t: T, raw: string) =>
	(await asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash: sha(raw) })) !== null;

const webhookDelete = (t: T, userId: string, orgId = ORG_A, eventAt = T0 + 1000) =>
	t.mutation(internal.orgMembership.applyClerkMembershipEvent, {
		kind: "delete",
		clerkOrgId: orgId,
		clerkOrgSlug: orgId === ORG_A ? SLUG_A : SLUG_B,
		clerkUserId: userId,
		role: "member",
		eventAt,
	});

const reconcile = (t: T, members: string[], dryRun = false, orgId = ORG_A) =>
	t.mutation(internal.orgMembership.reconcileOrgFromClerk, {
		clerkOrgId: orgId,
		clerkOrgSlug: orgId === ORG_A ? SLUG_A : SLUG_B,
		members: members.map((userId) => ({ userId, role: "member" as const })),
		dryRun,
		eventAt: T0 + 2000,
	});

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("REVOKED: the membership delete takes the person's tokens for that organisation", () => {
	test("webhook delete: the removed member's access token is revoked", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedPersonToken(t, "alice-a1", { userId: ALICE, orgId: ORG_A, slug: SLUG_A });
		await seedPersonToken(t, "alice-a2", { userId: ALICE, orgId: ORG_A, slug: SLUG_A });
		expect(await isLive(t, "alice-a1")).toBe(true);
		expect(await webhookDelete(t, ALICE)).toBe("removed");
		expect(await isLive(t, "alice-a1")).toBe(false);
		expect(await isLive(t, "alice-a2")).toBe(false);
	});

	test("reconcile tombstone: a member Clerk no longer lists loses the token", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedMember(t, ORG_A, SLUG_A, BOB);
		await seedPersonToken(t, "alice-a1", { userId: ALICE, orgId: ORG_A, slug: SLUG_A });
		await seedPersonToken(t, "bob-a1", { userId: BOB, orgId: ORG_A, slug: SLUG_A });
		const res = await reconcile(t, [BOB]);
		expect(res.removed).toBe(1);
		expect(await isLive(t, "alice-a1")).toBe(false);
		expect(await isLive(t, "bob-a1")).toBe(true);
	});

	test("a delete for a member with NO stored row (missed created) still revokes", async () => {
		const t = createT();
		await seedPersonToken(t, "alice-a1", { userId: ALICE, orgId: ORG_A, slug: SLUG_A });
		expect(await webhookDelete(t, ALICE)).toBe("absent");
		expect(await isLive(t, "alice-a1")).toBe(false);
	});

	test("a legacy token with no clerkOrgId is revoked through its slug", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedPersonToken(t, "alice-legacy", { userId: ALICE, slug: SLUG_A });
		await webhookDelete(t, ALICE);
		expect(await isLive(t, "alice-legacy")).toBe(false);
	});

	test("more tokens than one batch: the continuation finishes the revoke", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		const names = Array.from({ length: MEMBER_REVOKE_BATCH + 1 }, (_, i) => `alice-bulk-${i}`);
		for (const n of names) await seedPersonToken(t, n, { userId: ALICE, orgId: ORG_A, slug: SLUG_A });
		await webhookDelete(t, ALICE);
		// One transaction revokes one batch; the last token is still live until the continuation runs.
		expect(await isLive(t, names[MEMBER_REVOKE_BATCH])).toBe(true);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		for (const n of names) expect(await isLive(t, n)).toBe(false);
	});
});

describe("KEPT: the revoke is scoped to the person and the organisation", () => {
	test("cross-org: removed from A, the same person keeps the token for B", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedMember(t, ORG_B, SLUG_B, ALICE);
		await seedPersonToken(t, "alice-a1", { userId: ALICE, orgId: ORG_A, slug: SLUG_A });
		await seedPersonToken(t, "alice-b1", { userId: ALICE, orgId: ORG_B, slug: SLUG_B });
		await webhookDelete(t, ALICE, ORG_A);
		expect(await isLive(t, "alice-a1")).toBe(false);
		expect(await isLive(t, "alice-b1")).toBe(true);
	});

	test("cross-org through reconcile: B's token survives A's tombstone", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedPersonToken(t, "alice-a1", { userId: ALICE, orgId: ORG_A, slug: SLUG_A });
		await seedPersonToken(t, "alice-b1", { userId: ALICE, orgId: ORG_B, slug: SLUG_B });
		await reconcile(t, []);
		expect(await isLive(t, "alice-a1")).toBe(false);
		expect(await isLive(t, "alice-b1")).toBe(true);
	});

	test("a legacy token (no clerkOrgId) of another org's slug is kept", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedPersonToken(t, "alice-legacy-b", { userId: ALICE, slug: SLUG_B });
		await webhookDelete(t, ALICE, ORG_A);
		expect(await isLive(t, "alice-legacy-b")).toBe(true);
	});

	test("another member of the same org keeps the token", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedMember(t, ORG_A, SLUG_A, BOB);
		await seedPersonToken(t, "bob-a1", { userId: BOB, orgId: ORG_A, slug: SLUG_A });
		await webhookDelete(t, ALICE);
		expect(await isLive(t, "bob-a1")).toBe(true);
	});

	test("a STALE delete (older than the row's last event) revokes nothing", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedPersonToken(t, "alice-a1", { userId: ALICE, orgId: ORG_A, slug: SLUG_A });
		expect(await webhookDelete(t, ALICE, ORG_A, T0 - 5)).toBe("stale");
		expect(await isLive(t, "alice-a1")).toBe(true);
	});

	test("a dry-run reconcile revokes nothing", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedPersonToken(t, "alice-a1", { userId: ALICE, orgId: ORG_A, slug: SLUG_A });
		await reconcile(t, [], true);
		expect(await isLive(t, "alice-a1")).toBe(true);
	});

	test("a CURRENT member (upsert event) keeps the token", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedPersonToken(t, "alice-a1", { userId: ALICE, orgId: ORG_A, slug: SLUG_A });
		await t.mutation(internal.orgMembership.applyClerkMembershipEvent, {
			kind: "upsert",
			clerkOrgId: ORG_A,
			clerkOrgSlug: SLUG_A,
			clerkUserId: ALICE,
			role: "admin",
			eventAt: T0 + 1000,
		});
		expect(await isLive(t, "alice-a1")).toBe(true);
	});

	test("a seat token whose userId is an agent name is never touched by a person's delete", async () => {
		const t = createT();
		await seedMember(t, ORG_A, SLUG_A, ALICE);
		await seedPersonToken(t, "seat-a1", { userId: "clio", orgId: ORG_A, slug: SLUG_A });
		await webhookDelete(t, ALICE);
		expect(await isLive(t, "seat-a1")).toBe(true);
	});
});
