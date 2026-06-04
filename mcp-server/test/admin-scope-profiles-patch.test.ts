/**
 * S2.2 D5 admin endpoint tests — PATCH /admin/scope-profiles/:id
 *
 * Wraps the Convex mutation `oauth:patchScopeProfileEmergency` (S1.2-mutation +
 * S2.1 cascade + audit log) in an HTTP route gated by BEARER_SECRET_MASTER.
 *
 * Harness: Hono `app.request()` in-memory (no socket). The bootstrap is
 * guarded by VP_TEST_MODE=1 (vitest.config.ts → test.env).
 *
 * Convex layer: a fake ConvexHttpClient injected via _setInternalClientForTest.
 * The fake implements only `oauth:patchScopeProfileEmergency` and surfaces
 * deterministic error messages so the HTTP layer can map them to status codes.
 *
 * Auth contract (S1.5 D6 parity): Authorization: Bearer <BEARER_SECRET_MASTER>
 * — re-uses the existing masterOnlyMiddleware (constant-time compare via
 * timingSafeEqual is already established at the underlying Convex layer
 * `requireMasterAuth`; the middleware enforces the HTTP-layer 401/403 split).
 *
 * Body schema:
 *   {
 *     rename?: string,
 *     fromAllowList?: string[],
 *     namespaceReadPrefixes?: string[],
 *     namespaceWritePrefixes?: string[],
 *     cascadeRevokeTokens: boolean,   // required (matches Convex signature)
 *     reason: string                   // required, ≥40 chars
 *   }
 *
 * Response (200):
 *   {
 *     patchedProfileId: string,
 *     cascadeRevokedCount: number,
 *     clientsRetargeted: number,
 *     auditLogId: string
 *   }
 *
 * Error mapping:
 *   401 missing/malformed bearer
 *   403 wrong bearer (timing-safe compare at middleware)
 *   400 invalid body / missing required fields / D4 violation / reason <40
 *   404 profile not found
 *   500 internal Convex failure
 */

import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../server-http.js";
import { _setInternalClientForTest } from "../src/auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture state — reset before each test
// ─────────────────────────────────────────────────────────────────────────────

type CapturedMutationCall = {
	name: string;
	args: Record<string, unknown>;
};

const state: {
	mutationCalls: CapturedMutationCall[];
	// scripted behavior of the fake mutation per-test
	mutationImpl: (args: Record<string, unknown>) => Promise<unknown>;
} = {
	mutationCalls: [],
	mutationImpl: async () => ({
		patchedProfileId: "default",
		cascadeRevokedCount: 0,
		clientsRetargeted: 0,
		auditLogId: "audit-default",
	}),
};

function makeFakeConvex() {
	return {
		query: async (name: string) => {
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:patchScopeProfileEmergency") {
				state.mutationCalls.push({ name, args });
				return state.mutationImpl(args);
			}
			throw new Error(`unmocked mutation: ${name}`);
		},
	};
}

const MASTER = "test-master-token"; // matches vitest.config.ts env

