/// <reference types="vite/client" />
/**
 * Module M14: the episode doors decide on the verified caller and the org's ID.
 *
 * POLES
 *   (a) AUTHOR     a member's episode is authored by the verified caller
 *                  ("user:<subject>"); a claimed author that is anyone else is
 *                  refused and nothing is written. The master supplies the author
 *                  of the seat it authenticated.
 *   (b) NAMESPACE  a member owns `team/<its org ID>` (and the legacy label alias of
 *                  the SAME verified org); the ID form of another org is refused.
 *   (c) SAME NAME  a different org whose label equals this org's, but whose ID is
 *                  not, reads and writes nothing of it.
 *   (d) ABSENT     a scoped member with no episodes gets an empty SUCCESS.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";
import { asFleet } from "../../tests/lib/asFleet";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const member = (t: T, label: string, id: string, subject: string) =>
	t.withIdentity({
		subject,
		org_slug: label,
		org_id: id,
		org_role: "org:member",
	} as Parameters<typeof t.withIdentity>[0]);

const asService = (t: T) =>
	asFleet(t.withIdentity({ subject: "test-service-account-user-id" }), t);

const ID_A = testClerkOrgId("org-a");
const ID_IMPOSTOR = testClerkOrgId("impostor-org");

async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const [slug, id] of [
			["org-a", ID_A],
			["impostor", ID_IMPOSTOR],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

const EP = {
	context: "c",
	goal: "g",
	action: "a",
	outcome: "o",
	insight: "i",
	severity: "critical" as const,
};

describe("episodes:storeEpisode — the author is the verified caller", () => {
	test("a member claiming another author is refused RBAC_DENIED and nothing is written", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await expect(
			member(t, "org-a", ID_A, "alice").mutation(api.episodes.storeEpisode, {
				namespace: "team/org-a",
				createdBy: "pi",
				...EP,
			}),
		).rejects.toThrow(/RBAC_DENIED.*author-not-caller/s);
		const rows = await t.run((ctx) => ctx.db.query("memories").collect());
		expect(rows).toHaveLength(0);
	});

	test("a member naming itself is stored under the verified author", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await member(t, "org-a", ID_A, "alice").mutation(api.episodes.storeEpisode, {
			namespace: `team/${ID_A}`,
			createdBy: "user:alice",
			...EP,
		});
		const rows = await member(t, "org-a", ID_A, "alice").query(
			api.episodes.listEpisodes,
			{ namespace: `team/${ID_A}` },
		);
		expect(rows.map((r) => r.createdBy)).toEqual(["user:alice"]);
	});

	test("the master keeps supplying the author of the seat it authenticated", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await asService(t).mutation(api.episodes.storeEpisode, {
			namespace: "team/org-a",
			createdBy: "pi",
			...EP,
		});
		const rows = await asService(t).query(api.episodes.listEpisodes, {
			namespace: "team/org-a",
		});
		expect(rows.map((r) => r.createdBy)).toEqual(["pi"]);
	});
});

describe("episodes — the namespace is keyed by the org ID", () => {
	test("a member is refused another org's ID-keyed namespace on write, and served nothing on read", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await expect(
			member(t, "org-a", ID_A, "alice").mutation(api.episodes.storeEpisode, {
				namespace: `team/${ID_IMPOSTOR}`,
				createdBy: "user:alice",
				...EP,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		await asService(t).mutation(api.episodes.storeEpisode, {
			namespace: `team/${ID_IMPOSTOR}`,
			createdBy: "pi",
			...EP,
		});
		expect(
			await member(t, "org-a", ID_A, "alice").query(api.episodes.listEpisodes, {
				namespace: `team/${ID_IMPOSTOR}`,
			}),
		).toEqual([]);
	});

	test("the same label with another org ID reads and writes nothing of the real org's ID namespace", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await asService(t).mutation(api.episodes.storeEpisode, {
			namespace: `team/${ID_A}/notes`,
			createdBy: "pi",
			...EP,
		});
		// A session whose label says "org-a" but whose verified ID is the impostor's.
		const forged = member(t, "org-a", ID_IMPOSTOR, "mallory");
		expect(
			await forged.query(api.episodes.listEpisodes, {
				namespace: `team/${ID_A}/notes`,
			}),
		).toEqual([]);
		expect(await forged.query(api.episodes.getCriticalInsights, {})).toEqual([]);
		await expect(
			forged.mutation(api.episodes.storeEpisode, {
				namespace: `team/${ID_A}/notes`,
				createdBy: "user:mallory",
				...EP,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("getCriticalInsights serves the ID-keyed namespace and its sub-namespaces, not a lookalike ID", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		for (const ns of [
			`team/${ID_A}`,
			`team/${ID_A}/sub`,
			`team/${ID_A}x`,
			"team/org-a",
		]) {
			await asService(t).mutation(api.episodes.storeEpisode, {
				namespace: ns,
				createdBy: "pi",
				...EP,
				insight: ns,
			});
		}
		const rows = await member(t, "org-a", ID_A, "alice").query(
			api.episodes.getCriticalInsights,
			{},
		);
		expect(rows.map((r) => r.namespace).sort()).toEqual(
			[`team/${ID_A}`, `team/${ID_A}/sub`, "team/org-a"].sort(),
		);
	});

	test("ABSENT: a scoped member with no episodes gets an empty success", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const a = member(t, "org-a", ID_A, "alice");
		expect(
			await a.query(api.episodes.listEpisodes, { namespace: `team/${ID_A}` }),
		).toEqual([]);
		expect(await a.query(api.episodes.getCriticalInsights, {})).toEqual([]);
	});
});
