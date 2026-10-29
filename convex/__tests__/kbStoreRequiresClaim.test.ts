/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud: kb:storeDocumentChunked ingests only a blob the caller's
// organisation CLAIMED through its own upload ticket (generateUploadUrlWithTicket
// -> POST -> claimUpload). Before this, the first org to present any storageId
// was bound to it on ingest (trust on first use), so a leaked storageId could be
// ingested by whichever org presented it first.
//
// REFUSED  org B stores a blob org A claimed; an unclaimed blob (no ticket).
// PRESENT  org A stores a blob it claimed through its own ticket.
// ABSENT   a legacy binding to the same org is still honoured (no migration).

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

// biome-ignore lint/suspicious/noExplicitAny: kb actions are referenced by path, as in kbSeatVerifiedOrg.test.ts
const STORE = "kb:storeDocumentChunked" as any;

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

const A = "claim-tenant-a";
const B = "claim-tenant-b";
const BODY = "# Title\n\nSome text.";
const SHA = createHash("sha256").update(BODY).digest("hex");

async function world(): Promise<T> {
	const t = createT();
	await t.run(async (ctx) => {
		for (const slug of [A, B]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [`seat-${slug}`],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
	return t;
}

async function upload(t: T) {
	return await t.run(async (ctx) =>
		ctx.storage.store(new Blob([BODY], { type: "text/markdown" })),
	);
}

/** The documented flow for a member: ticket, POST, claim. */
async function claimAsMember(t: T, slug: string) {
	const { ticket } = await asMember(t, slug).mutation(
		api.kbMutations.generateUploadUrlWithTicket,
		{ orgId: slug, namespace: `team/${slug}`, sha256: SHA },
	);
	const storageId = await upload(t);
	await asMember(t, slug).mutation(api.kbMutations.claimUpload, {
		storageId,
		ticket,
	});
	return storageId;
}

const storeArgs = (storageId: string, slug: string) => ({
	storageId,
	mimeType: "text/markdown",
	filename: "a.md",
	orgId: slug,
	namespace: `team/${slug}`,
});

describe("kb:storeDocumentChunked requires a claim by the caller's org", () => {
	test("PRESENT: a member stores a blob it claimed through its own ticket", async () => {
		const t = await world();
		const storageId = await claimAsMember(t, A);
		const r = await asMember(t, A).action(STORE, storeArgs(storageId, A));
		expect(r.chunkCount).toBeGreaterThan(0);
	});

	test("PRESENT: a seat (service account + verifiedOrg) stores its own claimed blob", async () => {
		const t = await world();
		const { ticket } = await asMaster(t).mutation(
			api.kbMutations.generateUploadUrlWithTicket,
			{
				orgId: A,
				namespace: `team/${A}`,
				sha256: SHA,
				verifiedOrg: { orgSlug: A },
			},
		);
		const storageId = await upload(t);
		await asMaster(t).mutation(api.kbMutations.claimUpload, {
			storageId,
			ticket,
			verifiedOrg: { orgSlug: A },
		});
		const r = await asMaster(t).action(STORE, {
			...storeArgs(storageId, A),
			verifiedOrg: { orgSlug: A },
		});
		expect(r.chunkCount).toBeGreaterThan(0);
	});

	test("REFUSED: org B stores a blob org A claimed", async () => {
		const t = await world();
		const storageId = await claimAsMember(t, A);
		await expect(
			asMember(t, B).action(STORE, storeArgs(storageId, B)),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
	});

	test("REFUSED: an unclaimed blob (no ticket at all) is not ingested, and not bound", async () => {
		const t = await world();
		const storageId = await upload(t);
		await expect(
			asMember(t, B).action(STORE, storeArgs(storageId, B)),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
		const bound = await t.run(async (ctx) => ctx.db.query("kbUploads").collect());
		expect(bound).toEqual([]);
		const memories = await t.run(async (ctx) => ctx.db.query("memories").collect());
		expect(memories.length).toBe(0);
	});

	test("REFUSED: org A cannot win an unclaimed blob first, then lock B out of nothing (no TOFU)", async () => {
		const t = await world();
		const storageId = await upload(t);
		await expect(
			asMember(t, A).action(STORE, storeArgs(storageId, A)),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
		await expect(
			asMember(t, B).action(STORE, storeArgs(storageId, B)),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
	});

	test("ABSENT: a legacy binding to the same org is honoured; another org is still refused", async () => {
		const t = await world();
		const storageId = await upload(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("kbUploads", {
				storageId,
				orgId: A,
				createdAt: Date.now(),
			});
		});
		const r = await asMember(t, A).action(STORE, storeArgs(storageId, A));
		expect(r.chunkCount).toBeGreaterThan(0);
		await expect(
			asMember(t, B).action(STORE, storeArgs(storageId, B)),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
	});
});
