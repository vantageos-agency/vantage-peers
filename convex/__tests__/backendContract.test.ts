/// <reference types="vite/client" />
/**
 * BACKEND CONTRACT MANIFEST -- convex/meta.ts `backendContract`.
 *
 * Task k1716jehh2mhy4xah4js2804g58g4nsc (part 3). On 2026-10-12 the Railway MCP
 * auto-deployed main while Convex prod was still an older build: the MCP called
 * oauth:rotateRefreshToken and passed new arguments to a backend that did not
 * have them, for hours. The MCP now refuses to boot against a backend that does
 * not expose every public function it calls. This file pins the BACKEND half:
 *
 *   1. SYNC     -- the committed manifest (convex/lib/backendManifest.ts) lists
 *                  exactly the public registrations in convex/ (source-derived).
 *                  A function added or removed without regenerating it fails.
 *                  Regenerate: `node scripts/gen-backend-manifest.mjs`.
 *   2. ALLOW    -- the fleet service account (the MCP's own identity) reads it.
 *   3. REFUSED  -- an anonymous caller and an ordinary org member are RAISED at
 *                  with RBAC_DENIED naming the door (refusal is not an absence).
 *   4. SHAPE    -- function identifiers and a version only: no argument, no
 *                  secret, no value from any table.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { listPublicConvexFunctions } from "../../scripts/lib/convex-public-functions.mjs";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import {
	BACKEND_CONTRACT_VERSION,
	BACKEND_FUNCTIONS,
} from "../lib/backendManifest";
import schema from "../schema";

const CONVEX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);

const asMaster = (t: ReturnType<typeof createT>) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Parameters<
		typeof t.withIdentity
	>[0]);

describe("SYNC -- the manifest is the public surface of convex/", () => {
	const source: string[] = listPublicConvexFunctions(CONVEX_DIR);

	test("source enumeration is non-empty and agrees with a naive text count", () => {
		expect(source.length).toBeGreaterThan(100);
		let naive = 0;
		for (const id of source) {
			const [mod, fn] = id.split(":");
			const text = readFileSync(join(CONVEX_DIR, `${mod}.ts`), "utf8");
			const re = new RegExp(
				`^export const ${fn}\\s*=\\s*(query|mutation|action)\\b`,
				"m",
			);
			if (re.test(text)) naive += 1;
		}
		expect(naive).toBe(source.length);
	});

	test("manifest equals the source-derived public surface, both directions", () => {
		const have = new Set<string>(BACKEND_FUNCTIONS);
		const want = new Set<string>(source);
		const missingFromManifest = [...want].filter((f) => !have.has(f));
		const staleInManifest = [...have].filter((f) => !want.has(f));
		expect(
			{ missingFromManifest, staleInManifest },
			"regenerate with: node scripts/gen-backend-manifest.mjs",
		).toEqual({ missingFromManifest: [], staleInManifest: [] });
	});

	test("manifest lists its own door and is sorted, unique, well-formed", () => {
		expect(BACKEND_FUNCTIONS).toContain("meta:backendContract");
		expect([...BACKEND_FUNCTIONS]).toEqual(
			[...new Set(BACKEND_FUNCTIONS)].sort(),
		);
		for (const id of BACKEND_FUNCTIONS) {
			expect(id).toMatch(/^[A-Za-z0-9_/]+:[A-Za-z0-9_]+$/);
		}
		expect(Number.isInteger(BACKEND_CONTRACT_VERSION)).toBe(true);
		expect(BACKEND_CONTRACT_VERSION).toBeGreaterThanOrEqual(1);
	});
});

describe("ALLOW -- the MCP's own identity reads the manifest", () => {
	test("service account gets the version and the full function list", async () => {
		const t = createT();
		const out = await asMaster(t).query(api.meta.backendContract, {});
		expect(out.contractVersion).toBe(BACKEND_CONTRACT_VERSION);
		expect(out.functions).toEqual([...BACKEND_FUNCTIONS]);
		expect(out.functionCount).toBe(BACKEND_FUNCTIONS.length);
		expect(Object.keys(out).sort()).toEqual([
			"contractVersion",
			"functionCount",
			"functions",
		]);
	});
});

describe("REFUSED -- a refusal says so, it is not an empty success", () => {
	async function refusal(read: () => Promise<unknown>): Promise<string> {
		let caught: unknown;
		let returned: unknown;
		try {
			returned = await read();
		} catch (e) {
			caught = e;
		}
		if (caught === undefined) {
			throw new Error(
				`meta:backendContract answered a non-service caller with a success: ${JSON.stringify(returned)}`,
			);
		}
		expect(caught).toBeInstanceOf(ConvexError);
		return String((caught as ConvexError<string>).data);
	}

	test("anonymous caller is raised at, naming the door", async () => {
		const t = createT();
		const data = await refusal(() => t.query(api.meta.backendContract, {}));
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("meta:backendContract");
	});

	test("an ordinary member of an active org is raised at too", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: "org-a",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		const member = t.withIdentity({
			subject: "ordinary-member-of-org-a",
			organizationId: "org-a",
			org_id: testClerkOrgId("org-a"),
			organizationSlug: "org-a",
		} as Parameters<typeof t.withIdentity>[0]);
		const data = await refusal(() =>
			member.query(api.meta.backendContract, {}),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("meta:backendContract");
	});
});

describe("SHAPE -- identifiers only, nothing sensitive", () => {
	test("takes no argument and returns no row data", async () => {
		const source = readFileSync(join(CONVEX_DIR, "meta.ts"), "utf8");
		expect(source).toMatch(/args:\s*\{\s*\}/);
		expect(source).not.toMatch(/ctx\.db\./);
		expect(source).not.toMatch(/process\.env/);
	});
});
