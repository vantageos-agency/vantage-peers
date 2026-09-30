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
 *      nested ones included (ids are "a/b:fn"), and fails if a public one takes
 *      a master secret, unless that function has a runtime caller under
 *      mcp-server/ (derived by reading the mcp-server sources, not from a
 *      hardcoded list). An argument is a master secret when it FLOWS into
 *      requireMasterAuth in its module source; a secret-looking name is only an
 *      additional signal. A registration the guard cannot read is a failure.
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
// 3. Guard — derived from the registrations and from the FLOW of each argument
// ─────────────────────────────────────────────────────────────────────────────

// An argument is a MASTER SECRET when it reaches `requireMasterAuth` inside its
// own registration's module source. That is a behaviour, so it is measured as
// one (see `flowSecretArgs`). The name shape below is only an ADDITIONAL
// signal: a secret-looking name is accused even when the flow analysis cannot
// see where it goes, but a secret with an unlisted name is still caught by the
// flow. Per-user credentials that are the credential BY DESIGN (a license key,
// a token hash, an agent's own credential) reach no `requireMasterAuth` and are
// deliberately not accused.
const SECRET_ARG = /^(caller|master|bearer|admin)_?(token|secret|key)$/i;

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

const ALL = "*";

/**
 * Which of `argList` reach `requireMasterAuth` inside `body` (the source text of
 * one registration). Covered forms: `requireMasterAuth(args.x)`, a local alias
 * (`const t = args.x`), destructuring in the body (`const { x } = args`) or in
 * the handler parameters (`handler: async (ctx, { x })`), a renamed args
 * parameter, and passing all of `args`.
 */
