/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k176723g3m5cczsq44ak9fbgm58hd0tx: the diary doors run
// under the bearer's VERIFIED organisation when the MCP reaches them as the fleet
// service account.
//
// Defect (code read): an OAuth bearer reaches Convex as the service account, so
// `withOrgScope` resolves master with no organisation. `diary:list` then took its
// master branch and read EVERY tenant's rows of the orchestrator/createdBy name
// the MCP gate let through; `diary:get` read the fleet range; `diary:write`
// stored the row fleet-owned. A seat of org A named "seat-x" therefore received
// org B's "seat-x" entries. The transport's `verifiedOrg` (convex/lib/verifiedOrg.ts)
// is now an input of all three doors, exactly as on `briefingNotes`.
//
// World: organisations A and B each own an agent called "seat-x" (same NAME, two
// organisations); the operator org owns one too. One entry per tenant on the same
// date, each authored by "seat-x".
//
//   REFUSED  A's seat (service account + verifiedOrg A) never receives B's or the
//            fleet's entry from list (by orchestrator, by createdBy, unfiltered) or
//            get; B's seat never receives A's; a member naming verifiedOrg by
//            argument is refused; an inactive org is refused.
//   PRESENT  A's seat reads its own entry; a write it makes is stamped A and read
//            back by A only.
//   MASTER   with no verifiedOrg the service account reads exactly as before.
//   CLERK    a Clerk-JWT member of A (its own identity) is served as before.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
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
const OP_ID = "org_DIAOP1";
const A_ID = "org_DIAA1";
const B_ID = "org_DIAB1";
const OFF_ID = "org_DIAOFF1";
const OP_SLUG = "dia-op";
const A_SLUG = "dia-a";
const B_SLUG = "dia-b";
const OFF_SLUG = "dia-off";

const asMaster = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, slug: string, orgId: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationSlug: slug,
		org_id: orgId,
		org_role: "org:editor",
	} as Identity);

async function world() {
	const t = createT();
	const ids: Record<string, Id<"agents">> = {};
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: 1,
		});
		const agent = (orgSlug: string, clerkOrgId: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId,
				name: SEAT,
				normalizedName: normalizeOrchestratorId(SEAT),
				isActive: true,
				createdAt: NOW,
			});
		ids.op = await agent(OP_SLUG, OP_ID);
		ids.a = await agent(A_SLUG, A_ID);
		ids.b = await agent(B_SLUG, B_ID);
		ids.off = await agent(OFF_SLUG, OFF_ID);
		const mapping = (
			clerkOrgSlug: string,
			clerkOrgId: string,
			agentId: Id<"agents">,
			extra: Partial<Doc<"client_org_mapping">> = {},
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug,
				clerkOrgId,
				allowedOrchestrators: [SEAT],
				allowedAgentIds: [agentId],
				scopes: ["view-own-tasks"],
				displayName: clerkOrgSlug,
				isActive: true,
				createdAt: NOW,
				...extra,
			});
		await mapping(OP_SLUG, OP_ID, ids.op, { orgKind: "operator", fleetWide: true });
		await mapping(A_SLUG, A_ID, ids.a);
		await mapping(B_SLUG, B_ID, ids.b);
		await mapping(OFF_SLUG, OFF_ID, ids.off, { isActive: false });
		const entry = (content: string, stamp: { orgId?: string; clerkOrgId?: string }) =>
			ctx.db.insert("diary", {
				date: DATE,
				orchestrator: SEAT,
				createdBy: SEAT,
				content,
				createdAt: 1,
				...stamp,
			});
		await entry("A-PRIVATE", { orgId: A_SLUG, clerkOrgId: A_ID });
		await entry("B-PRIVATE", { orgId: B_SLUG, clerkOrgId: B_ID });
		await entry("FLEET-PRIVATE", { orgId: OP_SLUG, clerkOrgId: OP_ID });
	});
	return { t, ids };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function items(result: Doc<"diary">[] | { refused: true; items: Doc<"diary">[] }) {
	if (!Array.isArray(result)) throw new Error("expected a served array, got the refusal envelope");
	return result.map((r) => r.content).sort();
}

async function errorOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		return `${e instanceof Error ? e.message : String(e)} ${JSON.stringify((e as { data?: unknown }).data ?? "")}`;
	}
	return "";
}

