/// <reference types="vite/client" />
import { convexTest } from "../tests/fixtures/convexTestWithServiceAccount";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Exclude RAG/search/backfill modules — same exclusion as tests.test.ts
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function createT() {
	return convexTest(schema, modules);
}

// This suite exercises the LEGITIMATE (master/service-account) path — the
// fleet's own recognized carve-out (convex/lib/auth.ts's
// CLERK_SERVICE_ACCOUNT_USER_ID allowlist, set in vitest.config.ts as
// "test-service-account-user-id"), never the anonymous default. The
// cross-tenant / anonymous-refusal poles live in
// convex/__tests__/resourceIdOrgScopeRead.test.ts. The three write doors
// (createSession / touchSession / revokeSession) were removed (no caller in any
// repo of the organisation); rows are seeded straight into the table.
//
// Every `getSession` read below goes through `tMaster` rather than the bare `t`:
// `getSession` derives authority from the target row's own tenant (RESOURCE-ID
// class), so an anonymous read returns null and a `toBeNull()` case would pass
// for the WRONG reason.
function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

const NOW = 1_748_390_400_000; // 2026-05-28T00:00:00.000Z (deterministic)
const ONE_HOUR = 60 * 60 * 1000;


type Seed = {
	sessionId: string;
	expiresAt: number;
	tenantId?: string;
	userId?: string;
	revoked?: boolean;
};

async function seedSession(t: ReturnType<typeof createT>, row: Seed) {
	await t.run(async (ctx) => {
		await ctx.db.insert("iframeEmbedSessions", {
			sessionId: row.sessionId,
			origin: "https://app.example.com",
			...(row.tenantId !== undefined ? { tenantId: row.tenantId } : {}),
			...(row.userId !== undefined ? { userId: row.userId } : {}),
			createdAt: NOW,
			lastSeenAt: NOW,
			expiresAt: row.expiresAt,
			revoked: row.revoked ?? false,
		});
	});
}

describe("iframeEmbedSessions: getSession (master caller)", () => {
	test("returns a stored session", async () => {
		const t = createT();
		vi.setSystemTime(NOW);
		await seedSession(t, { sessionId: "sess-001", expiresAt: NOW + ONE_HOUR });
		const session = await asMaster(t).query(api.iframeEmbedSessions.getSession, {
			sessionId: "sess-001",
		});
		expect(session?.sessionId).toBe("sess-001");
		expect(session?.origin).toBe("https://app.example.com");
		expect(session?.revoked).toBe(false);
		expect(session?.createdAt).toBe(NOW);
	});

	test("returns the optional tenantId and userId", async () => {
		const t = createT();
		vi.setSystemTime(NOW);
		await seedSession(t, {
			sessionId: "sess-002",
			tenantId: "acme-hr",
			userId: "user-42",
			expiresAt: NOW + ONE_HOUR,
		});
		const session = await asMaster(t).query(api.iframeEmbedSessions.getSession, {
			sessionId: "sess-002",
		});
		expect(session?.tenantId).toBe("acme-hr");
		expect(session?.userId).toBe("user-42");
	});

	test("returns null for unknown sessionId", async () => {
		const t = createT();
		const session = await asMaster(t).query(api.iframeEmbedSessions.getSession, {
			sessionId: "nonexistent",
		});
		expect(session).toBeNull();
	});

	test("returns null for an expired session", async () => {
		const t = createT();
		vi.setSystemTime(NOW);
		await seedSession(t, { sessionId: "sess-expired", expiresAt: NOW - 1 });
		const session = await asMaster(t).query(api.iframeEmbedSessions.getSession, {
			sessionId: "sess-expired",
		});
		expect(session).toBeNull();
	});

	test("returns null for a revoked session", async () => {
		const t = createT();
		vi.setSystemTime(NOW);
		await seedSession(t, {
			sessionId: "sess-revoked",
			expiresAt: NOW + ONE_HOUR,
			revoked: true,
		});
		const session = await asMaster(t).query(api.iframeEmbedSessions.getSession, {
			sessionId: "sess-revoked",
		});
		expect(session).toBeNull();
	});
});
