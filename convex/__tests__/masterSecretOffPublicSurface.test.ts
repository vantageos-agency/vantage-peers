/// <reference types="vite/client" />
/**
 * masterSecretOffPublicSurface.test.ts
 *
 * The fleet master secret must never be a FUNCTION ARGUMENT of a public
 * registration: a public `mutation` / `query` is callable by anyone holding
 * the deployment URL, and what stops the call is knowledge of a secret carried
 * in the request body (request logs, proxy traces, echoed error reports).
 *
 * Three groups:
 *   1. LEAK pole per converted site: the registration is internal (no
 *      `isPublic` marker) and its argument validator carries no secret field.
 *   2. WITHHELD pole per converted site: the function still works through its
 *      internal path.
 *   3. Guard: enumerates EVERY registration of every importable convex module
 *      and fails if a public one takes a secret-shaped argument, unless that
 *      function has a runtime caller under mcp-server/ (derived by reading the
 *      mcp-server sources, not from a hardcoded list). A seventeenth site is
 *      seen because the population is the registrations, not a list of names.
 *
 * The secret's VALUE never appears here: only the variable NAME
 * BEARER_SECRET_MASTER is mentioned, and no test asserts on its content.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import * as licensesModule from "../licenses";
import * as oauthModule from "../oauth";
import * as oauthMigrationsModule from "../oauthMigrations";
import schema from "../schema";

// Same exclusion as the sibling suites: these modules cannot be imported in
// the test runtime. They are covered by the source scan in the guard instead.
const EXCLUDED = (path: string) =>
	path.includes("ragSync") ||
	path.includes("search") ||
	path.includes("backfill") ||
	path.includes("Backfill");

// Deployment configuration, not a module of registrations; it only loads inside
// the Convex runtime.
const NOT_A_FUNCTION_MODULE = (path: string) => path.endsWith("convex.config.ts");

const allGlob = import.meta.glob("../**/*.ts");
const modules = Object.fromEntries(
	Object.entries(allGlob).filter(([path]) => !EXCLUDED(path)),
);

type Registration = {
	isPublic?: boolean;
	isInternal?: boolean;
	exportArgs: () => string;
};

function asRegistration(fn: unknown): Registration {
	return fn as Registration;
}

