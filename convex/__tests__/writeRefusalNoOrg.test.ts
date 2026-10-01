/// <reference types="vite/client" />
/**
 * R-51 — THE PRE-ORGANISATION CALLER OF A PUBLIC WRITE IS REFUSED WITH THE CODED
 * REFUSAL, AND NOTHING IS WRITTEN.
 *
 * Thirteen public mutations throw on the no-org path with no `write-contract`
 * marker. Each was re-decided on ONE measured fact — does a client render
 * issue the write — enumerated by command in BOTH repositories
 * (`mcp-server/src/` and `vantage-peers-dashboard`):
 *
 *   briefingNotes:create        dashboard briefing-form.tsx:93 (submit handler,   KEEP THROW +
 *                               try/catch :153-165) and MCP tools.ts:6146         MARKER
 *   briefingNotes:update        MCP only (tools.ts:6216)                          KEEP THROW + MARKER
 *   kbMutations:generateUploadUrl, messages:deleteMessage,
 *   missionTemplates:instantiateTemplateIntoMission, missions:create,
 *   missions:updateStatus       MCP only                                          KEEP THROW + MARKER
 *   briefingNotes:deleteBriefingNote, diary:deleteDiary,
 *   iframeEmbedSessions:{createSession,touchSession,revokeSession},
 *   missions:updateProgress     no caller outside convex-test                     KEEP THROW + MARKER
 *
 * A write has no "empty" shape, so the refusal stays a RAISE (R-16 coded
 * refusal: `RBAC_DENIED`, `orgSlug: null`) — a typed-empty return would be the
 * absence-shaped answer to a refused writer and change `returns` for the MCP
 * caller. This suite pins, per site, the three poles:
 *   PRE-ORG   — signed in, no organisation: RAISES `RBAC_DENIED` with
 *               `"orgSlug":null`, and the table is UNCHANGED.
 *   ANONYMOUS — no credential: still RAISES `RBAC_DENIED` (never weakened).
 *   MEMBER    — a legitimate member of an active org is served (the write
 *               lands, or for the owner-gated deletes it passes the org gate).
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

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
type Caller = Pick<T, "mutation">;

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const PRE_ORG = "signed-in-user-with-no-organisation-yet";
const MEMBER = "ordinary-member-of-org-a";
const SEAT = "seat-a";
const NOW = 1_748_390_400_000;

for (const subject of [PRE_ORG, MEMBER]) {
	if (subject === SERVICE_ACCOUNT_USER_ID) {
		throw new Error(
			`test-integrity: ${subject} must not be the service-account id — a DENY pole under the maintenance identity proves the bypass, not the control`,
		);
	}
}

/** Authenticated, NO organisation claim of any kind. */
const asPreOrg = (t: T) =>
	t.withIdentity({ subject: PRE_ORG } as Parameters<typeof t.withIdentity>[0]);

const asMember = (t: T) =>
	t.withIdentity({
		subject: MEMBER,
		organizationId: "org-a",
		organizationSlug: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);

const seedOrgMapping = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: [SEAT],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});

/** The bytes of the error a caller would receive, or "SUCCESS". */
async function outcome(write: () => Promise<unknown>): Promise<string> {
	try {
		await write();
		return "SUCCESS";
	} catch (e) {
		return String((e as ConvexError<string>).data ?? e);
	}
}

const seedBriefingNote = (t: T, orgId: string) =>
	t.run((ctx) =>
		ctx.db.insert("briefingNotes", {
			title: "seed note",
			topic: "handoff",
			participants: [SEAT],
			content: "seed content",
			createdBy: SEAT,
			createdAt: NOW,
			orgId,
		}),
	);

const seedDiary = (t: T) =>
	t.run((ctx) =>
		ctx.db.insert("diary", {
			date: "2026-07-11",
			orchestrator: SEAT,
			content: "seed entry",
			createdAt: NOW,
		}),
	);

