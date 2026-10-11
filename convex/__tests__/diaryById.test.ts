/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, module M10b: the diary is read and written by ID scope.
//
// A diary row belongs to an organisation by the org's permanent Clerk ID
// (`clerkOrgId`), judged by @vantageos/cloud-identity (`sameOrg`, `isFleetStamp`,
// `sameTenantStamp`). The slug on the row is a renamable label and decides
// nothing. The orchestrator a member may reach is judged by AGENT ID against the
// organisation's stored ID roster (`allowedAgentIds`), never by a roster NAME.
// The author of a member's write is the verified caller, never a typed value.
//
// The world: organisation A was renamed (its rows still carry the old label
// "acme") and a NEW organisation B then took the freed label "acme". Both hold an
// orchestrator called "seat-x". The same NAME and the same LABEL, two
// organisations.
//
// Every pole runs under a SCOPED, non-master identity unless it says "master".
//   REFUSED  B never reads, lists or range-reads A's entry; B's write never
//            alters A's entry nor is locked out by it; B cannot delete it; a
//            member whose roster lists the name but not the agent ID is refused;
//            a member cannot write under another author.
//   PRESENT  A (renamed) still reads its own entry stamped with the old label;
//            B reads and writes its own; a member listed by ID is served; the
//            author is the verified subject; the operator org's member and the
//            master still read the fleet range.
//   ABSENT   a scoped caller reading an empty table gets an empty SUCCESS.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const NOW = 1_700_000_000_000;
const SEAT = "seat-x";
const DATE = "2026-10-01";

const OP_ID = "org_OPERATOR1";
const A_ID = "org_AAAA1";
const B_ID = "org_BBBB1";
const C_ID = "org_CCCC1";

// A was renamed: its CURRENT label is "acme-renamed"; its rows still say "acme".
// B took the freed label "acme".
const OP_SLUG = "fleet-op";
const A_SLUG = "acme-renamed";
const OLD_LABEL = "acme";
const B_SLUG = OLD_LABEL;
const C_SLUG = "client-c";

const asMember = (t: T, slug: string, orgId: string, subject: string) =>
	t.withIdentity({
		subject,
		organizationSlug: slug,
		org_id: orgId,
		org_role: "org:member",
	} as Identity);
const asMaster = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

type World = {
	t: T;
	ids: Record<string, Id<"agents">>;
};

async function world(): Promise<World> {
	const t = createT();
	const ids: Record<string, Id<"agents">> = {};
	await t.run(async (ctx) => {
		const agent = (orgSlug: string, clerkOrgId: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		ids.opPi = await agent(OP_SLUG, OP_ID, "pi");
		ids.aSeat = await agent(A_SLUG, A_ID, SEAT);
		ids.bSeat = await agent(B_SLUG, B_ID, SEAT);
		ids.cSeat = await agent(C_SLUG, C_ID, SEAT);
		ids.cOther = await agent(C_SLUG, C_ID, "other");
		const mapping = (
			clerkOrgSlug: string,
			clerkOrgId: string,
			allowedOrchestrators: string[],
			extra: Partial<Doc<"client_org_mapping">>,
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug,
				clerkOrgId,
				allowedOrchestrators,
				scopes: ["view-own-tasks"],
				displayName: clerkOrgSlug,
				isActive: true,
				createdAt: NOW,
				...extra,
			});
		await mapping(OP_SLUG, OP_ID, ["pi"], {
			orgKind: "operator",
			fleetWide: true,
			allowedAgentIds: [ids.opPi],
		});
		await mapping(A_SLUG, A_ID, [SEAT], { allowedAgentIds: [ids.aSeat] });
		await mapping(B_SLUG, B_ID, [SEAT], { allowedAgentIds: [ids.bSeat] });
		// C: "seat-x" is on the legacy NAME roster, but only "other" is on the ID
		// roster. A name is not a grant.
		await mapping(C_SLUG, C_ID, [SEAT, "other"], {
			allowedAgentIds: [ids.cOther],
		});
	});
	return { t, ids };
}

