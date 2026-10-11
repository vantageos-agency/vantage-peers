/// <reference types="vite/client" />
//
// T1/T2 — mission kb-upload-url-endpoint-v1 (k571vk3cc265w8777g3z54vnd989w8k1).
//
// Bug (Day 123, plan analysis/day123-kb-upload-url-plan.md): originally there
// was NO `generateUploadUrl` mutation anywhere — no client had a way to
// obtain a storageId to feed into storeDocumentChunked.
//
// T2 GREEN wiring note: generateUploadUrl is a public MUTATION and must live
// in convex/kbMutations.ts (V8 runtime) — Convex rejects public mutations
// defined in a "use node" file at deploy time (InvalidModules), even via
// re-export from convex/kb.ts. This test therefore imports directly from
// ../kbMutations, not ../kb.
//
// Constraint (plan §4): convex-test does NOT implement
// ctx.storage.generateUploadUrl (absent from node_modules/convex-test/dist),
// so this test drives the handler directly via a hand-rolled fake
// MutationCtx shim (mirrors convex/credentials.test.ts:89-112), NOT via
// t.mutation.
//
// Orchestrator: Sigma — VantagePeers | 2026-07-04

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { seedServiceAccount } from "../../tests/fixtures/seedServiceAccount";
import schema from "../schema";
// biome-ignore lint/suspicious/noExplicitAny: intentional — export does not
// exist yet on current code; this is the RED signal for T1.
import * as kbMutations from "../kbMutations";

// ─────────────────────────────────────────────────────────────────────────────
// Fake MutationCtx shim — storage.generateUploadUrl stubbed (mirrors
// credentials.test.ts makeCtx pattern; convex-test cannot drive real storage).
// ─────────────────────────────────────────────────────────────────────────────

const STUB_URL = "https://fake-storage.convex.cloud/upload/abc123";

// generateUploadUrl now derives authority from withOrgScope
// (convex/lib/auth.ts), which calls `ctx.auth.getUserIdentity()` — this shim
// resolves to the stored fleet service account (an agents row the operator
// org's mapping names, seeded by `seedServiceAccount`; module M2 part 2) so the
// pre-existing assertOrgArgs behaviour this suite pins stays reachable. The
// database is a real convex-test one: the service account is decided from
// stored rows. Cross-tenant / anonymous-refusal poles
// live in convex/__tests__/kbMutationsWriteScope.test.ts (driven via real
// t.mutation, not this handler shim).
const SERVICE_SUBJECT = "test-service-account-user-id";

async function withFakeCtx(
	body: (ctx: Parameters<typeof invokeHandler>[0]) => Promise<void>,
): Promise<void> {
	const t = convexTest(schema, import.meta.glob("../_generated/*.ts"));
	await seedServiceAccount(t, SERVICE_SUBJECT);
	await t.run(async (dbCtx) => {
		const ctx = {
			db: dbCtx.db,
			auth: {
				getUserIdentity: async () => ({ subject: SERVICE_SUBJECT }),
			},
			storage: {
				getUrl: async () => null,
				generateUploadUrl: async () => STUB_URL,
				delete: async () => undefined,
			},
		} as unknown as Parameters<typeof invokeHandler>[0];
		await body(ctx);
	});
}

/**
 * Invokes the handler of a Convex function definition object the same way
 * convex's own mutationGeneric wrapper exposes it internally: the object
 * returned by `mutation({ args, returns, handler })` carries the raw handler
 * on `._handler` (see node_modules/convex/dist/cjs/server/impl/registration_impl.js).
 * There is no public `.handler` property — corrected during T2 GREEN wiring.
 */
// biome-ignore lint/suspicious/noExplicitAny: test invocation of not-yet-existing export
function invokeHandler(ctx: any, args: { orgId: string; namespace: string }) {
	// biome-ignore lint/suspicious/noExplicitAny: kbMutations.generateUploadUrl access via _handler
	const fn = (kbMutations as any).generateUploadUrl;
	if (typeof fn?._handler !== "function") {
		throw new TypeError(
			"generateUploadUrl is not exported (or has no ._handler) from convex/kbMutations.ts.",
		);
	}
	return fn._handler(ctx, args);
}

describe("kbMutations.generateUploadUrl", () => {
	test("valid org: returns the stubbed non-empty upload URL", async () => {
		await withFakeCtx(async (ctx) => {
			const url = await invokeHandler(ctx, {
				orgId: "org_test123",
				namespace: "team/org_test123",
			});
			expect(typeof url).toBe("string");
			expect((url as string).length).toBeGreaterThan(0);
			expect(url).toBe(STUB_URL);
		});
	});

	test("no-org reject: empty orgId throws AUTH_NO_ORG_ID", async () => {
		await withFakeCtx(async (ctx) => {
			await expect(
				invokeHandler(ctx, { orgId: "", namespace: "team/org_test123" }),
			).rejects.toThrow(/AUTH_NO_ORG_ID/);
		});
	});

	test("bad namespace: namespace not starting with team/ throws", async () => {
		await withFakeCtx(async (ctx) => {
			await expect(
				invokeHandler(ctx, { orgId: "org_test123", namespace: "global" }),
			).rejects.toThrow(/AUTH_NO_ORG_ID/);
		});
	});
});
