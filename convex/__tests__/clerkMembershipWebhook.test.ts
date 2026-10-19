/// <reference types="vite/client" />
/**
 * `POST /clerk/webhook` keeps `orgMembership` live (task
 * k1778c2hvae8e8vz9f5bbbbbb98g62hw item 4a), plus the owner-membership lookup
 * and the Clerk backfill that read and fill the same table.
 *
 * Poles: signature (valid / bad / missing header / missing secret / stale
 * timestamp), event (created / updated / deleted / replay / unrelated), the
 * storage adapter (hit / miss) and the backfill (dry run writes nothing).
 */

import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { ownerMembershipLookups } from "../lib/actingPrincipal";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const SECRET_BYTES = Buffer.from("clerk-webhook-test-secret-bytes!");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const ORG_ID = "org_2abcDEF";
const ORG_SLUG = "acme-inc";
const USER_ID = "user_2xyz";

const nowSec = () => Math.floor(Date.now() / 1000);

function sign(
	id: string,
	timestamp: string,
	body: string,
	secretBytes: Buffer = SECRET_BYTES,
): string {
	const sig = createHmac("sha256", secretBytes)
		.update(`${id}.${timestamp}.${body}`)
		.digest("base64");
	return `v1,${sig}`;
}

function membershipEvent(
	type: string,
	role: string,
	overrides: {
		orgId?: string;
		slug?: string;
		userId?: string;
		updatedAt?: number;
	} = {},
) {
	return JSON.stringify({
		object: "event",
		type,
		timestamp: Date.now(),
		data: {
			id: "orgmem_1",
			role,
			...(overrides.updatedAt === undefined
				? {}
				: { updated_at: overrides.updatedAt }),
			organization: {
				id: overrides.orgId ?? ORG_ID,
				slug: overrides.slug ?? ORG_SLUG,
			},
			public_user_data: { user_id: overrides.userId ?? USER_ID },
		},
	});
}

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

function deliver(
	t: T,
	body: string,
	opts: {
		id?: string;
		timestamp?: string;
		signature?: string;
		omit?: "svix-id" | "svix-timestamp" | "svix-signature";
	} = {},
) {
	const id = opts.id ?? `msg_${crypto.randomUUID()}`;
	const timestamp = opts.timestamp ?? String(nowSec());
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"svix-id": id,
		"svix-timestamp": timestamp,
		"svix-signature": opts.signature ?? sign(id, timestamp, body),
	};
	if (opts.omit) delete headers[opts.omit];
	return t.fetch("/clerk/webhook", { method: "POST", headers, body });
}

const live = async (t: T) =>
	(await rows(t)).filter((r) => r.deletedAt === undefined);

const rows = (t: T) =>
	t.run(async (ctx) => await ctx.db.query("orgMembership").collect());

