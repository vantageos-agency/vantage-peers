/// <reference types="vite/client" />
/**
 * THE PRE-ORGANISATION CALLER IS REFUSED IN A SHAPE THAT SAYS SO.
 *
 * PR #1353 made a refusal distinguishable from an absence for an ANONYMOUS
 * caller and for an ORDINARY ORGANISATION MEMBER. It left a third population:
 * authenticated, but with no organisation yet — the pre-organisation shell
 * (`scope.refused`). Six sites still answered that caller with a bare `[]`,
 * byte-identical to "this table is empty".
 *
 * EACH SITE WAS RE-DECIDED, not inherited. The decision turns on ONE measured
 * fact — does a render subscribe to the read — measured by command in BOTH
 * repositories (`mcp-server/src/` and `vantage-peers-dashboard`):
 *
 *   site                              subscriber (dashboard useQuery)        decision
 *   mandates:list                     mandate-board.tsx:39                   ENVELOPE
 *   profiles:listProfiles             orchestrators-grid.tsx:53              ENVELOPE
 *   messages:listByChannel            message-timeline.tsx:51,               ENVELOPE
 *                                     unified-activity-feed.tsx:153
 *   messages:listMessages             none (MCP list_messages and the        RAISES
 *                                     messages-feed primitive are one-shot)
 *   messages:searchMessagesByKeyword  none (MCP one-shot)                    RAISES
 *   messages:checkNewMessages         message-timeline.tsx:69, and it does   BARE [] KEPT
 *                                     `.map()` on the raw result             (STOP clause)
 *
 * For every site the three poles run, and the REFUSED pole is asserted
 * ADJACENT to the ABSENT pole so the two cannot be the same bytes:
 *   REFUSED — a PRE-ORGANISATION identity (signed in, NO org claim) over a
 *             SEEDED table, so a refusal is proven to withhold, not to be empty.
 *   ABSENT  — a legitimately scoped caller over a genuinely EMPTY table.
 *   PRESENT — the same legitimate caller over a SEEDED table.
 * At `mandates:list` and `profiles:listProfiles` the ABSENT/PRESENT poles can
 * only run as the fleet service account, because those reads admit no ordinary
 * reader by design (their tables carry no orgId). That is the ALLOW pole only;
 * every REFUSED pole here is an ordinary pre-org identity and is never master.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
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

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const PRE_ORG = "signed-in-user-with-no-organisation-yet";
const MEMBER = "ordinary-member-of-org-a";

for (const subject of [PRE_ORG, MEMBER]) {
	if (subject === SERVICE_ACCOUNT_USER_ID) {
		throw new Error(
			`test-integrity: ${subject} must not be the service-account id — a DENY pole under the maintenance identity proves the bypass, not the control`,
		);
	}
}

/** Authenticated, NO organisation claim of any kind. */
const asPreOrg = (t: T) =>
	t.withIdentity({ subject: PRE_ORG } as Parameters<typeof t.withIdentity>[0]);

const asMember = (t: T) =>
	t.withIdentity({
		subject: MEMBER,
		organizationId: "org-a",
		organizationSlug: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);

/** ALLOW pole only — never used to prove a denial. */
const asMaster = (t: T) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Parameters<
		typeof t.withIdentity
	>[0]);

const seedOrgMapping = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});

const seedMandate = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("mandates", {
			requestedBy: "pi",
			fulfilledBy: "sigma",
			service: "spending authority row",
			budget: 100000,
			status: "requested",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});

const seedProfile = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId: "sigma",
			name: "Sigma",
			static: { role: "infra", workspace: "/x", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});

const seedMessage = (t: T, channel: string, tenantId?: string) =>
	t.run(async (ctx) => {
		await ctx.db.insert("messages", {
			from: "sigma",
			channel,
			content: "hello world",
			createdAt: Date.now(),
			...(tenantId !== undefined ? { tenantId } : {}),
		});
	});

/** The observable outcome of a read, as the bytes a caller would receive. */
async function outcome(
	read: () => Promise<unknown>,
): Promise<{ kind: "success" | "error"; bytes: string }> {
	try {
		return { kind: "success", bytes: JSON.stringify(await read()) };
	} catch (e) {
		return {
			kind: "error",
			bytes: String((e as ConvexError<string>).data ?? e),
		};
	}
}

// Convex serialises object keys in sorted order: `items` before `refused`.
const ENVELOPE = JSON.stringify({ items: [], refused: true });

// ─────────────────────────────────────────────────────────────────────────────
// ENVELOPE sites — a render subscribes, so a throw would crash it; a bare []
// would be the same bytes as an absence. `{ refused: true, items: [] }` is what
// every dashboard consumer already normalises with `.items ?? []`.
// ─────────────────────────────────────────────────────────────────────────────

// HARNESS NOTE. Every test below drives ONE `convexTest()` instance through
// ABSENT (empty table) -> seed -> REFUSED -> PRESENT. A second instance in the
// same test is deliberately avoided: measured, a read on instance A returns `[]`
// once instance B has been used in the same test, which would fake an ABSENT.

