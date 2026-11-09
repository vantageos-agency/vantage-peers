/// <reference types="vite/client" />
//
// listFiltersCompose.test.ts — a list read that is given two filters applies
// BOTH, newest first, and a partial page continues without a gap.
// ─────────────────────────────────────────────────────────────────────────────
//
// DEFECT (measured on prod at 406c3994): `list_messages from='pi' sessionDay=249
// limit=200` returned 12 rows, ALL from other senders, OLDEST first. The master
// path of `messages:listMessages` is an if / else-if chain: the `sessionDay`
// branch read `by_day ... .order("asc").take(cap)` and never applied `from`;
// only the `from` branch filtered the sender. Same class, second site:
// `issues:listByProject` took the project's newest `limit` rows and THEN
// narrowed by status in memory, so `project + status` answered a short page
// with no cursor while older matching rows existed.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const SERVICE_ACCOUNT = {
	subject: "test-service-account-user-id",
} as const;

type Seeded = { _id: string; from: string; sessionDay: number };

async function seedMessages() {
	const t = convexTest(schema, modules);
	const master = t.withIdentity(
		SERVICE_ACCOUNT as Parameters<typeof t.withIdentity>[0],
	);
	// Interleaved senders over two days. Insertion order IS creation order, so
	// the newest rows on day 249 belong to "sigma" and the "pi" rows are older:
	// an unfiltered `take(limit)` of day 249 would hand back sigma rows only.
	const plan: Array<[string, number]> = [
		["pi", 249],
		["sigma", 249],
		["pi", 249],
		["sigma", 249],
		["pi", 249],
		["sigma", 249],
		["sigma", 249],
		["sigma", 249],
		["pi", 250],
		["sigma", 250],
	];
	const rows: Seeded[] = [];
	let at = 1_780_000_000_000;
	for (const [from, sessionDay] of plan) {
		at += 1000;
		const id: string = await t.run(async (ctx) =>
			ctx.db.insert("messages", {
				from,
				channel: "fixture-channel",
				content: `fixture ${from} d${sessionDay} @${at}`,
				sessionDay,
				createdAt: at,
			}),
		);
		rows.push({ _id: id, from, sessionDay });
	}
	return { master, rows };
}

describe("messages:listMessages — from + sessionDay together", () => {
	test("returns only that sender on that day, newest first", async () => {
		const { master, rows } = await seedMessages();
		const got = await master.query(api.messages.listMessages, {
			from: "pi",
			sessionDay: 249,
			limit: 200,
		});
		const expected = rows
			.filter((r) => r.from === "pi" && r.sessionDay === 249)
			.map((r) => r._id)
			.reverse();
		expect(expected).toHaveLength(3);
		expect(got.map((r) => r._id)).toEqual(expected);
		expect(got.every((r) => r.from === "pi" && r.sessionDay === 249)).toBe(
			true,
		);
	});

	test("a window smaller than the day's other-sender rows still finds the sender", async () => {
		const { master, rows } = await seedMessages();
		const got = await master.query(api.messages.listMessages, {
			from: "pi",
			sessionDay: 249,
			limit: 2,
		});
		const newestTwo = rows
			.filter((r) => r.from === "pi" && r.sessionDay === 249)
			.map((r) => r._id)
			.reverse()
			.slice(0, 2);
		expect(got.map((r) => r._id)).toEqual(newestTwo);
	});

	test("sessionDay alone is newest first (the cursor contract runs downward)", async () => {
		const { master, rows } = await seedMessages();
		const got = await master.query(api.messages.listMessages, {
			sessionDay: 249,
			limit: 200,
		});
		const expected = rows
			.filter((r) => r.sessionDay === 249)
			.map((r) => r._id)
			.reverse();
		expect(got.map((r) => r._id)).toEqual(expected);
	});

	test("paging with createdBefore walks both filters with no gap and no repeat", async () => {
		const { master, rows } = await seedMessages();
		const collected: string[] = [];
		let createdBefore: number | undefined;
		for (let page = 0; page < 6; page++) {
			const got = await master.query(api.messages.listMessages, {
				from: "pi",
				sessionDay: 249,
				limit: 2,
				createdBefore,
			});
			if (got.length === 0) break;
			collected.push(...got.map((r) => r._id));
			createdBefore = got[got.length - 1]._creationTime;
		}
		const expected = rows
			.filter((r) => r.from === "pi" && r.sessionDay === 249)
			.map((r) => r._id)
			.reverse();
		expect(collected).toEqual(expected);
	});
});

describe("issues:listByProject — project + status together", () => {
	test("a status filter is applied by the read, so older matches are not lost to newer non-matches", async () => {
		const t = convexTest(schema, modules);
		const master = t.withIdentity(
			SERVICE_ACCOUNT as Parameters<typeof t.withIdentity>[0],
		);
		const statuses = [
			"open",
			"open",
			"closed",
			"closed",
			"closed",
			"closed",
		] as const;
		const ids: string[] = [];
		let n = 0;
		for (const status of statuses) {
			n += 1;
			ids.push(
				await t.run(async (ctx) =>
					ctx.db.insert("issues", {
						repo: "fixture-org/fixture-repo",
						issueNumber: n,
						title: `fixture issue ${n}`,
						body: "",
						htmlUrl: `https://example.invalid/issues/${n}`,
						labels: [],
						status,
						priority: "medium",
						assignedOrchestrator: "sigma",
						project: "fixture-project",
						githubCreatedAt: 1_780_000_000_000 + n,
						githubUpdatedAt: 1_780_000_000_000 + n,
					}),
				),
			);
		}
		const got = await master.query(api.issues.listByProject, {
			project: "fixture-project",
			status: "open",
			limit: 2,
		});
		expect(got.map((r) => r._id).sort()).toEqual([ids[0], ids[1]].sort());
		expect(got.every((r) => r.status === "open")).toBe(true);
	});
});

describe("messages:listMessages — an organisation's caller gets sessionDay too", () => {
	test("sessionDay + from narrow the organisation's rows; the day is not silently dropped", async () => {
		const t = convexTest(schema, modules);
		const orgId = testClerkOrgId("acme");
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "acme",
				clerkOrgId: orgId,
				allowedOrchestrators: ["victor", "noe"],
				scopes: ["view-own-tasks", "view-own-missions"],
				displayName: "acme",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		const plan: Array<[string, number]> = [
			["victor", 249],
			["noe", 249],
			["victor", 250],
			["victor", 249],
		];
		const ids: string[] = [];
		let at = 1_780_000_000_000;
		for (const [from, sessionDay] of plan) {
			at += 1000;
			ids.push(
				await t.run(async (ctx) =>
					ctx.db.insert("messages", {
						from,
						channel: "noe",
						content: `acme ${from} d${sessionDay}`,
						sessionDay,
						createdAt: at,
						tenantId: "acme",
						tenantOrgId: orgId,
					}),
				),
			);
		}
		const reader = t.withIdentity({
			subject: "user-acme-reader",
			organizationId: "acme",
			org_id: orgId,
		} as Parameters<typeof t.withIdentity>[0]);
		const day = await reader.query(api.messages.listMessages, {
			sessionDay: 249,
		});
		expect(day.map((r) => r._id)).toEqual([ids[3], ids[1], ids[0]]);
		const both = await reader.query(api.messages.listMessages, {
			sessionDay: 249,
			from: "victor",
		});
		expect(both.map((r) => r._id)).toEqual([ids[3], ids[0]]);
	});
});
