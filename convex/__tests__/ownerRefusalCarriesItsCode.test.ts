/// <reference types="vite/client" />
/**
 * Backend-doctor R-16: an owner/creator refusal is a coded ConvexError, never an
 * opaque `Error("Unauthorized: ...")`.
 *
 * Every site now raises `ConvexError("RBAC_DENIED: ... — {registration, orgSlug,
 * reason}")`, the same shape `requireScope` / `requireResolvedCaller` raise, so a
 * reader branches on the CODE and on the DOOR that refused rather than on prose.
 *
 *   REFUSED  the wrong caller -> ConvexError carrying RBAC_DENIED + the door
 *   PRESENT  the row's own party -> succeeds (no grant withheld)
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", "test-master-token-owner-refusal");
});
afterEach(() => {
	vi.unstubAllEnvs();
});

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedOrgA(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a", "seat-b"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const asMemberOfOrgA = (t: T) =>
	t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);

const asMaster = (t: T) =>
	t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);

/** Awaits a refused call and returns the structured ConvexError payload. */
async function refusalOf(call: Promise<unknown>): Promise<{
	text: string;
	payload: { registration: string; orgSlug: string | null; reason: string };
}> {
	let caught: unknown;
	try {
		await call;
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(ConvexError);
	// convex-test hands ConvexError.data through JSON, so a string payload may
	// arrive quoted; unwrap it once.
	const raw = String((caught as ConvexError<string>).data);
	const text = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
	expect(text).toMatch(/^RBAC_DENIED:/);
	const payload = JSON.parse(text.slice(text.lastIndexOf("— ") + 2));
	return { text, payload };
}

const seedNote = (t: T, createdBy: string) =>
	t.run((ctx) =>
		ctx.db.insert("briefingNotes", {
			title: "seed note",
			topic: "handoff",
			participants: [createdBy],
			content: "seed content",
			createdBy,
			createdAt: Date.now(),
			orgId: "org-a",
		}),
	);

const seedDiary = (t: T, orchestrator: string) =>
	t.run((ctx) =>
		ctx.db.insert("diary", {
			date: "2026-09-29",
			orchestrator,
			content: "seed diary",
			createdAt: Date.now(),
		}),
	);

const seedMessage = (t: T, from: string) =>
	t.run((ctx) =>
		ctx.db.insert("messages", {
			from,
			channel: "seat-x",
			content: "seed message",
			createdAt: Date.now(),
			// sendMessage stamps the caller's org; deleteMessage's tenant gate reads it.
			tenantId: "org-a",
		}),
	);

const seedMandate = (t: T) =>
	t.run((ctx) =>
		ctx.db.insert("mandates", {
			requestedBy: "seat-b",
			fulfilledBy: "seat-b",
			service: "svc",
			budget: 100,
			status: "requested",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);

describe("R-16 — owner refusals raise a coded ConvexError naming their door", () => {
	test("briefingNotes:deleteBriefingNote — omitted caller and non-creator", async () => {
		const t = createT();
		await seedOrgA(t);
		const noteId = await seedNote(t, "seat-b");
		const missing = await refusalOf(
			asMemberOfOrgA(t).mutation(api.briefingNotes.deleteBriefingNote, { noteId }),
		);
		// Admin CRUD B2: an omitted caller from a non-master member is the HUMAN
		// path; this member carries no writer role, so it is refused as such (still
		// coded, still naming its door).
		expect(missing.payload).toEqual({
			reason: "role-not-writer",
			door: "briefingNotes:deleteBriefingNote",
			role: null,
			orgSlug: "org-a",
		});
		const stranger = await refusalOf(
			asMemberOfOrgA(t).mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: "seat-a",
			}),
		);
		expect(stranger.payload.reason).toBe("not-creator");
		expect(stranger.payload.registration).toBe("briefingNotes:deleteBriefingNote");
		// PRESENT: the creator is still served.
		const ok = await asMemberOfOrgA(t).mutation(api.briefingNotes.deleteBriefingNote, {
			noteId,
			callerOrchestrator: "seat-b",
		});
		expect(ok.deleted).toBe(true);
	});

	test("briefingNotes:update — non-creator", async () => {
		const t = createT();
		await seedOrgA(t);
		const noteId = await seedNote(t, "seat-b");
		const r = await refusalOf(
			asMemberOfOrgA(t).mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "seat-a",
				title: "hijacked",
			}),
		);
		expect(r.payload).toEqual({
			registration: "briefingNotes:update",
			orgSlug: "org-a",
			reason: "not-creator",
		});
	});

	test("diary:deleteDiary — omitted caller and non-owner", async () => {
		const t = createT();
		await seedOrgA(t);
		const diaryId = await seedDiary(t, "seat-b");
		const missing = await refusalOf(
			asMemberOfOrgA(t).mutation(api.diary.deleteDiary, { diaryId }),
		);
		expect(missing.payload.registration).toBe("diary:deleteDiary");
		expect(missing.payload.reason).toBe("caller-orchestrator-required");
		const stranger = await refusalOf(
			asMemberOfOrgA(t).mutation(api.diary.deleteDiary, {
				diaryId,
				callerOrchestrator: "seat-a",
			}),
		);
		expect(stranger.payload.reason).toBe("not-owner");
		expect(await t.run((ctx) => ctx.db.get(diaryId))).not.toBeNull();
	});

	test("messages:deleteMessage — omitted caller and non-sender", async () => {
		const t = createT();
		await seedOrgA(t);
		const messageId = await seedMessage(t, "seat-b");
		const missing = await refusalOf(
			asMemberOfOrgA(t).mutation(api.messages.deleteMessage, { messageId }),
		);
		expect(missing.payload.registration).toBe("messages:deleteMessage");
		expect(missing.payload.reason).toBe("caller-orchestrator-required");
		const stranger = await refusalOf(
			asMemberOfOrgA(t).mutation(api.messages.deleteMessage, {
				messageId,
				callerOrchestrator: "seat-a",
			}),
		);
		expect(stranger.payload.reason).toBe("not-sender");
		expect(await t.run((ctx) => ctx.db.get(messageId))).not.toBeNull();
	});

	test("mandates:accept / update / settle — a stranger name is refused by the master", async () => {
		const t = createT();
		const mandateId = await seedMandate(t);
		const tM = asMaster(t);
		const accept = await refusalOf(
			tM.mutation(api.mandates.accept, { mandateId, callerOrchestrator: "seat-a" }),
		);
		expect(accept.payload.registration).toBe("mandates:accept");
		expect(accept.payload.reason).toBe("not-fulfilled-by");
		const update = await refusalOf(
			tM.mutation(api.mandates.update, {
				mandateId,
				callerOrchestrator: "seat-a",
				status: "delivered",
			}),
		);
		expect(update.payload.registration).toBe("mandates:update");
		const settle = await refusalOf(
			tM.mutation(api.mandates.settle, {
				mandateId,
				callerOrchestrator: "seat-a",
				finalCost: 1,
			}),
		);
		expect(settle.payload.registration).toBe("mandates:settle");
		expect(settle.payload.reason).toBe("not-requested-by");
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("requested");
	});

	test("oauth:provisionOrganization — an invalid master token is a coded refusal", async () => {
		const t = createT();
		const r = await refusalOf(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: "wrong",
				clerkOrgSlug: "y",
				displayName: "y",
				orchestrators: [{ name: "a" }],
			}),
		);
		expect(r.payload).toEqual({
			registration: "oauth:provisionOrganization",
			orgSlug: null,
			reason: "invalid-master-token",
		});
	});
});