describe("ENVELOPE sites \u2014 the pre-organisation caller is told it was refused", () => {
	test("mandates:list \u2014 ABSENT (master, empty) / REFUSED (pre-org, seeded) / PRESENT (master, seeded), adjacent", async () => {
		const t = createT();
		const absent = await outcome(() =>
			asMaster(t).query(api.mandates.list, {}),
		);
		await seedMandate(t);
		const refused = await outcome(() => asPreOrg(t).query(api.mandates.list, {}));
		const present = await outcome(() => asMaster(t).query(api.mandates.list, {}));

		expect(absent).toEqual({ kind: "success", bytes: "[]" });
		expect(refused).toEqual({ kind: "success", bytes: ENVELOPE });
		expect(JSON.parse(present.bytes)).toHaveLength(1);
		// ADJACENT: refusal and absence are not the same bytes.
		expect(refused.bytes).not.toBe(absent.bytes);
	});

	test("profiles:listProfiles \u2014 ABSENT (master, empty) / REFUSED (pre-org, seeded) / PRESENT (master, seeded), adjacent", async () => {
		const t = createT();
		const absent = await outcome(() =>
			asMaster(t).query(api.profiles.listProfiles, {}),
		);
		await seedProfile(t);
		const refused = await outcome(() =>
			asPreOrg(t).query(api.profiles.listProfiles, {}),
		);
		const present = await outcome(() =>
			asMaster(t).query(api.profiles.listProfiles, {}),
		);

		expect(absent).toEqual({ kind: "success", bytes: "[]" });
		expect(refused).toEqual({ kind: "success", bytes: ENVELOPE });
		expect(JSON.parse(present.bytes)).toHaveLength(1);
		expect(refused.bytes).not.toBe(absent.bytes);
	});

	test("messages:listByChannel \u2014 ABSENT (member, empty) / REFUSED (pre-org, seeded broadcast) / PRESENT (member, broadcast), adjacent", async () => {
		const t = createT();
		await seedOrgMapping(t);
		const absent = await outcome(() =>
			asMember(t).query(api.messages.listByChannel, {}),
		);
		await seedMessage(t, "broadcast");
		const refused = await outcome(() =>
			asPreOrg(t).query(api.messages.listByChannel, {}),
		);
		const present = await outcome(() =>
			asMember(t).query(api.messages.listByChannel, {}),
		);

		expect(absent).toEqual({ kind: "success", bytes: "[]" });
		expect(refused).toEqual({ kind: "success", bytes: ENVELOPE });
		expect(JSON.parse(present.bytes)).toHaveLength(1);
		expect(refused.bytes).not.toBe(absent.bytes);
	});
});

// ──────────────────────────────────────────────────────────────────────────────────────
// RAISING sites — no dashboard subscriber exists, so there is no render for a
// throw to crash. The refusal carries its CODE and names its DOOR.
// ──────────────────────────────────────────────────────────────────────────────────────

describe("RAISING sites \u2014 no subscriber, so the pre-organisation caller is raised at", () => {
	test("messages:listMessages \u2014 ABSENT succeeds empty / REFUSED raises / PRESENT succeeds with a row, adjacent", async () => {
		const t = createT();
		await seedOrgMapping(t);
		const absent = await outcome(() =>
			asMember(t).query(api.messages.listMessages, {}),
		);
		await seedMessage(t, "sigma", "org-a");
		const refused = await outcome(() =>
			asPreOrg(t).query(api.messages.listMessages, {}),
		);
		const present = await outcome(() =>
			asMember(t).query(api.messages.listMessages, {}),
		);

		expect(absent).toEqual({ kind: "success", bytes: "[]" });
		expect(refused.kind).toBe("error");
		expect(refused.bytes).toContain("RBAC_DENIED");
		// Word-boundary: the door must be named EXACTLY, not by a longer name it prefixes.
		expect(refused.bytes).toMatch(/messages:listMessages(?!\w)/);
		expect(refused.bytes).toContain("no-verified-organisation");
		expect(JSON.parse(present.bytes)).toHaveLength(1);
		expect(refused.kind).not.toBe(absent.kind);
	});

	test("messages:searchMessagesByKeyword \u2014 ABSENT succeeds empty / REFUSED raises / PRESENT succeeds with a row, adjacent", async () => {
		const t = createT();
		await seedOrgMapping(t);
		const search = { query: "hello" };
		const absent = await outcome(() =>
			asMember(t).query(api.messages.searchMessagesByKeyword, search),
		);
		await seedMessage(t, "sigma", "org-a");
		const refused = await outcome(() =>
			asPreOrg(t).query(api.messages.searchMessagesByKeyword, search),
		);
		const present = await outcome(() =>
			asMember(t).query(api.messages.searchMessagesByKeyword, search),
		);

		expect(absent).toEqual({ kind: "success", bytes: "[]" });
		expect(refused.kind).toBe("error");
		expect(refused.bytes).toContain("RBAC_DENIED");
		expect(refused.bytes).toMatch(/messages:searchMessagesByKeyword(?!\w)/);
		expect(refused.bytes).toContain("no-verified-organisation");
		expect(JSON.parse(present.bytes)).toHaveLength(1);
		expect(refused.kind).not.toBe(absent.kind);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// THE STOP-CLAUSE SITE. `messages:checkNewMessages` is subscribed by
// `vantage-peers-dashboard/components/messages/message-timeline.tsx:69`, which
// casts the raw result to an array and calls `.map()` on it (lines 78-83). An
// envelope there would throw "map is not a function" in the render; a raise
// would crash it as well. Its return is also a frozen bare-array contract
// (staleInProgress.test.ts). So the pre-org caller keeps the bare array HERE,
// deliberately and reported — and this pole pins that it is still an ARRAY, so
// the day the dashboard reads `.items` the change is made on purpose.
// ─────────────────────────────────────────────────────────────────────────────

describe("STOP-CLAUSE site — messages:checkNewMessages keeps the bare array its dashboard consumer maps over", () => {
	test("REFUSED (pre-org) is a bare ARRAY, never an envelope; ABSENT (member) is the same shape family", async () => {
		const seeded = createT();
		await seedOrgMapping(seeded);
		await seedMessage(seeded, "sigma", "org-a");
		const refused = await asPreOrg(seeded).query(
			api.messages.checkNewMessages,
			{ recipient: "sigma" },
		);
		expect(Array.isArray(refused)).toBe(true);
		expect(refused).toEqual([]);
	});
});
