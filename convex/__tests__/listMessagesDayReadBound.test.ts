/// <reference types="vite/client" />
//
// listMessagesDayReadBound.test.ts — `messages:listMessages` with a day opens
// the DAY's index range, never the sender's (or the organisation's) whole
// history.
// ─────────────────────────────────────────────────────────────────────────────
//
// DEFECT (measured on prod at 44b78b46 through the live MCP): `list_messages
// from='pi' sessionDay=60 limit=20` and `from='pi' sessionDay=249 limit=200`
// answered "Server Error"; `sessionDay=249 limit=50` and `sessionDay=200
// limit=20` were correct. The master path read the sender's whole `by_from`
// range newest first and filtered the day inside it, so an old day or a large
// page walked the busiest sender's entire history past Convex's per-function
// read limits. The organisation path did the same over its tenant range.
//
// THE PROXY FOR "DOCUMENTS TOUCHED" (declared, not hidden). convex-test meters
// only the documents a function RECEIVES (`get` / `queryStreamNext`); the rows
// a range or a `.filter()` evaluates internally are not metered (see the header
// of checkNewMessagesEnvelope-scan-bound.test.ts), so a volume-based assertion
// cannot fail here. This test therefore invokes the registered handler
// (`._handler`) with a `db` wrapper that, for every `messages` read, records the
// index the read opened and the SIZE OF THAT INDEX RANGE (the same
// `withIndex(...)` replayed alone with `.collect()`). The range size is the
// upper bound of the documents the read can walk, whatever the filter or the
// take do afterwards. Assertion: the range opened by a day read is no larger
// than that day's volume, and strictly smaller than the sender's history.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { listMessages } from "../messages";

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

type Op = { m: string; args: unknown[] };
type ReadLog = { index: string; rangeDocs: number };
type Terminal = "take" | "collect" | "first" | "unique";
const TERMINALS: ReadonlySet<string> = new Set<Terminal>([
	"take",
	"collect",
	"first",
	"unique",
]);

// biome-ignore lint/suspicious/noExplicitAny: a structural wrapper over the db reader
type Loose = any;

function recorder(db: Loose, ops: Op[], log: ReadLog[]): Loose {
	return new Proxy(
		{},
		{
			get(_t, prop) {
				if (typeof prop !== "string") return undefined;
				if (TERMINALS.has(prop)) {
					return async (...args: unknown[]) => {
						const first = ops.find((o) => o.m === "withIndex");
						let ranged = db.query("messages");
						if (first) ranged = ranged.withIndex(...first.args);
						const range: unknown[] = await ranged.collect();
						log.push({
							index: first ? String(first.args[0]) : "<full table>",
							rangeDocs: range.length,
						});
						let q = db.query("messages");
						for (const op of ops) q = q[op.m](...op.args);
						return q[prop](...args);
					};
				}
				return (...args: unknown[]) =>
					recorder(db, [...ops, { m: prop, args }], log);
			},
		},
	);
}