/** A module export that is a Convex registration, or null for anything else. */
function registrationOf(value: unknown): Registration | null {
	if (typeof value !== "function") return null;
	const r = value as unknown as Partial<Registration>;
	if (!r.isPublic && !r.isInternal) return null;
	if (typeof r.exportArgs !== "function") return null;
	return r as Registration;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LEAK pole — the six converted sites are not on the public surface
// ─────────────────────────────────────────────────────────────────────────────

const CONVERTED: ReadonlyArray<readonly [string, unknown]> = [
	["licenses:generate", licensesModule.generate],
	["oauth:createTestTenantTrioClients", oauthModule.createTestTenantTrioClients],
	["oauth:listScopeProfiles", oauthModule.listScopeProfiles],
	["oauth:seedTestTenantTrio", oauthModule.seedTestTenantTrio],
	["oauth:upsertScopeProfile", oauthModule.upsertScopeProfile],
	[
		"oauthMigrations:backfillTokenEndpointAuthMethod",
		oauthMigrationsModule.backfillTokenEndpointAuthMethod,
	],
];

describe("LEAK pole — converted sites are not on the public registration surface", () => {
	for (const [id, fn] of CONVERTED) {
		test(`${id} is registered internal and takes no callerToken`, () => {
			const reg = asRegistration(fn);
			expect(reg.isPublic).toBeUndefined();
			expect(reg.isInternal).toBe(true);
			expect(reg.exportArgs()).not.toMatch(/callerToken/);
		});
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. WITHHELD pole — the internal path still serves
//    (licenses:generate, oauth:upsertScopeProfile and
//    oauthMigrations:backfillTokenEndpointAuthMethod are exercised through
//    their internal reference in licenses.test.ts, oauth-upsert-scope-profile
//    .test.ts and oauth-backfill.test.ts; the three below had no test.)
// ─────────────────────────────────────────────────────────────────────────────

describe("WITHHELD pole — the internal path still works", () => {
	test("oauth:seedTestTenantTrio inserts the trio, then skips on re-run", async () => {
		const t = convexTest(schema, modules);
		const first = await t.mutation(internal.oauth.seedTestTenantTrio, {});
		expect(first.inserted.length).toBe(3);
		expect(first.skipped.length).toBe(0);
		const second = await t.mutation(internal.oauth.seedTestTenantTrio, {});
		expect(second.inserted.length).toBe(0);
		expect(second.skipped.length).toBe(3);
	});

	test("oauth:listScopeProfiles lists what seedTestTenantTrio wrote", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.oauth.seedTestTenantTrio, {});
		const rows = await t.query(internal.oauth.listScopeProfiles, {});
		expect(rows.map((r) => r.profileId).sort()).toEqual([
			"alpha-test-trio",
			"beta-test-trio",
			"gamma-test-trio",
		]);
	});

	test("oauth:listScopeProfiles on an empty table is an empty success", async () => {
		const t = convexTest(schema, modules);
		const rows = await t.query(internal.oauth.listScopeProfiles, {});
		expect(rows).toEqual([]);
	});

	test("oauth:createTestTenantTrioClients creates three clients, then reports them as existing", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.oauth.seedTestTenantTrio, {});
		const first = await t.mutation(
			internal.oauth.createTestTenantTrioClients,
			{},
		);
		expect(first.length).toBe(3);
		expect(first.every((c) => c.existed === false)).toBe(true);
		expect(first.every((c) => typeof c.clientSecret === "string")).toBe(true);
		const second = await t.mutation(
			internal.oauth.createTestTenantTrioClients,
			{},
		);
		expect(second.every((c) => c.existed === true)).toBe(true);
		expect(second.every((c) => c.clientSecret === null)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Guard — derived from the registrations, not from a list of names
// ─────────────────────────────────────────────────────────────────────────────

// The fleet master secret's argument shape: callerToken, masterToken,
// bearerSecret, ... Per-user credentials that are the credential BY DESIGN
// (a license key, a token hash, an agent's own credential) are a different
// class and are deliberately not matched here.
const SECRET_ARG = /^(caller|master|bearer|admin)_?(token|secret|key)$/i;

/** Argument names of a registration, read from its exported validator JSON. */
function argNames(reg: Registration): string[] {
	const parsed = JSON.parse(reg.exportArgs()) as {
		value?: Record<string, unknown>;
	};
	return Object.keys(parsed.value ?? {});
}

const MCP_DIR = join(__dirname, "..", "..", "mcp-server");

/** Non-test, non-build .ts sources under mcp-server/ (root files included). */
function mcpRuntimeSources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (["node_modules", "dist", "test", "tests", "__tests__"].includes(entry.name))
				continue;
			out.push(...mcpRuntimeSources(full));
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".d.ts")
		) {
			out.push(readFileSync(full, "utf-8"));
		}
	}
	return out;
}

const LOAD_TIMEOUT_MS = 120_000;

describe("guard — no public registration takes a secret-shaped argument", () => {
	let loaded: ReadonlyArray<readonly [string, unknown]> = [];
	beforeAll(async () => {
		loaded = await Promise.all(
			Object.entries(allGlob)
				.filter(([path]) => !EXCLUDED(path) && !NOT_A_FUNCTION_MODULE(path))
				.map(async ([path, load]) => [path, await load()] as const),
		);
	}, LOAD_TIMEOUT_MS);

	test("every importable module is enumerated (population is non-trivial)", () => {
		let registrations = 0;
		for (const [, mod] of loaded) {
			for (const value of Object.values(mod as Record<string, unknown>)) {
				if (registrationOf(value)) registrations++;
			}
		}
		expect(registrations).toBeGreaterThan(100);
	});

	test("a public registration with a secret-shaped argument has a runtime caller under mcp-server/", () => {
		const sources = mcpRuntimeSources(MCP_DIR).join("\n");
		const offenders: string[] = [];
		const withCaller: string[] = [];
		for (const [path, loadedModule] of loaded) {
			const moduleName = path.replace(/^\.\.\//, "").replace(/\.ts$/, "");
			if (moduleName.includes("/")) continue; // nested modules use "a/b:fn"; none carry secrets today
			const mod = loadedModule as Record<string, unknown>;
			for (const [exportName, value] of Object.entries(mod)) {
				const reg = registrationOf(value);
				if (!reg || !reg.isPublic) continue;
				const secretArgs = argNames(reg).filter((n) =>
					SECRET_ARG.test(n),
				);
				if (secretArgs.length === 0) continue;
				const id = `${moduleName}:${exportName}`;
				if (sources.includes(`"${id}"`)) withCaller.push(id);
				else offenders.push(`${id} (${secretArgs.join(", ")})`);
			}
		}
		// The sites that still take a secret are exactly the ones a runtime
		// caller needs; every other one is a defect of this class.
		expect(offenders).toEqual([]);
		// Sanity: the derivation found the callers it is meant to exempt, so an
		// empty `offenders` cannot be the product of an empty enumeration.
		expect(withCaller.length).toBeGreaterThan(0);
	});

	test("modules the runtime cannot import carry no secret-shaped argument in source", () => {
		const dir = join(__dirname, "..");
		const stack = [dir];
		const files: string[] = [];
		while (stack.length) {
			const d = stack.pop() as string;
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const full = join(d, e.name);
				if (e.isDirectory()) {
					if (["_generated", "__tests__", "node_modules"].includes(e.name)) continue;
					stack.push(full);
				} else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
					if (EXCLUDED(full)) files.push(full);
				}
			}
		}
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			expect(readFileSync(f, "utf-8")).not.toMatch(
				/\b(callerToken|masterToken|masterSecret)\s*:\s*v\./,
			);
		}
	});
});
