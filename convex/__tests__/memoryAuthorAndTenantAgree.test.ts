/// <reference types="vite/client" />
/**
 * Modules M10a + M14: the memory doors and the episode doors agree.
 *
 * Episodes ARE rows of the `memories` table. Two helpers judge them:
 * `memoryVisibleToScope` (the org stamp, M10a) and `isEpisodeNamespaceAllowed`
 * (the team/<orgId> namespace ownership, M14). They must say the same thing.
 *
 * POLES
 *   (a) CLIENT   a Clerk-JWT member that sends NO author (the MCP forwards none for
 *                a person) is stamped `user:<subject>` on storeMemory,
 *                storeMemoryScoped and storeEpisode; a member that claims ANOTHER
 *                author is refused (`author-not-caller`); the service account keeps
 *                supplying the label of its seat, and must supply one.
 *   (b) AGREE    a row written by either door is readable by the other for the SAME
 *                member, and invisible to a foreign org (also one reusing the label).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

const ID_A = testClerkOrgId("agree-org-a");
const ID_B = testClerkOrgId("agree-org-b");
const ID_IMPOSTOR = testClerkOrgId("agree-impostor");

const member = (t: T, subject: string, orgId: string, slug: string) =>
	t.withIdentity({
		subject,
		org_id: orgId,
		org_slug: slug,
		org_role: "org:member",
	} as Parameters<typeof t.withIdentity>[0]);

const memberA = (t: T) => member(t, "user-a", ID_A, "acme");
const memberB = (t: T) => member(t, "user-b", ID_B, "beta");
// A different organisation (different ID) that carries the SAME label as A.
const impostor = (t: T) => member(t, "user-x", ID_IMPOSTOR, "acme");
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		for (const [slug, id] of [
			["acme", ID_A],
			["beta", ID_B],
			["acme-impostor-label", ID_IMPOSTOR],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
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

async function refusal(p: Promise<unknown>): Promise<string> {
	const err = await p.then(
		() => null,
		(e: Error) => e,
	);
	expect(err, "expected a refusal").not.toBeNull();
	return `${(err as Error).message} ${JSON.stringify((err as { data?: unknown }).data ?? "")}`;
}

let t: T;
beforeEach(async () => {
	t = convexTest(schema, modules);
	await seedOrgs(t);
});

describe("(a) CLIENT: a person's write needs no typed author", () => {
	test("storeMemory without createdBy is stamped user:<subject> and the org ID", async () => {
		const id = await memberA(t).mutation(api.memories.storeMemory, {
			namespace: "team/acme",
			type: "project",
			content: "from Claude.ai",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.createdBy).toBe("user:user-a");
		expect(row?.clerkOrgId).toBe(ID_A);
	});

	test("storeMemoryScoped without createdBy is stamped user:<subject>", async () => {
		const id = await memberA(t).mutation(api.memoriesScoped.storeMemoryScoped, {
			namespace: "team/acme",
			type: "project",
			content: "scoped",
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.createdBy).toBe("user:user-a");
	});

	test("storeEpisode without createdBy is stamped user:<subject> and the org ID", async () => {
		const id = await memberA(t).mutation(api.episodes.storeEpisode, {
			namespace: "team/acme",
			...EP,
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.createdBy).toBe("user:user-a");
		expect(row?.clerkOrgId).toBe(ID_A);
	});

	test("a member's own spelled author still passes", async () => {
		const id = await memberA(t).mutation(api.memories.storeMemory, {
			namespace: "team/acme",
			type: "project",
			content: "own",
			createdBy: "user:user-a",
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.createdBy).toBe("user:user-a");
	});

	test("a member claiming ANOTHER author is refused on all three doors, nothing written", async () => {
		const count = () =>
			t.run(async (ctx) => (await ctx.db.query("memories").collect()).length);
		const before = await count();
		for (const claimed of ["pi", "user:user-b"]) {
			expect(
				await refusal(
					memberA(t).mutation(api.memories.storeMemory, {
						namespace: "team/acme",
						type: "project",
						content: "forged",
						createdBy: claimed,
					}),
				),
			).toMatch(/author-not-caller/);
			expect(
				await refusal(
					memberA(t).mutation(api.memoriesScoped.storeMemoryScoped, {
						namespace: "team/acme",
						type: "project",
						content: "forged",
						createdBy: claimed,
					}),
				),
			).toMatch(/author-not-caller/);
			expect(
				await refusal(
					memberA(t).mutation(api.episodes.storeEpisode, {
						namespace: "team/acme",
						createdBy: claimed,
						...EP,
					}),
				),
			).toMatch(/author-not-caller/);
		}
		expect(await count()).toBe(before);
	});

	test("the service account is unchanged: it supplies the label of its seat", async () => {
		const m = await asService(t).mutation(api.memories.storeMemory, {
			namespace: "team/acme",
			type: "project",
			content: "seat",
			createdBy: "pi",
		});
		const e = await asService(t).mutation(api.episodes.storeEpisode, {
			namespace: "team/acme",
			createdBy: "pi",
			...EP,
		});
		const s = await asService(t).mutation(api.memoriesScoped.storeMemoryScoped, {
			namespace: "team/acme",
			type: "project",
			content: "seat scoped",
			createdBy: "pi",
		});
		for (const id of [m, e, s]) {
			const row = await t.run((ctx) => ctx.db.get(id));
			expect(row?.createdBy).toBe("pi");
			expect(row?.clerkOrgId).toBe(ID_A);
		}
	});

	test("the service account must name an author: none is invented for a seat", async () => {
		expect(
			await refusal(
				asService(t).mutation(api.memories.storeMemory, {
					namespace: "team/acme",
					type: "project",
					content: "no author",
				}),
			),
		).toMatch(/author-required/);
		expect(
			await refusal(
				asService(t).mutation(api.episodes.storeEpisode, {
					namespace: "team/acme",
					...EP,
				}),
			),
		).toMatch(/author-required/);
	});
});

describe("(b) AGREE: one org, one answer, whichever door wrote or reads the row", () => {
	test("an episode written by storeEpisode is read by the memory doors and the episode doors", async () => {
		const id = await memberA(t).mutation(api.episodes.storeEpisode, {
			namespace: "team/acme",
			...EP,
		});
		expect(await memberA(t).query(api.memories.getMemory, { memoryId: id })).not.toBeNull();
		const listed = await memberA(t).query(api.memories.listMemories, {
			namespace: "team/acme",
		});
		expect(listed.value.map((m) => m._id)).toContain(id);
		const scoped = await memberA(t).query(api.memoriesScoped.listMemoriesScoped, {
			namespace: "team/acme",
		});
		expect(scoped.map((m) => m._id)).toContain(id);
		const eps = await memberA(t).query(api.episodes.listEpisodes, {
			namespace: "team/acme",
		});
		expect(eps.map((m) => m._id)).toContain(id);
	});

	test("an episode stored under team/<orgId> is readable through the memory doors too", async () => {
		const ns = `team/${ID_A}`;
		const id = await memberA(t).mutation(api.episodes.storeEpisode, {
			namespace: ns,
			...EP,
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.clerkOrgId).toBe(ID_A);
		expect(await memberA(t).query(api.memories.getMemory, { memoryId: id })).not.toBeNull();
		const listed = await memberA(t).query(api.memories.listMemories, { namespace: ns });
		expect(listed.value.map((m) => m._id)).toEqual([id]);
	});

	test("a memory written by storeMemory (episode payload) is read by the episode doors, at the label and at the ID", async () => {
		for (const ns of ["team/acme", `team/${ID_A}`]) {
			const id = await memberA(t).mutation(api.memories.storeMemory, {
				namespace: ns,
				type: "episode",
				content: "ep via memories",
				episode: { ...EP },
			});
			const eps = await memberA(t).query(api.episodes.listEpisodes, { namespace: ns });
			expect(eps.map((m) => m._id)).toContain(id);
			const crit = await memberA(t).query(api.episodes.getCriticalInsights, {});
			expect(crit.map((m) => m._id)).toContain(id);
		}
	});

	test("the master's write under team/<orgId> is stamped with that org's ID", async () => {
		const id = await asService(t).mutation(api.memories.storeMemory, {
			namespace: `team/${ID_A}`,
			type: "project",
			content: "master under ID namespace",
			createdBy: "pi",
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.clerkOrgId).toBe(ID_A);
		expect(await memberA(t).query(api.memories.getMemory, { memoryId: id })).not.toBeNull();
	});

	test("a foreign org sees neither door's rows; one reusing the label sees nothing of them", async () => {
		const viaEpisodes = await memberA(t).mutation(api.episodes.storeEpisode, {
			namespace: "team/acme",
			...EP,
		});
		const viaMemories = await memberA(t).mutation(api.memories.storeMemory, {
			namespace: "team/acme",
			type: "episode",
			content: "ep via memories",
			episode: { ...EP },
		});
		const ids = [viaEpisodes, viaMemories];
		for (const stranger of [memberB(t), impostor(t)]) {
			for (const id of ids) {
				expect(await stranger.query(api.memories.getMemory, { memoryId: id })).toBeNull();
			}
			const crit = await stranger.query(api.episodes.getCriticalInsights, {});
			expect(crit.map((m) => m._id).filter((i) => ids.includes(i))).toEqual([]);
			const eps = await stranger.query(api.episodes.listEpisodes, {
				namespace: "team/acme",
			});
			expect(eps).toEqual([]);
			const listed = await stranger.query(api.memories.listMemories, {
				namespace: "team/acme",
			});
			expect(listed.value).toEqual([]);
		}
	});
});

describe("(b) AGREE: a label freed by a rename and taken by another org", () => {
	test("the episode doors serve the new holder none of the old holder's rows", async () => {
		const t2 = convexTest(schema, modules);
		await t2.run(async (ctx) => {
			// A was renamed "acme-old"; the impostor org took the freed label "acme".
			for (const [slug, id] of [
				["acme-old", ID_A],
				["acme", ID_IMPOSTOR],
			] as const) {
				await ctx.db.insert("client_org_mapping", {
					clerkOrgSlug: slug,
					clerkOrgId: id,
					allowedOrchestrators: [],
					scopes: ["view-own-tasks"],
					displayName: slug,
					isActive: true,
					createdAt: 1,
				});
			}
		});
		const oldHolderRow = await t2.run((ctx) =>
			ctx.db.insert("memories", {
				namespace: "team/acme",
				type: "episode",
				content: "written by A when it was called acme",
				createdBy: "user:user-a",
				relations: [],
				isLatest: true,
				episode: { ...EP },
				clerkOrgId: ID_A,
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		const newHolder = member(t2, "user-x", ID_IMPOSTOR, "acme");
		expect(
			await newHolder.query(api.memories.getMemory, { memoryId: oldHolderRow }),
		).toBeNull();
		expect(
			await newHolder.query(api.episodes.listEpisodes, { namespace: "team/acme" }),
		).toEqual([]);
		const crit = await newHolder.query(api.episodes.getCriticalInsights, {});
		expect(crit.map((e) => e._id)).not.toContain(oldHolderRow);
	});
});