function metered(ctx: Loose, log: ReadLog[]): Loose {
	const db = ctx.db;
	const dbProxy = new Proxy(db, {
		get(target, prop) {
			if (prop === "query") {
				return (table: string) =>
					table === "messages"
						? recorder(target, [], log)
						: target.query(table);
			}
			const v = Reflect.get(target, prop);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	return new Proxy(ctx, {
		get(target, prop) {
			if (prop === "db") return dbProxy;
			return Reflect.get(target, prop);
		},
	});
}

type Client = {
	run: <T>(fn: (ctx: Loose) => Promise<T>) => Promise<T>;
};

async function meteredList(
	client: Client,
	args: Record<string, unknown>,
): Promise<{
	rows: Array<{ _id: string; _creationTime: number; from: string }>;
	reads: ReadLog[];
}> {
	const log: ReadLog[] = [];
	const rows = await client.run(async (ctx) =>
		(listMessages as Loose)._handler(metered(ctx, log), args),
	);
	return { rows, reads: log };
}

const HISTORY_DAYS = [240, 241, 242, 243, 244, 245, 246, 247, 248, 249];
const OLD_DAY = 60;

async function seedMaster() {
	const t = convexTest(schema, modules);
	const master = t.withIdentity(
		SERVICE_ACCOUNT as Parameters<typeof t.withIdentity>[0],
	);
	const seeded: Array<{ _id: string; from: string; sessionDay: number }> = [];
	let at = 1_780_000_000_000;
	// The old day first (oldest rows): pi has 3 there, two other senders 2 + 2.
	const plan: Array<[string, number]> = [
		["pi", OLD_DAY],
		["sigma", OLD_DAY],
		["pi", OLD_DAY],
		["noe", OLD_DAY],
		["sigma", OLD_DAY],
		["noe", OLD_DAY],
		["pi", OLD_DAY],
	];
	// Then pi's long recent history: 12 per day over 10 days = 120 rows, with a
	// second sender interleaved so the busy days are busy for everyone.
	for (const day of HISTORY_DAYS) {
		for (let i = 0; i < 12; i++) plan.push(["pi", day]);
		plan.push(["sigma", day]);
	}
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
		seeded.push({ _id: id, from, sessionDay });
	}
	return { t, master, seeded };
}

describe("messages:listMessages master path — a day read opens the day's range", () => {
	test("old day, small page: range bounded by the day, rows still right", async () => {
		const { master, seeded } = await seedMaster();
		const dayVolume = seeded.filter((r) => r.sessionDay === OLD_DAY).length;
		const history = seeded.filter((r) => r.from === "pi").length;
		expect(dayVolume).toBe(7);
		expect(history).toBe(123);

		const { rows, reads } = await meteredList(master as unknown as Client, {
			from: "pi",
			sessionDay: OLD_DAY,
			limit: 20,
		});
		const expected = seeded
			.filter((r) => r.from === "pi" && r.sessionDay === OLD_DAY)
			.map((r) => r._id)
			.reverse();
		expect(rows.map((r) => r._id)).toEqual(expected);
		expect(reads).toHaveLength(1);
		expect(reads[0].rangeDocs).toBeLessThanOrEqual(dayVolume);
		expect(reads[0].rangeDocs).toBeLessThan(history);
	});

	test("busy sender, large page on a recent day: range bounded by the day", async () => {
		const { master, seeded } = await seedMaster();
		const dayVolume = seeded.filter((r) => r.sessionDay === 249).length;
		const { rows, reads } = await meteredList(master as unknown as Client, {
			from: "pi",
			sessionDay: 249,
			limit: 200,
		});
		const expected = seeded
			.filter((r) => r.from === "pi" && r.sessionDay === 249)
			.map((r) => r._id)
			.reverse();
		expect(expected).toHaveLength(12);
		expect(rows.map((r) => r._id)).toEqual(expected);
		expect(reads).toHaveLength(1);
		expect(reads[0].rangeDocs).toBeLessThanOrEqual(dayVolume);
	});

	test("a cut page keeps a cursor; every page of the walk stays inside the day", async () => {
		const { master, seeded } = await seedMaster();
		const dayVolume = seeded.filter((r) => r.sessionDay === 249).length;
		const collected: string[] = [];
		let createdBefore: number | undefined;
		for (let page = 0; page < 10; page++) {
			const { rows, reads } = await meteredList(master as unknown as Client, {
				from: "pi",
				sessionDay: 249,
				limit: 5,
				createdBefore,
			});
			for (const r of reads) expect(r.rangeDocs).toBeLessThanOrEqual(dayVolume);
			if (rows.length === 0) break;
			collected.push(...rows.map((r) => r._id));
			createdBefore = rows[rows.length - 1]._creationTime;
		}
		const expected = seeded
			.filter((r) => r.from === "pi" && r.sessionDay === 249)
			.map((r) => r._id)
			.reverse();
		expect(collected).toEqual(expected);
	});

	test("the unfiltered-by-day sender read is unchanged (still the sender's range)", async () => {
		const { master } = await seedMaster();
		const { reads } = await meteredList(master as unknown as Client, {
			from: "pi",
			limit: 5,
		});
		expect(reads.map((r) => r.index)).toEqual(["by_from"]);
	});
});

describe("messages:listMessages organisation path — a day read opens the day's range", () => {
	test("old day: range bounded by the day, not by the organisation's history", async () => {
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
			["victor", OLD_DAY],
			["noe", OLD_DAY],
			["victor", OLD_DAY],
		];
		for (const day of HISTORY_DAYS) {
			for (let i = 0; i < 10; i++) plan.push(["victor", day]);
		}
		const ids: Array<{ id: string; from: string; day: number }> = [];
		let at = 1_780_000_000_000;
		for (const [from, sessionDay] of plan) {
			at += 1000;
			const id: string = await t.run(async (ctx) =>
				ctx.db.insert("messages", {
					from,
					channel: "noe",
					content: `acme ${from} d${sessionDay}`,
					sessionDay,
					createdAt: at,
					tenantId: "acme",
					tenantOrgId: orgId,
				}),
			);
			ids.push({ id, from, day: sessionDay });
		}
		const reader = t.withIdentity({
			subject: "user-acme-reader",
			organizationId: "acme",
			org_id: orgId,
		} as Parameters<typeof t.withIdentity>[0]);
		const dayVolume = ids.filter((r) => r.day === OLD_DAY).length;
		const { rows, reads } = await meteredList(reader as unknown as Client, {
			from: "victor",
			sessionDay: OLD_DAY,
			limit: 20,
		});
		const expected = ids
			.filter((r) => r.from === "victor" && r.day === OLD_DAY)
			.map((r) => r.id)
			.reverse();
		expect(rows.map((r) => r._id)).toEqual(expected);
		expect(reads).toHaveLength(1);
		expect(reads[0].rangeDocs).toBeLessThanOrEqual(dayVolume);
		expect(reads[0].rangeDocs).toBeLessThan(ids.length);
	});
});

describe("the instrument sees the public function too", () => {
	test("api.messages.listMessages and the handler agree on the rows", async () => {
		const { master } = await seedMaster();
		const viaApi = await master.query(api.messages.listMessages, {
			from: "pi",
			sessionDay: OLD_DAY,
			limit: 20,
		});
		const viaHandler = await meteredList(master as unknown as Client, {
			from: "pi",
			sessionDay: OLD_DAY,
			limit: 20,
		});
		expect(viaApi.map((r) => r._id)).toEqual(viaHandler.rows.map((r) => r._id));
	});
});
