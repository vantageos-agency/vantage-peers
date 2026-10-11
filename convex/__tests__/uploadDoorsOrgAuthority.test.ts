/// <reference types="vite/client" />
//
// Who may mint and claim an upload ticket: the contract the by-ID conversion of
// generateUploadUrlWithTicket and claimUpload (backend standard R-53) must keep.
// Four poles per door, each pinned on the door as it stands:
//   another org            REFUSED (RBAC_DENIED / AUTH_UPLOAD_TICKET_NOT_YOURS)
//   the same org           SERVED
//   an inactive org        REFUSED (withOrgScope refuses an inactive mapping)
//   the fleet service acct SERVED (master by subject, any org)

import { createHash } from "node:crypto";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
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

async function seedOrg(t: T, clerkOrgSlug: string, isActive = true) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive,
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

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const SHA = createHash("sha256").update(BYTES).digest("hex");

type Caller = ReturnType<typeof asOrg>;
const generate = (c: Caller, orgId: string) =>
	c.mutation(GENERATE, {
		orgId,
		namespace: `team/${orgId}`,
		sha256: SHA,
	}) as Promise<{
		ticket: string;
	}>;

async function upload(t: T): Promise<Id<"_storage">> {
	return await t.run(async (ctx) =>
		ctx.storage.store(new Blob([new Uint8Array(BYTES)])),
	);
}

describe("generateUploadUrlWithTicket — who may mint", () => {
	test("REFUSED — another org's id in args", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		await expect(generate(asOrg(t, "org-A"), "org-B")).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});

	test("PRESENT — the same org is served", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const r = await generate(asOrg(t, "org-A"), "org-A");
		expect(r.ticket).toMatch(/^[0-9a-f]{64}$/);
	});

	test("REFUSED — an inactive org, naming its own id", async () => {
		const t = createT();
		await seedOrg(t, "org-off", false);
		await expect(generate(asOrg(t, "org-off"), "org-off")).rejects.toThrow(
			/RBAC_DENIED/,
		);
		const tickets = await t.run(async (ctx) =>
			ctx.db.query("uploadTickets").collect(),
		);
		expect(tickets).toEqual([]);
	});

	test("PRESENT — the fleet service account mints for any org", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const r = await generate(asService(t), "org-A");
		expect(r.ticket).toMatch(/^[0-9a-f]{64}$/);
		const rows = await t.run(async (ctx) =>
			ctx.db.query("uploadTickets").collect(),
		);
		expect(rows.map((x) => x.orgId)).toEqual(["org-A"]);
	});
});

describe("claimUpload — who may claim", () => {
	test("REFUSED — another org presenting org-A's ticket; nothing bound", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		const { ticket } = await generate(asOrg(t, "org-A"), "org-A");
		const storageId = await upload(t);
		await expect(
			asOrg(t, "org-B").mutation(CLAIM, { storageId, ticket }),
		).rejects.toThrow(/AUTH_UPLOAD_TICKET_NOT_YOURS/);
		const bound = await t.run(async (ctx) =>
			ctx.db.query("kbUploads").collect(),
		);
		expect(bound).toEqual([]);
	});

	test("PRESENT — the same org claims its own upload", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const { ticket } = await generate(asOrg(t, "org-A"), "org-A");
		const storageId = await upload(t);
		const r = await asOrg(t, "org-A").mutation(CLAIM, { storageId, ticket });
		expect(r).toEqual({ storageId, orgId: "org-A" });
	});

	test("REFUSED — an org deactivated after it minted the ticket; nothing bound", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const { ticket } = await generate(asOrg(t, "org-A"), "org-A");
		const storageId = await upload(t);
		await t.run(async (ctx) => {
			const row = await ctx.db.query("client_org_mapping").first();
			if (row !== null) await ctx.db.patch(row._id, { isActive: false });
		});
		await expect(
			asOrg(t, "org-A").mutation(CLAIM, { storageId, ticket }),
		).rejects.toThrow(/RBAC_DENIED/);
		const bound = await t.run(async (ctx) =>
			ctx.db.query("kbUploads").collect(),
		);
		expect(bound).toEqual([]);
	});

	test("PRESENT — the fleet service account claims a ticket issued to any org, bound to that org", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const { ticket } = await generate(asOrg(t, "org-A"), "org-A");
		const storageId = await upload(t);
		const r = await asService(t).mutation(CLAIM, { storageId, ticket });
		expect(r).toEqual({ storageId, orgId: "org-A" });
	});
});
