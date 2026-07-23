/// <reference types="vite/client" />
import { convexTest } from "convex-test";
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

const NOW = 1_748_390_400_000; // 2026-05-28T00:00:00.000Z (deterministic)
const ONE_HOUR = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// createSession + getSession
// ─────────────────────────────────────────────────────────────────────────────

describe("iframeEmbedSessions: createSession + getSession", () => {
	test("createSession stores a new session and getSession returns it", async () => {
		const t = createT();
		vi.setSystemTime(NOW);

		await t.mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "sess-001",
			origin: "https://app.example.com",
			expiresAt: NOW + ONE_HOUR,
		});

		const session = await t.query(api.iframeEmbedSessions.getSession, {
			sessionId: "sess-001",
		});

		expect(session).not.toBeNull();
		expect(session?.sessionId).toBe("sess-001");
		expect(session?.origin).toBe("https://app.example.com");
		expect(session?.revoked).toBe(false);
		expect(session?.createdAt).toBe(NOW);
		expect(session?.lastSeenAt).toBe(NOW);
	});

	test("createSession stores optional tenantId and userId", async () => {
		const t = createT();
		vi.setSystemTime(NOW);

		await t.mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "sess-002",
			origin: "https://acme-hr.vantagepeers.com",
			tenantId: "acme-hr",
			userId: "user-42",
			expiresAt: NOW + ONE_HOUR,
		});

		const session = await t.query(api.iframeEmbedSessions.getSession, {
			sessionId: "sess-002",
		});

		expect(session?.tenantId).toBe("acme-hr");
		expect(session?.userId).toBe("user-42");
	});

	test("getSession returns null for unknown sessionId", async () => {
		const t = createT();
		const session = await t.query(api.iframeEmbedSessions.getSession, {
			sessionId: "nonexistent",
		});
		expect(session).toBeNull();
	});

	test("getSession returns null for expired session", async () => {
		const t = createT();
		vi.setSystemTime(NOW);

		await t.mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "sess-expired",
			origin: "https://app.example.com",
			expiresAt: NOW - 1, // already expired
		});

		const session = await t.query(api.iframeEmbedSessions.getSession, {
			sessionId: "sess-expired",
		});
		expect(session).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// touchSession
// ─────────────────────────────────────────────────────────────────────────────

describe("iframeEmbedSessions: touchSession", () => {
	test("touchSession updates lastSeenAt and returns true", async () => {
		const t = createT();
		vi.setSystemTime(NOW);

		await t.mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "sess-touch",
			origin: "https://app.example.com",
			expiresAt: NOW + ONE_HOUR,
		});

		const LATER = NOW + 5 * 60 * 1000; // +5 min
		vi.setSystemTime(LATER);

		const result = await t.mutation(api.iframeEmbedSessions.touchSession, {
			sessionId: "sess-touch",
		});
		expect(result).toBe(true);

		const session = await t.query(api.iframeEmbedSessions.getSession, {
			sessionId: "sess-touch",
		});
		expect(session?.lastSeenAt).toBe(LATER);
	});

	test("touchSession returns false for unknown sessionId", async () => {
		const t = createT();
		const result = await t.mutation(api.iframeEmbedSessions.touchSession, {
			sessionId: "nonexistent",
		});
		expect(result).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// revokeSession
// ─────────────────────────────────────────────────────────────────────────────

describe("iframeEmbedSessions: revokeSession", () => {
	test("revokeSession marks session as revoked and getSession returns null", async () => {
		const t = createT();
		vi.setSystemTime(NOW);

		await t.mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "sess-revoke",
			origin: "https://app.example.com",
			expiresAt: NOW + ONE_HOUR,
		});

		const revoked = await t.mutation(api.iframeEmbedSessions.revokeSession, {
			sessionId: "sess-revoke",
		});
		expect(revoked).toBe(true);

		// getSession must return null for revoked sessions
		const session = await t.query(api.iframeEmbedSessions.getSession, {
			sessionId: "sess-revoke",
		});
		expect(session).toBeNull();
	});

	test("revokeSession returns false for unknown sessionId", async () => {
		const t = createT();
		const result = await t.mutation(api.iframeEmbedSessions.revokeSession, {
			sessionId: "nonexistent",
		});
		expect(result).toBe(false);
	});
});
