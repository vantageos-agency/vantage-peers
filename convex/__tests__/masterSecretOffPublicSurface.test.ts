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
 *      hardcoded list). An argument is a master secret when it is CHECKED
 *      AGAINST the master secret's environment variable (compared inline, handed
 *      to a compare next to the secret, or passed to a same-module helper that
 *      does either); requireMasterAuth is one instance of that, not its
 *      definition. A secret-looking name is only an additional signal. A
 *      registration the guard cannot read is a failure.
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

// THE ANCHOR, named once: the environment variable that holds the master
// secret. The guard derives "checked against the master secret" from a read of
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

const ALL = "*";

type Refs = {
	/** Names that stand for the whole validated-args object. */
	objects: Set<string>;
	/** Local name -> the argument names whose value it carries. */
	values: Map<string, Set<string>>;
};

/**
 * Propagates argument-ness through the local bindings of `code`: destructuring
 * (`const { x } = args`), aliases (`const t = args.x`), and a renamed args object.
 */
function propagate(code: string, { objects, values }: Refs): void {
	const bind = (local: string, arg: string) => {
		const set = values.get(local) ?? new Set<string>();
		const before = set.size;
		set.add(arg);
		values.set(local, set);
		return set.size !== before;
	};
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
}

/** The argument names an expression's text carries, through `refs`. */
function refsIn(text: string, { objects, values }: Refs): Set<string> {
	const out = new Set<string>();
	for (const t of text.matchAll(
		/([A-Za-z_$][\w$]*)(?:\s*\??\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*["']([\w$]+)["']\s*\])?/g,
	)) {
		const [, base, prop, quoted] = t;
		if (objects.has(base)) out.add(prop ?? quoted ?? ALL);
		else for (const a of values.get(base) ?? []) out.add(a);
	}
	return out;
}

/** Splits call-argument text at top-level commas. */
function topLevelArguments(text: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth--;
		else if (c === "," && depth === 0) {
			out.push(text.slice(start, i));
			start = i + 1;
		}
	}
	out.push(text.slice(start));
	return out.filter((a) => a.trim() !== "");
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

/** The operand ending just before `end` in `code` (a member chain, calls and indexes included). */
function operandBefore(code: string, end: number): string {
	let i = end - 1;
	while (i >= 0 && /\s/.test(code[i])) i--;
	const last = i;
	while (i >= 0) {
		const c = code[i];
		if (c === ")" || c === "]") {
			const open = c === ")" ? "(" : "[";
			let depth = 0;
			for (; i >= 0; i--) {
				if (code[i] === c) depth++;
				else if (code[i] === open && --depth === 0) break;
			}
			i--;
		} else if (/[\w$.?!]/.test(c)) i--;
		else break;
	}
	return code.slice(i + 1, last + 1);
}

/** The operand starting at `start` in `code`. */
function operandAfter(code: string, start: number): string {
	let i = start;
	while (i < code.length && /\s/.test(code[i])) i++;
	const first = i;
	if (/^await\s/.test(code.slice(i, i + 6))) {
		i += 5;
		while (i < code.length && /\s/.test(code[i])) i++;
	}
	while (i < code.length) {
		const c = code[i];
		if (c === "(" || c === "[") {
			const close = c === "(" ? ")" : "]";
			let depth = 0;
			for (; i < code.length; i++) {
				if (code[i] === c) depth++;
				else if (code[i] === close && --depth === 0) break;
			}
			i++;
		} else if (/[\w$.?!]/.test(c)) i++;
		else break;
	}
	return code.slice(first, i);
}

// "The argument is checked against the master secret" is a property of the
// SECRET, not of a function's name. An argument is a master secret when it
// reaches an expression that READS `process.env[MASTER_SECRET_ENV]` (directly,
// through a local/module alias, through a destructured env, or through a helper
// of the same module that returns it) in one of three ways:
//   (a) it is an operand of `===` / `!==` / `==` / `!=` whose other operand is a
//       secret read;
//   (b) it is one argument of a call whose OTHER argument is a secret read
//       (a constant-time compare helper, whatever it is called);
//   (c) it is passed to a same-module helper whose own parameter reaches (a)/(b).
// `requireMasterAuth` is ONE instance of (c), seeded by name so a module that
// only imports it is still judged; it is not the definition of the property.
// Limit (named, not silent): a check reached through a helper defined in
// ANOTHER module is not followed.
const SEED_SINK_HELPERS = ["requireMasterAuth"];

function secretEnvRead(): RegExp {
	return new RegExp(
		`process\\s*\\.\\s*env\\s*(?:\\.\\s*${MASTER_SECRET_ENV}\\b|\\[\\s*["'\`]${MASTER_SECRET_ENV}["'\`]\\s*\\])`,
	);
}

type Helper = { params: (string | null)[]; body: string };

/** Functions declared in `code`: `function f(..){..}` and `const f = (..) => ..`. */
function declaredHelpers(code: string): Map<string, Helper> {
	const out = new Map<string, Helper>();
	const decl =
		/(?:\bfunction\s+([\w$]+)\s*(?:<[^>(]*>)?\s*\(|\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>(]*>\s*)?\()/g;
	for (const m of code.matchAll(decl)) {
		const name = (m[1] ?? m[2]) as string;
		const open = (m.index as number) + m[0].length - 1;
		const paramText = balancedArguments(code, open);
		const after = open + paramText.length + 2;
		const brace = code.indexOf("{", after);
		const arrow = code.indexOf("=>", after);
		let body: string;
		if (arrow !== -1 && (brace === -1 || arrow < brace)) {
			let j = arrow + 2;
			while (j < code.length && /\s/.test(code[j])) j++;
			if (code[j] === "{") body = balancedBraces(code, j);
			else {
				const stop = code.slice(j).search(/;|\n/);
				body = code.slice(j, stop === -1 ? code.length : j + stop);
				body = `return ${body}`;
			}
		} else if (brace !== -1) body = balancedBraces(code, brace);
		else continue;
		const params = topLevelArguments(paramText).map((p) => {
			const pm = /^\s*(?:\.\.\.)?([\w$]+)/.exec(p);
			return pm ? pm[1] : null;
		});
		out.set(name, { params, body });
	}
	return out;
}

type Facts = {
	aliases: Set<string>;
	/** Helpers whose return value is the secret. */
	readers: Set<string>;
	/** Helpers that check an argument against the secret: name -> parameter positions. */
	sinks: Map<string, Set<number> | "all">;
};

function readsSecret(text: string, facts: Facts): boolean {
	if (secretEnvRead().test(text)) return true;
	for (const a of facts.aliases)
		if (
			new RegExp(`(?<![\\w$.])${a.replace(/\$/g, "\\$")}(?![\\w$])`).test(text)
		)
			return true;
	for (const r of facts.readers)
		if (new RegExp(`(?<![\\w$.])${r.replace(/\$/g, "\\$")}\\s*\\(`).test(text))
			return true;
	return false;
}

/** Names bound to the secret read: `const m = process.env.X`, `const { X: m } = process.env`. */
function secretAliases(code: string): Set<string> {
	const out = new Set<string>();
	for (const m of code.matchAll(
		/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*([^;\n]+)/g,
	)) {
		if (secretEnvRead().test(m[2])) out.add(m[1]);
	}
	for (const m of code.matchAll(
		/\b(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=]+)?=\s*process\s*\.\s*env\b/g,
	)) {
		for (const e of patternEntries(m[1]))
			if (e.key === MASTER_SECRET_ENV) out.add(e.local);
	}
	return out;
}

/**
 * Which argument names reach a check against the secret inside `code`, given
 * how `refs` binds names to arguments and what `facts` says about the module.
 */
function secretReach(code: string, refs: Refs, facts: Facts): Set<string> {
	propagate(code, refs);
	const reached = new Set<string>();
	const addAll = (set: Set<string>) => {
		for (const x of set) reached.add(x);
	};
	// (c) a same-module helper whose parameter is checked
	for (const [name, positions] of facts.sinks) {
		for (const call of code.matchAll(
			new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g"),
		)) {
			const text = balancedArguments(
				code,
				(call.index as number) + call[0].length - 1,
			);
			topLevelArguments(text).forEach((arg, i) => {
				if (positions === "all" || positions.has(i)) addAll(refsIn(arg, refs));
			});
		}
	}
	// (a) comparison against a secret read
	for (const op of code.matchAll(/[!=]==?/g)) {
		const at = op.index as number;
		const left = operandBefore(code, at);
		const right = operandAfter(code, at + op[0].length);
		if (readsSecret(right, facts)) addAll(refsIn(left, refs));
		if (readsSecret(left, facts)) addAll(refsIn(right, refs));
	}
	// (b) one call, one argument that is the secret and another that is an argument
	for (const call of code.matchAll(/(?<![\w$])[\w$.]+\s*\(/g)) {
		const text = balancedArguments(
			code,
			(call.index as number) + call[0].length - 1,
		);
		const parts = topLevelArguments(text);
		if (parts.length < 2) continue;
		const secretAt = parts.map((p) => readsSecret(p, facts));
		parts.forEach((p, i) => {
			if (secretAt[i]) return;
			if (secretAt.some(Boolean)) addAll(refsIn(p, refs));
		});
	}
	return reached;
}

function moduleFacts(moduleCode: string): Facts {
	const facts: Facts = {
		aliases: secretAliases(moduleCode),
		readers: new Set<string>(),
		sinks: new Map(SEED_SINK_HELPERS.map((n) => [n, "all" as const])),
	};
	const helpers = declaredHelpers(moduleCode);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [name, h] of helpers) {
			if (facts.readers.has(name)) continue;
			const returned = [...h.body.matchAll(/\breturn\b([^;\n]*)/g)].some((r) =>
				readsSecret(r[1], facts),
			);
			if (returned) {
				facts.readers.add(name);
				changed = true;
			}
		}
	}
	for (let round = 0; round < 6; round++) {
		let moved = false;
		for (const [name, h] of helpers) {
			if (facts.sinks.get(name) === "all") continue;
			const refs: Refs = { objects: new Set(), values: new Map() };
			for (const p of h.params) if (p) refs.values.set(p, new Set([p]));
			const reached = secretReach(h.body, refs, facts);
			const positions = new Set<number>();
			h.params.forEach((p, i) => {
				if (p && reached.has(p)) positions.add(i);
			});
			const before = facts.sinks.get(name);
			const same =
				before !== undefined &&
				before !== "all" &&
				before.size === positions.size &&
				[...positions].every((i) => before.has(i));
			if (positions.size > 0 && !same) {
				facts.sinks.set(name, positions);
				moved = true;
			}
		}
		if (!moved) break;
	}
	return facts;
}

/**
 * Which of `argList` are checked against the master secret inside `body` (the
 * source text of one registration), see the note above. `moduleSource` is the
 * module the registration lives in (helpers, aliases); it defaults to `body`.
 * Covered argument forms: `args.x`, a local alias (`const t = args.x`),
 * destructuring in the body or in the handler parameters, a renamed args
 * parameter, and passing all of `args`.
 */
function flowSecretArgs(
	body: string,
	argList: readonly string[],
	moduleSource: string = body,
): string[] {
	const code = stripComments(body);
	const facts = moduleFacts(stripComments(moduleSource));
	const refs: Refs = { objects: new Set<string>(["args"]), values: new Map() };
	const handler =
		/handler\s*:\s*(?:async\s*)?\(\s*[\w$]+\s*,\s*(?:([\w$]+)|\{([^}]*)\})/.exec(
			code,
		);
	if (handler?.[1]) refs.objects.add(handler[1]);
	if (handler?.[2]) {
		for (const e of patternEntries(handler[2])) {
			if (e.rest) refs.objects.add(e.local);
			else
				refs.values.set(
					e.local,
					(refs.values.get(e.local) ?? new Set()).add(e.key),
				);
		}
	}
	const reached = secretReach(code, refs, facts);
	if (reached.has(ALL)) return [...argList];
	return argList.filter((a) => reached.has(a));
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
			const secretArgs = new Set([
				...flowSecretArgs(
					located.source,
					args,
					readModule(located.module) ?? located.source,
				),
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
		[
			"an argument compared with a literal while the env read is used elsewhere",
			"sharedSecret: v.string()",
			"sharedSecret",
			`const configured = process.env.${MASTER_SECRET_ENV};\n\t\tif (args.sharedSecret !== "fixed") throw new Error(String(configured));`,
		],
		[
			"an unrelated argument beside a master check on the env alone",
			"title: v.string()",
			"title",
			`if (!process.env.${MASTER_SECRET_ENV}) throw new Error("misconfigured");\n\t\tawait ctx.db.insert("t", { title: args.title });`,
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

	test("a helper reading the env that is called with an unrelated argument accuses nothing", () => {
		const src = `async function loadConfig(x: string) {\n\treturn [x, process.env.${MASTER_SECRET_ENV}];\n}\n${sourceWith(
			"title: v.string()",
			"handler: async (ctx, args)",
			"await loadConfig(args.title);",
		)}`;
		// reaching a function that merely READS the secret is not a check of the argument
		expect(flowSecretArgs(src, ["title"])).toEqual([]);
	});

	test("only the argument that is compared is accused among several", () => {
		const src = sourceWith(
			"title: v.string(), fleetKey: v.string()",
			"handler: async (ctx, args)",
			`log(args.title);\n\t\tif (args.fleetKey !== process.env.${MASTER_SECRET_ENV}) throw new Error("no");`,
		);
		expect(flowSecretArgs(src, ["title", "fleetKey"])).toEqual(["fleetKey"]);
	});

	test("a commented-out inline comparison accuses nothing", () => {
		const src = sourceWith(
			"fleetKey: v.string()",
			"handler: async (ctx, args)",
			`// if (args.fleetKey !== process.env.${MASTER_SECRET_ENV}) throw new Error("no");\n\t\treturn null;`,
		);
		expect(flowSecretArgs(src, ["fleetKey"])).toEqual([]);
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
