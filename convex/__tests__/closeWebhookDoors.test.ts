/// <reference types="vite/client" />
/**
 * Two public reads closed against an anonymous caller:
 * `githubRepoMapping:getByRepo` and `missionTemplates:getByName`.
 *
 * Neither table carries an org column, so both are FLEET-MASTER ONLY
 * (`masterOnly`), exactly like `githubRepoMapping:list` and
 * `missionTemplates:listNames`. The HMAC-verified GitHub webhook and
 * `issues:upsertFromGitHub` run with NO identity, so they read through the
 * `internalQuery` twins; the last block proves that path still works.
 *
 * Every DENY pole is an ORDINARY caller — never the service account.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
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
type Q = Pick<T, "query">;
type Identity = Parameters<T["withIdentity"]>[0];

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const MEMBER = "ordinary-member-of-org-a";
const NO_ORG = "ordinary-signed-in-user-with-no-org";

const asMember = (t: T) =>
	t.withIdentity({
		subject: MEMBER,
		organizationId: "org-a",
		organizationSlug: "org-a",
	} as Identity);
const asNoOrg = (t: T) => t.withIdentity({ subject: NO_ORG } as Identity);
const asMaster = (t: T) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Identity);

async function seedOrgA(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const REPO = "acme/door-repo";
const TEMPLATE = "door-template";

async function seedMapping(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("githubRepoMapping", {
			repo: REPO,
			orchestrator: "sigma",
			project: "door-project",
			active: true,
		});
	});
}

async function seedTemplate(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("missionTemplates", {
			name: TEMPLATE,
			steps: [{ title: "S1", description: "d" }],
			isDefault: false,
			createdBy: "sigma",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function expectRefusal(read: () => Promise<unknown>, registration: string) {
	let returned: unknown;
	let caught: unknown;
	let threw = false;
	try {
		returned = await read();
	} catch (e) {
		threw = true;
		caught = e;
	}
	if (!threw) {
		throw new Error(
			`${registration} answered instead of refusing. Got: ${JSON.stringify(returned)}`,
		);
	}
	expect(caught).toBeInstanceOf(ConvexError);
	const data = String((caught as ConvexError<string>).data);
	expect(data).toContain("RBAC_DENIED");
	expect(data).toContain(registration);
}

const DOORS = [
	{
		registration: "githubRepoMapping:getByRepo",
		seed: seedMapping,
		read: (c: Q) => c.query(api.githubRepoMapping.getByRepo, { repo: REPO }),
		readMissing: (c: Q) =>
			c.query(api.githubRepoMapping.getByRepo, { repo: "acme/none" }),
		present: (v: unknown) => (v as { project: string }).project === "door-project",
	},
	{
		registration: "missionTemplates:getByName",
		seed: seedTemplate,
		read: (c: Q) => c.query(api.missionTemplates.getByName, { name: TEMPLATE }),
		readMissing: (c: Q) =>
			c.query(api.missionTemplates.getByName, { name: "none" }),
		present: (v: unknown) => (v as { name: string }).name === TEMPLATE,
	},
];

for (const door of DOORS) {
	describe(door.registration, () => {
		test("guard: deny-pole subjects are not the service account", () => {
			expect([MEMBER, NO_ORG]).not.toContain(SERVICE_ACCOUNT_USER_ID);
		});

		test("REFUSED: anonymous caller RAISES RBAC_DENIED over a seeded table", async () => {
			const t = createT();
			await door.seed(t);
			await expectRefusal(() => door.read(t), door.registration);
		});

		test("REFUSED: signed-in caller with no organisation RAISES", async () => {
			const t = createT();
			await door.seed(t);
			await expectRefusal(() => door.read(asNoOrg(t)), door.registration);
		});

		test("REFUSED: ordinary org member RAISES (master-only, no org column)", async () => {
			const t = createT();
			await seedOrgA(t);
			await door.seed(t);
			await expectRefusal(() => door.read(asMember(t)), door.registration);
		});

		test("PRESENT: fleet master is served the row", async () => {
			const t = createT();
			await door.seed(t);
			expect(door.present(await door.read(asMaster(t)))).toBe(true);
		});

		test("ABSENT: fleet master reading a missing key gets a null success", async () => {
			const t = createT();
			expect(await door.readMissing(asMaster(t))).toBeNull();
		});
	});
}

describe("server-side path: internal twins serve with NO identity", () => {
	test("githubRepoMapping:getByRepoInternal returns the row, anonymously", async () => {
		const t = createT();
		await seedMapping(t);
		const row = await t.query(internal.githubRepoMapping.getByRepoInternal, {
			repo: REPO,
		});
		expect(row?.project).toBe("door-project");
		expect(
			await t.query(internal.githubRepoMapping.getByRepoInternal, {
				repo: "acme/none",
			}),
		).toBeNull();
	});

	test("missionTemplates:getByNameInternal returns the row, anonymously, and hides soft-deleted", async () => {
		const t = createT();
		await seedTemplate(t);
		const row = await t.query(internal.missionTemplates.getByNameInternal, {
			name: TEMPLATE,
		});
		expect(row?.name).toBe(TEMPLATE);
		await t.run(async (ctx) => {
			const doc = await ctx.db
				.query("missionTemplates")
				.withIndex("by_name", (q) => q.eq("name", TEMPLATE))
				.unique();
			if (doc) await ctx.db.patch(doc._id, { deletedAt: Date.now() });
		});
		expect(
			await t.query(internal.missionTemplates.getByNameInternal, {
				name: TEMPLATE,
			}),
		).toBeNull();
	});

	test("webhook POST /github/webhook (no identity) still resolves the mapping", async () => {
		delete process.env.GITHUB_WEBHOOK_SECRET;
		const t = createT();
		await seedMapping(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("profiles", {
				orchestratorId: "sigma",
				name: "sigma",
				static: { role: "sigma", workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			});
		});
		const res = await t.fetch("/github/webhook", {
			method: "POST",
			headers: { "x-github-event": "issues", "content-type": "application/json" },
			body: JSON.stringify({
				action: "opened",
				repository: { full_name: REPO },
				issue: {
					number: 7,
					title: "door test",
					body: "b",
					html_url: "https://github.com/acme/door-repo/issues/7",
					labels: [],
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
				},
			}),
		});
		// Mapped (not "unmapped repo"), then reached the template read (none seeded).
		expect(await res.text()).toBe("OK - no template");
		const issue = await t.run(async (ctx) =>
			ctx.db
				.query("issues")
				.withIndex("by_repo_number", (q) => q.eq("repo", REPO).eq("issueNumber", 7))
				.unique(),
		);
		// project comes from the mapping read inside issues:upsertFromGitHub.
		expect(issue?.project).toBe("door-project");
		expect(issue?.assignedOrchestrator).toBe("sigma");
	});
});
