/// <reference types="vite/client" />
/**
 * The durable OKF export keys its job by the RESOLVED organisation, not by a
 * caller argument (backend-standard R-6): `startOkfBundleExportDurable` writes
 * `okfDurableExportProgress.orgId` from the verified scope (the org's permanent
 * Clerk org ID, or the fleet marker for the master), and the namespace the job
 * exports lives in `namespace`. The status and cancel doors judge ownership on
 * that stored `namespace`, so a job whose `orgId` is an org ID (not the
 * namespace) is still served to its owner and refused to everyone else.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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

async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const slug of ["acme", "other"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
		}
		await ctx.db.insert("okfDurableExportProgress", {
			jobId: "job-1",
			orgId: testClerkOrgId("acme"),
			namespace: "team/acme/notes",
			memoriesCursor: null,
			memoriesDone: false,
			briefingsCursor: null,
			briefingsDone: false,
			tasksCursor: null,
			tasksDone: false,
			memoryCount: 0,
			briefingCount: 0,
			taskCount: 0,
			stepsCompleted: 0,
			status: "running",
			createdAt: 1,
			updatedAt: 1,
		});
	});
}

const as = (t: T, slug: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationSlug: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<typeof t.withIdentity>[0]);

async function outcome(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (err) {
		return String((err as { data?: unknown }).data ?? err);
	}
}

describe("okf durable export — ownership is judged on the stored namespace", () => {
	test("PRESENT: the owner passes the status and cancel gates of a job keyed by its org ID", async () => {
		const t = createT();
		await seed(t);
		const status = await outcome(
			as(t, "acme").query(api.okfBundleDurable.getOkfBundleExportDurableStatus, {
				jobId: "job-1",
			}),
		);
		expect(status).not.toMatch(/RBAC_DENIED|AUTH_NAMESPACE_DENIED/);
		const cancel = await outcome(
			as(t, "acme").mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-1",
			}),
		);
		expect(cancel).not.toMatch(/RBAC_DENIED|AUTH_NAMESPACE_DENIED/);
	});

	test("REFUSED: another org is refused both gates", async () => {
		const t = createT();
		await seed(t);
		expect(
			await outcome(
				as(t, "other").query(
					api.okfBundleDurable.getOkfBundleExportDurableStatus,
					{ jobId: "job-1" },
				),
			),
		).toMatch(/RBAC_DENIED/);
		expect(
			await outcome(
				as(t, "other").mutation(
					api.okfBundleDurable.cancelOkfBundleExportDurable,
					{ jobId: "job-1" },
				),
			),
		).toMatch(/RBAC_DENIED/);
	});
});

describe("okf durable export — the start door writes no tenant field from its arguments", () => {
	test("no `orgId:` value in startOkfBundleExportDurable is read from args", () => {
		const src = readFileSync(
			join(__dirname, "..", "okfBundleDurable.ts"),
			"utf8",
		);
		const start = src.slice(
			src.indexOf("export const startOkfBundleExportDurable"),
			src.indexOf("export const _exportOkfBundleStepInternal"),
		);
		const writes = [...start.matchAll(/^\s*orgId:\s*(.+),$/gm)].map((m) => m[1]);
		expect(writes.length).toBe(2);
		for (const w of writes) expect(w).not.toMatch(/\bargs\./);
		const ns = [...start.matchAll(/^\s*namespace:\s*(.+),$/gm)].map((m) => m[1]);
		// The namespace is its own field, written after the door has refused any
		// namespace the resolved scope does not own.
		expect(ns.filter((w) => w !== "v.string()")).toEqual(["args.namespace"]);
		expect(start.indexOf("assertCanExportNamespaceV8(")).toBeLessThan(
			start.indexOf("namespace: args.namespace"),
		);
	});
});
