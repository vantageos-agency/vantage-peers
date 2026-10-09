/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

/** Ordinary org member of org-a: NOT the service account, NOT master. */
const asMemberA = (t: T) =>
	t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
		orgRole: "org:member",
	} as Parameters<typeof t.withIdentity>[0]);
const asMemberB = (t: T) =>
	t.withIdentity({
		subject: "user-org-b",
		organizationId: "org-b",
		orgRole: "org:member",
	} as Parameters<typeof t.withIdentity>[0]);

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		for (const org of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

/**
 * The attribution property: a member either is refused, or the stored author is NOT the
 * forged string. A refusal must be a coded one (RBAC_/AUTH_), never an unrelated crash.
 */
async function expectForgedAuthorNotPersisted(
	call: () => Promise<unknown>,
	storedAuthors: () => Promise<(string | undefined)[]>,
	forged: string,
) {
	let refused = false;
	try {
		await call();
	} catch (e) {
		refused = true;
		expect(String(e)).toMatch(/RBAC_DENIED|AUTH_|createdBy/);
	}
	if (!refused) {
		expect(await storedAuthors()).not.toContain(forged);
	}
}

// R4 RED reproduction — episodes doors (storeEpisode, getCriticalInsights).

const EP = {
	context: "c",
	goal: "g",
	action: "a",
	outcome: "o",
	insight: "i",
	severity: "minor" as const,
};

describe("episodes:storeEpisode", () => {
	test("episodes:storeEpisode — an org-a member cannot author an episode as 'pi' (createdBy bound to the caller or refused)", async () => {
		const t = createT();
		await seedOrgs(t);
		await expectForgedAuthorNotPersisted(
			() =>
				asMemberA(t).mutation(api.episodes.storeEpisode, {
					namespace: "team/org-a",
					createdBy: "pi",
					...EP,
				}),
			async () =>
				(await asMemberA(t).query(api.episodes.listEpisodes, { namespace: "team/org-a" })).map(
					(e) => e.createdBy,
				),
			"pi",
		);
	});

	test("episodes:storeEpisode — positive control: the member's own episode is stored and listed", async () => {
		const t = createT();
		await seedOrgs(t);
		await asMemberA(t).mutation(api.episodes.storeEpisode, {
			namespace: "team/org-a",
			createdBy: "user:user-org-a",
			...EP,
		});
		const rows = await asMemberA(t).query(api.episodes.listEpisodes, { namespace: "team/org-a" });
		expect(rows).toHaveLength(1);
	});
});

describe("episodes:getCriticalInsights", () => {
	test("episodes:getCriticalInsights — an org-a member is served its own row although org-b holds 90x220KB critical episodes (read bounded to the caller's tenant)", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		await seedOrgs(t);
		const BIG = "x".repeat(220_000);
		for (let chunk = 0; chunk < 90; chunk += 30) {
			await t.run(async (ctx) => {
				for (let i = chunk; i < chunk + 30; i++) {
					await ctx.db.insert("memories", {
						namespace: "team/org-b",
						type: "episode",
						content: BIG,
						createdBy: "sigma",
						relations: [],
						isLatest: true,
						episode: { ...EP, severity: "critical", insight: `b${i}` },
						createdAt: i,
						updatedAt: i,
					});
				}
			});
		}
		await t.run((ctx) =>
			ctx.db.insert("memories", {
				namespace: "team/org-a",
				type: "episode",
				content: "own",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				episode: { ...EP, severity: "critical", insight: "own-insight" },
				createdAt: 1000,
				updatedAt: 1000,
			}),
		);
		const rows = await asMemberA(t).query(api.episodes.getCriticalInsights, {});
		expect(rows.map((r) => r.insight)).toEqual(["own-insight"]);
	});

	test("episodes:getCriticalInsights — positive control (small corpus): the member sees only its own critical episode, never org-b's", async () => {
		const t = createT();
		await seedOrgs(t);
		for (const [ns, ins] of [["team/org-a", "own"], ["team/org-b", "foreign"]] as const) {
			await t.run((ctx) =>
				ctx.db.insert("memories", {
					namespace: ns,
					type: "episode",
					content: ins,
					createdBy: "sigma",
					relations: [],
					isLatest: true,
					episode: { ...EP, severity: "critical", insight: ins },
					createdAt: 1,
					updatedAt: 1,
				}),
			);
		}
		const rows = await asMemberA(t).query(api.episodes.getCriticalInsights, {});
		expect(rows.map((r) => r.insight)).toEqual(["own"]);
	});
});