const seedMessage = (t: T) =>
	t.run((ctx) =>
		ctx.db.insert("messages", {
			from: SEAT,
			channel: "general",
			content: "seed message",
			createdAt: NOW,
			tenantId: "org-a",
		}),
	);

const seedMission = (t: T) =>
	t.run((ctx) =>
		ctx.db.insert("missions", {
			name: "seed mission",
			project: "p",
			status: "plan",
			priority: "medium",
			pilot: SEAT,
			agents: [SEAT],
			createdBy: SEAT,
			createdAt: NOW,
			updatedAt: NOW,
			orgId: "org-a",
		}),
	);

const seedTemplate = (t: T) =>
	t.run((ctx) =>
		ctx.db.insert("missionTemplates", {
			name: "tpl",
			steps: [{ title: "Step 1", description: "do the thing" }],
			isDefault: false,
			createdBy: SEAT,
			createdAt: NOW,
			updatedAt: NOW,
		}),
	);

const seedSession = (t: T, sessionId: string) =>
	t.run((ctx) =>
		ctx.db.insert("iframeEmbedSessions", {
			sessionId,
			tenantId: "org-a",
			origin: "https://acme.example.com",
			createdAt: NOW,
			lastSeenAt: NOW,
			expiresAt: NOW + 3_600_000,
			revoked: false,
		}),
	);

interface Site {
	name: string;
	/** Seeds rows for the call and returns the call, as the given caller. */
	prepare: (t: T) => Promise<(c: Caller) => Promise<unknown>>;
	/** Tables whose row counts must not move on a refusal. */
	tables: (
		| "briefingNotes"
		| "diary"
		| "messages"
		| "missions"
		| "iframeEmbedSessions"
		| "tasks"
	)[];
	/** true: the member write lands; false: asserted only to pass the org gate. */
	memberSucceeds: boolean;
}

const SITES: Site[] = [
	{
		name: "briefingNotes:create",
		tables: ["briefingNotes"],
		memberSucceeds: true,
		prepare: async () => (c) =>
			c.mutation(api.briefingNotes.create, {
				title: "n",
				topic: "handoff",
				participants: [SEAT],
				content: "c",
				createdBy: SEAT,
			}),
	},
	{
		name: "briefingNotes:update",
		tables: ["briefingNotes"],
		memberSucceeds: true,
		prepare: async (t) => {
			const noteId = await seedBriefingNote(t, "org-a");
			return (c) =>
				c.mutation(api.briefingNotes.update, {
					noteId,
					callerOrchestrator: SEAT,
					content: "edited",
				});
		},
	},
	{
		name: "briefingNotes:deleteBriefingNote",
		tables: ["briefingNotes"],
		memberSucceeds: true,
		prepare: async (t) => {
			const noteId = await seedBriefingNote(t, "org-a");
			return (c) =>
				c.mutation(api.briefingNotes.deleteBriefingNote, {
					noteId,
					callerOrchestrator: SEAT,
				});
		},
	},
	{
		name: "diary:deleteDiary",
		tables: ["diary"],
		memberSucceeds: true,
		prepare: async (t) => {
			const diaryId = await seedDiary(t);
			return (c) =>
				c.mutation(api.diary.deleteDiary, {
					diaryId,
					callerOrchestrator: SEAT,
				});
		},
	},
	{
		name: "iframeEmbedSessions:createSession",
		tables: ["iframeEmbedSessions"],
		memberSucceeds: true,
		prepare: async () => (c) =>
			c.mutation(api.iframeEmbedSessions.createSession, {
				sessionId: "sess-new",
				origin: "https://acme.example.com",
				expiresAt: Date.now() + 3_600_000,
			}),
	},
	{
		name: "iframeEmbedSessions:touchSession",
		tables: ["iframeEmbedSessions"],
		memberSucceeds: false,
		prepare: async (t) => {
			await seedSession(t, "sess-touch");
			return (c) =>
				c.mutation(api.iframeEmbedSessions.touchSession, {
					sessionId: "sess-touch",
				});
		},
	},
	{
		name: "iframeEmbedSessions:revokeSession",
		tables: ["iframeEmbedSessions"],
		memberSucceeds: true,
		prepare: async (t) => {
			await seedSession(t, "sess-revoke");
			return (c) =>
				c.mutation(api.iframeEmbedSessions.revokeSession, {
					sessionId: "sess-revoke",
				});
		},
	},
	{
		name: "kbMutations:generateUploadUrl",
		tables: [],
		memberSucceeds: true,
		prepare: async () => (c) =>
			c.mutation(api.kbMutations.generateUploadUrl, {
				orgId: "org-a",
				namespace: "team/org-a/docs",
			}),
	},
	{
		name: "messages:deleteMessage",
		tables: ["messages"],
		memberSucceeds: true,
		prepare: async (t) => {
			const messageId = await seedMessage(t);
			return (c) =>
				c.mutation(api.messages.deleteMessage, {
					messageId,
					callerOrchestrator: SEAT,
				});
		},
	},
	{
		name: "missionTemplates:instantiateTemplateIntoMission",
		tables: ["tasks"],
		memberSucceeds: false,
		prepare: async (t) => {
			await seedTemplate(t);
			const missionId = await seedMission(t);
			return (c) =>
				c.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
					templateName: "tpl",
					missionId,
					callerOrchestrator: SEAT,
				});
		},
	},
	{
		name: "missions:create",
		tables: ["missions"],
		memberSucceeds: true,
		prepare: async () => (c) =>
			c.mutation(api.missions.create, {
				name: "m",
				project: "p",
				status: "plan",
				priority: "medium",
				pilot: SEAT,
				agents: [SEAT],
				createdBy: SEAT,
			}),
	},
	{
		name: "missions:updateStatus",
		tables: ["missions"],
		memberSucceeds: true,
		prepare: async (t) => {
			const missionId: Id<"missions"> = await seedMission(t);
			return (c) =>
				c.mutation(api.missions.updateStatus, { missionId, status: "execute" });
		},
	},
	{
		name: "missions:updateProgress",
		tables: ["missions"],
		memberSucceeds: true,
		prepare: async (t) => {
			const missionId = await seedMission(t);
			return (c) =>
				c.mutation(api.missions.updateProgress, { missionId, progress: 50 });
		},
	},
];

