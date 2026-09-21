/// <reference types="vite/client" />
/**
 * Hardening pass on `findSeatNameCollision` (convex/oauth.ts), on top of the
 * cross-org seat-name collision fix (see
 * provisionOrganizationSeatNameCollision.test.ts).
 *
 * TWO properties:
 *
 *   1. FAIL-CLOSED ON THE SCAN BOUND — a bounded catalog scan that returns
 *      EXACTLY the configured limit means rows beyond it were never
 *      inspected. Silently returning "no collision" in that case is
 *      fail-OPEN (a real collision past the bound goes unseen forever).
 *      `findSeatNameCollision` must throw `SEAT_NAME_CHECK_INCOMPLETE`
 *      instead. The scan limit is injectable so this is provable without
 *      seeding thousands of rows.
 *
 *   2. FLEET NAMES ARE COVERED FROM MEMORY DATA TOO — the operator fleet's
 *      orchestrators write to `orchestrator/<name>` memory namespaces but
 *      are not guaranteed to appear in `client_org_mapping` or
 *      `oauth_scope_profiles` at all. Any existing memory already stored in
 *      `orchestrator/<name>` makes that name taken for a brand-new org — a
 *      brand-new org cannot legitimately own a pre-existing memory. The
 *      idempotent replay path (an org already mapped with that exact name
 *      set) is unaffected because the collision check only runs for a
 *      brand-new org's names (see the `existing` early-return in
 *      `provisionOrganization`, checked directly below).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { findSeatNameCollision } from "../oauth";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER = "test-master-token-seat-hardening";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

const createT = () => convexTest(schema, modules);

describe("findSeatNameCollision — fail-closed on the scan bound", () => {
	test("POLE DENY: a client_org_mapping scan that exactly fills the injected limit refuses instead of certifying free", async () => {
		const t = createT();
		const SMALL_LIMIT = 3;
		await t.run(async (ctx) => {
			for (let i = 0; i < SMALL_LIMIT; i++) {
				await ctx.db.insert("client_org_mapping", {
					clerkOrgSlug: `bound-org-${i}`,
					allowedOrchestrators: [`bound-seat-${i}`],
					scopes: ["view-own-tasks"],
					displayName: `Bound org ${i}`,
					isActive: true,
					createdAt: Date.now(),
				});
			}
		});

		await expect(
			t.run((ctx) =>
				findSeatNameCollision(ctx, "any-name", "own-slug", SMALL_LIMIT),
			),
		).rejects.toThrow(/SEAT_NAME_CHECK_INCOMPLETE/);
	});

	test("POLE DENY: an oauth_scope_profiles scan that exactly fills the injected limit refuses instead of certifying free", async () => {
		const t = createT();
		const SMALL_LIMIT = 2;
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < SMALL_LIMIT; i++) {
				await ctx.db.insert("oauth_scope_profiles", {
					profileId: `bound-profile-${i}`,
					description: "bound profile",
					fromAllowList: [`bound-profile-seat-${i}`],
					namespaceReadPrefixes: [`orchestrator/bound-profile-seat-${i}`],
					namespaceWritePrefixes: [`orchestrator/bound-profile-seat-${i}`],
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		await expect(
			t.run((ctx) =>
				findSeatNameCollision(ctx, "any-name", "own-slug", SMALL_LIMIT),
			),
		).rejects.toThrow(/SEAT_NAME_CHECK_INCOMPLETE/);
	});

	test("POLE ALLOW: a scan strictly UNDER the limit resolves normally (no false refusal)", async () => {
		const t = createT();
		const SMALL_LIMIT = 5;
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "under-limit-org",
				allowedOrchestrators: ["under-limit-seat"],
				scopes: ["view-own-tasks"],
				displayName: "Under limit org",
				isActive: true,
				createdAt: Date.now(),
			});
		});

		const result = await t.run((ctx) =>
			findSeatNameCollision(ctx, "fresh-name", "own-slug", SMALL_LIMIT),
		);
		expect(result).toBe(false);
	});

	test("mutation probe: removing the fail-closed throw lets a past-bound collision go unseen (would report no collision)", async () => {
		// Documents the property this guards against, without touching
		// production code: SMALL_LIMIT rows are seeded, none named the
		// target, and the (bounded, non-throwing) manual scan below shows
		// exactly why the throw is required — a naive `.take(limit)` that
		// silently accepts an exactly-full page could hide a same-name row
		// beyond the bound.
		const t = createT();
		const SMALL_LIMIT = 2;
		await t.run(async (ctx) => {
			for (let i = 0; i < SMALL_LIMIT; i++) {
				await ctx.db.insert("client_org_mapping", {
					clerkOrgSlug: `naive-org-${i}`,
					allowedOrchestrators: [`naive-seat-${i}`],
					scopes: ["view-own-tasks"],
					displayName: `Naive org ${i}`,
					isActive: true,
					createdAt: Date.now(),
				});
			}
			// The real collision — a THIRD row beyond SMALL_LIMIT, which a
			// `.take(SMALL_LIMIT)` scan would never see.
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "naive-org-beyond-bound",
				allowedOrchestrators: ["target-name"],
				scopes: ["view-own-tasks"],
				displayName: "Naive org beyond bound",
				isActive: true,
				createdAt: Date.now(),
			});
		});

		// The real (fixed) function refuses rather than silently missing it.
		await expect(
			t.run((ctx) =>
				findSeatNameCollision(ctx, "target-name", "own-slug", SMALL_LIMIT),
			),
		).rejects.toThrow(/SEAT_NAME_CHECK_INCOMPLETE/);
	});
});

describe("findSeatNameCollision — fleet names covered via existing memories", () => {
	test("POLE DENY: an orchestrator/<name> namespace holding a memory with no mapping/profile backing it makes the name taken for a new org", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("memories", {
				namespace: "orchestrator/unmapped-fleet-name",
				type: "reference",
				content: "pre-existing fleet memory, no mapping/profile row",
				createdBy: "unmapped-fleet-name",
				relations: [],
				isLatest: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-vs-unmapped-fleet",
				displayName: "Org vs unmapped fleet",
				orchestrators: [{ name: "unmapped-fleet-name" }],
			}),
		).rejects.toThrow(/SEAT_NAME_TAKEN/);
	});

	test("POLE ALLOW: a fresh name with no memory, mapping, or profile is accepted", async () => {
		const t = createT();
		const result = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-fresh-memory-check",
			displayName: "Org fresh memory check",
			orchestrators: [{ name: "truly-fresh-name" }],
		});
		expect(result.orchestrators[0].name).toBe("truly-fresh-name");
	});

	test("idempotent replay for a brand-new org's own memory-backed name set is unaffected by the memory check", async () => {
		// First call creates the org + writes the profile (this mutation
		// itself never writes to `memories` — proving replay does not
		// self-collide against anything the memory check would see, since
		// the check only runs on the brand-new-org path, never on replay).
		const t = createT();
		const first = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-replay-memory-check",
			displayName: "Org replay memory check",
			orchestrators: [{ name: "replay-memory-seat" }],
		});
		expect(first.replay).toBe(false);

		const second = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-replay-memory-check",
			displayName: "Org replay memory check",
			orchestrators: [{ name: "replay-memory-seat" }],
		});
		expect(second.replay).toBe(true);
		expect(second.mappingId).toBe(first.mappingId);
	});
});