describe("POST /clerk/webhook", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		process.env.CLERK_WEBHOOK_SECRET = SECRET;
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		delete process.env.CLERK_WEBHOOK_SECRET;
		vi.restoreAllMocks();
	});

	test("valid signature: created upserts a member row keyed by the Clerk ids", async () => {
		const t = makeT();
		const res = await deliver(
			t,
			membershipEvent("organizationMembership.created", "org:member"),
		);
		expect(res.status).toBe(200);
		const all = await rows(t);
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({
			clerkOrgId: ORG_ID,
			clerkOrgSlug: ORG_SLUG,
			clerkUserId: USER_ID,
			role: "member",
		});
	});

	test("org:admin maps to admin, any other Clerk role to member", async () => {
		const t = makeT();
		await deliver(
			t,
			membershipEvent("organizationMembership.created", "org:admin"),
		);
		await deliver(
			t,
			membershipEvent("organizationMembership.created", "org:billing", {
				userId: "user_other",
			}),
		);
		const byUser = Object.fromEntries(
			(await rows(t)).map((r) => [r.clerkUserId, r.role]),
		);
		expect(byUser).toEqual({ [USER_ID]: "admin", user_other: "member" });
	});

	test("a signature list with one valid candidate among bad ones is accepted", async () => {
		const t = makeT();
		const body = membershipEvent(
			"organizationMembership.created",
			"org:member",
		);
		const id = "msg_multi";
		const ts = String(nowSec());
		const bad = sign(id, ts, body, Buffer.from("other-secret"));
		const good = sign(id, ts, body);
		const res = await deliver(t, body, {
			id,
			timestamp: ts,
			signature: `${bad} ${good}`,
		});
		expect(res.status).toBe(200);
		expect(await rows(t)).toHaveLength(1);
	});

	test("bad signature: 401 and no write", async () => {
		const t = makeT();
		const body = membershipEvent(
			"organizationMembership.created",
			"org:member",
		);
		const res = await deliver(t, body, {
			signature: sign("x", "1", body, Buffer.from("not-the-secret")),
		});
		expect(res.status).toBe(401);
		expect(await rows(t)).toHaveLength(0);
	});

	test("a body altered after signing is refused", async () => {
		const t = makeT();
		const body = membershipEvent(
			"organizationMembership.created",
			"org:member",
		);
		const id = "msg_tamper";
		const ts = String(nowSec());
		const signature = sign(id, ts, body);
		const res = await deliver(
			t,
			membershipEvent("organizationMembership.created", "org:admin"),
			{ id, timestamp: ts, signature },
		);
		expect(res.status).toBe(401);
		expect(await rows(t)).toHaveLength(0);
	});

	for (const header of [
		"svix-id",
		"svix-timestamp",
		"svix-signature",
	] as const) {
		test(`missing ${header}: 401 and no write`, async () => {
			const t = makeT();
			const res = await deliver(
				t,
				membershipEvent("organizationMembership.created", "org:member"),
				{ omit: header },
			);
			expect(res.status).toBe(401);
			expect(await rows(t)).toHaveLength(0);
		});
	}

	test("secret unset: every delivery refused 500, logged, no write", async () => {
		delete process.env.CLERK_WEBHOOK_SECRET;
		const t = makeT();
		const res = await deliver(
			t,
			membershipEvent("organizationMembership.created", "org:member"),
		);
		expect(res.status).toBe(500);
		expect(await rows(t)).toHaveLength(0);
		expect(errorSpy.mock.calls.flat().join(" ")).toContain(
			"CLERK_WEBHOOK_SECRET",
		);
	});

	test("stale and far-future timestamps (beyond 5 minutes) are refused, correctly signed", async () => {
		const t = makeT();
		const body = membershipEvent(
			"organizationMembership.created",
			"org:member",
		);
		for (const delta of [-6 * 60, 6 * 60]) {
			const res = await deliver(t, body, {
				timestamp: String(nowSec() + delta),
			});
			expect(res.status).toBe(401);
		}
		expect(await rows(t)).toHaveLength(0);
	});

	test("updated changes the role", async () => {
		const t = makeT();
		await deliver(
			t,
			membershipEvent("organizationMembership.created", "org:member"),
		);
		await deliver(
			t,
			membershipEvent("organizationMembership.updated", "org:admin"),
		);
		const all = await rows(t);
		expect(all).toHaveLength(1);
		expect(all[0].role).toBe("admin");
	});

	test("deleted leaves a tombstone: no live row, the row kept with deletedAt", async () => {
		const t = makeT();
		await deliver(
			t,
			membershipEvent("organizationMembership.created", "org:member"),
		);
		const res = await deliver(
			t,
			membershipEvent("organizationMembership.deleted", "org:member"),
		);
		expect(res.status).toBe(200);
		expect(await live(t)).toHaveLength(0);
		const all = await rows(t);
		expect(all).toHaveLength(1);
		expect(all[0].deletedAt).toBeTypeOf("number");
		expect(all[0].role).toBe("member");
	});

	test("replay of the same delivery is a no-op (no second row, no write)", async () => {
		const t = makeT();
		const body = membershipEvent(
			"organizationMembership.created",
			"org:member",
		);
		const id = "msg_replay";
		const ts = String(nowSec());
		await deliver(t, body, { id, timestamp: ts });
		const first = (await rows(t))[0];
		const res = await deliver(t, body, { id, timestamp: ts });
		expect(res.status).toBe(200);
		const all = await rows(t);
		expect(all).toHaveLength(1);
		expect(all[0].updatedAt).toBe(first.updatedAt);
		expect(all[0]._id).toBe(first._id);
	});

	test("an unrelated event type is 200, ignored, no write", async () => {
		const t = makeT();
		const res = await deliver(
			t,
			JSON.stringify({
				object: "event",
				type: "user.created",
				data: { id: USER_ID },
			}),
		);
		expect(res.status).toBe(200);
		expect(await rows(t)).toHaveLength(0);
	});

	test("a signed membership event missing the Clerk ids is 400, no write", async () => {
		const t = makeT();
		const res = await deliver(
			t,
			JSON.stringify({
				type: "organizationMembership.created",
				data: { role: "org:member" },
			}),
		);
		expect(res.status).toBe(400);
		expect(await rows(t)).toHaveLength(0);
	});
});