async function counts(t: T, tables: Site["tables"]): Promise<string> {
	return JSON.stringify(
		await t.run(async (ctx) => {
			const out: Record<string, unknown> = {};
			for (const tb of tables) out[tb] = await ctx.db.query(tb).collect();
			return out;
		}),
	);
}

describe("R-51 — public writes refuse a no-org caller with the coded refusal", () => {
	for (const site of SITES) {
		describe(site.name, () => {
			test("PRE-ORG: raises RBAC_DENIED carrying orgSlug:null, writes nothing", async () => {
				const t = createT();
				await seedOrgMapping(t);
				const call = await site.prepare(t);
				const before = await counts(t, site.tables);
				const bytes = await outcome(() => call(asPreOrg(t)));
				expect(bytes).toContain("RBAC_DENIED");
				expect(bytes).toMatch(/orgSlug\\*"\s*:\s*null/);
				expect(await counts(t, site.tables)).toBe(before);
			});

			test("ANONYMOUS: still raises RBAC_DENIED, writes nothing", async () => {
				const t = createT();
				await seedOrgMapping(t);
				const call = await site.prepare(t);
				const before = await counts(t, site.tables);
				const bytes = await outcome(() => call(t));
				expect(bytes).toContain("RBAC_DENIED");
				expect(await counts(t, site.tables)).toBe(before);
			});

			test("MEMBER: a legitimate org member is served (not refused as no-org)", async () => {
				const t = createT();
				await seedOrgMapping(t);
				const call = await site.prepare(t);
				const bytes = await outcome(() => call(asMember(t)));
				expect(bytes).not.toMatch(/orgSlug\\*"\s*:\s*null/);
				if (site.memberSucceeds) expect(bytes).toBe("SUCCESS");
			});
		});
	}
});
