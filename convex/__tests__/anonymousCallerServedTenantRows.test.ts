/// <reference types="vite/client" />
/**
 * A caller presenting NO CREDENTIAL, and a caller with no verified
 * organisation, are never served another tenant's rows — AUTH_NAMESPACE_DENIED
 * class, closed at the Convex public-function boundary.
 *
 * THE MEASURED DEFECT this suite pins (against LIVE production, before the
 * fix): two public Convex functions returned real tenant rows to an
 * unauthenticated caller straight off the open internet —
 *
 *   POST https://compassionate-goldfinch-737.convex.cloud/api/query
 *     {"path":"memoriesScoped:listMemoriesScoped","args":{"namespace":"global","limit":3}}
 *       -> {"status":"success", 3 rows of real memory content}
 *     {"path":"episodes:getCriticalInsights","args":{"limit":3}}
 *       -> {"status":"success", 3 rows}
 *
 * The MCP server's tool-layer `enforceScope` does NOT defend these: a PUBLIC
 * Convex function is reachable directly at the deployment URL, which is
 * exactly how the measurement above was taken. Standing precedent in this
 * repository: `oauth.getScopeProfile` — a guard in the transport layer is not
 * a defence for a public Convex function. Both rules in `.claude/rules/` say
 * this from their two sides: `authority-attached-to-anonymous-object.md` (the
 * data join) and `http-boundary-derives-from-principal.md` (the transport key).
 *
 * WHY THE IDENTITIES BELOW ARE ORDINARY, NEVER MASTER: a suite that
 * authenticates as master (`allowNoIdentityMaster`) or as the configured
 * service account (`CLERK_SERVICE_ACCOUNT_USER_ID`, "test-service-account-user-id"
 * in vitest.config.ts) would pass with the authorization DELETED and proves
 * nothing. Every caller constructed here is a plain scoped org member, or has
 * no identity at all. `ORDINARY_*` subjects are asserted to differ from the
 * service-account id so a future config change cannot silently turn these
 * into master callers.
 *
 * THE THREE POLES, per the brief:
 *   1. no verified organisation -> a converted READ yields a TYPED EMPTY
 *      value, never rows (a reactively-subscribed query that THROWS crashes
 *      the subscriber's render, so a read refuses with a typed empty value
 *      gated on the resolved scope — see withOrgScope's `refuseWithoutThrow`).
 *   2. org A cannot read org B's rows through any of these functions.
 *   3. a WRITE with no verified organisation is REFUSED BY THROW (a chosen,
 *      imperative call has a call site to catch it; a write refusal is never
 *      converted into a typed empty value).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

// `search` is excluded here for the SAME reason every pre-existing suite in
// this directory excludes it (see client-scope-global-namespace.test.ts,
// kb-ingest.test.ts): convex/search.ts is a "use node" module that builds its
// RAG client at MODULE LOAD time via getAITextEmbeddingProvider(), which
// requires a live AI_GATEWAY_API_KEY/OPENAI_API_KEY. It cannot be loaded under
// convex-test at all. The three search.ts actions are therefore NOT covered by
// this suite — see the final report; they are fixed but their coverage is by
// the pure decision helper, not end-to-end here.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const ORDINARY_A = "ordinary-member-of-org-a";
const ORDINARY_B = "ordinary-member-of-org-b";
const ORDINARY_NO_ORG = "ordinary-signed-in-user-with-no-org";

// Guard the guard: if any of these ever equalled the configured service
// account, withOrgScope's by-id master carve-out would fire and every
// assertion below would pass vacuously.
for (const subject of [ORDINARY_A, ORDINARY_B, ORDINARY_NO_ORG]) {
	if (subject === SERVICE_ACCOUNT_USER_ID) {
		throw new Error(
			`test-integrity: ${subject} must not be the service-account id — ` +
				"these callers must be ORDINARY, never master",
		);
	}
}

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

/** An ordinary, non-master member of `orgSlug`. */
const asOrgMember = (
	t: ReturnType<typeof createT>,
	subject: string,
	orgSlug: string,
) =>
	t.withIdentity({
		subject,
		organizationId: orgSlug,
		organizationSlug: orgSlug,
	} as Parameters<typeof t.withIdentity>[0]);

