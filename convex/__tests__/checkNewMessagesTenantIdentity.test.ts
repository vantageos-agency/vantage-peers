/// <reference types="vite/client" />
//
// Task: sigma/read-half-tenant-identity — the READ half of the tenant-
// isolation defect (T1 fixed the WRITE half, see
// sendMessageTenantDerivation.test.ts).
//
// DEFECT: checkNewMessages / checkNewMessagesEnvelope take `tenantId` as an
// OPTIONAL CALLER ARGUMENT and trust it verbatim:
//   - omitting it returns ALL tenants' messages ("admin/legacy access, not a
//     bypass" per the stale comment this task also corrects);
//   - supplying a foreign tenantId returns that foreign tenant's messages.
// The sibling reads (listMessages, listByChannel, searchMessagesByKeyword)
// already derive the effective tenant from `withOrgScope(ctx)` and force
// `.eq("tenantId", scope.orgSlug)` for non-master callers — this task mirrors
// that pattern onto the two checkNewMessages* queries.
//
// FIX: resolve `scope = await withOrgScope(ctx)` and compute the EFFECTIVE
// tenant server-side:
//   - TRUE master (isMaster && orgSlug===null): args.tenantId honored as-is
//     (may be undefined = all tenants) — legacy admin path, now gated on a
//     VERIFIED master identity.
//   - Non-master (orgSlug !== null): effective tenant = scope.orgSlug,
//     DERIVED — args.tenantId is IGNORED for widening.
//   - Anonymous (!isMaster && orgSlug===null): no tenant, no master — return
//     empty results (mirrors the sibling reads' guard).
//
// Identity claim key for a non-master scope: `organizationId` (see
// convex/lib/auth.ts:126-131 — slug-first-id-fallback precedence; camelCase
// `organizationId` resolves the mapping, matching the pattern in
// sendMessageTenantDerivation.test.ts / broadcast-org-scoped.test.ts).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function seedProfile(
	t: ReturnType<typeof createT>,
	orchestratorId: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			name: orchestratorId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
	allowedOrchestrators: string[],
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators,
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function identityFor(
	t: ReturnType<typeof createT>,
	subject: string,
	organizationId: string,
) {
	return t.withIdentity({
		subject,
		organizationId,
	} as Parameters<typeof t.withIdentity>[0]);
}

// Sends a message + receipt directly to `recipient` in tenant `tenantId` via
// the internal write path (bypasses sendMessage's own tenant derivation so
// each test fully controls the seeded tenant, independent of T1's fix).
async function seedMessageForRecipient(
	t: ReturnType<typeof createT>,
	opts: {
		from: string;
		recipient: string;
		content: string;
		tenantId: string | undefined;
	},
) {
	await t.run(async (ctx) => {
		const messageId = await ctx.db.insert("messages", {
			from: opts.from,
			channel: opts.recipient,
			content: opts.content,
			tenantId: opts.tenantId,
			createdAt: Date.now(),
		});
		await ctx.db.insert("messageReceipts", {
			messageId,
			recipient: opts.recipient,
			tenantId: opts.tenantId,
			readAt: undefined,
		});
	});
}

