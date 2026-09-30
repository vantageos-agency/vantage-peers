/// <reference types="vite/client" />
/**
 * masterSecretOffPublicSurface.test.ts
 *
 * The fleet master secret must never be a FUNCTION ARGUMENT of a public
 * registration: a public `mutation` / `query` is callable by anyone holding
 * the deployment URL, and what stops the call is knowledge of a secret carried
 * in the request body (request logs, proxy traces, echoed error reports).
 *
 * Four groups:
 *   1. LEAK pole per converted site: the registration is internal (no
 *      `isPublic` marker) and its argument validator carries no secret field.
 *   2. WITHHELD pole per converted site: the function still works through its
 *      internal path.
 *   3. Guard: enumerates EVERY registration of every importable convex module,
 *      nested ones included (ids are "a/b:fn"), and fails if a public one
 *      REACHES the fleet master secret, unless that function has a runtime
 *      caller under mcp-server/ (derived by reading the mcp-server sources, not
 *      from a hardcoded list). Reach is the whole judgment: the registration's
 *      own source, or a same-module helper it calls, reads the master secret's
 *      environment variable. What the code then does with the value (compare,
 *      switch on, membership test, log, concatenate) is irrelevant and is not
 *      looked at: a publicly-reachable handler that holds the fleet secret is
 *      the defect. A registration the guard cannot read is a failure.
 *   4. Fixtures: synthetic modules proving the guard refuses a nested planted
 *      registration, a differently-named secret, and an unreadable population.
 *
 * The secret's VALUE never appears here: only the variable NAME
 * BEARER_SECRET_MASTER is mentioned, and no test asserts on its content.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
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
const NOT_A_FUNCTION_MODULE = (path: string) =>
	path.endsWith("convex.config.ts");

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
	[
		"oauth:createTestTenantTrioClients",
		oauthModule.createTestTenantTrioClients,
	],
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
// 3. Guard — derived from the registrations and from what each one REACHES
// ─────────────────────────────────────────────────────────────────────────────

// A secret-looking argument NAME is an additional signal, kept only so that the
// offender's message can name the argument: the accusation is REACH (see
// `reachesMasterSecret`) and does not depend on finding a comparison, a helper
// or an argument. Per-user credentials that are the credential BY DESIGN (a
// license key, a token hash, an agent's own credential) do not read the fleet
// secret and are not accused.
const SECRET_ARG = /^(caller|master|bearer|admin)_?(token|secret|key)$/i;

// THE ANCHOR, named once: the environment variable that holds the master
// secret. The guard derives "reaches the master secret" from a read of
// THIS variable, never from the name of a function. If the deployment ever
// renames the variable this is the one line to change (a guard still pointing
// at the old name would find no secret at all; the sanity test below reads the
// production module that defines the check and fails if it no longer mentions
// this name). It is a variable NAME, not the secret's value.
const MASTER_SECRET_ENV = "BEARER_SECRET_MASTER";

/** Argument names of a registration, read from its exported validator JSON. */
function argNames(reg: Registration): string[] {
	const parsed = JSON.parse(reg.exportArgs()) as {
		value?: Record<string, unknown>;
	};
	return Object.keys(parsed.value ?? {});
}

const CONVEX_DIR = join(__dirname, "..");
const MCP_DIR = join(CONVEX_DIR, "..", "mcp-server");

/** Non-test, non-build .ts sources under mcp-server/ (root files included). */
function mcpRuntimeSources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (
				["node_modules", "dist", "test", "tests", "__tests__"].includes(
					entry.name,
				)
			)
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

/** Source of a convex module by its Convex name ("a/b" for convex/a/b.ts). */
function readConvexModule(moduleName: string): string | null {
	try {
		return readFileSync(join(CONVEX_DIR, `${moduleName}.ts`), "utf-8");
	} catch {
		return null;
	}
}

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
}

/** The text of the call arguments opening at `open` (index of the "("). */
function balancedArguments(code: string, open: number): string {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === "(") depth++;
		else if (code[i] === ")") {
			depth--;
			if (depth === 0) return code.slice(open + 1, i);
		}
	}
	return code.slice(open + 1);
}

/** Entries of an object pattern `{ a, b: alias, c = 1, ...rest }`. */
function patternEntries(
	pattern: string,
): { key: string; local: string; rest: boolean }[] {
	const out: { key: string; local: string; rest: boolean }[] = [];
	for (const raw of pattern.split(",")) {
		const part = raw.trim();
		if (!part) continue;
		const rest = /^\.\.\.\s*([\w$]+)$/.exec(part);
		if (rest) {
			out.push({ key: "", local: rest[1], rest: true });
			continue;
		}
		const m = /^([\w$]+)\s*(?::\s*([\w$]+))?\s*(?:=[\s\S]*)?$/.exec(part);
		if (m) out.push({ key: m[1], local: m[2] ?? m[1], rest: false });
	}
	return out;
}