describe("ownerMembershipLookups.personById", () => {
	test("hit: an existing (org id, user id) row answers {id, orgId, active: true}", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: ORG_SLUG,
				clerkOrgId: ORG_ID,
				clerkUserId: USER_ID,
				role: "member",
				createdAt: 1,
				updatedAt: 1,
			});
		});
		const hit = await t.run(
			async (ctx) =>
				await ownerMembershipLookups(ctx).personById?.(USER_ID, ORG_ID),
		);
		expect(hit).toEqual({ id: USER_ID, orgId: ORG_ID, active: true });
	});

	test("miss: another org, another user, or no row answers null", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: ORG_SLUG,
				clerkOrgId: ORG_ID,
				clerkUserId: USER_ID,
				role: "admin",
				createdAt: 1,
				updatedAt: 1,
			});
		});
		const answers = await t.run(async (ctx) => {
			const l = ownerMembershipLookups(ctx);
			return [
				await l.personById?.(USER_ID, "org_other"),
				await l.personById?.("user_nobody", ORG_ID),
				await l.personById?.(USER_ID, ORG_SLUG),
			];
		});
		expect(answers).toEqual([null, null, null]);
	});
});

describe("orgMembership:backfillFromClerk", () => {
	beforeEach(() => {
		process.env.CLERK_SECRET_KEY = "sk_test_backfill_secret_do_not_log";
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		delete process.env.CLERK_SECRET_KEY;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function stubClerk(opts: { failMembershipsFor?: string } = {}) {
		const calls: string[] = [];
		const json = (b: unknown, status = 200) =>
			new Response(JSON.stringify(b), {
				status,
				headers: { "content-type": "application/json" },
			});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				calls.push(url);
				const u = new URL(url);
				if (u.pathname === "/v1/organizations") {
					const offset = Number(u.searchParams.get("offset") ?? 0);
					return json({
						data:
							offset === 0
								? [
										{ id: ORG_ID, slug: ORG_SLUG },
										{ id: "org_broken", slug: "broken" },
									]
								: [],
						total_count: 2,
					});
				}
				const m = u.pathname.match(
					/^\/v1\/organizations\/([^/]+)\/memberships$/,
				);
				if (m) {
					if (m[1] === opts.failMembershipsFor) return json({}, 500);
					const offset = Number(u.searchParams.get("offset") ?? 0);
					return json({
						data:
							offset === 0 && m[1] === ORG_ID
								? [
										{
											role: "org:admin",
											public_user_data: { user_id: USER_ID },
											organization: { id: ORG_ID, slug: ORG_SLUG },
										},
									]
								: [],
						total_count: m[1] === ORG_ID ? 1 : 0,
					});
				}
				return json({}, 404);
			}),
		);
		return calls;
	}

	const seedStale = (t: T) =>
		t.run(async (ctx) => {
			for (const [org, slug, user] of [
				[ORG_ID, ORG_SLUG, "user_gone"],
				["org_broken", "broken", "user_kept"],
			]) {
				await ctx.db.insert("orgMembership", {
					clerkOrgSlug: slug,
					clerkOrgId: org,
					clerkUserId: user,
					role: "member",
					createdAt: 1,
					updatedAt: 1,
				});
			}
		});

	test("dry run (the default) reports counts and writes nothing", async () => {
		const t = makeT();
		await seedStale(t);
		stubClerk();
		const res = await t.action(internal.orgMembership.backfillFromClerk, {});
		expect(res).toMatchObject({
			orgs: 2,
			memberships: 1,
			upserted: 1,
			removed: 2,
		});
		const all = await rows(t);
		expect(all.map((r) => r.clerkUserId).sort()).toEqual([
			"user_gone",
			"user_kept",
		]);
		expect(all.every((r) => r.deletedAt === undefined)).toBe(true);
		expect(all.every((r) => r.lastEventAt === undefined)).toBe(true);
	});

	test("dryRun:false upserts, removes only in orgs it fully read, and never sends the key anywhere but the header", async () => {
		const t = makeT();
		await seedStale(t);
		const calls = stubClerk({ failMembershipsFor: "org_broken" });
		const before = Date.now();
		const res = await t.action(internal.orgMembership.backfillFromClerk, {
			dryRun: false,
		});
		expect(res).toMatchObject({
			orgs: 2,
			memberships: 1,
			upserted: 1,
			removed: 1,
		});
		const all = await rows(t);
		// user_gone is a tombstone, not a hard delete; org_broken was not fully
		// read, so user_kept stays live.
		expect(
			(await live(t)).map((r) => `${r.clerkOrgId}/${r.clerkUserId}`).sort(),
		).toEqual([`${ORG_ID}/${USER_ID}`, "org_broken/user_kept"]);
		const gone = all.find((r) => r.clerkUserId === "user_gone");
		expect(gone?.deletedAt).toBeTypeOf("number");
		expect(gone?.lastEventAt).toBe(gone?.deletedAt);
		expect(gone?.lastEventAt).toBeGreaterThanOrEqual(before);
		expect(
			all.find((r) => r.clerkUserId === USER_ID)?.lastEventAt,
		).toBeGreaterThanOrEqual(before);
		expect(calls.join(" ")).not.toContain("sk_test_backfill_secret_do_not_log");
	});

	test("without CLERK_SECRET_KEY the backfill refuses and writes nothing", async () => {
		delete process.env.CLERK_SECRET_KEY;
		const t = makeT();
		await expect(
			t.action(internal.orgMembership.backfillFromClerk, { dryRun: false }),
		).rejects.toThrow(/CLERK_SECRET_KEY/);
		expect(await rows(t)).toHaveLength(0);
	});
});