const row = (
	content: string,
	stamp: { orgId?: string; clerkOrgId?: string },
	over: Partial<Doc<"diary">> = {},
) => ({
	date: DATE,
	orchestrator: SEAT,
	content,
	createdAt: 1,
	...stamp,
	...over,
});

const A_ROW = { orgId: OLD_LABEL, clerkOrgId: A_ID };
const B_ROW = { orgId: B_SLUG, clerkOrgId: B_ID };

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

// A served list is the bare array; the refusal envelope is a different shape.
function served(result: Doc<"diary">[] | { refused: true; items: Doc<"diary">[] }): Doc<"diary">[] {
	if (!Array.isArray(result)) throw new Error("expected a served array, got the refusal envelope");
	return result;
}

async function errorOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		return `${e instanceof Error ? e.message : String(e)} ${JSON.stringify((e as { data?: unknown }).data ?? "")}`;
	}
	return "";
}

describe("diary reads — a same-NAME, same-LABEL principal of another org is refused", () => {
	test("REFUSED: diary:get — B (label 'acme', seat-x) does not receive A's entry", async () => {
		const { t } = await world();
		await t.run((ctx) => ctx.db.insert("diary", row("A's private", A_ROW)));
		const got = await asMember(t, B_SLUG, B_ID, "user-b").query(api.diary.get, {
			date: DATE,
			orchestrator: SEAT,
		});
		expect(got).toBeNull();
	});

	test("REFUSED: diary:list — B's list holds none of A's entries", async () => {
		const { t } = await world();
		await t.run((ctx) => ctx.db.insert("diary", row("A's private", A_ROW)));
		const got = await asMember(t, B_SLUG, B_ID, "user-b").query(api.diary.list, {});
		expect(got).toEqual([]);
	});

	test("REFUSED: diary:listByDateRange — B's range read holds none of A's entries", async () => {
		const { t } = await world();
		await t.run((ctx) => ctx.db.insert("diary", row("A's private", A_ROW)));
		const got = await asMember(t, B_SLUG, B_ID, "user-b").query(
			api.diary.listByDateRange,
			{ from: "2026-01-01", to: "2026-12-31", orchestrator: SEAT },
		);
		expect(got).toEqual([]);
		const all = await asMember(t, B_SLUG, B_ID, "user-b").query(
			api.diary.listByDateRange,
			{ from: "2026-01-01", to: "2026-12-31" },
		);
		expect(all).toEqual([]);
	});

	test("REFUSED: a member listed by NAME but not by agent ID is served nothing (C)", async () => {
		const { t } = await world();
		await t.run((ctx) =>
			ctx.db.insert("diary", row("C's seat-x entry", { orgId: C_SLUG, clerkOrgId: C_ID })),
		);
		const c = asMember(t, C_SLUG, C_ID, "user-c");
		expect(await c.query(api.diary.get, { date: DATE, orchestrator: SEAT })).toBeNull();
		expect(await c.query(api.diary.list, { orchestrator: SEAT })).toEqual([]);
		expect(await c.query(api.diary.list, {})).toEqual([]);
		expect(
			await c.query(api.diary.listByDateRange, {
				from: "2026-01-01",
				to: "2026-12-31",
			}),
		).toEqual([]);
		expect(await errorOf(
			c.mutation(api.diary.write, { date: "2026-10-05", orchestrator: SEAT, content: "x" }),
		)).toMatch(/RBAC_DENIED/);
	});
});

