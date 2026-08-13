/// <reference types="vite/client" />
//
// pagination-class-sweep-messages.test.ts — TDD-RED for mission k574p02m
// lot 2. CLASS: `createdBefore` applied AFTER an unbounded `.take(limit)`.
// convex/messages.ts:626-719 `listMessages` (master/no-identity path).
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

type ListMessagesRow = FunctionReturnType<typeof api.messages.listMessages>[number];

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("messages.listMessages pagination — createdBefore applied after unbounded take", () => {
	test("RED/GREEN: paginating to the end must return every seeded message", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 12;
		const PAGE_LIMIT = 5;

		// listMessages calls withOrgScope(ctx) fail-closed (no
		// allowNoIdentityMaster) — an anonymous caller is RBAC_DENIED. Use the
		// service-account identity (vitest.config.ts sets
		// CLERK_SERVICE_ACCOUNT_USER_ID="test-service-account-user-id",
		// convex/lib/auth.ts:111-121 carve-out), mirroring
		// broadcast-org-scoped.test.ts.
		const tInternal = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		// A known recipient role so the channel resolves without a bounce.
		await t.mutation(api.profiles.upsertProfile, {
			orchestratorId: "sweep-listener",
			instanceId: "sweep-listener-vps",
			name: "Sweep Listener",
			static: { role: "test", workspace: "test-ws", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 0 },
		});

		const seededIds: string[] = [];
		for (let i = 0; i < TOTAL; i++) {
			const id: string = await t.mutation(api.messages.sendMessage, {
				from: "sweep-sender",
				channel: "sweep-listener",
				content: `sweep message ${i}`,
			});
			seededIds.push(id);
		}

		const collected: { _id: string; _creationTime: number }[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		while (pages < 10) {
			pages++;
			const page: ListMessagesRow[] = await tInternal.query(api.messages.listMessages, {
				from: "sweep-sender",
				limit: PAGE_LIMIT,
				createdBefore,
			});
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
