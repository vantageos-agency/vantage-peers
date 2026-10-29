/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud: the KB doors act for a SEAT bearer's VERIFIED organisation.
//
// Defect (prod, 2026-10-29): a client seat reaches Convex as the fleet service
// account, so `withOrgScope` resolves master with no organisation, and the MCP had
// no org to name for it (it read namespaceWritePrefixes[0], which for a seat is
// `orchestrator/<agent>`). The transport's `verifiedOrg` is now an input of the
// five KB doors (believed from the service account only, resolved against an
// ACTIVE org mapping), and the org the call acts on is the verified one.
//
// REFUSED  a verified org X never reaches org Y (named orgId / namespace Y);
//          a member naming verifiedOrg by argument; an inactive org.
// PRESENT  upload URL / ticket / store / soft-delete act on org X's namespace,
//          keyed by X's permanent org ID.
// ABSENT   the fleet master with no verifiedOrg keeps acting on any org.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import { storeClaimed } from "../../tests/fixtures/storeClaimed";
import schema from "../schema";

// biome-ignore lint/suspicious/noExplicitAny: kb actions are referenced by path, as in kb-ingest.test.ts
const STORE = "kb:storeDocumentChunked" as any;
// biome-ignore lint/suspicious/noExplicitAny: same
const SOFT_DELETE = "kb:softDeleteDocument" as any;

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

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const asMaster = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, slug: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationSlug: slug,
		org_id: testClerkOrgId(slug),
	} as Identity);

async function world(): Promise<T> {
	const t = createT();
	await t.run(async (ctx) => {
		for (const [slug, isActive] of [
			["probe-tenant-a", true],
			["probe-tenant-b", true],
			["probe-tenant-off", false],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [`seat-${slug}`],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive,
				createdAt: Date.now(),
			});
		}
	});
	return t;
}

const A = "probe-tenant-a";
const B = "probe-tenant-b";
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);
const SHA = "a".repeat(64);

// The blob is claimed by `ownerKey` (a claimed storageId is what store requires):
// a seat's key is its org slug, the master's is the orgId it names.
async function blob(t: T, ownerKey?: string): Promise<string> {
	return await t.run(async (ctx) => {
		const blob = new Blob(["# Title\n\nSome text."], { type: "text/markdown" });
		return ownerKey === undefined
			? await ctx.storage.store(blob)
			: await storeClaimed(ctx, ownerKey, blob);
	});
}

