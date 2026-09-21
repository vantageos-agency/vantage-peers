/// <reference types="vite/client" />
//
// URGENT security fix — convex/briefingNotes.ts's public queries `get`
// (~l.91) and `list` (~l.235) took `master: v.optional(v.boolean())` and
// `callerIdentities: v.optional(v.array(v.string()))` straight from the
// caller. `callerCanRead` returned true when `master === true` OR when
// `callerIdentities === undefined` — both values are attacker-controlled,
// so an anonymous `get {noteId}` returned ANY note, and an anonymous `list`
// returned EVERY note. Briefing notes carry client material.
//
// FIX: `get`/`list` now resolve the caller's verified org scope via
// `withOrgScope(ctx)` FIRST (see convex/lib/auth.ts, and the #1313 pattern
// in convex/messages.ts's markAsRead/deleteMessage). Anonymous (no Clerk
// identity, no service-account carve-out) is refused with RBAC_DENIED — no
// legacy unscoped read remains. A verified Clerk-org (non-master) caller may
// read only notes whose stored `orgId` equals its own orgSlug, intersected
// with any `callerIdentities` it passes; its `master` argument is IGNORED
// (master is derived from the verified identity server-side, never from a
// client-supplied bool). A verified master/service-account caller keeps
// today's behaviour exactly — `master`/`callerIdentities` are honoured for
// it because only the MCP server holds that credential.

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

const SERVICE_ACCOUNT_SUBJECT = "test-service-account-user-id"; // matches vitest.config.ts CLERK_SERVICE_ACCOUNT_USER_ID

async function seedOrgMapping(
	t: ReturnType<typeof createTestConvex>,
	slug: string,
	allowedOrchestrators: string[] = ["*"],
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators,
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrg(t: ReturnType<typeof createTestConvex>, orgSlug: string) {
	return t.withIdentity({
		subject: `user-${orgSlug}`,
		organizationId: orgSlug,
	} as Parameters<typeof t.withIdentity>[0]);
}

function asServiceAccount(t: ReturnType<typeof createTestConvex>) {
	return t.withIdentity({
		subject: SERVICE_ACCOUNT_SUBJECT,
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedNote(
	t: ReturnType<typeof createTestConvex>,
	opts: {
		title: string;
		createdBy: string;
		participants: string[];
		orgId: string;
	},
) {
	return await t.run(async (ctx) => {
		const noteId = await ctx.db.insert("briefingNotes", {
			title: opts.title,
			topic: "daily",
			participants: opts.participants,
			content: `content for ${opts.title}`,
			createdBy: opts.createdBy,
			createdAt: Date.now(),
			orgId: opts.orgId,
		});
		for (const participant of opts.participants) {
			await ctx.db.insert("briefingNoteParticipants", {
				noteId,
				participant,
			});
		}
		return noteId;
	});
}

const decodeRbacDenied = (caught: unknown): boolean => {
	if (!(caught instanceof ConvexError)) return false;
	const raw = caught.data;
	const message = typeof raw === "string" ? raw : JSON.stringify(raw);
	return message.includes("RBAC_DENIED");
};

describe("briefingNotes.get — anonymous callers are refused (RBAC_DENIED)", () => {
	test("anonymous get is refused", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		const noteId = await seedNote(t, {
			title: "org-a note",
			createdBy: "seat-a",
			participants: ["seat-a"],
			orgId: "org-a",
		});

		let caught: unknown;
		try {
			await t.query(api.briefingNotes.get, { noteId });
			throw new Error("get did not throw — expected RBAC_DENIED");
		} catch (e) {
			caught = e;
		}
		expect(decodeRbacDenied(caught)).toBe(true);
	});

	test("anonymous get with master: true is refused — the client cannot self-grant master", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		const noteId = await seedNote(t, {
			title: "org-a note",
			createdBy: "seat-a",
			participants: ["seat-a"],
			orgId: "org-a",
		});

		let caught: unknown;
		try {
			await t.query(api.briefingNotes.get, { noteId, master: true });
			throw new Error("get did not throw — expected RBAC_DENIED");
		} catch (e) {
			caught = e;
		}
		expect(decodeRbacDenied(caught)).toBe(true);
	});
});

describe("briefingNotes.list — anonymous callers are refused (RBAC_DENIED)", () => {
	test("anonymous list is refused", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		await seedNote(t, {
			title: "org-a note",
			createdBy: "seat-a",
			participants: ["seat-a"],
			orgId: "org-a",
		});

		let caught: unknown;
		try {
			await t.query(api.briefingNotes.list, { fields: "full" });
			throw new Error("list did not throw — expected RBAC_DENIED");
		} catch (e) {
			caught = e;
		}
		expect(decodeRbacDenied(caught)).toBe(true);
	});

	test("anonymous list with master: true is refused", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		await seedNote(t, {
			title: "org-a note",
			createdBy: "seat-a",
			participants: ["seat-a"],
			orgId: "org-a",
		});

		let caught: unknown;
		try {
			await t.query(api.briefingNotes.list, { fields: "full", master: true });
			throw new Error("list did not throw — expected RBAC_DENIED");
		} catch (e) {
			caught = e;
		}
		expect(decodeRbacDenied(caught)).toBe(true);
	});
});

