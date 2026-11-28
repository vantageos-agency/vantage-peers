/// <reference types="vite/client" />
//
// S-28 (Pi ruling): a right is presented, never inferred. kbMutations:claimUpload
// refuses a service-account call that carries no verifiedOrg (RBAC_DENIED); it
// no longer serves it as master on the ticket's org. Every other caller is
// unchanged: a Clerk-signed member (no claim needed) and the service account
// carrying the verifiedOrg of the ticket's org.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

// biome-ignore lint/suspicious/noExplicitAny: string refs, codegen-lag workaround (see okfUploadTicketClaim.test.ts)
const GENERATE = "kbMutations:generateUploadUrlWithTicket" as any;
// biome-ignore lint/suspicious/noExplicitAny: string refs, codegen-lag workaround
const CLAIM = "kbMutations:claimUpload" as any;

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

function asService(t: T) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

const BYTES = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
const SHA = createHash("sha256").update(BYTES).digest("hex");

async function issue(t: T, orgId: string): Promise<string> {
	const r = (await asOrg(t, orgId).mutation(GENERATE, {
		orgId,
		namespace: `team/${orgId}`,
		sha256: SHA,
	})) as { ticket: string };
	return r.ticket;
}

async function upload(t: T): Promise<Id<"_storage">> {
	return await t.run(async (ctx) =>
		ctx.storage.store(new Blob([new Uint8Array(BYTES)])),
	);
}

const bound = (t: T) =>
	t.run(async (ctx) => ctx.db.query("kbUploads").collect());
const tickets = (t: T) =>
	t.run(async (ctx) => ctx.db.query("uploadTickets").collect());

describe("claimUpload — a right is presented, never inferred", () => {
	test("REFUSED — service account WITHOUT verifiedOrg: RBAC_DENIED, ticket stays unclaimed", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const ticket = await issue(t, "org-A");
		const storageId = await upload(t);
		await expect(
			asService(t).mutation(CLAIM, { storageId, ticket }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await bound(t)).toEqual([]);
		const rows = await tickets(t);
		expect(rows).toHaveLength(1);
		expect(rows[0].usedAt).toBeUndefined();
	});

	test("PRESENT — service account + verifiedOrg of the ticket's org: claimed for that org", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const ticket = await issue(t, "org-A");
		const storageId = await upload(t);
		const r = await asService(t).mutation(CLAIM, {
			storageId,
			ticket,
			verifiedOrg: { orgSlug: "org-A" },
		});
		expect(r).toEqual({ storageId, orgId: "org-A" });
		const rows = await bound(t);
		expect(rows.map((x) => x.orgId)).toEqual(["org-A"]);
	});

	test("REFUSED — service account + verifiedOrg of ANOTHER org: not the ticket's, nothing bound", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		const ticket = await issue(t, "org-A");
		const storageId = await upload(t);
		await expect(
			asService(t).mutation(CLAIM, {
				storageId,
				ticket,
				verifiedOrg: { orgSlug: "org-B" },
			}),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_NOT_YOURS/);
		expect(await bound(t)).toEqual([]);
		const rows = await tickets(t);
		expect(rows[0].usedAt).toBeUndefined();
	});

	test("PRESENT — a Clerk member of the ticket's org, no verifiedOrg: claimed (unchanged)", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const ticket = await issue(t, "org-A");
		const storageId = await upload(t);
		const r = await asOrg(t, "org-A").mutation(CLAIM, { storageId, ticket });
		expect(r).toEqual({ storageId, orgId: "org-A" });
	});
});