describe("event ordering: a late event never re-adds a removed member", () => {
	beforeEach(() => {
		process.env.CLERK_WEBHOOK_SECRET = SECRET;
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		delete process.env.CLERK_WEBHOOK_SECRET;
		vi.restoreAllMocks();
	});

	const send = (
		t: T,
		type: string,
		role: string,
		updatedAt: number | undefined,
	) => deliver(t, membershipEvent(type, role, { updatedAt }));
	const personById = (t: T) =>
		t.run(
			async (ctx) =>
				await ownerMembershipLookups(ctx).personById?.(USER_ID, ORG_ID),
		);

	test("deleted then a STALE created: 200, still no live row, personById null", async () => {
		const t = makeT();
		await send(t, "organizationMembership.created", "org:member", 1000);
		await send(t, "organizationMembership.deleted", "org:member", 3000);
		const res = await send(
			t,
			"organizationMembership.created",
			"org:admin",
			2000,
		);
		expect(res.status).toBe(200);
		expect(await live(t)).toHaveLength(0);
		expect(await personById(t)).toBeNull();
		const all = await rows(t);
		expect(all).toHaveLength(1);
		expect(all[0].lastEventAt).toBe(3000);
	});

	test("a created at EXACTLY the delete's event time is ignored", async () => {
		const t = makeT();
		await send(t, "organizationMembership.created", "org:member", 1000);
		await send(t, "organizationMembership.deleted", "org:member", 3000);
		await send(t, "organizationMembership.created", "org:member", 3000);
		expect(await live(t)).toHaveLength(0);
	});

	test("deleted then a NEWER created revives the row and clears the tombstone", async () => {
		const t = makeT();
		await send(t, "organizationMembership.created", "org:member", 1000);
		await send(t, "organizationMembership.deleted", "org:member", 3000);
		await send(t, "organizationMembership.created", "org:admin", 4000);
		const all = await rows(t);
		expect(all).toHaveLength(1);
		expect(all[0].deletedAt).toBeUndefined();
		expect(all[0].role).toBe("admin");
		expect(all[0].lastEventAt).toBe(4000);
		expect(await personById(t)).toEqual({
			id: USER_ID,
			orgId: ORG_ID,
			active: true,
		});
	});

	test("an updated OLDER than the current state is ignored; a newer one applies", async () => {
		const t = makeT();
		await send(t, "organizationMembership.created", "org:member", 2000);
		await send(t, "organizationMembership.updated", "org:admin", 1000);
		expect((await rows(t))[0].role).toBe("member");
		await send(t, "organizationMembership.updated", "org:admin", 3000);
		const row = (await rows(t))[0];
		expect(row.role).toBe("admin");
		expect(row.lastEventAt).toBe(3000);
	});

	test("a delete that arrives BEFORE the created leaves a tombstone, so the late created stays absent", async () => {
		const t = makeT();
		await send(t, "organizationMembership.deleted", "org:member", 3000);
		await send(t, "organizationMembership.created", "org:member", 2000);
		expect(await live(t)).toHaveLength(0);
		expect(await personById(t)).toBeNull();
		expect(await rows(t)).toHaveLength(1);
	});

	test("without data.updated_at the svix-timestamp (ms) is the event time", async () => {
		const t = makeT();
		const ts = nowSec() - 60;
		await deliver(
			t,
			membershipEvent("organizationMembership.created", "org:member"),
			{ timestamp: String(ts) },
		);
		expect((await rows(t))[0].lastEventAt).toBe(ts * 1000);
	});

	test("personById answers null for a tombstoned row", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: ORG_SLUG,
				clerkOrgId: ORG_ID,
				clerkUserId: USER_ID,
				role: "admin",
				createdAt: 1,
				updatedAt: 1,
				lastEventAt: 5,
				deletedAt: 5,
			});
		});
		expect(await personById(t)).toBeNull();
	});
});