describe("briefingNotes.get — org-scoped caller is confined to its own org", () => {
	test("org-a caller reading an org-b note is refused", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		const noteId = await seedNote(t, {
			title: "org-b note",
			createdBy: "seat-b",
			participants: ["seat-b"],
			orgId: "org-b",
		});

		const note = await asOrg(t, "org-a").query(api.briefingNotes.get, {
			noteId,
		});
		expect(note).toBeNull();
	});

	test("org-a caller with master: true reading an org-b note is still refused — master arg is ignored for an org scope", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		const noteId = await seedNote(t, {
			title: "org-b note",
			createdBy: "seat-b",
			participants: ["seat-b"],
			orgId: "org-b",
		});

		const note = await asOrg(t, "org-a").query(api.briefingNotes.get, {
			noteId,
			master: true,
		});
		expect(note).toBeNull();
	});

	test("org-a caller naming the org-b author via callerIdentities (M1 shape) is still refused", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		const noteId = await seedNote(t, {
			title: "org-b note",
			createdBy: "seat-b",
			participants: ["seat-b"],
			orgId: "org-b",
		});

		const note = await asOrg(t, "org-a").query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["seat-b"],
		});
		expect(note).toBeNull();
	});

	test("org-a caller reading its own note is allowed", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		const noteId = await seedNote(t, {
			title: "org-a note",
			createdBy: "seat-a",
			participants: ["seat-a"],
			orgId: "org-a",
		});

		const note = await asOrg(t, "org-a").query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["seat-a"],
		});
		expect(note).not.toBeNull();
		expect(note?.title).toBe("org-a note");
	});
});

describe("briefingNotes.list — org-scoped caller sees only its own org's notes", () => {
	test("org-a caller list returns only org-a notes, even with master: true", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		await seedNote(t, {
			title: "org-a note",
			createdBy: "seat-a",
			participants: ["seat-a"],
			orgId: "org-a",
		});
		await seedNote(t, {
			title: "org-b note",
			createdBy: "seat-b",
			participants: ["seat-b"],
			orgId: "org-b",
		});

		const notes = await asOrg(t, "org-a").query(api.briefingNotes.list, {
			fields: "full",
			master: true,
		});
		const titles = notes.map((n: { title: string }) => n.title);
		expect(titles).toContain("org-a note");
		expect(titles).not.toContain("org-b note");
	});
});

describe("briefingNotes.get/list — master/service-account caller keeps today's behaviour exactly", () => {
	test("service-account caller with master: true sees every note, across orgs", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		const noteAId = await seedNote(t, {
			title: "org-a note",
			createdBy: "seat-a",
			participants: ["seat-a"],
			orgId: "org-a",
		});
		const noteBId = await seedNote(t, {
			title: "org-b note",
			createdBy: "seat-b",
			participants: ["seat-b"],
			orgId: "org-b",
		});

		const tService = asServiceAccount(t);

		const noteA = await tService.query(api.briefingNotes.get, {
			noteId: noteAId,
			master: true,
		});
		expect(noteA).not.toBeNull();

		const noteB = await tService.query(api.briefingNotes.get, {
			noteId: noteBId,
			master: true,
		});
		expect(noteB).not.toBeNull();

		const notes = await tService.query(api.briefingNotes.list, {
			fields: "full",
			master: true,
		});
		const titles = notes.map((n: { title: string }) => n.title);
		expect(titles).toContain("org-a note");
		expect(titles).toContain("org-b note");
	});

	test("service-account caller with master: false and callerIdentities: [seat-a] sees only notes readable by seat-a — exactly as before", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		const noteAId = await seedNote(t, {
			title: "org-a note (seat-a participant)",
			createdBy: "someone-else",
			participants: ["seat-a"],
			orgId: "org-a",
		});
		const noteBId = await seedNote(t, {
			title: "org-b note (no seat-a)",
			createdBy: "seat-b",
			participants: ["seat-b"],
			orgId: "org-b",
		});

		const tService = asServiceAccount(t);

		const noteA = await tService.query(api.briefingNotes.get, {
			noteId: noteAId,
			master: false,
			callerIdentities: ["seat-a"],
		});
		expect(noteA).not.toBeNull();

		const noteB = await tService.query(api.briefingNotes.get, {
			noteId: noteBId,
			master: false,
			callerIdentities: ["seat-a"],
		});
		expect(noteB).toBeNull();

		const notes = await tService.query(api.briefingNotes.list, {
			fields: "full",
			master: false,
			callerIdentities: ["seat-a"],
		});
		const titles = notes.map((n: { title: string }) => n.title);
		expect(titles).toContain("org-a note (seat-a participant)");
		expect(titles).not.toContain("org-b note (no seat-a)");
	});
});
