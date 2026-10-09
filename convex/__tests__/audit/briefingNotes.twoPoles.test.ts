/// <reference types="vite/client" />
/**
 * R4 RED reproduction — briefingNotes doors (audit rows: list, deleteBriefingNote, update).
 * Every test asserts the CORRECT behaviour; a FAIL means the audited defect is real on this tree.
 * Identity: an ordinary org-a member (subject user-org-a, organizationId org-a, orgRole org:member)
 * — NOT the service account, NOT the note creator.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const asMember = (t: T, role = "org:member") =>
	t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
		orgRole: role,
	} as Parameters<typeof t.withIdentity>[0]);

async function seed(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
		// Fleet-default writer list: only admins write.
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin"],
			updatedAt: Date.now(),
		});
	});
}

async function seedNote(t: T, createdBy: string, title = "n") {
	return await t.run(async (ctx) =>
		ctx.db.insert("briefingNotes", {
			title,
			topic: "handoff",
			participants: [createdBy],
			content: "c",
			createdBy,
			createdAt: Date.now(),
			orgId: "org-a",
		}),
	);
}

describe("briefingNotes:list — cursor paging", () => {
	test("briefingNotes:list — an org-a member can page past the first page with createdBefore (n1 is returned on page 2)", async () => {
		const t = createT();
		await seed(t);
		const n1 = await seedNote(t, "sigma", "n1");
		const n2 = await seedNote(t, "sigma", "n2");
		const n3 = await seedNote(t, "sigma", "n3");
		const page1 = (await asMember(t).query(api.briefingNotes.list, { limit: 2 })) as { _id: string }[];
		expect(page1.map((r) => r._id)).toEqual([n3, n2]);
		const n2doc = await t.run((ctx) => ctx.db.get(n2));
		const page2 = (await asMember(t).query(api.briefingNotes.list, {
			limit: 2,
			createdBefore: (n2doc as { _creationTime: number })._creationTime,
		})) as { _id: string }[];
		expect(page2.map((r) => r._id)).toEqual([n1]);
	});
});

describe("briefingNotes:deleteBriefingNote — agent path", () => {
	test("briefingNotes:deleteBriefingNote — a non-admin org member cannot delete a note by passing the creator's name as callerOrchestrator", async () => {
		const t = createT();
		await seed(t);
		const noteId = await seedNote(t, "sigma");
		await expect(
			asMember(t).mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: "sigma",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.get(noteId))).not.toBeNull();
	});

	test("briefingNotes:deleteBriefingNote — positive control: the human path refuses the same non-admin member", async () => {
		const t = createT();
		await seed(t);
		const noteId = await seedNote(t, "sigma");
		await expect(
			asMember(t).mutation(api.briefingNotes.deleteBriefingNote, { noteId }),
		).rejects.toThrow(/role-not-admin|role-not-writer|RBAC_DENIED/);
	});

	test("briefingNotes:deleteBriefingNote — positive control: an org:admin deletes on the human path", async () => {
		const t = createT();
		await seed(t);
		const noteId = await seedNote(t, "sigma");
		const r = await asMember(t, "org:admin").mutation(api.briefingNotes.deleteBriefingNote, { noteId });
		expect(r).toEqual({ deleted: true });
	});
});

describe("briefingNotes:update — agent path", () => {
	test("briefingNotes:update — a non-writer org member cannot edit a note by passing the creator's name as callerOrchestrator", async () => {
		const t = createT();
		await seed(t);
		const noteId = await seedNote(t, "sigma");
		await expect(
			asMember(t).mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "sigma",
				content: "x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await t.run((ctx) => ctx.db.get(noteId));
		expect(row?.content).toBe("c");
		expect(row?.updatedBy).toBeUndefined();
	});

	test("briefingNotes:update — positive control: the human path refuses the same non-writer member", async () => {
		const t = createT();
		await seed(t);
		const noteId = await seedNote(t, "sigma");
		await expect(
			asMember(t).mutation(api.briefingNotes.update, { noteId, content: "x" }),
		).rejects.toThrow(/role-not-writer/);
	});
});
