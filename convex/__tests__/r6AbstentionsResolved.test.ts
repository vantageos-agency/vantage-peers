/// <reference types="vite/client" />
/**
 * backend-doctor R-6 "could-not-judge" sites, resolved by proof instead of
 * carried as abstentions. Eight sites:
 *
 *   errorMonitor:addDeployment, errorMonitor:removeDeployment,
 *   githubRepoMapping:add, githubRepoMapping:remove,
 *   issues:updateStatus, issues:linkCommit, issues:verify,
 *   licenses:activate
 *
 * Verdict for all eight: SAFE. The first seven write fleet-internal tables that
 * carry NO tenant column, behind a master-only guard; a member has no boundary
 * to steer. `licenses:activate` is possession-gated by the presented key plus
 * the licensee email, and writes only the row that key hashes to.
 *
 * Every REFUSED caller is an ORDINARY MEMBER of an active org (org-a or org-b),
 * never the master or the service account. Each REFUSED pole compares a full
 * snapshot of the touched table(s) before and after: nothing was written.
 * Each PRESENT pole runs as the fleet service account (the only caller these
 * doors admit by design) and proves the write happened.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";

const asMember = (t: T, orgSlug: string) =>
	t.withIdentity({
		subject: `member-of-${orgSlug}`,
		organizationId: orgSlug,
		organizationSlug: orgSlug,
		org_role: "org:admin",
	} as Identity);
const asMaster = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Identity);

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		for (const [slug, seat] of [
			["org-a", "seat-a"],
			["org-b", "seat-b"],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [seat],
				scopes: ["view-own-missions"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

type Table =
	| "monitoredDeployments"
	| "githubRepoMapping"
	| "issues"
	| "licenses";
const snapshot = (t: T, table: Table) =>
	t.run(async (ctx) => JSON.stringify(await ctx.db.query(table).collect()));

/** Every non-master caller, including one steering toward the other org. */
const NON_MASTER = ["org-a", "org-b"] as const;

// ─── errorMonitor:addDeployment / removeDeployment ──────────────────────────

describe("errorMonitor:addDeployment / removeDeployment — master-only, tenant-less table", () => {
	const dep = {
		name: "prod-main",
		deploymentUrl: "https://x.convex.cloud",
		deployKeyEnvVar: "KEY",
		githubRepo: "acme/widgets",
		orchestrator: "seat-a",
	};

	test("REFUSED: a member of either org cannot add or overwrite a deployment", async () => {
		const t = createT();
		await seedOrgs(t);
		await asMaster(t).mutation(api.errorMonitor.addDeployment, dep);
		const before = await snapshot(t, "monitoredDeployments");
		for (const org of NON_MASTER) {
			await expect(
				asMember(t, org).mutation(api.errorMonitor.addDeployment, {
					...dep,
					deploymentUrl: "https://attacker.example",
					orchestrator: "seat-b",
				}),
			).rejects.toThrow(/RBAC_DENIED/);
			await expect(
				asMember(t, org).mutation(api.errorMonitor.addDeployment, { ...dep, name: "new-one" }),
			).rejects.toThrow(/RBAC_DENIED/);
		}
		expect(await snapshot(t, "monitoredDeployments")).toBe(before);
	});

	test("REFUSED: a member cannot deactivate a deployment", async () => {
		const t = createT();
		await seedOrgs(t);
		await asMaster(t).mutation(api.errorMonitor.addDeployment, dep);
		const before = await snapshot(t, "monitoredDeployments");
		for (const org of NON_MASTER) {
			await expect(
				asMember(t, org).mutation(api.errorMonitor.removeDeployment, { name: dep.name }),
			).rejects.toThrow(/RBAC_DENIED/);
		}
		expect(await snapshot(t, "monitoredDeployments")).toBe(before);
	});

	test("PRESENT: the service account adds, then deactivates", async () => {
		const t = createT();
		const id = await asMaster(t).mutation(api.errorMonitor.addDeployment, dep);
		expect((await t.run((ctx) => ctx.db.get(id)))?.active).toBe(true);
		await asMaster(t).mutation(api.errorMonitor.removeDeployment, { name: dep.name });
		expect((await t.run((ctx) => ctx.db.get(id)))?.active).toBe(false);
	});
});

// ─── githubRepoMapping:add / remove ─────────────────────────────────────────

