/// <reference types="vite/client" />
//
// pagination-class-sweep-mandates.test.ts — TDD-RED for mission k574p02m
// lot 2. CLASS: `createdBefore` applied AFTER an unbounded `.take(limit)`.
// convex/mandates.ts:181-259 `list`.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
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

// The fleet master is served the bare-array arm; the refusal envelope
// (`{ refused: true, items: [] }`) is what an ORDINARY member gets, so it is
// excluded here and a master that received it fails the read below.
type ListMandatesRow = Extract<
	FunctionReturnType<typeof api.mandates.list>,
	unknown[]
>[number];

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("mandates.list pagination — createdBefore applied after unbounded take", () => {
	test("RED/GREEN: paginating to the end must return every seeded mandate", async () => {
		const t = convexTest(schema, modules);
		// mandates.create now requires the verified fleet master
		// (convex/lib/auth.ts's withOrgScope isMaster grant — see
		// convex/__tests__/mandatesWriteScope.test.ts).
		const tMaster = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);
		const TOTAL = 12;
		const PAGE_LIMIT = 5;
		const seededIds: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const id: string = await tMaster.mutation(api.mandates.create, {
				requestedBy: "sigma",
				fulfilledBy: "eta",
				service: `sweep-service-${i}`,
				budget: 100,
			});
			seededIds.push(id);
		}

		const collected: { _id: string; _creationTime: number }[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		while (pages < 10) {
			pages++;
			const result = await t.withIdentity(FLEET_IDENTITY as Parameters<typeof t.withIdentity>[0]).query(api.mandates.list, {
				requestedBy: "sigma",
				limit: PAGE_LIMIT,
				createdBefore,
			});
			if (!Array.isArray(result)) throw new Error("fleet master was refused");
			const page: ListMandatesRow[] = result;
			collected.push(
				...page.map((r) => ({ _id: r._id, _creationTime: r._creationTime })),
			);
			if (page.length < PAGE_LIMIT || page.length === 0) break;
			createdBefore = page[page.length - 1]._creationTime;
		}

		const collectedIds = new Set(collected.map((r) => r._id));
		const missing = seededIds.filter((id) => !collectedIds.has(id));
		expect(missing).toEqual([]);
		expect(collectedIds.size).toBe(TOTAL);
	});
});
