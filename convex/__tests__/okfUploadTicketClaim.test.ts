/// <reference types="vite/client" />
//
// Upload ticket + claim: how a client's own upload becomes ITS blob without
// first-claim. generate_upload_url (kbMutations:generateUploadUrlWithTicket)
// issues, beside the URL, an UPLOAD TICKET bound to the caller's verified org:
// 32 random bytes, stored only as a sha256 hash, single-use, short TTL. After
// the upload the client claims the blob with kbMutations:claimUpload
// (storageId, ticket), which binds the storageId to the ticket's org only when
// the ticket is valid, unused, unexpired and issued to the caller's own org,
// and consumes it. A leaked storageId cannot be claimed without its ticket;
// validate_okf_bundle stays assert-only (okfValidateStorageOwnership.test.ts).
//
// Coordinator ruling on #1465 (after Argus REVISE): repair the client OKF flow
// generate -> upload -> validate without reintroducing first-claim.

import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import type { Id } from "../_generated/dataModel";
import { packTarball } from "../okfBundleNode";
import schema from "../schema";

// biome-ignore lint/suspicious/noExplicitAny: string refs, codegen-lag workaround (see okfBundleValidate.test.ts)
const GENERATE = "kbMutations:generateUploadUrlWithTicket" as any;
// biome-ignore lint/suspicious/noExplicitAny: string refs, codegen-lag workaround
const CLAIM = "kbMutations:claimUpload" as any;
// biome-ignore lint/suspicious/noExplicitAny: string refs, codegen-lag workaround
const VALIDATE = "okfBundleNode:validateOkfBundle" as any;

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

afterEach(() => {
	vi.useRealTimers();
});

async function seedOrg(t: T, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrg(t: T, orgId: string) {
	return t.withIdentity({
		subject: `user-${orgId}`,
		tokenIdentifier: `test|user-${orgId}`,
		organizationId: orgId,
		org_id: testClerkOrgId(orgId),
	} as Parameters<typeof t.withIdentity>[0]);
}

const bundleCache = new Map<string, Uint8Array>();

/**
 * A real OKF bundle; `label` makes its bytes (and so its sha256) distinct.
 * Memoized per label: packTarball stamps the tar headers with the wall clock,
 * so two calls straddling a second boundary yield different bytes, and a test
 * that hashes at issue time and uploads later would fail intermittently.
 */
async function bundle(label = "default"): Promise<Uint8Array> {
	const cached = bundleCache.get(label);
	if (cached) return cached;
	const buf = await packTarball([
		{
			path: "index.md",
			content: `---\nokf_version: "0.1"\ntype: index\n---\n# Bundle ${label}\n`,
		},
	]);
	const bytes = new Uint8Array(buf);
	bundleCache.set(label, bytes);
	return bytes;
}

/** What the client computes before uploading: lowercase hex sha256. */
const sha256Of = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

async function issue(t: T, orgId: string, sha256?: string) {
	return (await asOrg(t, orgId).mutation(GENERATE, {
		orgId,
		namespace: `team/${orgId}`,
		sha256: sha256 ?? sha256Of(await bundle()),
	})) as { uploadUrl: string; ticket: string; expiresAt: number };
}

/** The client's POST to the upload URL: a new blob in _storage. */
async function upload(t: T, bytes?: Uint8Array): Promise<Id<"_storage">> {
	const body = bytes ?? (await bundle());
	return await t.run(async (ctx) =>
		ctx.storage.store(new Blob([new Uint8Array(body)])),
	);
}

async function bindingsOf(t: T, storageId: Id<"_storage">) {
	return await t.run(async (ctx) =>
		ctx.db
			.query("kbUploads")
			.withIndex("by_storageId", (q) => q.eq("storageId", storageId))
			.collect(),
	);
}

describe("upload ticket + claim_upload — the client OKF flow without first-claim", () => {
	test("PRESENT — the owner's full flow: generate, upload, claim, validate", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const { uploadUrl, ticket, expiresAt } = await issue(t, "org-A");
		expect(uploadUrl).toMatch(/^https?:\/\//);
		expect(ticket).toMatch(/^[0-9a-f]{64}$/);
		expect(expiresAt).toBeGreaterThan(Date.now());
		// only the hash is stored, never the ticket
		const stored = await t.run(async (ctx) =>
			ctx.db.query("uploadTickets").collect(),
		);
		expect(JSON.stringify(stored)).not.toContain(ticket);

		const storageId = await upload(t);
		await asOrg(t, "org-A").mutation(CLAIM, { storageId, ticket });
		expect((await bindingsOf(t, storageId)).map((r) => r.orgId)).toEqual([
			"org-A",
		]);

		const result = await asOrg(t, "org-A").action(VALIDATE, { storageId });
		expect(result.schemaVersion).toBe("0.1");
	});

	test("REFUSED — another org holding the storageId but not the ticket cannot claim it", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		await issue(t, "org-A");
		const storageId = await upload(t);

		await expect(
			asOrg(t, "org-B").mutation(CLAIM, {
				storageId,
				ticket: "0".repeat(64),
			}),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_INVALID/);
		expect(await bindingsOf(t, storageId)).toEqual([]);
	});

	test("REFUSED — a ticket issued to org-A cannot be claimed by org-B, and stays usable by org-A", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		const { ticket } = await issue(t, "org-A");
		const storageId = await upload(t);

		await expect(
			asOrg(t, "org-B").mutation(CLAIM, { storageId, ticket }),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_NOT_YOURS/);
		expect(await bindingsOf(t, storageId)).toEqual([]);

		await asOrg(t, "org-A").mutation(CLAIM, { storageId, ticket });
		expect((await bindingsOf(t, storageId)).map((r) => r.orgId)).toEqual([
			"org-A",
		]);
	});

	test("REFUSED — a reused ticket is refused", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const { ticket } = await issue(t, "org-A");
		const first = await upload(t);
		await asOrg(t, "org-A").mutation(CLAIM, { storageId: first, ticket });

		const second = await upload(t);
		await expect(
			asOrg(t, "org-A").mutation(CLAIM, { storageId: second, ticket }),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_USED/);
		expect(await bindingsOf(t, second)).toEqual([]);
	});

	test("REFUSED — an expired ticket is refused", async () => {
		vi.useFakeTimers();
		const t = createT();
		await seedOrg(t, "org-A");
		const { ticket, expiresAt } = await issue(t, "org-A");
		const storageId = await upload(t);
		vi.setSystemTime(expiresAt + 1);

		await expect(
			asOrg(t, "org-A").mutation(CLAIM, { storageId, ticket }),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_EXPIRED/);
		expect(await bindingsOf(t, storageId)).toEqual([]);
	});

	test("REFUSED — a blob created BEFORE the ticket was issued is not claimable with it", async () => {
		vi.useFakeTimers();
		const t = createT();
		await seedOrg(t, "org-A");
		const older = await upload(t);
		vi.setSystemTime(Date.now() + 60_000);
		const { ticket } = await issue(t, "org-A");

		await expect(
			asOrg(t, "org-A").mutation(CLAIM, { storageId: older, ticket }),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_STALE_BLOB/);
		expect(await bindingsOf(t, older)).toEqual([]);
	});

	test("REFUSED — validate on an uploaded but unclaimed blob is still refused", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await issue(t, "org-A");
		const storageId = await upload(t);

		await expect(
			asOrg(t, "org-A").action(VALIDATE, { storageId }),
		).rejects.toThrow(/AUTH_STORAGE_UNBOUND/);
		expect(await bindingsOf(t, storageId)).toEqual([]);
	});
});