describe("githubRepoMapping:add / remove — master-only, tenant-less table", () => {
	const row = { repo: "acme/widgets", orchestrator: "seat-a", project: "widgets" };

	test("REFUSED: a member cannot add or re-point a repo mapping", async () => {
		const t = createT();
		await seedOrgs(t);
		await asMaster(t).mutation(api.githubRepoMapping.add, row);
		const before = await snapshot(t, "githubRepoMapping");
		for (const org of NON_MASTER) {
			await expect(
				asMember(t, org).mutation(api.githubRepoMapping.add, { ...row, orchestrator: "seat-b" }),
			).rejects.toThrow(/RBAC_DENIED/);
			await expect(
				asMember(t, org).mutation(api.githubRepoMapping.add, { ...row, repo: "acme/other" }),
			).rejects.toThrow(/RBAC_DENIED/);
		}
		expect(await snapshot(t, "githubRepoMapping")).toBe(before);
	});

	test("REFUSED: a member cannot remove a repo mapping", async () => {
		const t = createT();
		await seedOrgs(t);
		await asMaster(t).mutation(api.githubRepoMapping.add, row);
		const before = await snapshot(t, "githubRepoMapping");
		for (const org of NON_MASTER) {
			await expect(
				asMember(t, org).mutation(api.githubRepoMapping.remove, { repo: row.repo }),
			).rejects.toThrow(/RBAC_DENIED/);
		}
		expect(await snapshot(t, "githubRepoMapping")).toBe(before);
	});

	test("PRESENT: the service account adds (upserts) and removes", async () => {
		const t = createT();
		const id = await asMaster(t).mutation(api.githubRepoMapping.add, row);
		expect((await t.run((ctx) => ctx.db.get(id)))?.orchestrator).toBe("seat-a");
		await asMaster(t).mutation(api.githubRepoMapping.add, { ...row, orchestrator: "seat-c" });
		expect((await t.run((ctx) => ctx.db.get(id)))?.orchestrator).toBe("seat-c");
		const res = await asMaster(t).mutation(api.githubRepoMapping.remove, { repo: row.repo });
		expect(res).toEqual({ deleted: true });
		expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
	});
});

// ─── issues:updateStatus / linkCommit / verify ──────────────────────────────

describe("issues:updateStatus / linkCommit / verify — master-only, tenant-less table", () => {
	const key = { repo: "acme/widgets", issueNumber: 42 };
	const seedIssue = (t: T) =>
		t.run((ctx) =>
			ctx.db.insert("issues", {
				...key,
				title: "seed",
				body: "b",
				htmlUrl: "https://github.com/acme/widgets/issues/42",
				labels: [],
				status: "open",
				priority: "medium",
				assignedOrchestrator: "seat-a",
				project: "widgets",
				githubCreatedAt: 1,
				githubUpdatedAt: 1,
			}),
		);

	test("REFUSED: a member of either org cannot change, link or verify an issue", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedIssue(t);
		const before = await snapshot(t, "issues");
		for (const org of NON_MASTER) {
			const m = asMember(t, org);
			await expect(
				m.mutation(api.issues.updateStatus, { ...key, status: "closed" }),
			).rejects.toThrow(/RBAC_DENIED/);
			await expect(
				m.mutation(api.issues.linkCommit, { ...key, commitSha: "abc1234", fixedBy: "seat-b" }),
			).rejects.toThrow(/RBAC_DENIED/);
			await expect(
				m.mutation(api.issues.verify, { ...key, verifiedBy: "seat-b" }),
			).rejects.toThrow(/RBAC_DENIED/);
		}
		expect(await snapshot(t, "issues")).toBe(before);
	});

	test("PRESENT: the service account updates, links and verifies", async () => {
		const t = createT();
		const id = await seedIssue(t);
		const m = asMaster(t);
		await m.mutation(api.issues.updateStatus, { ...key, status: "in_progress" });
		expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("in_progress");
		await m.mutation(api.issues.linkCommit, { ...key, commitSha: "abc1234", fixedBy: "seat-a" });
		const linked = await t.run((ctx) => ctx.db.get(id));
		expect(linked?.fixCommits).toEqual(["abc1234"]);
		expect(linked?.fixedBy).toBe("seat-a");
		await m.mutation(api.issues.verify, { ...key, verifiedBy: "seat-a" });
		const verified = await t.run((ctx) => ctx.db.get(id));
		expect(verified?.status).toBe("verified");
		expect(verified?.verifiedBy).toBe("seat-a");
	});
});

// ─── licenses:activate ──────────────────────────────────────────────────────

describe("licenses:activate — possession-gated, writes only the presented row", () => {
	const seedLicense = async (t: T, rawKey: string, email: string) => {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
		const keyHash = Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		return t.run((ctx) =>
			ctx.db.insert("licenses", {
				keyHash,
				customerEmail: email,
				productCode: "vantage-peers-self-host",
				tier: "open-core-99-eur-yr",
				purchasedAt: Date.now(),
				expiresAt: Date.now() + 86_400_000,
				status: "active",
			}),
		);
	};

	test("REFUSED: a member cannot activate a licence by steering with another org's email or an unknown key", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedLicense(t, "key-of-b", "b@org-b.example");
		const before = await snapshot(t, "licenses");
		const m = asMember(t, "org-a");
		await expect(
			m.mutation(api.licenses.activate, { licenseKey: "key-of-b", customerEmail: "a@org-a.example" }),
		).rejects.toThrow(/License invalid or expired/);
		await expect(
			m.mutation(api.licenses.activate, { licenseKey: "guess", customerEmail: "b@org-b.example" }),
		).rejects.toThrow(/License invalid or expired/);
		expect(await snapshot(t, "licenses")).toBe(before);
	});

	test("PRESENT: the right key and email activate that row only, whoever the caller is", async () => {
		const t = createT();
		await seedOrgs(t);
		const idA = await seedLicense(t, "key-of-a", "a@org-a.example");
		const idB = await seedLicense(t, "key-of-b", "b@org-b.example");
		await asMember(t, "org-a").mutation(api.licenses.activate, {
			licenseKey: "key-of-a",
			customerEmail: "a@org-a.example",
		});
		expect((await t.run((ctx) => ctx.db.get(idA)))?.activatedAt).toBeTypeOf("number");
		expect((await t.run((ctx) => ctx.db.get(idB)))?.activatedAt).toBeUndefined();
	});
});