describe("checkNewMessages / checkNewMessagesEnvelope — read-half tenant identity", () => {
	test("POSITIVE CONTROL: a scoped acme caller reads back a message addressed to it in acme", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["noe"]);
		await seedProfile(t, "noe");
		await seedMessageForRecipient(t, {
			from: "victor",
			recipient: "noe",
			content: "acme positive control",
			tenantId: "acme",
		});

		const reader = identityFor(t, "user-acme-noe", "acme");
		const rows = await reader.query(api.messages.checkNewMessages, {
			recipient: "noe",
		});
		expect(rows.some((r) => r.content === "acme positive control")).toBe(
			true,
		);

		const envelope = await reader.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "noe",
		});
		expect(
			envelope.messages.some((r) => r.content === "acme positive control"),
		).toBe(true);
	});

	test("RED 1 (omit widening): scoped acme caller omitting tenantId sees ONLY acme's message, not beta's — checkNewMessages", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["noe"]);
		await seedOrgMapping(t, "project/beta", ["noe"]);
		await seedProfile(t, "noe");
		await seedMessageForRecipient(t, {
			from: "victor",
			recipient: "noe",
			content: "acme mail",
			tenantId: "acme",
		});
		await seedMessageForRecipient(t, {
			from: "marie",
			recipient: "noe",
			content: "beta mail",
			tenantId: "project/beta",
		});

		const reader = identityFor(t, "user-acme-noe", "acme");
		const rows = await reader.query(api.messages.checkNewMessages, {
			recipient: "noe",
		});
		expect(rows.some((r) => r.content === "acme mail")).toBe(true);
		expect(rows.some((r) => r.content === "beta mail")).toBe(false);
	});

	test("RED 1 (omit widening): scoped acme caller omitting tenantId sees ONLY acme's message, not beta's — checkNewMessagesEnvelope", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["noe"]);
		await seedOrgMapping(t, "project/beta", ["noe"]);
		await seedProfile(t, "noe");
		await seedMessageForRecipient(t, {
			from: "victor",
			recipient: "noe",
			content: "acme mail env",
			tenantId: "acme",
		});
		await seedMessageForRecipient(t, {
			from: "marie",
			recipient: "noe",
			content: "beta mail env",
			tenantId: "project/beta",
		});

		const reader = identityFor(t, "user-acme-noe", "acme");
		const envelope = await reader.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "noe",
		});
		expect(envelope.messages.some((r) => r.content === "acme mail env")).toBe(
			true,
		);
		expect(
			envelope.messages.some((r) => r.content === "beta mail env"),
		).toBe(false);
	});

	test("RED 2 (ask widening): scoped acme caller passing tenantId=project/beta does NOT receive beta's message — checkNewMessages", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["noe"]);
		await seedOrgMapping(t, "project/beta", ["noe"]);
		await seedProfile(t, "noe");
		await seedMessageForRecipient(t, {
			from: "marie",
			recipient: "noe",
			content: "beta only mail",
			tenantId: "project/beta",
		});

		const reader = identityFor(t, "user-acme-noe", "acme");
		const rows = await reader.query(api.messages.checkNewMessages, {
			recipient: "noe",
			tenantId: "project/beta",
		});
		expect(rows.some((r) => r.content === "beta only mail")).toBe(false);
	});

	test("RED 2 (ask widening): scoped acme caller passing tenantId=project/beta does NOT receive beta's message — checkNewMessagesEnvelope", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["noe"]);
		await seedOrgMapping(t, "project/beta", ["noe"]);
		await seedProfile(t, "noe");
		await seedMessageForRecipient(t, {
			from: "marie",
			recipient: "noe",
			content: "beta only mail env",
			tenantId: "project/beta",
		});

		const reader = identityFor(t, "user-acme-noe", "acme");
		const envelope = await reader.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "noe",
			tenantId: "project/beta",
		});
		expect(
			envelope.messages.some((r) => r.content === "beta only mail env"),
		).toBe(false);
	});

	test("MUST-PASS: TRUE master identity with no tenantId still sees ALL tenants — checkNewMessages + checkNewMessagesEnvelope", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["noe"]);
		await seedOrgMapping(t, "project/beta", ["noe"]);
		await seedProfile(t, "noe");
		await seedMessageForRecipient(t, {
			from: "victor",
			recipient: "noe",
			content: "acme mail master",
			tenantId: "acme",
		});
		await seedMessageForRecipient(t, {
			from: "marie",
			recipient: "noe",
			content: "beta mail master",
			tenantId: "project/beta",
		});

		// Service-account identity — resolves to master via the
		// CLERK_SERVICE_ACCOUNT_USER_ID carve-out (convex/lib/auth.ts:141-160).
		// vitest.config.ts sets CLERK_SERVICE_ACCOUNT_USER_ID to this subject.
		const master = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		const rows = await master.query(api.messages.checkNewMessages, {
			recipient: "noe",
		});
		expect(rows.some((r) => r.content === "acme mail master")).toBe(true);
		expect(rows.some((r) => r.content === "beta mail master")).toBe(true);

		const envelope = await master.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "noe",
		});
		expect(
			envelope.messages.some((r) => r.content === "acme mail master"),
		).toBe(true);
		expect(
			envelope.messages.some((r) => r.content === "beta mail master"),
		).toBe(true);
	});

	test("MUST-PASS: TRUE master identity WITH a tenantId scopes to that tenant only", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["noe"]);
		await seedOrgMapping(t, "project/beta", ["noe"]);
		await seedProfile(t, "noe");
		await seedMessageForRecipient(t, {
			from: "victor",
			recipient: "noe",
			content: "acme mail master scoped",
			tenantId: "acme",
		});
		await seedMessageForRecipient(t, {
			from: "marie",
			recipient: "noe",
			content: "beta mail master scoped",
			tenantId: "project/beta",
		});

		const master = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		const rows = await master.query(api.messages.checkNewMessages, {
			recipient: "noe",
			tenantId: "acme",
		});
		expect(rows.some((r) => r.content === "acme mail master scoped")).toBe(
			true,
		);
		expect(rows.some((r) => r.content === "beta mail master scoped")).toBe(
			false,
		);
	});

	test("Anonymous caller (no identity) gets empty results, never all tenants", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["noe"]);
		await seedProfile(t, "noe");
		await seedMessageForRecipient(t, {
			from: "victor",
			recipient: "noe",
			content: "acme mail anon",
			tenantId: "acme",
		});

		// No withIdentity() at all — anonymous. withOrgScope(ctx) with no
		// allowNoIdentityMaster resolves isMaster=false, orgSlug=null.
		const rows = await t.query(api.messages.checkNewMessages, {
			recipient: "noe",
		});
		expect(rows).toEqual([]);

		const envelope = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "noe",
		});
		expect(envelope.messages).toEqual([]);
	});
});