describe("orgMembership:backfillFromClerk revives a tombstone Clerk still reports", () => {
	beforeEach(() => {
		process.env.CLERK_SECRET_KEY = "sk_test_backfill_secret_do_not_log";
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		delete process.env.CLERK_SECRET_KEY;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test("tombstoned (older) + reported by Clerk -> live again, lastEventAt = backfill time", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: ORG_SLUG,
				clerkOrgId: ORG_ID,
				clerkUserId: USER_ID,
				role: "member",
				createdAt: 1,
				updatedAt: 1,
				lastEventAt: 10,
				deletedAt: 10,
			});
		});
		const json = (b: unknown) =>
			new Response(JSON.stringify(b), { status: 200 });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const u = new URL(String(input));
				if (u.pathname === "/v1/organizations")
					return json({ data: [{ id: ORG_ID, slug: ORG_SLUG }] });
				return json({
					data: [
						{
							role: "org:admin",
							public_user_data: { user_id: USER_ID },
						},
					],
				});
			}),
		);
		const before = Date.now();
		await t.action(internal.orgMembership.backfillFromClerk, {
			dryRun: false,
		});
		const row = (await rows(t))[0];
		expect(row.deletedAt).toBeUndefined();
		expect(row.role).toBe("admin");
		expect(row.lastEventAt).toBeGreaterThanOrEqual(before);
	});
});