describe("diary doors narrow a service-account call to its verifiedOrg", () => {
	test("REFUSED: list by orchestrator — A's seat never receives B's or the fleet's same-name entry", async () => {
		const { t } = await world();
		const got = await asMaster(t).query(api.diary.list, {
			orchestrator: SEAT,
			verifiedOrg: { orgSlug: A_SLUG },
		});
		expect(items(got)).toEqual(["A-PRIVATE"]);
	});

	test("REFUSED: list by createdBy (colliding userId) — A's seat receives only A's entry", async () => {
		const { t } = await world();
		const got = await asMaster(t).query(api.diary.list, {
			createdBy: SEAT,
			verifiedOrg: { orgSlug: A_SLUG },
		});
		expect(items(got)).toEqual(["A-PRIVATE"]);
	});

	test("REFUSED: list with no filter — B's seat receives only B's entry", async () => {
		const { t } = await world();
		const got = await asMaster(t).query(api.diary.list, {
			verifiedOrg: { orgSlug: B_SLUG },
		});
		expect(items(got)).toEqual(["B-PRIVATE"]);
	});

	test("REFUSED/PRESENT: get — each seat receives its own org's entry, never another's", async () => {
		const { t } = await world();
		const m = asMaster(t);
		const a = await m.query(api.diary.get, {
			date: DATE,
			orchestrator: SEAT,
			verifiedOrg: { orgSlug: A_SLUG },
		});
		expect(a?.content).toBe("A-PRIVATE");
		const b = await m.query(api.diary.get, {
			date: DATE,
			orchestrator: SEAT,
			verifiedOrg: { orgSlug: B_SLUG },
		});
		expect(b?.content).toBe("B-PRIVATE");
	});

	test("PRESENT: a seat's write is stamped with its verified org and read back by that org only", async () => {
		const { t } = await world();
		const m = asMaster(t);
		const day = "2026-10-02";
		const id = await m.mutation(api.diary.write, {
			date: day,
			orchestrator: SEAT,
			content: "A-NEW",
			createdBy: SEAT,
			verifiedOrg: { orgSlug: A_SLUG },
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.orgId).toBe(A_SLUG);
		expect(row?.clerkOrgId).toBe(A_ID);
		const own = await m.query(api.diary.get, {
			date: day,
			orchestrator: SEAT,
			verifiedOrg: { orgSlug: A_SLUG },
		});
		expect(own?._id).toBe(id);
		const foreign = await m.query(api.diary.get, {
			date: day,
			orchestrator: SEAT,
			verifiedOrg: { orgSlug: B_SLUG },
		});
		expect(foreign).toBeNull();
	});

	test("REFUSED: B's seat writing the same (orchestrator, date) never patches A's entry", async () => {
		const { t } = await world();
		const m = asMaster(t);
		const id = await m.mutation(api.diary.write, {
			date: DATE,
			orchestrator: SEAT,
			content: "B-OVERWRITE",
			createdBy: SEAT,
			verifiedOrg: { orgSlug: B_SLUG },
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.clerkOrgId).toBe(B_ID);
		const a = await m.query(api.diary.get, {
			date: DATE,
			orchestrator: SEAT,
			verifiedOrg: { orgSlug: A_SLUG },
		});
		expect(a?.content).toBe("A-PRIVATE");
	});

	test("REFUSED: a member cannot name a verifiedOrg by argument", async () => {
		const { t } = await world();
		const member = asMember(t, A_SLUG, A_ID);
		expect(
			await errorOf(
				member.query(api.diary.list, { orchestrator: SEAT, verifiedOrg: { orgSlug: B_SLUG } }),
			),
		).toMatch(/RBAC_DENIED.*verified-org-not-trusted/s);
		expect(
			await errorOf(
				member.query(api.diary.get, {
					date: DATE,
					orchestrator: SEAT,
					verifiedOrg: { orgSlug: B_SLUG },
				}),
			),
		).toMatch(/RBAC_DENIED.*verified-org-not-trusted/s);
		expect(
			await errorOf(
				member.mutation(api.diary.write, {
					date: DATE,
					orchestrator: SEAT,
					content: "x",
					verifiedOrg: { orgSlug: B_SLUG },
				}),
			),
		).toMatch(/RBAC_DENIED.*verified-org-not-trusted/s);
	});

	test("REFUSED: a verifiedOrg naming an inactive organisation", async () => {
		const { t } = await world();
		expect(
			await errorOf(
				asMaster(t).query(api.diary.list, {
					orchestrator: SEAT,
					verifiedOrg: { orgSlug: OFF_SLUG },
				}),
			),
		).toMatch(/RBAC_DENIED.*org-not-active/s);
	});

	test("MASTER: with no verifiedOrg the service account reads as before", async () => {
		const { t } = await world();
		const m = asMaster(t);
		expect(items(await m.query(api.diary.list, { orchestrator: SEAT }))).toEqual([
			"A-PRIVATE",
			"B-PRIVATE",
			"FLEET-PRIVATE",
		]);
		const fleet = await m.query(api.diary.get, { date: DATE, orchestrator: SEAT });
		expect(fleet?.content).toBe("FLEET-PRIVATE");
	});

	test("CLERK: a Clerk-JWT member of A is served its own entry, unchanged", async () => {
		const { t } = await world();
		const member = asMember(t, A_SLUG, A_ID);
		expect(items(await member.query(api.diary.list, { orchestrator: SEAT }))).toEqual([
			"A-PRIVATE",
		]);
		const got = await member.query(api.diary.get, { date: DATE, orchestrator: SEAT });
		expect(got?.content).toBe("A-PRIVATE");
	});
});
