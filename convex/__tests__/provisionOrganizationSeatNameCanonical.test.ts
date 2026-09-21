/// <reference types="vite/client" />
/**
 * Seat-name normalization — the collision check used to compare names
 * EXACTLY, but every MCP identity gate downstream (`isInAllowList`,
 * `listTasksGate`, and everything built on
 * `convex/_helpers/normalizeOrchestratorId.ts`) normalizes (NFC + lowercase
 * + trim) before comparing. With a fleet memory at `orchestrator/sigma`:
 *   - "sigma" was refused, but "SIGMA" / "Sigma" were still provisioned;
 *   - a cross-org "ALPHA" was provisioned right after "alpha";
 *   - `isInAllowList(["SIGMA"], "sigma")` is `true` — an org-admin who
 *     provisions "SIGMA" can list sigma's tasks and read its inbox, the
 *     exact reach the collision check exists to close.
 *
 * THE FIX, both parts:
 *   1. `provisionOrganization` refuses to WRITE a non-canonical seat name at
 *      all (`SEAT_NAME_NOT_CANONICAL`), so every STORED name is always
 *      already its own canonical form.
 *   2. `findSeatNameCollision` normalizes EVERY comparison — both sides —
 *      so a LEGACY non-canonical row (written before the refusal existed,
 *      or by a path outside `provisionOrganization`) still blocks a new
 *      canonical name that collides with it under normalization.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

const MASTER = "test-master-token-seat-canonical";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

const createT = () => convexTest(schema, modules);

describe("provisionOrganization — canonical seat names", () => {
	test("POLE DENY: 'SIGMA' is refused (non-canonical) even with no collision present", async () => {
		const t = createT();
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-sigma-upper",
				displayName: "Org sigma upper",
				orchestrators: [{ name: "SIGMA" }],
			}),
		).rejects.toThrow(/SEAT_NAME_NOT_CANONICAL/);
	});

	test("POLE DENY: 'Sigma' is refused (non-canonical) with a fleet memory at orchestrator/sigma present", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("memories", {
				namespace: "orchestrator/sigma",
				type: "reference",
				content: "fleet memory",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-sigma-mixed",
				displayName: "Org sigma mixed",
				orchestrators: [{ name: "Sigma" }],
			}),
		).rejects.toThrow(/SEAT_NAME_NOT_CANONICAL/);
	});

	test("POLE DENY: a legacy non-canonical mapping ('Sigma') still blocks a new canonical 'sigma' request", async () => {
		const t = createT();
		// Simulate a row written before the canonical-name refusal existed
		// (or by a path outside provisionOrganization) — a
		// client_org_mapping whose allowedOrchestrators holds a
		// non-canonical name.
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-legacy-sigma",
				allowedOrchestrators: ["Sigma"],
				scopes: ["view-own-tasks"],
				displayName: "Org legacy sigma",
				isActive: true,
				createdAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-new-sigma",
				displayName: "Org new sigma",
				orchestrators: [{ name: "sigma" }],
			}),
		).rejects.toThrow(/SEAT_NAME_TAKEN/);
	});

	test("POLE DENY: a legacy non-canonical oauth_scope_profiles row ('Sigma') still blocks a new canonical 'sigma' request", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "legacy-sigma-profile",
				description: "legacy non-canonical profile",
				fromAllowList: ["Sigma"],
				namespaceReadPrefixes: ["orchestrator/Sigma"],
				namespaceWritePrefixes: ["orchestrator/Sigma"],
				createdAt: now,
				updatedAt: now,
			});
		});

		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-new-sigma-profile",
				displayName: "Org new sigma profile",
				orchestrators: [{ name: "sigma" }],
			}),
		).rejects.toThrow(/SEAT_NAME_TAKEN/);
	});

	test("POLE DENY: cross-org 'ALPHA' is refused right after canonical 'alpha' is provisioned", async () => {
		const t = createT();
		const first = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-alpha-lower",
			displayName: "Org alpha lower",
			orchestrators: [{ name: "alpha" }],
		});
		expect(first.orchestrators[0].name).toBe("alpha");

		// "ALPHA" is refused for TWO independent reasons stacked here — it is
		// non-canonical (refused before the collision check even runs) AND,
		// were it canonical, "alpha" is already taken. The refusal fires on
		// the canonical-form check first; either way, org X never gets in.
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-alpha-upper",
				displayName: "Org alpha upper",
				orchestrators: [{ name: "ALPHA" }],
			}),
		).rejects.toThrow(/SEAT_NAME_NOT_CANONICAL/);
	});

	test("POLE DENY: an NFD-decomposed accented name collides with the NFC form", async () => {
		const t = createT();
		const nfc = "zoë"; // NFC — single composed 'ë' codepoint.
		const nfd = "zoë"; // NFD — 'e' + combining diaeresis (decomposes to the same "zoë").
		expect(nfc.normalize("NFC")).not.toBe(nfd);
		expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));

		const first = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-zoe-nfc",
			displayName: "Org zoe nfc",
			orchestrators: [{ name: nfc }],
		});
		expect(first.orchestrators[0].name).toBe(nfc);

		// The NFD form is itself non-canonical (normalizeOrchestratorId NFC-
		// normalizes), so it is refused at the canonical-form gate — proving
		// the two forms are treated as the SAME identity rather than two
		// distinct, independently-provisionable seats.
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-zoe-nfd",
				displayName: "Org zoe nfd",
				orchestrators: [{ name: nfd }],
			}),
		).rejects.toThrow(/SEAT_NAME_NOT_CANONICAL/);
	});

	test("POLE ALLOW: the canonical name is still accepted (no false refusal)", async () => {
		const t = createT();
		const result = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-canonical-allow",
			displayName: "Org canonical allow",
			orchestrators: [{ name: "canonical-fresh-name" }],
		});
		expect(result.orchestrators[0].name).toBe("canonical-fresh-name");

		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "canonical-fresh-name-org-canonical-allow",
		});
		expect(profile?.fromAllowList).toEqual(["canonical-fresh-name"]);
	});

	test("within-call duplicate check is also normalized ('alpha' + 'Alpha' in one call is a duplicate)", async () => {
		// 'Alpha' is refused first by the canonical-form gate (it runs before
		// the duplicate check), so this pins that ordering rather than
		// reaching the duplicate branch — both refusals protect the same
		// property (no two entries in one call resolve to the same
		// identity), and the canonical-form gate is strictly stronger.
		const t = createT();
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-dup-case",
				displayName: "Org dup case",
				orchestrators: [{ name: "alpha" }, { name: "Alpha" }],
			}),
		).rejects.toThrow(/SEAT_NAME_NOT_CANONICAL/);
	});
});
