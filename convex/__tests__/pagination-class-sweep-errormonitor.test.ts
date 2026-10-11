/// <reference types="vite/client" />
//
// pagination-class-sweep-errormonitor.test.ts — TDD-RED for mission k574p02m
// lot 2. CLASS: `createdBefore` applied AFTER an unbounded `.take(limit)`.
// convex/errorMonitor.ts:517-535 `listErrors`.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";


// ─────────────────────────────────────────────────────────────────────────────
// FLEET_IDENTITY — task k173wwv743mkvrn4qr7ap0qrps8f6d6k.
//
// The read(s) this suite drives were measured against LIVE production at commit
// bd8c60e9 serving real rows to a caller presenting NO CREDENTIAL AT ALL, and are
// now refused for any caller that is not the verified fleet master (these tables
// carry no orgId column) or, where the rows name an orchestrator, any caller
// outside its own roster. This suite asserts PAGINATION/ENVELOPE behaviour, not
// authorisation: nothing it checks has changed, so it now presents the identity
// its subject is actually for — the MCP server's own Clerk service-account
// subject, which withOrgScope resolves to master by id
// (CLERK_SERVICE_ACCOUNT_USER_ID, set in vitest.config.ts).
//
// This is NOT a weakened assertion: the DENY poles for these same reads — an
// anonymous caller, a signed-in caller with no organisation, and an ORDINARY
// member of an active organisation — are pinned in
// convex/__tests__/publicRegistrationResolvesCaller.test.ts, where deleting any
// guard turns them red.
// ─────────────────────────────────────────────────────────────────────────────
const FLEET_IDENTITY = { subject: "test-service-account-user-id" };

type ListErrorsRow = FunctionReturnType<typeof api.errorMonitor.listErrors>[number];

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("errorMonitor.listErrors pagination — createdBefore applied after unbounded take", () => {
	test("RED/GREEN: paginating to the end must return every seeded error hash", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 12;
		const PAGE_LIMIT = 5;
		const seededHashes: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const hash = `sweep-hash-${i}`;
			seededHashes.push(hash);
			await t.mutation(internal.errorMonitor.upsertError, {
				hash,
				deployment: "sweep-deploy",
				functionName: "handler",
				errorMessage: "boom",
				githubRepo: "org/repo",
				orchestrator: "sigma",
			});
		}

		const collected: { hash: string; _creationTime: number }[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		while (pages < 10) {
			pages++;
			const page: ListErrorsRow[] = await t.withIdentity(FLEET_IDENTITY as Parameters<typeof t.withIdentity>[0]).query(api.errorMonitor.listErrors, {
				limit: PAGE_LIMIT,
				createdBefore,
			});
			const relevant = page.filter((r) => seededHashes.includes(r.hash));
			collected.push(
				...relevant.map((r) => ({ hash: r.hash, _creationTime: r._creationTime })),
			);
			if (page.length < PAGE_LIMIT || page.length === 0) break;
			createdBefore = page[page.length - 1]._creationTime;
		}

		const collectedHashes = new Set(collected.map((r) => r.hash));
		const missing = seededHashes.filter((h) => !collectedHashes.has(h));
		expect(missing).toEqual([]);
		expect(collectedHashes.size).toBe(TOTAL);
	});
});