// ── The ticket is bound to the file's CONTENT (coordinator, #1465): an org
// holding its own valid ticket plus another org's leaked storageId must also
// hold that org's file content to claim it. ──
describe("upload ticket bound to the declared content sha256", () => {
	test("REFUSED — org-B with its OWN valid ticket and org-A's leaked storageId cannot claim it", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		// org-B holds a ticket issued BEFORE the victim uploads, so the
		// stale-blob check cannot stop it: only the content binding can. Its
		// ticket declares the file org-B actually has.
		const { ticket } = await issue(t, "org-B", sha256Of(await bundle("b")));
		const victimBytes = await bundle("org-A secret");
		await issue(t, "org-A", sha256Of(victimBytes));
		const leaked = await upload(t, victimBytes);

		await expect(
			asOrg(t, "org-B").mutation(CLAIM, { storageId: leaked, ticket }),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_HASH_MISMATCH/);
		expect(await bindingsOf(t, leaked)).toEqual([]);
	});

	// Origin: Argus REVISE at d460b96 (M5) and Eta REVISE at 4907062. The test
	// above is stopped by the content binding, not by the owner check. This one
	// has org-B's ticket declare the SAME sha256 as org-A's blob, issued before
	// the upload, with org-A already holding the claim: only the other-org-owner
	// check in claimUpload can refuse it. Without it, org-B's ticket is consumed
	// and claim_upload returns {orgId: "org-B"} for a blob whose kbUploads row is
	// org-A's.
	test("REFUSED — org-B's ticket declaring the SAME sha256 cannot claim a blob org-A already holds; row unchanged, ticket not consumed", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		const shared = await bundle("shared file");
		const a = await issue(t, "org-A", sha256Of(shared));
		const b = await issue(t, "org-B", sha256Of(shared));
		const storageId = await upload(t, shared);
		await asOrg(t, "org-A").mutation(CLAIM, { storageId, ticket: a.ticket });
		const before = await bindingsOf(t, storageId);
		expect(before.map((r) => r.orgId)).toEqual(["org-A"]);

		await expect(
			asOrg(t, "org-B").mutation(CLAIM, { storageId, ticket: b.ticket }),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);

		expect(await bindingsOf(t, storageId)).toEqual(before);
		const tickets = await t.run(async (ctx) =>
			ctx.db.query("uploadTickets").collect(),
		);
		const orgB = tickets.filter((r) => r.orgId === "org-B");
		expect(orgB).toHaveLength(1);
		expect(orgB[0].usedAt).toBeUndefined();
	});

	test("REFUSED — a blob whose content differs from the declared hash; the ticket stays usable for the declared file", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const declared = await bundle("declared");
		const { ticket } = await issue(t, "org-A", sha256Of(declared));
		const other = await upload(t, await bundle("something else"));

		await expect(
			asOrg(t, "org-A").mutation(CLAIM, { storageId: other, ticket }),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_HASH_MISMATCH/);
		expect(await bindingsOf(t, other)).toEqual([]);

		const right = await upload(t, declared);
		await asOrg(t, "org-A").mutation(CLAIM, { storageId: right, ticket });
		expect((await bindingsOf(t, right)).map((r) => r.orgId)).toEqual(["org-A"]);
	});

	test("REFUSED — generate_upload_url without a well-formed hex sha256 issues no ticket", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await expect(issue(t, "org-A", "not-a-hash")).rejects.toThrow(
			/UPLOAD_TICKET_SHA256_INVALID/,
		);
		const rows = await t.run(async (ctx) =>
			ctx.db.query("uploadTickets").collect(),
		);
		expect(rows).toEqual([]);
	});
});
