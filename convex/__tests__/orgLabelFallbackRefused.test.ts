/// <reference types="vite/client" />
// orgLabelFallbackRefused.test.ts - M4, ruling (2): an organisation is never
// resolved from its label (slug) on a request path. A miss on the ID-keyed
// mapping lookup REFUSES with RBAC_DENIED; it never falls back to the mapping a
// label names, and a row stamped with a label only is not the caller's row.
//
// Poles, each under an ORDINARY member identity (never the master, never the
// service account):
//   MAPPING-WITHOUT-ID  the credential's org_id names no mapping row, while a
//                       mapping with the SAME slug exists (its ID not filled):
//                       REFUSED, on a read door and on a write door.
//   SLUG-ONLY CREDENTIAL a credential carrying a slug and no org_id, while the
//                       mapping that slug names exists and is active: REFUSED.
//   ROW-LABEL-ONLY      a row stamped with the caller org's slug but no org ID
//                       is not the caller's row: the write is refused
//                       `row-not-in-caller-org` and the row is untouched.
//   PRESENT             the same member, resolved by ID, writes a row stamped
//                       with its ID (no grant is withheld from an ID-keyed row).
//   SOURCE              no non-test source in convex/ or mcp-server/src turns
//                       `labelFallback` on.
// Hermetic: fictitious identifiers only.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

const LEAD = "lead-seat";
const NOW = 1_700_000_000_000;
const ACME = { slug: "acme", id: "org_ACME1" };

const withClaims = (t: T, claims: Record<string, string>) =>
	t.withIdentity({
		subject: "member-of-acme",
		...claims,
	} as Parameters<T["withIdentity"]>[0]);

const mapping = (slug: string, id: string | undefined) => ({
	clerkOrgSlug: slug,
	allowedOrchestrators: [LEAD],
	scopes: ["view-own-tasks", "view-own-missions"],
	displayName: slug,
	isActive: true,
	createdAt: NOW,
	...(id !== undefined ? { clerkOrgId: id } : {}),
});

async function seedBusinessUnit(
	t: T,
	stamp: { orgId: string; clerkOrgId?: string },
) {
	return await t.run(async (ctx) =>
		ctx.db.insert("businessUnits", {
			name: "bu",
			description: "d",
			purpose: "p",
			domain: "x",
			orchestratorId: LEAD,
			status: "live",
			businessModel: "m",
			targetCustomers: "c",
			services: [],
			pricing: "p",
			revenueProjections: { y1: 1, y2: 2, y3: 3 },
			coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
			coreProcesses: [],
			dependencies: [],
			kpis: [],
			managementFee: 10,
			createdAt: NOW,
			updatedAt: NOW,
			...stamp,
		} as never),
	);
}

const buName = (t: T, id: string) =>
	t.run(
		async (ctx) => ((await ctx.db.get(id as never)) as { name: string }).name,
	);

const errorData = (e: unknown): string =>
	e instanceof ConvexError ? JSON.stringify(e.data) : String(e);

async function refusalOf(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (e) {
		return errorData(e);
	}
	return "SERVED";
}

describe("a miss on the ID-keyed mapping refuses; it never falls back to the label", () => {
	test("MAPPING-WITHOUT-ID: org_id names no mapping while a same-slug mapping exists -> RBAC_DENIED", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, undefined));
		});
		const bu = await seedBusinessUnit(t, { orgId: ACME.slug });
		const caller = withClaims(t, {
			organizationSlug: ACME.slug,
			org_id: ACME.id,
		});

		const read = await refusalOf(() =>
			caller.query(api.businessUnits.list, {}),
		);
		expect(read).toContain("RBAC_DENIED");
		expect(read).toContain("org-mapping-not-found");

		const write = await refusalOf(() =>
			caller.mutation(api.businessUnits.update, {
				buId: bu as never,
				callerOrchestrator: LEAD,
				name: "served-by-label",
			}),
		);
		expect(write).toContain("RBAC_DENIED");
		expect(await buName(t, bu)).toBe("bu");
	});

	test("SLUG-ONLY CREDENTIAL: a slug and no org_id is refused although the slug's mapping is active", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, ACME.id));
		});
		const caller = withClaims(t, { organizationSlug: ACME.slug });
		const read = await refusalOf(() =>
			caller.query(api.businessUnits.list, {}),
		);
		expect(read).toContain("RBAC_DENIED");
		expect(read).toContain("no-verified-organisation");
	});

	test("ROW-LABEL-ONLY: a row carrying the caller org's slug but no org ID is not the caller's row", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, ACME.id));
		});
		const bu = await seedBusinessUnit(t, { orgId: ACME.slug });
		const write = await refusalOf(() =>
			withClaims(t, { organizationSlug: ACME.slug, org_id: ACME.id }).mutation(
				api.businessUnits.update,
				{
					buId: bu as never,
					callerOrchestrator: LEAD,
					name: "matched-by-label",
				},
			),
		);
		expect(write).toContain("RBAC_DENIED");
		expect(write).toContain("row-not-in-caller-org");
		expect(await buName(t, bu)).toBe("bu");
	});

	test("PRESENT: the same member, resolved by ID, writes its own ID-stamped row", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, ACME.id));
		});
		const bu = await seedBusinessUnit(t, {
			orgId: ACME.slug,
			clerkOrgId: ACME.id,
		});
		await withClaims(t, {
			organizationSlug: ACME.slug,
			org_id: ACME.id,
		}).mutation(api.businessUnits.update, {
			buId: bu as never,
			callerOrchestrator: LEAD,
			name: "by-id-ok",
		});
		expect(await buName(t, bu)).toBe("by-id-ok");
	});
});

describe("SOURCE: no request path turns the label fallback on", () => {
	const HERE = dirname(fileURLToPath(import.meta.url));
	const ROOTS = [join(HERE, ".."), join(HERE, "..", "..", "mcp-server", "src")];

	function sourceFiles(dir: string, out: string[] = []): string[] {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (["__tests__", "_generated", "node_modules"].includes(name)) continue;
			if (statSync(full).isDirectory()) sourceFiles(full, out);
			else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
		}
		return out;
	}

	const code = (full: string) =>
		readFileSync(full, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

	test("no non-test source names labelFallback", () => {
		const offenders: string[] = [];
		for (const root of ROOTS) {
			for (const file of sourceFiles(root)) {
				if (/\blabelFallback\b/.test(code(file)))
					offenders.push(relative(HERE, file));
			}
		}
		expect(offenders).toEqual([]);
	});
});