/** The text of the braces opening at `open` (index of the "{"), braces excluded. */
function balancedBraces(code: string, open: number): string {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === "{") depth++;
		else if (code[i] === "}") {
			depth--;
			if (depth === 0) return code.slice(open + 1, i);
		}
	}
	return code.slice(open + 1);
}

// "The registration reaches the master secret" is a property of the SECRET, not
// of what is done with it. A registration reaches it when its own source, or a
// helper of the same module that it calls, contains a read of the environment
// variable MASTER_SECRET_ENV: the variable's name as a token (`process.env.X`,
// `process.env["X"]`, `env.X`, a destructuring, a key constant), a local or
// module-level name bound to such a read, or a call to a same-module helper that
// itself reaches it (transitively). `requireMasterAuth` is defined in another
// module and reads the secret there, so it is seeded by name; a test below reads
// its definition and fails if it stops reading the variable.
// Limits (named, not silent, pinned by fixtures): a helper DEFINED IN ANOTHER
// module is not followed (only the seeded one); a computed name
// (`process.env[name]`), an aliased env object (`const e = process.env`) and a
// hop through `ctx.runQuery(internal.x.y)` are not read.
const SEED_READERS = ["requireMasterAuth"];

type Facts = {
	/** Names bound to a read of the secret's variable, or to its name. */
	aliases: Set<string>;
	/** Same-module helpers, and the seeded ones, whose body reaches the secret. */
	readers: Set<string>;
};

function mentionsSecretVariable(code: string): boolean {
	return new RegExp(`\\b${MASTER_SECRET_ENV}\\b`).test(code);
}

function escapeName(name: string): string {
	return name.replace(/\$/g, "\\$");
}

/** Whether `code` (comments already stripped) reaches the secret, given `facts`. */
function reachesSecret(code: string, facts: Facts): boolean {
	if (mentionsSecretVariable(code)) return true;
	for (const name of [...facts.aliases, ...facts.readers])
		if (new RegExp(`(?<![\\w$.])${escapeName(name)}(?![\\w$])`).test(code))
			return true;
	return false;
}

type Helper = { name: string; body: string };

