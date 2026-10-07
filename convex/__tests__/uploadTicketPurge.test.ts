/// <reference types="vite/client" />
//
// uploadTickets cleanup: kbMutations:purgeUploadTickets deletes tickets that
// are expired OR used, in bounded batches (take(UPLOAD_TICKET_PURGE_BATCH) per
// index) and re-schedules itself while a batch came back full, so a large
// backlog drains across transactions (backend standard R-31). Registered as an
// hourly cron in convex/crons.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { UPLOAD_TICKET_PURGE_BATCH } from "../kbMutations";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

afterEach(() => {
	vi.useRealTimers();
});

async function seed(
	t: T,
	rows: { label: string; expiresAt: number; usedAt?: number }[],
) {
	await t.run(async (ctx) => {
		for (const r of rows)
			await ctx.db.insert("uploadTickets", {
				ticketHash: r.label,
				orgId: "org-A",
				contentSha256: "0".repeat(64),
				createdAt: r.expiresAt - 15 * 60 * 1000,
				expiresAt: r.expiresAt,
				...(r.usedAt === undefined ? {} : { usedAt: r.usedAt }),
			});
	});
}

const remaining = (t: T) =>
	t.run(async (ctx) =>
		(await ctx.db.query("uploadTickets").collect()).map((r) => r.ticketHash),
	);

describe("purgeUploadTickets — expired or used tickets are deleted in batches", () => {
	test("PRESENT/ABSENT — deletes the expired and the used ticket, keeps the live unused one", async () => {
		const t = createT();
		const now = Date.now();
		await seed(t, [
			{ label: "expired-unused", expiresAt: now - 1 },
			{ label: "used-unexpired", expiresAt: now + 60_000, usedAt: now - 5 },
			{ label: "live-unused", expiresAt: now + 60_000 },
		]);
		await t.mutation(internal.kbMutations.purgeUploadTickets, {});
		expect(await remaining(t)).toEqual(["live-unused"]);
	});

	test("BATCHED — a backlog over one batch is drained by self-scheduling, one bounded batch per transaction", async () => {
		vi.useFakeTimers();
		const t = createT();
		const now = Date.now();
		const extra = 5;
		await seed(
			t,
			Array.from({ length: UPLOAD_TICKET_PURGE_BATCH + extra }, (_, i) => ({
				label: `expired-${i}`,
				expiresAt: now - 1 - i,
			})),
		);

		await t.mutation(internal.kbMutations.purgeUploadTickets, {});
		// one transaction deleted exactly one batch
		expect(await remaining(t)).toHaveLength(extra);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await remaining(t)).toEqual([]);
	});

	test("REGISTERED — convex/crons.ts schedules purgeUploadTickets", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const crons = readFileSync(join(here, "..", "crons.ts"), "utf8");
		expect(crons).toMatch(/internal\.kbMutations\.purgeUploadTickets/);
	});
});
