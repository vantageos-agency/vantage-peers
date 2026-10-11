/// <reference types="vite/client" />
//
// The client upload -> ingest chain under an ORG identity, keyed by the org's
// Clerk org ID end to end (task k1709kfcggpbqw6vc6x33nsadn8g3sfj, Eta pre-review
// of #1510): generateUploadUrlWithTicket -> upload -> claimUpload ->
// kb:storeDocumentChunked. Before this, tickets and claims were keyed by slug
// and ingest by ID, so no orgId value made the chain pass for an org member.
//
// Both directions are pinned: the own org passes every step; another org is
// refused at every step it can reach (RBAC_DENIED at generate,
// AUTH_UPLOAD_TICKET_NOT_YOURS at claim, AUTH_STORAGE_NOT_OWNED at ingest).

import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

// biome-ignore lint/suspicious/noExplicitAny: string refs, codegen-lag workaround
const GENERATE = "kbMutations:generateUploadUrlWithTicket" as any;
// biome-ignore lint/suspicious/noExplicitAny: string refs, codegen-lag workaround
const CLAIM = "kbMutations:claimUpload" as any;
// biome-ignore lint/suspicious/noExplicitAny: string refs, codegen-lag workaround
const INGEST = "kb:storeDocumentChunked" as any;

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

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const ID_A = testClerkOrgId("org-A");
const ID_B = testClerkOrgId("org-B");

async function seedOrg(t: T, slug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrg(t: T, slug: string) {
	return t.withIdentity({
		subject: `user-${slug}`,
		tokenIdentifier: `test|user-${slug}`,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<typeof t.withIdentity>[0]);
}

const BYTES = new TextEncoder().encode(
	"# Chain\n\nA document uploaded by a member of its own organisation.\n",
);
const SHA = createHash("sha256").update(BYTES).digest("hex");

async function generate(t: T, slug: string, orgId: string) {
	return (await asOrg(t, slug).mutation(GENERATE, {
		orgId,
		namespace: `team/${orgId}`,
		sha256: SHA,
	})) as { uploadUrl: string; ticket: string; expiresAt: number };
}

async function upload(t: T): Promise<Id<"_storage">> {
	return await t.run(async (ctx) =>
		ctx.storage.store(new Blob([new Uint8Array(BYTES)], { type: "text/plain" })),
	);
}

async function ingest(t: T, slug: string, orgId: string, storageId: Id<"_storage">) {
	return await asOrg(t, slug).action(INGEST, {
		storageId,
		mimeType: "text/plain",
		filename: "chain.txt",
		orgId,
		namespace: `team/${orgId}`,
	});
}

describe("upload -> ingest chain under an org identity, keyed by Clerk org ID", () => {
	test("PRESENT - own org: generate -> claim -> ingest all pass on the org ID", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const { ticket } = await generate(t, "org-A", ID_A);
		const stored = await t.run(async (ctx) => ctx.db.query("uploadTickets").collect());
		expect(stored.map((r) => r.orgId)).toEqual([ID_A]);

		const storageId = await upload(t);
		const claimed = await asOrg(t, "org-A").mutation(CLAIM, { storageId, ticket });
		expect(claimed.orgId).toBe(ID_A);
		const bound = await t.run(async (ctx) => ctx.db.query("kbUploads").collect());
		expect(bound.map((r) => r.orgId)).toEqual([ID_A]);

		const result = await ingest(t, "org-A", ID_A, storageId);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(result.chunkCount).toBeGreaterThan(0);
	}, 30_000);

	test("REFUSED - the slug is no longer an org key at generate", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await expect(generate(t, "org-A", "org-A")).rejects.toThrow(/RBAC_DENIED/);
	});

	test("REFUSED - another org cannot mint a ticket for org A's ID", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		await expect(generate(t, "org-B", ID_A)).rejects.toThrow(/RBAC_DENIED/);
	});

	test("REFUSED - another org cannot claim org A's ticket, nor ingest org A's blob", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		const { ticket } = await generate(t, "org-A", ID_A);
		const storageId = await upload(t);

		await expect(
			asOrg(t, "org-B").mutation(CLAIM, { storageId, ticket }),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_NOT_YOURS/);

		await asOrg(t, "org-A").mutation(CLAIM, { storageId, ticket });
		await expect(ingest(t, "org-B", ID_B, storageId)).rejects.toThrow(
			/AUTH_STORAGE_NOT_OWNED/,
		);
		await expect(ingest(t, "org-B", ID_A, storageId)).rejects.toThrow(
			/AUTH_NAMESPACE_DENIED/,
		);
	}, 30_000);

	test("both directions - org B runs its own chain on the same host as org A", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		const { ticket } = await generate(t, "org-B", ID_B);
		const storageId = await upload(t);
		await asOrg(t, "org-B").mutation(CLAIM, { storageId, ticket });
		const result = await ingest(t, "org-B", ID_B, storageId);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(result.chunkCount).toBeGreaterThan(0);
		await expect(ingest(t, "org-A", ID_A, storageId)).rejects.toThrow(
			/AUTH_STORAGE_NOT_OWNED/,
		);
	}, 30_000);
});