describe("diary writes — the other org's entry is never altered and never a lockout", () => {
	test("REFUSED: B's write leaves A's entry byte-identical and lands B's own", async () => {
		const { t } = await world();
		const aId = await t.run((ctx) => ctx.db.insert("diary", row("A's private", A_ROW)));
		const before = await t.run((ctx) => ctx.db.get(aId));
		const mine = await asMember(t, B_SLUG, B_ID, "user-b").mutation(api.diary.write, {
			date: DATE,
			orchestrator: SEAT,
			content: "B's own",
		});
		expect(mine).not.toBe(aId);
		expect(await t.run((ctx) => ctx.db.get(aId))).toEqual(before);
		const stored = await t.run((ctx) => ctx.db.get(mine));
		expect(stored?.clerkOrgId).toBe(B_ID);
		expect(stored?.content).toBe("B's own");
	});

	test("REFUSED: B cannot delete A's entry", async () => {
		const { t } = await world();
		const aId = await t.run((ctx) => ctx.db.insert("diary", row("A's private", A_ROW)));
		const msg = await errorOf(
			asMember(t, B_SLUG, B_ID, "user-b").mutation(api.diary.deleteDiary, {
				diaryId: aId,
				callerOrchestrator: SEAT,
			}),
		);
		expect(msg).toMatch(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.get(aId))).not.toBeNull();
	});

	test("REFUSED: a member cannot write under another author", async () => {
		const { t } = await world();
		const msg = await errorOf(
			asMember(t, B_SLUG, B_ID, "user-b").mutation(api.diary.write, {
				date: DATE,
				orchestrator: SEAT,
				content: "forged",
				createdBy: "pi",
			}),
		);
		expect(msg).toMatch(/RBAC_DENIED/);
		expect(msg).toMatch(/author-not-caller/);
		expect(await t.run((ctx) => ctx.db.query("diary").collect())).toHaveLength(0);
	});
});