function flowSecretArgs(body: string, argList: readonly string[]): string[] {
	const code = stripComments(body);
	const objects = new Set<string>(["args"]);
	const values = new Map<string, Set<string>>(); // local name -> arg names
	const bind = (local: string, arg: string) => {
		const set = values.get(local) ?? new Set<string>();
		const before = set.size;
		set.add(arg);
		values.set(local, set);
		return set.size !== before;
	};

	const handler =
		/handler\s*:\s*(?:async\s*)?\(\s*[\w$]+\s*,\s*(?:([\w$]+)|\{([^}]*)\})/.exec(
			code,
		);
	if (handler?.[1]) objects.add(handler[1]);
	if (handler?.[2]) {
		for (const e of patternEntries(handler[2])) {
			if (e.rest) objects.add(e.local);
			else bind(e.local, e.key);
		}
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const m of code.matchAll(
			/\b(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=]+)?=\s*([\w$]+)\s*[;\n]/g,
		)) {
			if (!objects.has(m[2])) continue;
			for (const e of patternEntries(m[1])) {
				if (e.rest) {
					if (!objects.has(e.local)) {
						objects.add(e.local);
						changed = true;
					}
				} else if (bind(e.local, e.key)) changed = true;
			}
		}
		for (const m of code.matchAll(
			/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*([^;\n]+)/g,
		)) {
			const [, local, rhs] = m;
			if (/^\s*[\w$]+\s*$/.test(rhs) && objects.has(rhs.trim())) {
				if (!objects.has(local)) {
					objects.add(local);
					changed = true;
				}
				continue;
			}
			for (const t of rhs.matchAll(
				/([A-Za-z_$][\w$]*)(?:\s*\??\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*["']([\w$]+)["']\s*\])?/g,
			)) {
				const [, base, prop, quoted] = t;
				if (objects.has(base) && (prop ?? quoted)) {
					if (bind(local, (prop ?? quoted) as string)) changed = true;
				} else if (objects.has(base)) {
					if (bind(local, ALL)) changed = true;
				} else if (values.has(base) && base !== local) {
					for (const a of values.get(base) as Set<string>)
						if (bind(local, a)) changed = true;
				}
			}
		}
	}

	const reached = new Set<string>();
	for (const call of code.matchAll(/\brequireMasterAuth\s*\(/g)) {
		const text = balancedArguments(code, (call.index as number) + call[0].length - 1);
		for (const t of text.matchAll(
			/([A-Za-z_$][\w$]*)(?:\s*\??\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*["']([\w$]+)["']\s*\])?/g,
		)) {
			const [, base, prop, quoted] = t;
			if (objects.has(base)) reached.add((prop ?? quoted) ?? ALL);
			else for (const a of values.get(base) ?? []) reached.add(a);
		}
	}
	if (reached.has(ALL)) return [...argList];
	return argList.filter((a) => reached.has(a));
}

/**
 * The source text of `exportName` inside module `moduleName`, following a
 * `export { x } from "./y.js"` re-export. Null when it cannot be located.
 */
function exportSource(
	moduleName: string,
	exportName: string,
	readModule: (name: string) => string | null,
	depth = 0,
): string | null {
	const source = readModule(moduleName);
	if (source === null || depth > 4) return null;
	const declared = new RegExp(
		`^export\\s+(?:const|let|var|async\\s+function|function)\\s+${exportName}\\b`,
		"m",
	).exec(source);
	if (declared) {
		const rest = source.slice(declared.index + declared[0].length);
		const next = /^export\s/m.exec(rest);
		return source.slice(
			declared.index,
			declared.index + declared[0].length + (next ? next.index : rest.length),
		);
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
	/** Public, takes a master secret, no runtime caller under mcp-server/. */
	offenders: string[];
	/** Public, takes a master secret, and has a runtime caller (allowed). */
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
				verdict.unreadable.push(`${path}:${exportName} (module name not derivable)`);
				continue;
			}
			const moduleName = named[1]; // nested modules are "a/b", ids are "a/b:fn"
			const id = `${moduleName}:${exportName}`;
			const args = argNames(reg);
			const body = exportSource(moduleName, exportName, readModule);
			if (body === null) {
				verdict.unreadable.push(`${id} (source or export not found)`);
				continue;
			}
			const secretArgs = new Set([
				...flowSecretArgs(body, args),
				...args.filter((n) => SECRET_ARG.test(n)),
			]);
			if (secretArgs.size === 0) continue;
			if (runtimeSources.includes(`"${id}"`)) verdict.callerGated.push(id);
			else verdict.offenders.push(id);
		}
	}
	return verdict;
}
// <judge-end>

/** `requireMasterAuth(` or a secret-shaped validator in an un-importable module. */
const EXCLUDED_MODULE_SECRET =
	/\b(callerToken|masterToken|masterSecret)\s*:\s*v\.|\brequireMasterAuth\s*\(/;

function fakePublic(args: readonly string[]): unknown {
	const validator = Object.fromEntries(args.map((a) => [a, { type: "string" }]));
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

	test("modules the runtime cannot import carry no master secret in source", () => {
		const stack = [CONVEX_DIR];
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

function sourceWith(argsBlock: string, handlerHead: string, bodyLines: string): string {
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
		const v = judgeOne("./elsewhere/planted.js", "plantedFn", ["callerToken"], PLANTED_SOURCE);
		expect(v.unreadable).toHaveLength(1);
		expect(v.offenders).toEqual([]);
	});
});

describe("fixtures — unreadable is a refusal, never a pass", () => {
	test("a public registration whose module source cannot be read is unreadable", () => {
		const v = judgeOne("../ghost.ts", "ghostFn", ["title"], null);
		expect(v.unreadable).toEqual(["ghost:ghostFn (source or export not found)"]);
	});

	test("a public registration whose export is not in its module source is unreadable", () => {
		const v = judgeOne("../ghost.ts", "ghostFn", ["title"], "export const other = 1;\n");
		expect(v.unreadable).toEqual(["ghost:ghostFn (source or export not found)"]);
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
				"await ctx.db.insert(\"t\", { title: args.title });",
			),
		);
		expect(v.offenders).toEqual([]);
		expect(v.callerGated).toEqual([]);
	});

	test("only the argument that reaches requireMasterAuth is accused among several", () => {
		const args = ["title", "sharedSecret"];
		const src = sourceWith(
			"title: v.string(), sharedSecret: v.string()",
			"handler: async (ctx, args)",
			"log(args.title);\n\t\tawait requireMasterAuth(args.sharedSecret);",
		);
		expect(flowSecretArgs(src, args)).toEqual(["sharedSecret"]);
	});

	test("a commented-out requireMasterAuth call accuses nothing", () => {
		const args = ["sharedSecret"];
		const src = sourceWith(
			"sharedSecret: v.string()",
			"handler: async (ctx, args)",
			"// await requireMasterAuth(args.sharedSecret);\n\t\treturn null;",
		);
		expect(flowSecretArgs(src, args)).toEqual([]);
	});
});

describe("fixtures — the source scan refuses requireMasterAuth in un-importable modules", () => {
	test("a call to requireMasterAuth is refused", () => {
		expect("await requireMasterAuth(args.sharedSecret);").toMatch(EXCLUDED_MODULE_SECRET);
	});
	test("a secret-shaped validator is still refused", () => {
		expect("args: { callerToken: v.string() }").toMatch(EXCLUDED_MODULE_SECRET);
	});
	test("an unrelated source is not refused", () => {
		expect("args: { title: v.string() }").not.toMatch(EXCLUDED_MODULE_SECRET);
	});
});