beforeEach(() => {
	state.mutationCalls.length = 0;
	state.mutationImpl = async () => ({
		patchedProfileId: "iris-rh",
		cascadeRevokedCount: 0,
		clientsRetargeted: 0,
		auditLogId: "audit-fake-1",
	});
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test fake
		makeFakeConvex() as any,
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const VALID_REASON =
	"emergency remediation: drop global wildcard from tenant scope profile per Day 90";

function reqPatch(
	id: string,
	body: Record<string, unknown> | string | undefined,
	auth: string | undefined,
): Promise<Response> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (auth) headers.Authorization = auth;
	return app.request(`http://localhost/admin/scope-profiles/${id}`, {
		method: "PATCH",
		headers,
		body:
			body === undefined
				? undefined
				: typeof body === "string"
					? body
					: JSON.stringify(body),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /admin/scope-profiles/:id — S2.2 D5", () => {
	// T1 — happy path
	it("T1 200 with valid master Bearer + valid body returns mutation result", async () => {
		state.mutationImpl = async () => ({
			patchedProfileId: "iris-rh",
			cascadeRevokedCount: 3,
			clientsRetargeted: 1,
			auditLogId: "audit-1",
		});
		const res = await reqPatch(
			"marie-iris-rh",
			{
				rename: "iris-rh",
				namespaceReadPrefixes: ["iris/"],
				namespaceWritePrefixes: ["iris/"],
				cascadeRevokeTokens: true,
				reason: VALID_REASON,
			},
			`Bearer ${MASTER}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.patchedProfileId).toBe("iris-rh");
		expect(body.cascadeRevokedCount).toBe(3);
		expect(body.clientsRetargeted).toBe(1);
		expect(body.auditLogId).toBe("audit-1");
	});

	// T2 — missing Authorization header
	it("T2 401 when Authorization header missing", async () => {
		const res = await reqPatch(
			"marie-iris-rh",
			{
				cascadeRevokeTokens: false,
				reason: VALID_REASON,
			},
			undefined,
		);
		expect(res.status).toBe(401);
		expect(state.mutationCalls.length).toBe(0);
	});

	// T3 — non-master Bearer
	it("T3 403 when Bearer is not the master token", async () => {
		const res = await reqPatch(
			"marie-iris-rh",
			{ cascadeRevokeTokens: false, reason: VALID_REASON },
			"Bearer not-the-master-token",
		);
		expect(res.status).toBe(403);
		expect(state.mutationCalls.length).toBe(0);
	});

	// T4 — malformed bearer (length differs) — constant-time compare path
	it("T4 401/403 on malformed bearer (no Bearer prefix)", async () => {
		const res = await reqPatch(
			"marie-iris-rh",
			{ cascadeRevokeTokens: false, reason: VALID_REASON },
			MASTER, // no "Bearer " prefix
		);
		expect(res.status).toBe(401);
		expect(state.mutationCalls.length).toBe(0);
	});

	// T5 — body validation: missing required cascadeRevokeTokens
	it("T5 400 when required field cascadeRevokeTokens is missing", async () => {
		const res = await reqPatch(
			"marie-iris-rh",
			{ reason: VALID_REASON },
			`Bearer ${MASTER}`,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body.error).toBe("string");
		expect(state.mutationCalls.length).toBe(0);
	});

	// T5b — body validation: missing reason
	it("T5b 400 when reason missing", async () => {
		const res = await reqPatch(
			"marie-iris-rh",
			{ cascadeRevokeTokens: false },
			`Bearer ${MASTER}`,
		);
		expect(res.status).toBe(400);
		expect(state.mutationCalls.length).toBe(0);
	});

	// T5c — body validation: reason too short
	it("T5b' 400 when reason < 40 chars (typed error from Convex bubble)", async () => {
		state.mutationImpl = async () => {
			throw new Error(
				"reason must be at least 40 characters for audit trail hygiene",
			);
		};
		const res = await reqPatch(
			"marie-iris-rh",
			{ cascadeRevokeTokens: false, reason: "too short" },
			`Bearer ${MASTER}`,
		);
		expect(res.status).toBe(400);
	});

	// T5d — malformed JSON body
	it("T5d 400 when body is not valid JSON", async () => {
		const res = await reqPatch(
			"marie-iris-rh",
			"{ not json",
			`Bearer ${MASTER}`,
		);
		expect(res.status).toBe(400);
		expect(state.mutationCalls.length).toBe(0);
	});

	// T6 — rename triggers cascade-retarget clients + audit log entry
	it("T6 cascade-update oauth_clients on rename + audit log returned", async () => {
		state.mutationImpl = async (args) => {
			// Verify the mutation was called with rename arg
			expect(args.rename).toBe("iris-rh");
			expect(args.profileId).toBe("marie-iris-rh");
			return {
				patchedProfileId: "iris-rh",
				cascadeRevokedCount: 0,
				clientsRetargeted: 2,
				auditLogId: "audit-rename-1",
			};
		};
		const res = await reqPatch(
			"marie-iris-rh",
			{
				rename: "iris-rh",
				cascadeRevokeTokens: false,
				reason: VALID_REASON,
			},
			`Bearer ${MASTER}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.clientsRetargeted).toBe(2);
		expect(body.auditLogId).toBe("audit-rename-1");
		expect(state.mutationCalls.length).toBe(1);
	});

	// T7 — new scope arrays + cascade revoke tokens returns count
	it("T7 cascade-revoke tokens when cascadeRevokeTokens=true + count returned", async () => {
		state.mutationImpl = async (args) => {
			expect(args.cascadeRevokeTokens).toBe(true);
			expect(args.namespaceReadPrefixes).toEqual(["iris/"]);
			return {
				patchedProfileId: "marie-iris-rh",
				cascadeRevokedCount: 5,
				clientsRetargeted: 0,
				auditLogId: "audit-revoke-1",
			};
		};
		const res = await reqPatch(
			"marie-iris-rh",
			{
				namespaceReadPrefixes: ["iris/"],
				namespaceWritePrefixes: ["iris/"],
				cascadeRevokeTokens: true,
				reason: VALID_REASON,
			},
			`Bearer ${MASTER}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.cascadeRevokedCount).toBe(5);
	});

	// T8 — non-existent profile id maps to 404
	it("T8 404 when profile not found (Convex bubble)", async () => {
		state.mutationImpl = async () => {
			throw new Error("profile not found: ghost-profile");
		};
		const res = await reqPatch(
			"ghost-profile",
			{ cascadeRevokeTokens: false, reason: VALID_REASON },
			`Bearer ${MASTER}`,
		);
		expect(res.status).toBe(404);
	});

	// T9 — D4 violation → 400 typed
	it("T9 400 typed error on D4 violation (global/* in tenant profile)", async () => {
		state.mutationImpl = async () => {
			throw new Error(
				'D4 violation: profile "marie-iris-rh" cannot include "global" in namespace prefixes',
			);
		};
		const res = await reqPatch(
			"marie-iris-rh",
			{
				namespaceReadPrefixes: ["global"],
				cascadeRevokeTokens: false,
				reason: VALID_REASON,
			},
			`Bearer ${MASTER}`,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(String(body.error ?? "")).toMatch(/D4 violation/i);
	});

	// T10 — full response shape contract
	it("T10 response shape: patchedProfileId + cascadeRevokedCount + clientsRetargeted + auditLogId", async () => {
		state.mutationImpl = async () => ({
			patchedProfileId: "iris-rh",
			cascadeRevokedCount: 7,
			clientsRetargeted: 3,
			auditLogId: "audit-shape-1",
		});
		const res = await reqPatch(
			"marie-iris-rh",
			{
				rename: "iris-rh",
				cascadeRevokeTokens: true,
				reason: VALID_REASON,
			},
			`Bearer ${MASTER}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(
			[
				"auditLogId",
				"cascadeRevokedCount",
				"clientsRetargeted",
				"patchedProfileId",
			].sort(),
		);
		expect(typeof body.patchedProfileId).toBe("string");
		expect(typeof body.cascadeRevokedCount).toBe("number");
		expect(typeof body.clientsRetargeted).toBe("number");
		expect(typeof body.auditLogId).toBe("string");
	});
});