describe("diary — the owner is served by ID", () => {
	test("PRESENT: A (renamed) reads its own entry still stamped with the OLD label", async () => {
		const { t } = await world();
		await t.run((ctx) => ctx.db.insert("diary", row("A's private", A_ROW)));
		const a = asMember(t, A_SLUG, A_ID, "user-a");
		const got = await a.query(api.diary.get, { date: DATE, orchestrator: SEAT });
		expect(got?.content).toBe("A's private");
		expect(served(await a.query(api.diary.list, {})).length).toBe(1);
		expect(
			(await a.query(api.diary.listByDateRange, {
				from: "2026-01-01",
				to: "2026-12-31",
			})).length,
		).toBe(1);
	});

	test("PRESENT: A (renamed) upserts the entry stamped with the old label, it does not fork", async () => {
		const { t } = await world();
		const aId = await t.run((ctx) => ctx.db.insert("diary", row("v1", A_ROW)));
		const got = await asMember(t, A_SLUG, A_ID, "user-a").mutation(api.diary.write, {
			date: DATE,
			orchestrator: SEAT,
			content: "v2",
		});
		expect(got).toBe(aId);
		expect((await t.run((ctx) => ctx.db.get(aId)))?.content).toBe("v2");
	});

	test("PRESENT: B reads its own entry, and only its own, next to A's", async () => {
		const { t } = await world();
		await t.run(async (ctx) => {
			await ctx.db.insert("diary", row("A's private", A_ROW));
			await ctx.db.insert("diary", row("B's own", B_ROW));
		});
		const b = asMember(t, B_SLUG, B_ID, "user-b");
		expect((await b.query(api.diary.get, { date: DATE, orchestrator: SEAT }))?.content).toBe("B's own");
		expect(served(await b.query(api.diary.list, {})).map((r) => r.content)).toEqual(["B's own"]);
	});

	test("PRESENT: the author of a member write is the verified subject", async () => {
		const { t } = await world();
		const id = await asMember(t, B_SLUG, B_ID, "user-b").mutation(api.diary.write, {
			date: DATE,
			orchestrator: SEAT,
			content: "mine",
		});
		const stored = await t.run((ctx) => ctx.db.get(id));
		expect(stored?.createdBy).toBe("user:user-b");
		expect(stored?.clerkOrgId).toBe(B_ID);
		expect(stored?.orgId).toBe(B_SLUG);
	});

	test("PRESENT: the member's own author is accepted when it names the verified subject", async () => {
		const { t } = await world();
		const id = await asMember(t, B_SLUG, B_ID, "user-b").mutation(api.diary.write, {
			date: DATE,
			orchestrator: SEAT,
			content: "mine",
			createdBy: "user:user-b",
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.createdBy).toBe("user:user-b");
	});

	test("PRESENT: B deletes its own entry", async () => {
		const { t } = await world();
		const id = await t.run((ctx) => ctx.db.insert("diary", row("B's own", B_ROW)));
		const out = await asMember(t, B_SLUG, B_ID, "user-b").mutation(api.diary.deleteDiary, {
			diaryId: id,
			callerOrchestrator: SEAT,
		});
		expect(out).toEqual({ deleted: true });
		expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
	});

	test("PRESENT: a member listed by agent ID is served the orchestrator it lists (C: other)", async () => {
		const { t } = await world();
		await t.run((ctx) =>
			ctx.db.insert("diary", row("C's other entry", { orgId: C_SLUG, clerkOrgId: C_ID }, { orchestrator: "other" })),
		);
		const c = asMember(t, C_SLUG, C_ID, "user-c");
		expect((await c.query(api.diary.get, { date: DATE, orchestrator: "other" }))?.content).toBe("C's other entry");
		expect(served(await c.query(api.diary.list, {})).length).toBe(1);
		expect(
			(await c.query(api.diary.listByDateRange, { from: "2026-01-01", to: "2026-12-31" })).length,
		).toBe(1);
	});
});

describe("diary — the fleet range", () => {
	test("PRESENT: master reads the fleet entry and a member of the operator org reads it too", async () => {
		const { t } = await world();
		await t.run(async (ctx) => {
			await ctx.db.insert("diary", row("fleet unstamped", {}, { orchestrator: "pi" }));
			await ctx.db.insert("diary", row("A's private", A_ROW, { orchestrator: "pi" }));
		});
		const m = await asMaster(t).query(api.diary.get, { date: DATE, orchestrator: "pi" });
		expect(m?.content).toBe("fleet unstamped");
		const op = asMember(t, OP_SLUG, OP_ID, "user-op");
		const got = await op.query(api.diary.get, { date: DATE, orchestrator: "pi" });
		expect(got?.content).toBe("fleet unstamped");
		expect(served(await op.query(api.diary.list, {})).map((r) => r.content)).toEqual(["fleet unstamped"]);
	});

	test("REFUSED: a client member never reads the fleet (unstamped) entry of the same name", async () => {
		const { t } = await world();
		await t.run((ctx) => ctx.db.insert("diary", row("fleet unstamped", {})));
		const b = asMember(t, B_SLUG, B_ID, "user-b");
		expect(await b.query(api.diary.get, { date: DATE, orchestrator: SEAT })).toBeNull();
		expect(await b.query(api.diary.list, {})).toEqual([]);
	});
});

describe("diary — absence stays an absence", () => {
	test("ABSENT: a scoped caller on an empty table gets an empty SUCCESS from all three reads", async () => {
		const { t } = await world();
		const b = asMember(t, B_SLUG, B_ID, "user-b");
		expect(await b.query(api.diary.get, { date: DATE, orchestrator: SEAT })).toBeNull();
		expect(await b.query(api.diary.list, {})).toEqual([]);
		expect(
			await b.query(api.diary.listByDateRange, { from: "2026-01-01", to: "2026-12-31" }),
		).toEqual([]);
	});

	test("REFUSED: an anonymous caller is raised at, not served an empty success", async () => {
		const { t } = await world();
		expect(await errorOf(t.query(api.diary.list, {}))).toMatch(/RBAC_DENIED/);
		expect(
			await errorOf(t.query(api.diary.get, { date: DATE, orchestrator: SEAT })),
		).toMatch(/RBAC_DENIED/);
	});
});