/** Signed in, but has not joined/created an organisation yet. */
const asNoOrg = (t: ReturnType<typeof createT>) =>
	t.withIdentity({ subject: ORDINARY_NO_ORG } as Parameters<
		typeof t.withIdentity
	>[0]);

async function seedMemory(
	t: ReturnType<typeof createT>,
	namespace: string,
	content: string,
	extra: { type?: "project" | "reference"; episode?: unknown } = {},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("memories", {
			namespace,
			type: (extra.type ?? "project") as "project",
			content,
			createdBy: "sigma",
			relations: [],
			isLatest: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function seedEpisode(
	t: ReturnType<typeof createT>,
	namespace: string,
	insight: string,
	severity: "minor" | "major" | "critical" = "critical",
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("memories", {
			namespace,
			type: "episode",
			content: insight,
			createdBy: "sigma",
			relations: [],
			isLatest: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			episode: {
				context: `context for ${insight}`,
				goal: "goal",
				action: "action",
				outcome: "outcome",
				insight,
				severity,
			},
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// POLE 1 + 2 — READS. episodes.ts::listEpisodes
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTH_NAMESPACE_DENIED — episodes:listEpisodes", () => {
	test("anonymous caller (no credential at all) is served NO rows", async () => {
		const t = createT();
		await seedEpisode(t, "team/org-a", "org-a private lesson");

		const rows = await t.query(api.episodes.listEpisodes, {
			namespace: "team/org-a",
		});

		expect(rows).toEqual([]);
	});

	test("signed-in caller with NO verified organisation gets a typed empty array, never rows", async () => {
		const t = createT();
		await seedEpisode(t, "team/org-a", "org-a private lesson");

		const rows = await asNoOrg(t).query(api.episodes.listEpisodes, {
			namespace: "team/org-a",
		});

		expect(rows).toEqual([]);
	});

	test("org A cannot read org B's episodes — AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		await seedEpisode(t, "team/org-b", "org-b private lesson");

		const rows = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.episodes.listEpisodes,
			{ namespace: "team/org-b" },
		);

		expect(rows).toEqual([]);
	});

	test("ALLOW pole — org A DOES read its own episodes (the grant must produce access)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedEpisode(t, "team/org-a", "org-a own lesson");

		const rows = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.episodes.listEpisodes,
			{ namespace: "team/org-a" },
		);

		expect(rows).toHaveLength(1);
		expect(rows[0].episode.insight).toBe("org-a own lesson");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POLE 1 + 2 — READS. episodes.ts::getCriticalInsights
// This one takes NO namespace argument: it is cross-namespace BY DESIGN, which
// is precisely why an anonymous caller reading it drains every tenant at once.
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTH_NAMESPACE_DENIED — episodes:getCriticalInsights (cross-namespace by design)", () => {
	test("anonymous caller (the CONFIRMED production leak) is served NO rows", async () => {
		const t = createT();
		await seedEpisode(t, "team/org-a", "org-a critical");
		await seedEpisode(t, "team/org-b", "org-b critical");

		const rows = await t.query(api.episodes.getCriticalInsights, {});

		expect(rows).toEqual([]);
	});

	test("signed-in caller with NO verified organisation gets a typed empty array", async () => {
		const t = createT();
		await seedEpisode(t, "team/org-a", "org-a critical");

		const rows = await asNoOrg(t).query(api.episodes.getCriticalInsights, {});

		expect(rows).toEqual([]);
	});

	test("org A sees ONLY its own critical insights, never org B's — AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		await seedEpisode(t, "team/org-a", "org-a critical");
		await seedEpisode(t, "team/org-b", "org-b critical");

		const rows = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.episodes.getCriticalInsights,
			{},
		);

		expect(rows.map((r) => r.insight)).toEqual(["org-a critical"]);
		expect(rows.every((r) => r.namespace === "team/org-a")).toBe(true);
	});

	test("the SAME org resolved for two DIFFERENT subjects yields IDENTICAL rows (identical inputs, identical outputs)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedEpisode(t, "team/org-a", "org-a critical");
		await seedEpisode(t, "team/org-b", "org-b critical");

		const first = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.episodes.getCriticalInsights,
			{},
		);
		const second = await asOrgMember(t, "a-second-ordinary-subject", "org-a").query(
			api.episodes.getCriticalInsights,
			{},
		);

		expect(second).toEqual(first);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POLE 1 + 2 — READS. profiles.ts::getProfileWithMemories
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTH_NAMESPACE_DENIED — profiles:getProfileWithMemories", () => {
	test("anonymous caller is served NO memories", async () => {
		const t = createT();
		await seedMemory(t, "team/org-a", "org-a private memory");

		const res = await t.query(api.profiles.getProfileWithMemories, {
			orchestratorId: "sigma",
			namespace: "team/org-a",
		});

		expect(res.memories).toEqual([]);
		expect(res.profile).toBeNull();
	});

	test("signed-in caller with NO verified organisation gets a typed empty result", async () => {
		const t = createT();
		await seedMemory(t, "team/org-a", "org-a private memory");

		const res = await asNoOrg(t).query(api.profiles.getProfileWithMemories, {
			orchestratorId: "sigma",
			namespace: "team/org-a",
		});

		expect(res.memories).toEqual([]);
		expect(res.profile).toBeNull();
	});

	test("org A cannot read org B's memories through the profile surface — AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		await seedMemory(t, "team/org-b", "org-b private memory");

		const res = await asOrgMember(t, ORDINARY_B, "org-a").query(
			api.profiles.getProfileWithMemories,
			{ orchestratorId: "sigma", namespace: "team/org-b" },
		);

		expect(res.memories).toEqual([]);
	});

	test("ALLOW pole — org A DOES read its own memories through the profile surface", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedMemory(t, "team/org-a", "org-a own memory");

		const res = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.profiles.getProfileWithMemories,
			{ orchestratorId: "sigma", namespace: "team/org-a" },
		);

		expect(res.memories.map((m) => m.content)).toEqual(["org-a own memory"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POLE 1 + 2 — READS. memoriesScoped.ts::listMemoriesScoped
//
// This site is NOT the "no identity-consulting call" shape the brief's scanner
// reported. It DOES call ctx.auth.getUserIdentity() — via resolveOrgId — and
// then FAILS OPEN: `if (!identity) return null` resolves an anonymous caller
// to the MASTER branch (null == "all namespaces allowed"). The verified
// principal is consulted and then discarded in favour of a populated default,
// which is the exact defect authority-attached-to-anonymous-object.md names.
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTH_NAMESPACE_DENIED — memoriesScoped:listMemoriesScoped (fails OPEN, not unguarded)", () => {
	test("anonymous caller (the CONFIRMED production leak) is served NO rows", async () => {
		const t = createT();
		await seedMemory(t, "global", "fleet-common row that leaked in production");

		const rows = await t.query(api.memoriesScoped.listMemoriesScoped, {
			namespace: "global",
			limit: 3,
		});

		expect(rows).toEqual([]);
	});

	test("signed-in caller with NO verified organisation gets a typed empty array, never rows", async () => {
		const t = createT();
		await seedMemory(t, "team/org-a", "org-a private memory");

		const rows = await asNoOrg(t).query(
			api.memoriesScoped.listMemoriesScoped,
			{ namespace: "team/org-a" },
		);

		expect(rows).toEqual([]);
	});

	test("ALLOW pole — org A DOES read its own team namespace", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedMemory(t, "team/org-a", "org-a own memory");

		const rows = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.memoriesScoped.listMemoriesScoped,
			{ namespace: "team/org-a" },
		);

		expect(rows.map((r) => r.content)).toEqual(["org-a own memory"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POLE 3 — WRITES refuse BY THROW, never by a typed empty value.
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTH_NAMESPACE_DENIED — writes refuse by THROW", () => {
	test("memoriesScoped:storeMemoryScoped — anonymous caller is REFUSED by throw", async () => {
		const t = createT();

		await expect(
			t.mutation(api.memoriesScoped.storeMemoryScoped, {
				namespace: "team/org-a",
				type: "project",
				content: "written by nobody",
				createdBy: "sigma",
			}),
		).rejects.toThrow();

		// And nothing was written.
		const written = await t.run(async (ctx) =>
			ctx.db.query("memories").collect(),
		);
		expect(written).toEqual([]);
	});

	test("memoriesScoped:storeMemoryScoped — signed-in caller with NO verified organisation is REFUSED by throw", async () => {
		const t = createT();

		await expect(
			asNoOrg(t).mutation(api.memoriesScoped.storeMemoryScoped, {
				namespace: "team/org-a",
				type: "project",
				content: "written with no org",
				createdBy: "sigma",
			}),
		).rejects.toThrow();

		const written = await t.run(async (ctx) =>
			ctx.db.query("memories").collect(),
		);
		expect(written).toEqual([]);
	});

	test("ALLOW pole — org A DOES write into its own team namespace", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");

		const id = await asOrgMember(t, ORDINARY_A, "org-a").mutation(
			api.memoriesScoped.storeMemoryScoped,
			{
				namespace: "team/org-a",
				type: "project",
				content: "org-a legitimate write",
				createdBy: "sigma",
			},
		);

		expect(id).toBeTruthy();
	});

	test("kb:softDeleteDocument — anonymous caller is REFUSED by throw (orgId arg is caller-supplied, not authority)", async () => {
		const t = createT();
		await seedMemory(t, "team/org-a/doc-1", "org-a chunk", {
			type: "reference",
		});

		// The CODE and the DOOR are asserted, not merely "it threw". The anonymous
		// caller is refused by requireResolvedCaller (resolveKbCaller in
		// convex/kb.ts) BEFORE the claimed-org comparison: `RBAC_DENIED` naming
		// `kb:softDeleteDocument`, the same code every refused read and write in this
		// repo raises (.claude/rules/refusal-is-distinguishable-from-absence.md).
		// This pin used to match the message of assertScopeAuthorizesOrg's
		// no-organisation branch; closeDoorsKb.test.ts pins the full poles.
		await expect(
			t.action(api.kb.softDeleteDocument, {
				docId: "doc-1",
				orgId: "org-a",
				namespace: "team/org-a",
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*kb:softDeleteDocument/);

		// The chunk is untouched — still isLatest.
		const rows = await t.run(async (ctx) =>
			ctx.db.query("memories").collect(),
		);
		expect(rows.every((r) => r.isLatest === true)).toBe(true);
	});

	test("kb:softDeleteDocument — org A cannot soft-delete org B's document by simply CLAIMING orgId=org-b", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		await seedMemory(t, "team/org-b/doc-b", "org-b chunk", {
			type: "reference",
		});

		await expect(
			asOrgMember(t, ORDINARY_A, "org-a").action(api.kb.softDeleteDocument, {
				docId: "doc-b",
				orgId: "org-b",
				namespace: "team/org-b",
			}),
		).rejects.toThrow(
			'verified organisation "org-a" may not act on claimed org "org-b"',
		);

		const rows = await t.run(async (ctx) =>
			ctx.db.query("memories").collect(),
		);
		expect(rows.every((r) => r.isLatest === true)).toBe(true);
	});

	test("ALLOW pole — org A DOES soft-delete its OWN document", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedMemory(t, "team/org-a/doc-1", "org-a chunk", {
			type: "reference",
		});

		const res = await asOrgMember(t, ORDINARY_A, "org-a").action(
			api.kb.softDeleteDocument,
			{ docId: "doc-1", orgId: "org-a", namespace: "team/org-a" },
		);

		expect(res.markedCount).toBe(1);
	});
});