/** Functions declared in `code`: `function f(..){..}` and `const f = (..) => ..`. */
function declaredHelpers(code: string): Helper[] {
	const out: Helper[] = [];
	const decl =
		/(?:\bfunction\s+([\w$]+)\s*(?:<[^>(]*>)?\s*\(|\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>(]*>\s*)?\()/g;
	for (const m of code.matchAll(decl)) {
		const name = (m[1] ?? m[2]) as string;
		const open = (m.index as number) + m[0].length - 1;
		const paramText = balancedArguments(code, open);
		const after = open + paramText.length + 2;
		const brace = code.indexOf("{", after);
		const arrow = code.indexOf("=>", after);
		if (arrow !== -1 && (brace === -1 || arrow < brace)) {
			let j = arrow + 2;
			while (j < code.length && /\s/.test(code[j])) j++;
			if (code[j] === "{") out.push({ name, body: balancedBraces(code, j) });
			else {
				const stop = code.slice(j).search(/;|\n/);
				out.push({
					name,
					body: code.slice(j, stop === -1 ? code.length : j + stop),
				});
			}
		} else if (brace !== -1)
			out.push({ name, body: balancedBraces(code, brace) });
	}
	return out;
}

/** Names bound to a read of the secret or to its name: `const m = process.env.X`, `const K = "X"`, `const { X: m } = env`. */
function secretAliases(code: string): Set<string> {
	const out = new Set<string>();
	for (const m of code.matchAll(
		/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*([^;\n]+)/g,
	)) {
		if (mentionsSecretVariable(m[2])) out.add(m[1]);
	}
	for (const m of code.matchAll(
		/\b(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=]+)?=/g,
	)) {
		for (const e of patternEntries(m[1]))
			if (e.key === MASTER_SECRET_ENV) out.add(e.local);
	}
	return out;
}

function moduleFacts(moduleCode: string): Facts {
	const facts: Facts = {
		aliases: secretAliases(moduleCode),
		readers: new Set<string>(SEED_READERS),
	};
	const helpers = declaredHelpers(moduleCode);
	let changed = true;
	while (changed) {
		changed = false;
		for (const h of helpers) {
			if (facts.readers.has(h.name)) continue;
			if (reachesSecret(h.body, facts)) {
				facts.readers.add(h.name);
				changed = true;
			}
		}
	}
	return facts;
}

/**
 * Whether the registration whose source text is `body` reaches the master
 * secret. `moduleSource` is the module the registration lives in (helpers,
 * aliases); it defaults to `body`.
 */
function reachesMasterSecret(
	body: string,
	moduleSource: string = body,
): boolean {
	return reachesSecret(
		stripComments(body),
		moduleFacts(stripComments(moduleSource)),
	);
}

/**
 * The source text of `exportName` inside module `moduleName`, following a
 * `export { x } from "./y.js"` re-export, and the module it was found in.
 * Null when it cannot be located.
 */
function exportSource(
	moduleName: string,
	exportName: string,
	readModule: (name: string) => string | null,
	depth = 0,
): { source: string; module: string } | null {
	const source = readModule(moduleName);
	if (source === null || depth > 4) return null;
	const declared = new RegExp(
		`^export\\s+(?:const|let|var|async\\s+function|function)\\s+${exportName}\\b`,
		"m",
	).exec(source);
	if (declared) {
		const rest = source.slice(declared.index + declared[0].length);
		const next = /^export\s/m.exec(rest);
		return {
			source: source.slice(
				declared.index,
				declared.index + declared[0].length + (next ? next.index : rest.length),
			),
			module: moduleName,
		};
	}
	for (const m of source.matchAll(
		/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
	)) {
		for (const part of m[1].split(",")) {
			const pm = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
			if (!pm || (pm[2] ?? pm[1]) !== exportName) continue;
			const target = posix
				.normalize(posix.join(posix.dirname(moduleName), m[2]))
				.replace(/\.(js|ts)$/, "");
			return exportSource(target, pm[1], readModule, depth + 1);
		}
	}
	return null;
}

type GuardEntry = { path: string; exports: Record<string, unknown> };
type Verdict = {
	/** Public, reaches the master secret, no runtime caller under mcp-server/. */
	offenders: string[];
	/** Public, reaches the master secret, and has a runtime caller (allowed). */
	callerGated: string[];
	/** Public registrations the guard could not read: a refusal, never a pass. */
	unreadable: string[];
};

// <judge-begin>
/**
 * Judges every public registration of `entries`. The population is the
 * registrations; a registration whose module cannot be named or read, or whose
 * export cannot be located, lands in `unreadable` (the test FAILS on it).
 */
function judgeGuard(
	entries: readonly GuardEntry[],
	readModule: (name: string) => string | null,
	runtimeSources: string,
): Verdict {
	const verdict: Verdict = { offenders: [], callerGated: [], unreadable: [] };
	for (const { path, exports } of entries) {
		const named = /^\.\.\/(.+)\.ts$/.exec(path);
		for (const [exportName, value] of Object.entries(exports)) {
			const reg = registrationOf(value);
			if (!reg || !reg.isPublic) continue;
			if (!named) {
				verdict.unreadable.push(
					`${path}:${exportName} (module name not derivable)`,
				);
				continue;
			}
			const moduleName = named[1]; // nested modules are "a/b", ids are "a/b:fn"
			const id = `${moduleName}:${exportName}`;
			const args = argNames(reg);
			const located = exportSource(moduleName, exportName, readModule);
			if (located === null) {
				verdict.unreadable.push(`${id} (source or export not found)`);
				continue;
			}
			const reaches = reachesMasterSecret(
				located.source,
				readModule(located.module) ?? located.source,
			);
			// A secret-shaped argument NAME is an additional signal, and names the
			// argument in the message; the accusation does not need it.
			if (!reaches && !args.some((n) => SECRET_ARG.test(n))) continue;
			if (runtimeSources.includes(`"${id}"`)) verdict.callerGated.push(id);
			else verdict.offenders.push(id);
		}
	}
	return verdict;
}
// <judge-end>

/**
 * `requireMasterAuth(`, a secret-shaped validator, or ANY read of the master
 * secret's environment variable in an un-importable module: the flow analysis
 * cannot read what it cannot import, so such a module may not touch the secret.
 */
const EXCLUDED_MODULE_SECRET = new RegExp(
	`\\b(callerToken|masterToken|masterSecret)\\s*:\\s*v\\.|\\brequireMasterAuth\\s*\\(|process\\s*\\.\\s*env\\s*(?:\\.\\s*${MASTER_SECRET_ENV}\\b|\\[\\s*["'\`]${MASTER_SECRET_ENV}["'\`]\\s*\\])`,
);

function fakePublic(args: readonly string[]): unknown {
	const validator = Object.fromEntries(
		args.map((a) => [a, { type: "string" }]),
	);
	return Object.assign(() => undefined, {
		isPublic: true,
		exportArgs: () => JSON.stringify({ type: "object", value: validator }),
	});
}

function judgeOne(
	path: string,
	exportName: string,
	args: readonly string[],
	source: string | null,
	runtimeSources = "",
): Verdict {
	return judgeGuard(
		[{ path, exports: { [exportName]: fakePublic(args) } }],
		(name) => (source !== null && `../${name}.ts` === path ? source : null),
		runtimeSources,
	);
}

const LOAD_TIMEOUT_MS = 120_000;

describe("guard — no public registration takes a master secret", () => {
	let loaded: GuardEntry[] = [];
	beforeAll(async () => {
		loaded = await Promise.all(
			Object.entries(allGlob)
				.filter(([path]) => !EXCLUDED(path) && !NOT_A_FUNCTION_MODULE(path))
				.map(async ([path, load]) => ({
					path,
					exports: (await load()) as Record<string, unknown>,
				})),
		);
	}, LOAD_TIMEOUT_MS);

	test("every importable module is enumerated (population is non-trivial)", () => {
		let registrations = 0;
		for (const { exports } of loaded) {
			for (const value of Object.values(exports)) {
				if (registrationOf(value)) registrations++;
			}
		}
		expect(registrations).toBeGreaterThan(100);
	});

	test("nested modules are part of the population", () => {
		expect(loaded.some(({ path }) => path.split("/").length > 2)).toBe(true);
	});

	test("a public registration whose master secret has no runtime caller under mcp-server/ is a defect", () => {
		const sources = mcpRuntimeSources(MCP_DIR).join("\n");
		const verdict = judgeGuard(loaded, readConvexModule, sources);
		expect(verdict.unreadable).toEqual([]);
		// The sites that still take a secret are exactly the ones a runtime
		// caller needs; every other one is a defect of this class.
		expect(verdict.offenders).toEqual([]);
		// Sanity: the derivation found the callers it is meant to exempt, so an
		// empty `offenders` cannot be the product of an empty enumeration.
		expect(verdict.callerGated.length).toBeGreaterThan(0);
	});

	test("oauth:provisionOrganization is seen and is caller-gated, not accused", () => {
		const sources = mcpRuntimeSources(MCP_DIR).join("\n");
		const verdict = judgeGuard(loaded, readConvexModule, sources);
		expect(verdict.callerGated).toContain("oauth:provisionOrganization");
		expect(verdict.offenders).toEqual([]);
		expect(verdict.unreadable).toEqual([]);
	});

	test("the anchor is still the variable the production check reads", () => {
		// If the deployment renames the variable, MASTER_SECRET_ENV goes stale and
		// the guard would find no secret anywhere; this pins the two together.
		expect(readConvexModule("oauth")).toContain(
			`process.env.${MASTER_SECRET_ENV}`,
		);
	});

	test("modules the runtime cannot import carry no master secret in source", () => {
		const stack = [CONVEX_DIR];
		const files: string[] = [];
		while (stack.length) {
			const d = stack.pop() as string;
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const full = join(d, e.name);
				if (e.isDirectory()) {
					if (["_generated", "__tests__", "node_modules"].includes(e.name))
						continue;
					stack.push(full);
				} else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
					if (EXCLUDED(full)) files.push(full);
				}
			}
		}
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			expect(readFileSync(f, "utf-8")).not.toMatch(EXCLUDED_MODULE_SECRET);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Fixtures — the guard REFUSES what it is meant to refuse
//    (synthetic modules; no file is planted on the tree)
// ─────────────────────────────────────────────────────────────────────────────

const PLANTED_SOURCE = `
import { mutation } from "./_generated/server";
export const plantedFn = mutation({
	args: { callerToken: v.string() },
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);
	},
});
`;

function sourceWith(
	argsBlock: string,
	handlerHead: string,
	bodyLines: string,
): string {
	return `
export const probeFn = mutation({
	args: { ${argsBlock} },
	${handlerHead} => {
		${bodyLines}
	},
});
`;
}

describe("fixtures — H1: a nested module is judged, never skipped", () => {
	test("a public registration taking callerToken in a subdirectory is an offender named a/b:fn", () => {
		const v = judgeOne(
			"../migrations/planted.ts",
			"plantedFn",
			["callerToken"],
			PLANTED_SOURCE,
		);
		expect(v.offenders).toEqual(["migrations/planted:plantedFn"]);
		expect(v.unreadable).toEqual([]);
	});

	test("a nested registration with a runtime caller is caller-gated under its a/b:fn id", () => {
		const v = judgeOne(
			"../migrations/planted.ts",
			"plantedFn",
			["callerToken"],
			PLANTED_SOURCE,
			'client.mutation("migrations/planted:plantedFn" as any)',
		);
		expect(v.callerGated).toEqual(["migrations/planted:plantedFn"]);
		expect(v.offenders).toEqual([]);
	});

	test("a module name that cannot be derived is unreadable, not skipped", () => {
		const v = judgeOne(
			"./elsewhere/planted.js",
			"plantedFn",
			["callerToken"],
			PLANTED_SOURCE,
		);
		expect(v.unreadable).toHaveLength(1);
		expect(v.offenders).toEqual([]);
	});
});

describe("fixtures — unreadable is a refusal, never a pass", () => {
	test("a public registration whose module source cannot be read is unreadable", () => {
		const v = judgeOne("../ghost.ts", "ghostFn", ["title"], null);
		expect(v.unreadable).toEqual([
			"ghost:ghostFn (source or export not found)",
		]);
	});

	test("a public registration whose export is not in its module source is unreadable", () => {
		const v = judgeOne(
			"../ghost.ts",
			"ghostFn",
			["title"],
			"export const other = 1;\n",
		);
		expect(v.unreadable).toEqual([
			"ghost:ghostFn (source or export not found)",
		]);
	});
});

describe("fixtures — H2: secret-ness is the flow into requireMasterAuth", () => {
	const HEAD = "handler: async (ctx, args)";
	const cases: ReadonlyArray<readonly [string, string, string, string]> = [
		[
			"direct: requireMasterAuth(args.sharedSecret)",
			"sharedSecret: v.string()",
			HEAD,
			"await requireMasterAuth(args.sharedSecret);",
		],
		[
			"local alias of a differently-spelled argument",
			"fleetMasterSecret: v.string()",
			HEAD,
			"const presented = args.fleetMasterSecret;\n\t\tawait requireMasterAuth(presented);",
		],
		[
			"destructuring in the body",
			"sharedSecret: v.string()",
			HEAD,
			"const { sharedSecret } = args;\n\t\tawait requireMasterAuth(sharedSecret);",
		],
		[
			"destructuring with a rename in the body",
			"sharedSecret: v.string()",
			HEAD,
			"const { sharedSecret: s } = args;\n\t\tawait requireMasterAuth(s);",
		],
		[
			"destructuring in the handler parameters",
			"sharedSecret: v.string()",
			"handler: async (ctx, { sharedSecret })",
			"await requireMasterAuth(sharedSecret);",
		],
		[
			"a renamed args parameter",
			"sharedSecret: v.string()",
			"handler: async (ctx, a)",
			"await requireMasterAuth(a.sharedSecret);",
		],
		[
			"all of args passed",
			"sharedSecret: v.string()",
			HEAD,
			"await requireMasterAuth(args);",
		],
	];
	for (const [label, argsBlock, head, body] of cases) {
		test(`${label} is an offender`, () => {
			const argName = /^(\w+):/.exec(argsBlock)?.[1] as string;
			const v = judgeOne(
				"../probe.ts",
				"probeFn",
				[argName],
				sourceWith(argsBlock, head, body),
			);
			expect(v.offenders).toEqual(["probe:probeFn"]);
			expect(v.unreadable).toEqual([]);
		});
	}

	test("an argument that never reaches requireMasterAuth is not accused", () => {
		const v = judgeOne(
			"../probe.ts",
			"probeFn",
			["title", "sharedSecret"],
			sourceWith(
				"title: v.string(), sharedSecret: v.string()",
				"handler: async (ctx, args)",
				'await ctx.db.insert("t", { title: args.title });',
			),
		);
		expect(v.offenders).toEqual([]);
		expect(v.callerGated).toEqual([]);
	});

	test("a handler that calls requireMasterAuth reaches the secret whatever it passes", () => {
		const src = sourceWith(
			"title: v.string(), sharedSecret: v.string()",
			"handler: async (ctx, args)",
			"log(args.title);\n\t\tawait requireMasterAuth(args.sharedSecret);",
		);
		expect(reachesMasterSecret(src)).toBe(true);
	});

	test("requireMasterAuth, seeded by name, still reads the secret where it is defined", () => {
		const oauth = stripComments(readConvexModule("oauth") ?? "");
		const def = declaredHelpers(oauth).find(
			(h) => h.name === "requireMasterAuth",
		);
		expect(def).toBeDefined();
		expect(mentionsSecretVariable((def as Helper).body)).toBe(true);
	});

	test("a commented-out requireMasterAuth call accuses nothing", () => {
		const src = sourceWith(
			"sharedSecret: v.string()",
			"handler: async (ctx, args)",
			"// await requireMasterAuth(args.sharedSecret);\n\t\treturn null;",
		);
		expect(reachesMasterSecret(src)).toBe(false);
	});
});

describe("fixtures — the source scan refuses requireMasterAuth in un-importable modules", () => {
	test("a call to requireMasterAuth is refused", () => {
		expect("await requireMasterAuth(args.sharedSecret);").toMatch(
			EXCLUDED_MODULE_SECRET,
		);
	});
	test("a secret-shaped validator is still refused", () => {
		expect("args: { callerToken: v.string() }").toMatch(EXCLUDED_MODULE_SECRET);
	});
	test("an inline read of the master secret's variable is refused", () => {
		expect(`if (k !== process.env.${MASTER_SECRET_ENV}) return;`).toMatch(
			EXCLUDED_MODULE_SECRET,
		);
		expect(`const m = process.env["${MASTER_SECRET_ENV}"];`).toMatch(
			EXCLUDED_MODULE_SECRET,
		);
	});
	test("a read of some OTHER variable is not refused", () => {
		expect("const m = process.env.SOME_OTHER_VARIABLE;").not.toMatch(
			EXCLUDED_MODULE_SECRET,
		);
	});
	test("an unrelated source is not refused", () => {
		expect("args: { title: v.string() }").not.toMatch(EXCLUDED_MODULE_SECRET);
	});
});

describe("fixtures — H3: secret-ness is the flow into the MASTER SECRET, not into a function name", () => {
	const HEAD = "handler: async (ctx, args)";
	const ENV = `process.env.${MASTER_SECRET_ENV}`;
	const offenderCases: ReadonlyArray<
		readonly [string, string, string, string, string]
	> = [
		[
			"inline !== against the env read, no requireMasterAuth (fleetKey)",
			"fleetKey",
			HEAD,
			`if (args.fleetKey !== ${ENV}) {\n\t\t\tthrow new Error("no");\n\t\t}`,
			"",
		],
		[
			"inline === against the env read",
			"fleetKey",
			HEAD,
			`if (args.fleetKey === ${ENV}) {\n\t\t\treturn 1;\n\t\t}`,
			"",
		],
		[
			"the env read on the left of the comparison",
			"fleetKey",
			HEAD,
			`if (${ENV} !== args.fleetKey) throw new Error("no");`,
			"",
		],
		[
			"loose != and a bracketed env read",
			"fleetKey",
			HEAD,
			`if (args.fleetKey != process.env["${MASTER_SECRET_ENV}"]) throw new Error("no");`,
			"",
		],
		[
			"compared against a local alias of the env read",
			"fleetKey",
			HEAD,
			`const expected = ${ENV} ?? "";\n\t\tif (args.fleetKey !== expected) throw new Error("no");`,
			"",
		],
		[
			"compared against a module-level alias of the env read",
			"fleetKey",
			HEAD,
			`if (args.fleetKey !== MASTER) throw new Error("no");`,
			`const MASTER = ${ENV};`,
		],
		[
			"compared against a destructured env read",
			"fleetKey",
			HEAD,
			`const { ${MASTER_SECRET_ENV}: expected } = process.env;\n\t\tif (args.fleetKey !== expected) throw new Error("no");`,
			"",
		],
		[
			"through an alias of the argument",
			"fleetKey",
			HEAD,
			`const presented = args.fleetKey;\n\t\tif (presented !== ${ENV}) throw new Error("no");`,
			"",
		],
		[
			"handed to a constant-time compare next to the env read",
			"fleetKey",
			HEAD,
			`if (!timingSafeEqual(args.fleetKey, ${ENV} ?? "")) throw new Error("no");`,
			"",
		],
		[
			"through a same-module helper that reads the env (not named requireMasterAuth)",
			"fleetKey",
			HEAD,
			"await checkFleet(args.fleetKey);",
			`async function checkFleet(k: string) {\n\tif (k !== ${ENV}) throw new Error("no");\n}`,
		],
		[
			"through a helper that hands the argument on to a helper that reads the env",
			"fleetKey",
			HEAD,
			"await outer(args.fleetKey);",
			`async function inner(k: string) {\n\tif (k !== ${ENV}) throw new Error("no");\n}\nasync function outer(k: string) {\n\tawait inner(k);\n}`,
		],
		[
			"compared against a helper that returns the env read",
			"fleetKey",
			HEAD,
			'if (args.fleetKey !== getFleetSecret()) throw new Error("no");',
			`function getFleetSecret() {\n\treturn ${ENV};\n}`,
		],
		[
			"handler-parameter destructuring compared inline",
			"fleetKey",
			"handler: async (ctx, { fleetKey })",
			`if (fleetKey !== ${ENV}) throw new Error("no");`,
			"",
		],
	];
	for (const [label, arg, head, body, prelude] of offenderCases) {
		test(`${label} is an offender`, () => {
			const src = `${prelude}\n${sourceWith(`${arg}: v.string()`, head, body)}`;
			const v = judgeOne("../probe.ts", "probeFn", [arg], src);
			expect(v.offenders).toEqual(["probe:probeFn"]);
			expect(v.unreadable).toEqual([]);
			// The verdict names the property, never the helper: requireMasterAuth is absent.
			expect(src).not.toMatch(/requireMasterAuth/);
		});
	}

	const cleanCases: ReadonlyArray<readonly [string, string, string, string]> = [
		[
			"an argument that reaches nothing",
			"sharedSecret: v.string()",
			"sharedSecret",
			'await ctx.db.insert("t", { title: "x" });',
		],
		[
			"an argument compared against some OTHER env variable",
			"sharedSecret: v.string()",
			"sharedSecret",
			'if (args.sharedSecret !== process.env.SOME_OTHER_VARIABLE) throw new Error("no");',
		],
	];
	for (const [label, argsBlock, arg, body] of cleanCases) {
		test(`${label} is not accused`, () => {
			const v = judgeOne(
				"../probe.ts",
				"probeFn",
				[arg],
				sourceWith(argsBlock, "handler: async (ctx, args)", body),
			);
			expect(v.offenders).toEqual([]);
			expect(v.callerGated).toEqual([]);
			expect(v.unreadable).toEqual([]);
		});
	}

	test("a commented-out inline comparison accuses nothing", () => {
		const src = sourceWith(
			"fleetKey: v.string()",
			"handler: async (ctx, args)",
			`// if (args.fleetKey !== process.env.${MASTER_SECRET_ENV}) throw new Error("no");\n\t\treturn null;`,
		);
		expect(reachesMasterSecret(src)).toBe(false);
	});

	test("an inline-compared secret with a runtime caller is caller-gated, like the helper form", () => {
		const src = sourceWith(
			"fleetKey: v.string()",
			"handler: async (ctx, args)",
			`if (args.fleetKey !== process.env.${MASTER_SECRET_ENV}) throw new Error("no");`,
		);
		const v = judgeOne(
			"../probe.ts",
			"probeFn",
			["fleetKey"],
			src,
			'client.mutation("probe:probeFn" as any)',
		);
		expect(v.callerGated).toEqual(["probe:probeFn"]);
		expect(v.offenders).toEqual([]);
	});

	test("a helper in the module that DEFINES a re-exported registration is followed", () => {
		const modules: Record<string, string> = {
			"../barrel": 'export { probeFn } from "./impl.js";',
			"../impl": `async function checkFleet(k: string) {\n\tif (k !== process.env.${MASTER_SECRET_ENV}) throw new Error("no");\n}\n${sourceWith(
				"fleetKey: v.string()",
				"handler: async (ctx, args)",
				"await checkFleet(args.fleetKey);",
			)}`,
		};
		const v = judgeGuard(
			[
				{
					path: "../barrel.ts",
					exports: { probeFn: fakePublic(["fleetKey"]) },
				},
			],
			(name) => modules[`../${name}`] ?? null,
			"",
		);
		expect(v.offenders).toEqual(["barrel:probeFn"]);
	});

	test("a check through a helper imported from ANOTHER module is not followed (named limit)", () => {
		const modules: Record<string, string> = {
			"../probe": `import { checkFleet } from "./other";\n${sourceWith(
				"fleetKey: v.string()",
				"handler: async (ctx, args)",
				"await checkFleet(args.fleetKey);",
			)}`,
			"../other": `export async function checkFleet(k: string) {\n\tif (k !== process.env.${MASTER_SECRET_ENV}) throw new Error("no");\n}`,
		};
		const v = judgeGuard(
			[{ path: "../probe.ts", exports: { probeFn: fakePublic(["fleetKey"]) } }],
			(name) => modules[`../${name}`] ?? null,
			"",
		);
		// LIMIT, pinned so it cannot become a silent one: this escapes. If the
		// guard learns to follow imports this test must flip to offenders.
		expect(v.offenders).toEqual([]);
	});

	test("an inline check reached through a re-exported registration is still seen", () => {
		const modules: Record<string, string> = {
			"../barrel": 'export { probeFn } from "./impl.js";',
			"../impl": sourceWith(
				"fleetKey: v.string()",
				"handler: async (ctx, args)",
				`if (args.fleetKey !== process.env.${MASTER_SECRET_ENV}) throw new Error("no");`,
			),
		};
		const v = judgeGuard(
			[
				{
					path: "../barrel.ts",
					exports: { probeFn: fakePublic(["fleetKey"]) },
				},
			],
			(name) => modules[`../${name}`] ?? null,
			"",
		);
		expect(v.offenders).toEqual(["barrel:probeFn"]);
		expect(v.unreadable).toEqual([]);
	});
});

function fakeInternal(args: readonly string[]): unknown {
	const validator = Object.fromEntries(
		args.map((a) => [a, { type: "string" }]),
	);
	return Object.assign(() => undefined, {
		isInternal: true,
		exportArgs: () => JSON.stringify({ type: "object", value: validator }),
	});
}

describe("fixtures — H4: the accusation is REACH, not the shape of a comparison", () => {
	const HEAD = "handler: async (ctx, args)";
	const ENV = `process.env.${MASTER_SECRET_ENV}`;
	const PRELUDE = `const secret = ${ENV} ?? "";`;
	// [label, module prelude, handler body]
	const reachCases: ReadonlyArray<readonly [string, string, string]> = [
		[
			"membership test: [secret].includes(args.fleetKey)",
			PRELUDE,
			'if (![secret].includes(args.fleetKey)) throw new Error("no");',
		],
		[
			"switch/case on the argument against the secret",
			PRELUDE,
			'switch (args.fleetKey) {\n\t\t\tcase secret:\n\t\t\t\tbreak;\n\t\t\tdefault:\n\t\t\t\tthrow new Error("no");\n\t\t}',
		],
		[
			"args.fleetKey.localeCompare(secret)",
			PRELUDE,
			'if (args.fleetKey.localeCompare(secret) !== 0) throw new Error("no");',
		],
		["the secret is logged, no argument involved", "", `console.log(${ENV});`],
		[
			"the secret is concatenated into a returned string",
			"",
			`return "k=" + ${ENV};`,
		],
		[
			"the secret is read and compared against a literal, the argument beside it unused",
			"",
			`const configured = ${ENV};\n\t\tif (args.fleetKey !== "fixed") throw new Error(String(configured));`,
		],
		[
			"the secret's presence is checked, the argument is unrelated",
			"",
			`if (!${ENV}) throw new Error("misconfigured");`,
		],
		["a bracketed read", "", `return process.env["${MASTER_SECRET_ENV}"];`],
		[
			"a destructured env read",
			"",
			`const { ${MASTER_SECRET_ENV}: s } = process.env;\n\t\treturn s;`,
		],
		[
			"a key constant used to index the env",
			`const KEY = "${MASTER_SECRET_ENV}";`,
			"return process.env[KEY];",
		],
		[
			"a same-module helper that only reads the secret, called with an unrelated argument",
			`async function loadConfig(x: string) {\n\treturn [x, ${ENV}];\n}`,
			"await loadConfig(args.fleetKey);",
		],
		[
			"a helper two hops away",
			`function inner() {\n\treturn ${ENV};\n}\nfunction outer() {\n\treturn inner();\n}`,
			"return outer();",
		],
	];
	for (const [label, prelude, body] of reachCases) {
		test(`${label} is an offender`, () => {
			const src = `${prelude}\n${sourceWith("fleetKey: v.string()", HEAD, body)}`;
			const v = judgeOne("../probe.ts", "probeFn", ["fleetKey"], src);
			expect(v.offenders).toEqual(["probe:probeFn"]);
			expect(v.unreadable).toEqual([]);
		});
	}

	test("a public handler that reads some OTHER env variable is not accused", () => {
		const src = sourceWith(
			"fleetKey: v.string()",
			HEAD,
			'const other = process.env.SOME_OTHER_VARIABLE;\n\t\tif (args.fleetKey !== other) throw new Error("no");',
		);
		const v = judgeOne("../probe.ts", "probeFn", ["fleetKey"], src);
		expect(v.offenders).toEqual([]);
		expect(v.callerGated).toEqual([]);
	});

	test("a secret-shaped argument NAME is accused even when the handler reads nothing (additional signal)", () => {
		const src = sourceWith(
			"callerToken: v.string()",
			HEAD,
			"await verifyElsewhere(args.callerToken);",
		);
		const v = judgeOne("../probe.ts", "probeFn", ["callerToken"], src);
		expect(v.offenders).toEqual(["probe:probeFn"]);
	});

	test("a public handler that reaches nothing is not accused", () => {
		const src = sourceWith(
			"title: v.string()",
			HEAD,
			'await ctx.db.insert("t", { title: args.title });',
		);
		const v = judgeOne("../probe.ts", "probeFn", ["title"], src);
		expect(v.offenders).toEqual([]);
		expect(v.callerGated).toEqual([]);
	});

	test("a caller-gated registration that reads the secret is not accused", () => {
		const src = sourceWith(
			"fleetKey: v.string()",
			HEAD,
			`if (![${ENV}].includes(args.fleetKey)) throw new Error("no");`,
		);
		const v = judgeOne(
			"../probe.ts",
			"probeFn",
			["fleetKey"],
			src,
			'client.mutation("probe:probeFn" as any)',
		);
		expect(v.callerGated).toEqual(["probe:probeFn"]);
		expect(v.offenders).toEqual([]);
	});

	test("an INTERNAL registration that reads the secret is not accused", () => {
		const src = sourceWith("fleetKey: v.string()", HEAD, `return ${ENV};`);
		const v = judgeGuard(
			[
				{
					path: "../probe.ts",
					exports: { probeFn: fakeInternal(["fleetKey"]) },
				},
			],
			(name) => (name === "probe" ? src : null),
			"",
		);
		expect(v.offenders).toEqual([]);
		expect(v.callerGated).toEqual([]);
		expect(v.unreadable).toEqual([]);
	});

	test("only the registration that reaches the secret is accused among two in one module", () => {
		const src = `${sourceWith("fleetKey: v.string()", HEAD, `return ${ENV};`)}
export const cleanFn = mutation({
	args: { title: v.string() },
	handler: async (ctx, args) => {
		await ctx.db.insert("t", { title: args.title });
	},
});
`;
		const v = judgeGuard(
			[
				{
					path: "../probe.ts",
					exports: {
						probeFn: fakePublic(["fleetKey"]),
						cleanFn: fakePublic(["title"]),
					},
				},
			],
			(name) => (name === "probe" ? src : null),
			"",
		);
		expect(v.offenders).toEqual(["probe:probeFn"]);
	});

	test("a commented-out read accuses nothing", () => {
		const src = sourceWith(
			"title: v.string()",
			HEAD,
			`// return ${ENV};\n\t\t/* ${ENV} */\n\t\treturn null;`,
		);
		expect(reachesMasterSecret(src)).toBe(false);
	});

	// NAMED LIMITS, pinned so none can become silent. Each of these escapes today;
	// if the guard learns to read one, that test must flip to an offender.
	test("LIMIT: a computed env name (process.env[name]) is not read", () => {
		const src = sourceWith(
			"fleetKey: v.string()",
			HEAD,
			'const name = ["BEARER", "SECRET", "MASTER"].join("_");\n\t\treturn process.env[name];',
		);
		expect(reachesMasterSecret(src)).toBe(false);
	});

	test("LIMIT: an aliased env object (const e = process.env) is not read", () => {
		const src = sourceWith(
			"fleetKey: v.string()",
			HEAD,
			'const e = process.env;\n\t\treturn e["BEARER_SECRET_" + "MASTER"];',
		);
		expect(reachesMasterSecret(src)).toBe(false);
	});

	test("LIMIT: a hop through an internal registration (ctx.runQuery(internal.x.y)) is not followed", () => {
		const src = sourceWith(
			"fleetKey: v.string()",
			HEAD,
			"return await ctx.runQuery(internal.probe.readIt, {});",
		);
		expect(reachesMasterSecret(src)).toBe(false);
	});
});
