/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// CLASS: a retired (erased / superseded) row never comes back through a read path.
// One test group per table the schema flags as ERASURE (convex/lib/retired.ts
// RETIREMENT): memories (isLatest), missionTemplates (deletedAt), orgMembership
// (deletedAt). The RAG search paths of `memories` are pinned in
// kbRetiredChunkLeavesRag.test.ts; the static conformance of every read site is
// pinned in retiredRowsConformance.test.ts.
//
// Every read below runs under a scoped CLIENT identity (an active member of
// org X, a JWT with org_id), never the service account. missionTemplates is a
// fleet-wide catalog that refuses an org member by design, so for it the client
// pole is "refused, and the retired row is not in what the refusal says", and the
// fleet pole (internal twin / master) is "live names only".

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const X = "org-x";
const X_ID = testClerkOrgId(X);

const asMember = (t: T) =>
	t.withIdentity({
		subject: "user-x",
		organizationId: X,
		organizationSlug: X,
		org_id: X_ID,
	} as Identity);

async function seedOrg(t: T): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: X,
			clerkOrgId: X_ID,
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: X,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

describe("memories (isLatest): a retired memory is not served to an org member", () => {
	async function seed(t: T) {
		return await t.run(async (ctx) => {
			const base = {
				namespace: `team/${X_ID}/notes`,
				type: "project" as const,
				createdBy: "kb" as const,
				relations: [],
				clerkOrgId: X_ID,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			const live = await ctx.db.insert("memories", {
				...base,
				content: "live",
				isLatest: true,
			});
			const dead = await ctx.db.insert("memories", {
				...base,
				content: "dead",
				isLatest: false,
			});
			return { live, dead };
		});
	}

	test("getMemory: a retired memory's ID answers like a missing one; the live one is served", async () => {
		const t = createT();
		await seedOrg(t);
		const { live, dead } = await seed(t);
		expect(
			await asMember(t).query(api.memories.getMemory, { memoryId: dead }),
		).toBeNull();
		const got = await asMember(t).query(api.memories.getMemory, {
			memoryId: live,
		});
		expect(got?._id).toBe(live);
	});

	test("listMemories: a member's includeSuperseded is ignored; no retired row on any branch", async () => {
		const t = createT();
		await seedOrg(t);
		const { live } = await seed(t);
		const ns = `team/${X_ID}/notes`;
		const variants = [
			{ namespace: ns },
			{ namespace: ns, includeSuperseded: true },
			{ namespace: ns, type: "project" as const, includeSuperseded: true },
			{
				namespace: ns,
				includeSuperseded: true,
				paginationOpts: { numItems: 10, cursor: null },
			},
		];
		for (const args of variants) {
			const r = await asMember(t).query(api.memories.listMemories, args);
			expect(r.value.map((m) => m._id)).toEqual([live]);
		}
	});

	test("listEpisodes: a superseded episode is not listed", async () => {
		const t = createT();
		await seedOrg(t);
		const ids = await t.run(async (ctx) => {
			const ep = {
				namespace: `team/${X_ID}/eps`,
				type: "episode" as const,
				createdBy: "kb" as const,
				relations: [],
				clerkOrgId: X_ID,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				episode: {
					context: "c",
					goal: "g",
					action: "a",
					outcome: "o",
					insight: "i",
					severity: "minor" as const,
				},
			};
			const live = await ctx.db.insert("memories", {
				...ep,
				content: "live ep",
				isLatest: true,
			});
			await ctx.db.insert("memories", {
				...ep,
				content: "dead ep",
				isLatest: false,
			});
			return live;
		});
		const rows = await asMember(t).query(api.episodes.listEpisodes, {
			namespace: `team/${X_ID}/eps`,
		});
		expect(rows.map((r) => r._id)).toEqual([ids]);
	});

	test("OKF export fetch: a retired memory is not in the bundle page", async () => {
		const t = createT();
		await seedOrg(t);
		const { live } = await seed(t);
		const page = await t.query(internal.okfBundle._fetchMemoriesForBundle, {
			namespace: `team/${X_ID}/notes`,
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(page.page.map((r: { _id: string }) => r._id)).toEqual([live]);
	});
});

describe("missionTemplates (deletedAt): a soft-deleted template is not served", () => {
	async function seed(t: T) {
		await t.run(async (ctx) => {
			const base = {
				steps: [{ title: "S1", description: "d" }],
				isDefault: false,
				createdBy: "sigma" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			await ctx.db.insert("missionTemplates", { ...base, name: "tpl-live" });
			await ctx.db.insert("missionTemplates", {
				...base,
				name: "tpl-dead",
				deletedAt: Date.now(),
			});
		});
	}

	test("fleet read (internal twin): live name found, retired name is null", async () => {
		const t = createT();
		await seed(t);
		expect(
			(await t.query(internal.missionTemplates.getByNameInternal, {
				name: "tpl-live",
			}))?.name,
		).toBe("tpl-live");
		expect(
			await t.query(internal.missionTemplates.getByNameInternal, {
				name: "tpl-dead",
			}),
		).toBeNull();
	});

	test("org member: the catalog is refused (listNames, getByName); nothing about the retired row is served", async () => {
		const t = createT();
		await seedOrg(t);
		await seed(t);
		const names = await asMember(t)
			.query(api.missionTemplates.listNames, {})
			.catch((e: unknown) => String(e));
		expect(JSON.stringify(names)).not.toContain("tpl-dead");
		const one = await asMember(t)
			.query(api.missionTemplates.getByName, { name: "tpl-dead" })
			.catch((e: unknown) => String(e));
		expect(one === null || typeof one === "string").toBe(true);
	});

	test("master listNames: the retired name is absent", async () => {
		const t = createT();
		await seed(t);
		const names = await t
			.withIdentity({ subject: "test-service-account-user-id" } as Identity)
			.query(api.missionTemplates.listNames, {});
		expect(names).toContain("tpl-live");
		expect(names).not.toContain("tpl-dead");
	});

	test("org member: instantiating a retired template is 'Template not found'", async () => {
		const t = createT();
		await seedOrg(t);
		await seed(t);
		const missionId = await t.run(async (ctx) =>
			ctx.db.insert("missions", {
				name: "m",
				project: "p",
				status: "execute",
				priority: "urgent",
				pilot: "sigma",
				agents: ["sigma"],
				createdBy: "sigma",
				clerkOrgId: X_ID,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		await expect(
			asMember(t).mutation(api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: "tpl-dead",
				missionId,
			}),
		).rejects.toThrow(/Template not found|RBAC_DENIED/);
	});
});

describe("orgMembership (deletedAt): a removed member is not listed", () => {
	test("getMembership: the tombstoned member is absent for an org member reading its own org and itself", async () => {
		const t = createT();
		await seedOrg(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			const row = {
				clerkOrgSlug: X,
				clerkOrgId: X_ID,
				role: "member" as const,
				createdAt: now,
				updatedAt: now,
			};
			await ctx.db.insert("orgMembership", { ...row, clerkUserId: "user-x" });
			await ctx.db.insert("orgMembership", {
				...row,
				clerkUserId: "user-gone",
				deletedAt: now,
			});
		});
		const org = await asMember(t).query(api.orgMembership.getMembership, {
			clerkOrgSlug: X,
		});
		expect(org.map((m) => m.clerkUserId)).toEqual(["user-x"]);
		const self = await asMember(t).query(api.orgMembership.getMembership, {});
		expect(self.map((m) => m.clerkUserId)).toEqual(["user-x"]);
	});
});