describe("kbMutations upload doors take the verified org", () => {
	test("PRESENT: generateUploadUrl for the seat's own verified org", async () => {
		const t = await world();
		const url = await asMaster(t).mutation(api.kbMutations.generateUploadUrl, {
			orgId: A,
			namespace: `team/${A}/placeholder`,
			verifiedOrg: { orgSlug: A },
		});
		expect(url.length).toBeGreaterThan(0);
	});

	test("REFUSED: generateUploadUrl naming org B under verified org A", async () => {
		const t = await world();
		await expect(
			asMaster(t).mutation(api.kbMutations.generateUploadUrl, {
				orgId: B,
				namespace: `team/${B}/placeholder`,
				verifiedOrg: { orgSlug: A },
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("PRESENT: the ticket is bound to the verified org", async () => {
		const t = await world();
		await asMaster(t).mutation(api.kbMutations.generateUploadUrlWithTicket, {
			orgId: A,
			namespace: `team/${A}/placeholder`,
			sha256: SHA,
			verifiedOrg: { orgSlug: A },
		});
		const rows = await t.run(async (ctx) => ctx.db.query("uploadTickets").collect());
		expect(rows.map((r) => r.orgId)).toEqual([A]);
	});

	test("REFUSED: ticket for org B under verified org A", async () => {
		const t = await world();
		await expect(
			asMaster(t).mutation(api.kbMutations.generateUploadUrlWithTicket, {
				orgId: B,
				namespace: `team/${B}/placeholder`,
				sha256: SHA,
				verifiedOrg: { orgSlug: A },
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("REFUSED: a member naming a verifiedOrg by argument", async () => {
		const t = await world();
		await expect(
			asMember(t, A).mutation(api.kbMutations.generateUploadUrl, {
				orgId: A,
				namespace: `team/${A}/placeholder`,
				verifiedOrg: { orgSlug: A },
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("REFUSED: an inactive verified org", async () => {
		const t = await world();
		await expect(
			asMaster(t).mutation(api.kbMutations.generateUploadUrl, {
				orgId: "probe-tenant-off",
				namespace: "team/probe-tenant-off/placeholder",
				verifiedOrg: { orgSlug: "probe-tenant-off" },
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("ABSENT: the master with no verifiedOrg still mints for any org", async () => {
		const t = await world();
		const url = await asMaster(t).mutation(api.kbMutations.generateUploadUrl, {
			orgId: B,
			namespace: `team/${B}/placeholder`,
		});
		expect(url.length).toBeGreaterThan(0);
	});
});

describe("kb actions take the verified org", () => {
	test("PRESENT: store files the chunks under the verified org's permanent ID", async () => {
		const t = await world();
		const storageId = await blob(t, A);
		const r = await asMaster(t).action(STORE, {
			storageId,
			mimeType: "text/markdown",
			filename: "a.md",
			orgId: A,
			namespace: `team/${A}`,
			verifiedOrg: { orgSlug: A },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const rows = await t.run(async (ctx) => ctx.db.query("memories").collect());
		const namespaces = new Set(rows.filter((m) => m.type === "reference").map((m) => m.namespace));
		expect([...namespaces]).toEqual([`team/${A_ID}/${r.docId}`]);
	});

	test("REFUSED: store naming org B under verified org A writes nothing", async () => {
		const t = await world();
		const storageId = await blob(t);
		await expect(
			asMaster(t).action(STORE, {
				storageId,
				mimeType: "text/markdown",
				filename: "a.md",
				orgId: B,
				namespace: `team/${B}`,
				verifiedOrg: { orgSlug: A },
			}),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
		const rows = await t.run(async (ctx) => ctx.db.query("memories").collect());
		expect(rows.length).toBe(0);
	});

	test("PRESENT: soft-delete marks the verified org's document", async () => {
		const t = await world();
		const storageId = await blob(t, A);
		const stored = await asMaster(t).action(STORE, {
			storageId,
			mimeType: "text/markdown",
			filename: "a.md",
			orgId: A,
			namespace: `team/${A}`,
			docId: "doc-1",
			verifiedOrg: { orgSlug: A },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const r = await asMaster(t).action(SOFT_DELETE, {
			docId: "doc-1",
			orgId: A,
			namespace: `team/${A}`,
			verifiedOrg: { orgSlug: A },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(r.markedCount).toBe(stored.chunkCount);
	});

	test("REFUSED: soft-delete of org B's document under verified org A leaves it live", async () => {
		const t = await world();
		const storageId = await blob(t, B_ID as string);
		await asMaster(t).action(STORE, {
			storageId,
			mimeType: "text/markdown",
			filename: "b.md",
			orgId: B_ID as string,
			namespace: `team/${B_ID}`,
			docId: "doc-b",
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await expect(
			asMaster(t).action(SOFT_DELETE, {
				docId: "doc-b",
				orgId: B_ID as string,
				namespace: `team/${B_ID}`,
				verifiedOrg: { orgSlug: A },
			}),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
		const live = await t.run(async (ctx) =>
			ctx.db.query("memories").filter((q) => q.eq(q.field("isLatest"), true)).collect(),
		);
		expect(live.length).toBeGreaterThan(0);
	});

	test("REFUSED: a member naming a verifiedOrg by argument", async () => {
		const t = await world();
		await expect(
			asMember(t, A).action(SOFT_DELETE, {
				docId: "d",
				orgId: A,
				namespace: `team/${A}`,
				verifiedOrg: { orgSlug: A },
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("ABSENT: the master with no verifiedOrg keeps acting on any org", async () => {
		const t = await world();
		const storageId = await blob(t, B);
		const r = await asMaster(t).action(STORE, {
			storageId,
			mimeType: "text/markdown",
			filename: "m.md",
			orgId: B,
			namespace: `team/${B}`,
			docId: "doc-m",
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(r.chunkCount).toBeGreaterThan(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// TRUST: `verifiedOrg` is believed from the fleet service account ONLY.
// An ordinary member of org A naming org B as its verifiedOrg is refused at each
// of the five KB doors with `verified-org-not-trusted`, and nothing is written.
// Pins resolveVerifiedOrgMapping's service-account-only check
// (convex/lib/verifiedOrg.ts): without it the member would act as org B.
// ─────────────────────────────────────────────────────────────────────────────

async function snapshot(t: T) {
	return await t.run(async (ctx) => ({
		memories: (await ctx.db.query("memories").collect()).length,
		kbUploads: (await ctx.db.query("kbUploads").collect()).length,
		tickets: (await ctx.db.query("uploadTickets").collect()).map((r) => ({
			id: r._id,
			usedAt: r.usedAt ?? null,
			storageId: r.storageId ?? null,
		})),
		storage: (await ctx.db.system.query("_storage").collect()).length,
	}));
}

async function sha256HexOf(text: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifiedOrg from a non-service-account caller is refused at all five KB doors", () => {
	const BODY = "# Title\n\nSome text.";
	type Member = ReturnType<typeof asMember>;
	type Door = {
		door: string;
		// state the door could touch, created BEFORE the snapshot
		seed?: (t: T) => Promise<{ ticket: string; storageId: string }>;
		call: (t: T, member: Member, seeded?: { ticket: string; storageId: string }) => Promise<unknown>;
	};
	const doors: Door[] = [
		{
			door: "kb:storeDocumentChunked",
			seed: async (t) => ({ ticket: "", storageId: await blob(t) }),
			call: (_t, member, s) =>
				member.action(STORE, {
					storageId: s?.storageId,
					mimeType: "text/markdown",
					filename: "x.md",
					orgId: B_ID as string,
					namespace: `team/${B_ID}`,
					verifiedOrg: { orgSlug: B },
				}),
		},
		{
			door: "kb:softDeleteDocument",
			call: (_t, member) =>
				member.action(SOFT_DELETE, {
					docId: "doc-b",
					orgId: B_ID as string,
					namespace: `team/${B_ID}`,
					verifiedOrg: { orgSlug: B },
				}),
		},
		{
			door: "kbMutations:generateUploadUrl",
			call: (_t, member) =>
				member.mutation(api.kbMutations.generateUploadUrl, {
					orgId: B,
					namespace: `team/${B}/placeholder`,
					verifiedOrg: { orgSlug: B },
				}),
		},
		{
			door: "kbMutations:generateUploadUrlWithTicket",
			call: (_t, member) =>
				member.mutation(api.kbMutations.generateUploadUrlWithTicket, {
					orgId: B,
					namespace: `team/${B}/placeholder`,
					sha256: SHA,
					verifiedOrg: { orgSlug: B },
				}),
		},
		{
			door: "kbMutations:claimUpload",
			// A genuine, claimable org-B ticket and blob: were the member's claim
			// believed, it would consume the ticket and bind the blob to B.
			seed: async (t) => {
				const issued = await asMaster(t).mutation(
					api.kbMutations.generateUploadUrlWithTicket,
					{
						orgId: B,
						namespace: `team/${B}/placeholder`,
						sha256: await sha256HexOf(BODY),
						verifiedOrg: { orgSlug: B },
					},
				);
				const storageId = await t.run(async (ctx) =>
					ctx.storage.store(new Blob([BODY], { type: "text/markdown" })),
				);
				return { ticket: issued.ticket, storageId };
			},
			call: (_t, member, s) =>
				member.mutation(api.kbMutations.claimUpload, {
					storageId: s?.storageId as never,
					ticket: s?.ticket as string,
					verifiedOrg: { orgSlug: B },
				}),
		},
	];

	for (const { door, seed, call } of doors) {
		test(`${door}: a member of A naming verifiedOrg B is refused and writes nothing`, async () => {
			const t = await world();
			const seeded = seed === undefined ? undefined : await seed(t);
			const before = await snapshot(t);
			let thrown: unknown;
			try {
				await call(t, asMember(t, A), seeded);
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown)).toMatch(/RBAC_DENIED/);
			expect(String(thrown)).toMatch(/verified-org-not-trusted/);
			expect(await snapshot(t)).toEqual(before);
		});
	}
});
