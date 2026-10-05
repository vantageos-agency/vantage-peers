#!/usr/bin/env node
/**
 * derive-backend-doctor-oracle.mjs — derive `.backend-doctor/vp-by-tool.csv`
 * (the per-tool inventory backend-doctor's oracle-backed rules read) FROM THE
 * CURRENT TREE. Task k17dkeateza85tkgt4v2scpb4s8fe5mf.
 *
 * Nothing in the output is typed by hand. Every cell is either:
 *   - read from code by the TypeScript AST (mcp-server/src defineTool calls,
 *     convex/ registrations, convex/schema.ts), or
 *   - the doctor's own placeholder `?` (backend-doctor src/detectors/shared.ts
 *     isPlaceholder: "", tbd, ?, ~, n/a) when the column is not mechanically
 *     derivable. `?` is never a guess: it says "not derived", and every
 *     detector that reads such a cell treats it as a non-value.
 *
 * Format consumed (backend-doctor @ 60780e6):
 *   - location: `<repo>/.backend-doctor/vp-by-tool.csv` (src/oracle.ts:26-33,63)
 *   - 18 columns in this exact order (src/oracle.ts:170-189); a row with any
 *     other cell count is malformed => could-not-judge (src/oracle.ts:255-265)
 *   - RFC-4180 quoting (src/oracle.ts:210-252)
 *
 * Grain: ONE ROW PER REGISTERED MCP TOOL (defineTool call). A tool touching
 * several tables carries them `+`-joined in `table`.
 *
 * Derivation rules per column (each is a rule over code, applied uniformly):
 *   table            tables named by `db.query("t")`, `db.insert("t")`, and,
 *                    when a db.get/patch/replace/delete takes an id, the
 *                    `v.id("t")` validators of the Convex function's args.
 *   outil            the tool name literal.
 *   T2_verdict,
 *   T2_composant_cible  audit bookkeeping, no code source => `?`.
 *   crud             from the Convex effects reached (see verbOf below);
 *                    `n/a` when the handler reaches no Convex function.
 *   operation_detail `module:function(kind)` of every Convex function the
 *                    handler calls (string refs and api./internal. refs).
 *   search_mecanisme for READ-LIST / SEARCH rows only:
 *                    `<mechanism> | <locus> | <cursor> | defaut:N max:M`
 *                    (vocabulary of the day-158 audit the doctor's regexes read).
 *   surface          `MCP-public` when the name is in mcp-server/tool-exposure.json
 *                    `core` (advertised), `hors-MCP` when registered but masked
 *                    (`.disable()`d, mcp-server/src/tools.ts registerTools).
 *   rbac_qui, scope_enforcement, namespace_ou_org
 *                    from the defineTool `scope` literal (mcp-server/src/
 *                    registerTool.ts ToolScope), in the vocabulary the day-158
 *                    audit used for the same kinds (1:1 in that audit), plus the
 *                    Convex-side caller-resolution helpers reached.
 *   tokens_estime_contexte  ceil(chars(name + description + input-schema
 *                    source) / 4) — a method-stated estimate.
 *   doublon_alias    no code source => "".
 *   rbac_coherence_table  per table group: the set of authority tiers of the
 *                    read rows vs of the write rows; equal (or one side empty)
 *                    => COHERENT(...), else INCOHERENT read=... write=...
 *                    A row's tier is what the Convex handlers it reaches
 *                    enforce on the data door (master / org, see convexTierOf),
 *                    NOT the MCP transport label: a direct caller of the public
 *                    backend never passes through the MCP layer.
 *   rbac_adjustment_needed  a remediation decision, no code source => `?`,
 *                    except (1) the tool's own `// oracle-justified: <reason>`
 *                    comment block, immediately before its defineTool( call,
 *                    emitted as `JUSTIFIED: <reason>` (the reason is the
 *                    author's statement in the source, never generated here;
 *                    a marker without reason text makes the population guard
 *                    refuse), and (2) a `public`/`filtered` scope `reason`
 *                    string, quoted verbatim as `source reason (...)`.
 *   table_purpose    the leading comment of the table in convex/schema.ts
 *                    (banner lines dropped); `?` when there is none.
 *   table_conserver_supprimer  a disposition decision, no code source => "".
 *   statut_suppression  a current tool is not removed => "".
 *
 * Writer authority (backend-standard R-10) has NO column in the 18-column
 * oracle the doctor parses, and cannot be given one: a 19th cell makes every row
 * `malformed` and every oracle-backed rule could-not-judge (backend-doctor
 * src/oracle.ts toRows, measured: 108 of 108 rows). It is therefore derived to
 * a SIDE-CAR, `.backend-doctor/vp-writer-tier.csv`, one row per write tool:
 *   writer_tier  public / org-member / org-admin / fleet-internal / master, from
 *                the gates of the mutation/action doors the handler reaches
 *                (writerGateOf: mcpBoundOnly -> fleet-internal, masterOnly ->
 *                master, requireOrgAdmin -> org-admin, a GUARDS resolver ->
 *                org-member); the most permissive reachable door decides; a
 *                tool with no gated write door keeps its MCP-scope tier,
 *                collapsed as the doctor's collapseTier collapses rbac_qui.
 *   writer_gate  the gate that decided it, or `mcp-scope:<tier>`.
 *   write_doors  every reached write door and its gate.
 * The doctor does not read this file; R-10 stays red until it does.
 *
 * Population guard (refuses, never shrinks). The AST enumeration of tools is
 * cross-checked BEFORE any row is written, in both modes, against sources that
 * do not share its walker:
 *   1. required inputs exist (REQUIRED_INPUTS below) and every relative import
 *      reachable from the registration entry (mcp-server/src/tools.ts)
 *      resolves to a file — a missing module is a missing slice of surface;
 *   2. a LEXICAL count of `defineTool(` call sites per file (comments
 *      removed, no AST) equals the AST count of defineTool calls turned into
 *      rows — a call the walker skipped, could not name, or never saw shows
 *      up as a per-file difference;
 *   3. no lexical `.tool(` / `.registerTool(` call outside registerTool.ts,
 *      and no use of `defineTool` other than as a direct call (aliased or
 *      passed as a value) — such registrations are invisible to both counts;
 *   4. every name in mcp-server/tool-exposure.json `core` (a data file the
 *      server itself asserts against its registered set at boot,
 *      tools.ts registerTools) is among the derived tool names.
 * Any failure exits 2 naming expected vs found and what is missing; no file
 * is written.
 *
 * Usage: node scripts/derive-backend-doctor-oracle.mjs [--check] [--root <dir>]
 *   default: writes .backend-doctor/vp-by-tool.csv and prints a summary.
 *   --check: exits 1 when a committed CSV (oracle or writer side-car) differs
 *            from a fresh derivation.
 *   --root:  derive from another tree (tests run against temp copies);
 *            defaults to the repository containing this script.
 *   exit 2:  the population guard refused (see above), in either mode.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const rootArg = process.argv.indexOf("--root");
const ROOT =
	rootArg > -1 && process.argv[rootArg + 1]
		? resolve(process.argv[rootArg + 1])
		: resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SRC = join(ROOT, "mcp-server", "src");
const CONVEX = join(ROOT, "convex");
const OUT = join(ROOT, ".backend-doctor", "vp-by-tool.csv");
const WRITER_OUT = join(ROOT, ".backend-doctor", "vp-writer-tier.csv");
const UNKNOWN = "?";

/** Exit 2 with a named population failure; nothing is written. */
function refusePopulation(problems) {
	console.error(
		`REFUSED: the tool enumeration does not cover the surface (${problems.length} problem(s)); ${relative(ROOT, OUT)} not written/checked`,
	);
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(2);
}

// Inputs whose absence silently removes rows or columns: refuse up front.
const REGISTRATION_ENTRY = join(MCP_SRC, "tools.ts");
const REQUIRED_INPUTS = [
	REGISTRATION_ENTRY,
	join(MCP_SRC, "registerTool.ts"),
	join(ROOT, "mcp-server", "tool-exposure.json"),
	join(CONVEX, "schema.ts"),
];
{
	const missing = REQUIRED_INPUTS.filter((f) => !existsSync(f));
	if (missing.length)
		refusePopulation(
			missing.map((f) => `required input missing: ${relative(ROOT, f)}`),
		);
}

const COLUMNS = [
	"table",
	"outil",
	"T2_verdict",
	"T2_composant_cible",
	"crud",
	"operation_detail",
	"search_mecanisme",
	"surface",
	"rbac_qui",
	"scope_enforcement",
	"namespace_ou_org",
	"tokens_estime_contexte",
	"doublon_alias",
	"rbac_coherence_table",
	"rbac_adjustment_needed",
	"table_purpose",
	"table_conserver_supprimer",
	"statut_suppression",
];

// ── file + AST plumbing ─────────────────────────────────────────────────────

function walkFiles(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (
			name === "node_modules" ||
			name === "_generated" ||
			name === "__tests__"
		)
			continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walkFiles(full, out);
		else if (
			name.endsWith(".ts") &&
			!name.endsWith(".test.ts") &&
			!name.endsWith(".d.ts")
		)
			out.push(full);
	}
	return out;
}

const sfCache = new Map();
function sourceOf(file) {
	let sf = sfCache.get(file);
	if (!sf) {
		sf = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.ES2022,
			true,
			ts.ScriptKind.TS,
		);
		sfCache.set(file, sf);
	}
	return sf;
}

function forEachDeep(node, fn) {
	fn(node);
	ts.forEachChild(node, (c) => forEachDeep(c, fn));
}

function strip(node) {
	let n = node;
	while (
		n &&
		(ts.isAsExpression(n) ||
			ts.isParenthesizedExpression(n) ||
			ts.isSatisfiesExpression?.(n) ||
			ts.isNonNullExpression(n))
	)
		n = n.expression;
	return n;
}

/** Every named function in a file, at any depth: name -> [node]. */
const fnIndexCache = new Map();
function functionIndex(file) {
	let idx = fnIndexCache.get(file);
	if (idx) return idx;
	idx = new Map();
	const add = (name, node) => {
		const list = idx.get(name) ?? [];
		list.push(node);
		idx.set(name, list);
	};
	forEachDeep(sourceOf(file), (n) => {
		if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text, n);
		else if (
			ts.isVariableDeclaration(n) &&
			ts.isIdentifier(n.name) &&
			n.initializer
		) {
			const init = strip(n.initializer);
			if (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
				add(n.name.text, init);
		}
	});
	fnIndexCache.set(file, idx);
	return idx;
}

function resolveModule(fromFile, spec) {
	if (!spec.startsWith(".")) return null;
	const base = resolve(dirname(fromFile), spec.replace(/\.(m?js|ts)$/, ""));
	for (const cand of [`${base}.ts`, join(base, "index.ts")])
		if (existsSync(cand)) return cand;
	return null;
}

/** Named imports of a file: local name -> { file, name }. */
const importCache = new Map();
function importsOf(file) {
	let map = importCache.get(file);
	if (map) return map;
	map = new Map();
	for (const st of sourceOf(file).statements) {
		if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings)
			continue;
		const target = resolveModule(file, st.moduleSpecifier.text);
		if (!target || !ts.isNamedImports(st.importClause.namedBindings)) continue;
		for (const el of st.importClause.namedBindings.elements)
			map.set(el.name.text, {
				file: target,
				name: (el.propertyName ?? el.name).text,
			});
	}
	importCache.set(file, map);
	return map;
}

function constString(file, name) {
	let found = null;
	forEachDeep(sourceOf(file), (n) => {
		if (
			!found &&
			ts.isVariableDeclaration(n) &&
			ts.isIdentifier(n.name) &&
			n.name.text === name &&
			n.initializer
		)
			found = n.initializer;
	});
	return found ? evalString(file, found) : null;
}

function evalString(file, node) {
	const n = strip(node);
	if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
		return n.text;
	if (
		ts.isBinaryExpression(n) &&
		n.operatorToken.kind === ts.SyntaxKind.PlusToken
	) {
		const l = evalString(file, n.left);
		const r = evalString(file, n.right);
		return l !== null && r !== null ? l + r : null;
	}
	if (ts.isIdentifier(n)) return constString(file, n.text);
	if (ts.isTemplateExpression(n)) return n.getText().slice(1, -1);
	return null;
}

// ── Convex registrations ────────────────────────────────────────────────────

const BUILDERS = /^(internal)?(query|mutation|action)$/i;
/** "module:fn" -> { file, kind, internal, args, handler } */
const convexFns = new Map();
for (const file of walkFiles(CONVEX)) {
	const mod = relative(CONVEX, file).replace(/\.ts$/, "");
	for (const st of sourceOf(file).statements) {
		if (!ts.isVariableStatement(st)) continue;
		if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
			continue;
		for (const d of st.declarationList.declarations) {
			const init = d.initializer && strip(d.initializer);
			if (
				!init ||
				!ts.isCallExpression(init) ||
				!ts.isIdentifier(init.expression)
			)
				continue;
			const m = BUILDERS.exec(init.expression.text);
			if (!m || !ts.isIdentifier(d.name)) continue;
			const cfg = init.arguments[0] && strip(init.arguments[0]);
			let args = null;
			let handler = cfg ?? null;
			if (cfg && ts.isObjectLiteralExpression(cfg)) {
				for (const p of cfg.properties) {
					const key = p.name && ts.isIdentifier(p.name) ? p.name.text : null;
					if (key === "args" && ts.isPropertyAssignment(p))
						args = p.initializer;
					if (key === "handler")
						handler = ts.isPropertyAssignment(p) ? p.initializer : p;
				}
			}
			convexFns.set(`${mod}:${d.name.text}`, {
				file,
				kind: m[2].toLowerCase(),
				internal: Boolean(m[1]),
				args,
				handler,
			});
		}
	}
}

/** `api.a.b.fn` / `internal.a.b.fn` -> "a/b:fn"; "a/b:fn" literal -> itself. */
function convexRefOf(node) {
	const n = strip(node);
	if (ts.isStringLiteral(n) && /^[\w/]+:\w+$/.test(n.text)) return n.text;
	if (ts.isPropertyAccessExpression(n)) {
		const parts = n.getText().replace(/\s+/g, "").split(".");
		if ((parts[0] === "api" || parts[0] === "internal") && parts.length >= 3)
			return `${parts.slice(1, -1).join("/")}:${parts[parts.length - 1]}`;
	}
	return null;
}

// Caller-resolution helpers: their presence is recorded, their bodies are NOT
// descended into (otherwise the mapping-table reads inside them would be
// attributed to every tool).
const GUARDS = [
	"withOrgScope",
	"requireScope",
	"requireResolvedCaller",
	"requireAuthenticatedCaller",
	"filterByOrgScope",
	"resolveOrgContext",
	"getUserIdentity",
];
const isAuthLib = (file) =>
	/[\\/]convex[\\/]lib[\\/]auth[^\\/]*\.ts$/.test(file);

/**
 * Collect every function body reachable from `start` (in `file`): local and
 * imported helpers by name, and — on the Convex side — ctx.runQuery/
 * runMutation/runAction targets. Returns { nodes, convexRefs }.
 */
function reach(file, start, { followConvexRuns }) {
	const nodes = [];
	const convexRefs = new Set();
	const seen = new Set();
	const queue = [[file, start]];
	while (queue.length) {
		const [f, node] = queue.shift();
		if (seen.has(node)) continue;
		seen.add(node);
		nodes.push([f, node]);
		forEachDeep(node, (n) => {
			if (!ts.isCallExpression(n)) return;
			const callee = n.expression;
			if (ts.isPropertyAccessExpression(callee)) {
				const method = callee.name.text;
				if (/^(query|mutation|action)$/.test(method) && n.arguments[0]) {
					const ref = convexRefOf(n.arguments[0]);
					if (ref) convexRefs.add(ref);
				}
				if (
					followConvexRuns &&
					/^run(Query|Mutation|Action)$/.test(method) &&
					n.arguments[0]
				) {
					const ref = convexRefOf(n.arguments[0]);
					const target = ref && convexFns.get(ref);
					if (target?.handler) queue.push([target.file, target.handler]);
				}
				return;
			}
			if (!ts.isIdentifier(callee) || GUARDS.includes(callee.text)) return;
			const local = functionIndex(f).get(callee.text);
			if (local) {
				for (const fnNode of local) queue.push([f, fnNode]);
				return;
			}
			const imp = importsOf(f).get(callee.text);
			if (imp && !isAuthLib(imp.file)) {
				for (const fnNode of functionIndex(imp.file).get(imp.name) ?? [])
					queue.push([imp.file, fnNode]);
			}
		});
	}
	return { nodes, convexRefs };
}

/** True when an object literal names a `status` property (incl. shorthand). */
function objectNamesStatus(obj) {
	return obj.properties.some(
		(p) => p.name && ts.isIdentifier(p.name) && p.name.text === "status",
	);
}

/**
 * Does the patch argument of a `db.patch/replace` write `status`? The patch is
 * either an inline object literal, or an identifier built earlier in the same
 * handler (`const patch = { status: ... }`, later `patch.status = ...`):
 * tasks:start builds its patch in a local and was missed by the literal-only
 * reading (R-37: start_task UPDATE vs resume_task TRANSITION).
 */
function patchWritesStatus(arg, scopeNode) {
	const obj = strip(arg);
	if (!obj) return false;
	if (ts.isObjectLiteralExpression(obj)) return objectNamesStatus(obj);
	if (!ts.isIdentifier(obj)) return false;
	const name = obj.text;
	let found = false;
	forEachDeep(scopeNode, (n) => {
		if (found) return;
		if (
			ts.isVariableDeclaration(n) &&
			ts.isIdentifier(n.name) &&
			n.name.text === name &&
			n.initializer
		) {
			const init = strip(n.initializer);
			if (init && ts.isObjectLiteralExpression(init) && objectNamesStatus(init))
				found = true;
		} else if (
			ts.isBinaryExpression(n) &&
			n.operatorToken.kind === ts.SyntaxKind.EqualsToken
		) {
			const l = n.left;
			if (
				ts.isPropertyAccessExpression(l) &&
				ts.isIdentifier(l.expression) &&
				l.expression.text === name &&
				l.name.text === "status"
			)
				found = true;
			else if (
				ts.isElementAccessExpression(l) &&
				ts.isIdentifier(l.expression) &&
				l.expression.text === name &&
				ts.isStringLiteralLike(l.argumentExpression) &&
				l.argumentExpression.text === "status"
			)
				found = true;
		}
	});
	return found;
}

/** Effects of a set of Convex bodies. */
function convexFacts(fnKeys) {
	const facts = {
		kinds: new Set(),
		tablesNamed: new Set(),
		idTables: new Set(),
		writes: new Set(),
		statusPatch: false,
		reads: {
			list: false,
			get: false,
			// get evidence split: `db.get(id)` (a by-id fetch) vs a table's
			// `.first()`/`.unique()` chain; and the tables a list chain drains.
			getById: false,
			probeTables: new Set(),
			listTables: new Set(),
			indexedChains: 0,
			unindexedChains: 0,
		},
		search: new Set(),
		paginate: false,
		external: false,
		guards: new Set(),
		// per reached Convex function: the tier its OWN handler enforces on the
		// data door (see convexTierOf) — the coherence flag compares THESE, not
		// the MCP transport label.
		tiers: new Set(),
		// per reached mutation/action: the writer gate its own code enforces
		// (see writerGateOf) — what writerTierOf reads.
		writeDoors: [],
		text: "",
		resolved: [],
		unresolved: [],
	};
	for (const key of fnKeys) {
		const fn = convexFns.get(key);
		if (!fn) {
			facts.unresolved.push(key);
			continue;
		}
		facts.resolved.push(`${key}(${fn.internal ? "internal" : ""}${fn.kind})`);
		facts.kinds.add(fn.kind);
		if (fn.args)
			for (const m of fn.args.getText().matchAll(/v\.id\(\s*"(\w+)"\s*\)/g))
				facts.idTables.add(m[1]);
		if (!fn.handler) continue;
		const { nodes } = reach(fn.file, fn.handler, { followConvexRuns: true });
		const fnGuards = new Set();
		let fnText = "";
		for (const [, node] of nodes) {
			const text = node.getText();
			// Guard and tier detection read CODE only: a helper named in a comment
			// ("filterByOrgScope() does not fit") is not a call the handler makes.
			const code = withoutComments(text);
			facts.text += `\n${text}`;
			fnText += `\n${code}`;
			for (const m of text.matchAll(/searchType\s*:\s*"(vector|text|hybrid)"/g))
				facts.search.add(m[1]);
			for (const g of GUARDS)
				if (new RegExp(`\\b${g}\\s*\\(`).test(code)) {
					facts.guards.add(g);
					fnGuards.add(g);
				}
			forEachDeep(node, (n) => {
				if (!ts.isCallExpression(n)) return;
				const callee = n.expression;
				if (ts.isIdentifier(callee) && callee.text === "fetch")
					facts.external = true;
				if (!ts.isPropertyAccessExpression(callee)) return;
				const method = callee.name.text;
				const recv = callee.expression.getText();
				const onDb = /(^|\.)db$/.test(recv);
				const lit = n.arguments[0] && strip(n.arguments[0]);
				const litTable = lit && ts.isStringLiteral(lit) ? lit.text : null;
				if (method === "withSearchIndex") facts.search.add("bm25");
				if (method === "vectorSearch") facts.search.add("vector");
				if (method === "paginate") facts.paginate = true;
				if (!onDb) return;
				if (method === "query" && litTable) {
					facts.tablesNamed.add(litTable);
					// walk up the builder chain: db.query("t").withIndex(...).take(n)
					const chain = [];
					let cur = n;
					while (
						cur.parent &&
						(ts.isPropertyAccessExpression(cur.parent) ||
							ts.isCallExpression(cur.parent))
					) {
						cur = cur.parent;
						if (ts.isPropertyAccessExpression(cur)) chain.push(cur.name.text);
					}
					// Convex serves a chain with no withIndex from the default
					// by_creation_time index; it is a whole-table SCAN only when it
					// filters (`.filter`) or drains the table (`.collect()`).
					const indexed = chain.some(
						(c) => c === "withIndex" || c === "withSearchIndex",
					);
					if (!indexed && chain.some((c) => c === "filter" || c === "collect"))
						facts.reads.unindexedChains++;
					else facts.reads.indexedChains++;
					if (
						chain.some(
							(c) => c === "collect" || c === "take" || c === "paginate",
						)
					) {
						facts.reads.list = true;
						facts.reads.listTables.add(litTable);
					}
					if (chain.some((c) => c === "first" || c === "unique")) {
						facts.reads.get = true;
						facts.reads.probeTables.add(litTable);
					}
				} else if (method === "get") {
					facts.reads.get = true;
					facts.reads.getById = true;
					if (litTable && n.arguments.length > 1)
						facts.tablesNamed.add(litTable);
				} else if (method === "insert") {
					facts.writes.add("insert");
					if (litTable) facts.tablesNamed.add(litTable);
				} else if (
					method === "patch" ||
					method === "replace" ||
					method === "delete"
				) {
					facts.writes.add(method === "delete" ? "delete" : "patch");
					if (litTable && n.arguments.length > 1)
						facts.tablesNamed.add(litTable);
					const last = n.arguments[n.arguments.length - 1];
					if (method !== "delete" && last && patchWritesStatus(last, node))
						facts.statusPatch = true;
				}
			});
		}
		facts.tiers.add(convexTierOf(fnText, fnGuards));
		if (fn.kind !== "query")
			facts.writeDoors.push({ key, gate: writerGateOf(fnText, fnGuards) });
	}
	return facts;
}

/**
 * The tier ONE Convex handler enforces on the data door, read from its own
 * reached source (never from the MCP transport label, which a direct caller
 * of the public backend bypasses):
 *   master    the handler admits only the fleet master: `masterOnly: true`
 *             on requireResolvedCaller, or an `if (!scope.isMaster)` that
 *             throws or returns (requireFleetMaster / requireMasterScope
 *             helpers included, they are reached like any helper);
 *   org       it resolves the caller's organisation (a GUARDS resolver)
 *             without a master-only gate;
 *   unguarded it reaches no resolver at all.
 */
function convexTierOf(text, guards) {
	if (
		/masterOnly\s*:\s*true/.test(text) ||
		/if\s*\(\s*!\s*scope\.isMaster\s*\)\s*\{?\s*(throw|return)\b/.test(text)
	)
		return "master";
	return guards.size > 0 ? "org" : "unguarded";
}

/**
 * The tier a tool's coherence is judged on: what the Convex handlers it can
 * reach enforce. A tool reaching ANY org-admitting handler is org (the most
 * permissive reachable door decides); only-master handlers => master; a tool
 * with an unguarded handler, or none reached, keeps its MCP-layer tier.
 */
function effectiveTier(mcpTier, cf) {
	if (cf.tiers.size === 0 || cf.tiers.has("unguarded")) return mcpTier;
	return cf.tiers.has("org") ? "org" : "master";
}

/**
 * The WRITER gate ONE reached mutation/action enforces, read from its own code
 * (comments removed), most restrictive gate first:
 *   mcpBoundOnly  requireResolvedCaller(..., { mcpBoundOnly: true }): only the
 *                 MCP-bound service account is admitted      -> fleet-internal
 *   masterOnly    convexTierOf() === "master" (masterOnly: true, or an
 *                 `if (!scope.isMaster)` refusal)             -> master
 *   orgAdmin      requireOrgAdmin(...)                        -> org-admin
 *   orgResolver   a GUARDS resolver, no gate above            -> org-member
 *   none          no resolver at all                          -> (MCP layer)
 */
function writerGateOf(code, guards) {
	if (/mcpBoundOnly\s*:\s*true/.test(code)) return "mcpBoundOnly";
	if (convexTierOf(code, guards) === "master") return "masterOnly";
	if (/\brequireOrgAdmin\s*\(/.test(code)) return "orgAdmin";
	return guards.size > 0 ? "orgResolver" : "none";
}

const WRITER_TIER_OF_GATE = {
	mcpBoundOnly: "fleet-internal",
	masterOnly: "master",
	orgAdmin: "org-admin",
	orgResolver: "org-member",
};
/** Most restrictive first: the most permissive reachable write door decides
 * (the same rule effectiveTier applies to coherence). */
const GATE_OPENNESS = [
	"masterOnly",
	"mcpBoundOnly",
	"orgAdmin",
	"orgResolver",
	"none",
];
/** The MCP-layer tier a write with no Convex gate falls back to, collapsed to
 * the five standard tiers the way the doctor's collapseTier collapses `rbac_qui`. */
const MCP_TIER_AS_WRITER_TIER = {
	master: "fleet-internal",
	identite: "org-member",
	ns: "org-member",
	org: "org-member",
	public: "public",
};

/**
 * The writer authority of a write tool: one of public / org-member / org-admin /
 * fleet-internal / master (standard §2, R-10), DERIVED from the gates of the
 * mutation/action doors the handler reaches. A tool that reaches no write door,
 * or only ungated ones, keeps its MCP-layer tier. Returns the tier and the gate
 * that decided it.
 */
function writerTierOf(mcpTier, cf) {
	const fallback = {
		tier: MCP_TIER_AS_WRITER_TIER[mcpTier] ?? UNKNOWN,
		gate: `mcp-scope:${mcpTier}`,
	};
	if (cf.writeDoors.length === 0) return fallback;
	const gate = cf.writeDoors
		.map((d) => d.gate)
		.sort((a, b) => GATE_OPENNESS.indexOf(b) - GATE_OPENNESS.indexOf(a))[0];
	return gate === "none" ? fallback : { tier: WRITER_TIER_OF_GATE[gate], gate };
}

/** Closed verb (backend-doctor src/detectors/predicates.ts:39-51) or `?`. */
function verbOf(f) {
	// No Convex function reached from the handler: the tool performs no data
	// operation through the backend. `n/a` is the doctor's "no data op" value
	// (backend-doctor predicates.ts R-2, oracle-axis2.ts R-8).
	if (f.resolved.length === 0 && f.unresolved.length === 0) return "n/a";
	if (f.resolved.length === 0) return UNKNOWN;
	const w = f.writes;
	if (w.size > 0) {
		if (w.size === 1 && w.has("insert")) return "CREATE";
		if (w.size === 1 && w.has("delete")) return "DELETE";
		if (w.size === 1 && w.has("patch"))
			return f.statusPatch ? "TRANSITION" : "UPDATE";
		if (w.size === 2 && w.has("insert") && w.has("patch")) return "UPSERT";
		return UNKNOWN; // a mix the closed set has no single verb for
	}
	if (f.search.size > 0) return "SEARCH";
	if (f.external && !f.reads.list && !f.reads.get) return "EXTERNAL-EFFECT";
	if (f.reads.list && !f.reads.get) return "READ-LIST";
	if (f.reads.get && !f.reads.list) return "READ-GET";
	// list + get: a list tool that also does a per-row existence/visibility probe
	// (`.first()`/`.unique()`) on a table it does NOT itself list — e.g.
	// briefingNotes:list probing briefingNoteParticipants for each note — is still
	// a READ-LIST. Any `db.get(id)` by id, or a `.first()`/`.unique()` on a table
	// the same handler lists, keeps the mix undecidable (`?`).
	if (
		f.reads.list &&
		f.reads.get &&
		!f.reads.getById &&
		[...f.reads.probeTables].every((t) => !f.reads.listTables.has(t))
	)
		return "READ-LIST";
	return UNKNOWN; // no effect seen, or list+get mixed
}

// ── MCP tool registrations ──────────────────────────────────────────────────

const exposure = JSON.parse(
	readFileSync(join(ROOT, "mcp-server", "tool-exposure.json"), "utf8"),
);
const coreNames = new Set(exposure.core);

function objProps(node, file) {
	const out = {};
	let n = node && strip(node);
	if (n && file && ts.isIdentifier(n)) {
		let init = null;
		forEachDeep(sourceOf(file), (d) => {
			if (
				!init &&
				ts.isVariableDeclaration(d) &&
				ts.isIdentifier(d.name) &&
				d.name.text === n.text
			)
				init = d.initializer;
		});
		n = init && strip(init);
	}
	if (!n || !ts.isObjectLiteralExpression(n)) return null;
	for (const p of n.properties) {
		if (!ts.isPropertyAssignment(p) || !p.name) continue;
		const key =
			ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)
				? p.name.text
				: p.name.getText();
		out[key] = p.initializer;
	}
	return out;
}

/**
 * The written justification a tool's source carries for a divergence from its
 * table neighbours: a `// oracle-justified: <reason>` comment block placed
 * immediately before the tool's `defineTool(` statement (continuation lines
 * are the following `//` lines of the same block). The reason is the
 * author's own statement, never generated here; a marker with no reason text
 * makes the population guard refuse (returned as `{ empty: true }`).
 */
function justificationOf(file, call) {
	let stmt = call;
	while (
		stmt.parent &&
		!ts.isBlock(stmt.parent) &&
		!ts.isSourceFile(stmt.parent) &&
		!ts.isModuleBlock(stmt.parent)
	)
		stmt = stmt.parent;
	const text = sourceOf(file).getFullText();
	const lines = [];
	for (const r of ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [])
		lines.push(
			...text
				.slice(r.pos, r.end)
				.split("\n")
				.map((l) => l.replace(/^\s*\/\/ ?/, "").trim()),
		);
	const at = lines.findLastIndex((l) => l.startsWith("oracle-justified:"));
	if (at < 0) return null;
	const reason = [
		lines[at].slice("oracle-justified:".length),
		...lines.slice(at + 1),
	]
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return reason === "" ? { empty: true } : { reason };
}

const tools = [];
const mcpFiles = walkFiles(MCP_SRC).filter(
	(f) => !f.endsWith("registerTool.ts"),
);
const astSkipped = [];
for (const file of mcpFiles) {
	forEachDeep(sourceOf(file), (n) => {
		if (
			!ts.isCallExpression(n) ||
			!ts.isIdentifier(n.expression) ||
			n.expression.text !== "defineTool"
		)
			return;
		const a = n.arguments;
		const where = `${relative(ROOT, file)}:${sourceOf(file).getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
		if (a.length < 7 || a.some((x) => ts.isSpreadElement(x))) {
			astSkipped.push(`${where} defineTool call with an unparsed shape`);
			return;
		}
		const name = evalString(file, a[3]);
		if (name === null) {
			astSkipped.push(`${where} defineTool name is not a resolvable literal`);
			return;
		}
		const description = evalString(file, a[4]) ?? a[4].getText();
		const scopeProps = objProps(a[2], file) ?? {};
		const scope = {};
		for (const [k, v] of Object.entries(scopeProps))
			scope[k] = evalString(file, v) ?? v.getText();
		const schemaNode = strip(a[5]);
		const handler = a[a.length - 1];
		const justification = justificationOf(file, n);
		if (justification?.empty)
			astSkipped.push(
				`${where} oracle-justified marker carries no reason text`,
			);
		tools.push({
			justification: justification?.reason ?? "",
			file,
			line: sourceOf(file).getLineAndCharacterOfPosition(n.getStart()).line + 1,
			name,
			description,
			scope,
			schemaNode,
			handler,
		});
	});
}

// ── population guard ────────────────────────────────────────────────────────

/** A `/` starts a regex literal (not a division) after these. */
function regexMayStart(before) {
	const t = before.slice(-32).trimEnd();
	if (t === "") return before.trim() === "";
	if (/[([{,;:=!&|?+\-*%<>~^]$/.test(t)) return true;
	return /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(t);
}

/** Source text with comments removed (string/template contents kept, line
 * structure kept). Independent of the TypeScript parser on purpose. */
function withoutComments(text) {
	let out = "";
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		const d = text[i + 1];
		if (c === "/" && d === "/") {
			while (i < n && text[i] !== "\n") i++;
		} else if (c === "/" && d === "*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end === -1 ? n : end + 2;
			// keep the newlines so line numbers still point at the source
			out += ` ${text.slice(i, stop).replace(/[^\n]/g, "")}`;
			i = stop;
		} else if (c === "/" && regexMayStart(out)) {
			// a regex literal: its quotes and slashes are not code
			let j = i + 1;
			let inClass = false;
			while (j < n && text[j] !== "\n") {
				if (text[j] === "\\") j++;
				else if (text[j] === "[") inClass = true;
				else if (text[j] === "]") inClass = false;
				else if (text[j] === "/" && !inClass) break;
				j++;
			}
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === '"' || c === "'" || c === "`") {
			let j = i + 1;
			while (j < n && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

function populationProblems() {
	const problems = [];
	// (1) every relative import reachable from the registration entry resolves.
	const seen = new Set();
	const queue = [REGISTRATION_ENTRY];
	while (queue.length) {
		const f = queue.shift();
		if (seen.has(f)) continue;
		seen.add(f);
		for (const st of sourceOf(f).statements) {
			if (
				!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) ||
				!st.moduleSpecifier ||
				!ts.isStringLiteral(st.moduleSpecifier)
			)
				continue;
			const spec = st.moduleSpecifier.text;
			if (!spec.startsWith(".")) continue;
			const target = resolveModule(f, spec);
			if (target) queue.push(target);
			else
				problems.push(
					`${relative(ROOT, f)} imports "${spec}", which resolves to no file`,
				);
		}
	}
	// (2) lexical defineTool( count == AST rows, per file.
	// (3) no registration that bypasses defineTool.
	const astByFile = new Map();
	for (const t of tools)
		astByFile.set(t.file, (astByFile.get(t.file) ?? 0) + 1);
	let lexicalTotal = 0;
	for (const f of mcpFiles) {
		const code = withoutComments(readFileSync(f, "utf8"));
		const lexical = (code.match(/\bdefineTool\s*(?:<[^>(]*>)?\s*\(/g) ?? [])
			.length;
		lexicalTotal += lexical;
		const ast = astByFile.get(f) ?? 0;
		if (lexical !== ast)
			problems.push(
				`${relative(ROOT, f)}: ${lexical} defineTool( call site(s) in the text, ${ast} enumerated as tools`,
			);
		// defineTool used as a value (aliased, passed, wrapped): its calls are
		// out of reach of both counts above, so the reference itself refuses.
		const codeNoImports = code.replace(
			/\bimport\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']+["']/g,
			(m) => m.replace(/[^\n]/g, ""),
		);
		for (const m of codeNoImports.matchAll(
			/\bdefineTool\b(?!\s*(?:<[^>(]*>)?\s*\()/g,
		)) {
			const line = codeNoImports.slice(0, m.index).split("\n").length;
			problems.push(
				`${relative(ROOT, f)}:${line} uses defineTool other than as a direct call — its registrations cannot be counted`,
			);
		}
		for (const m of code.matchAll(/\.(registerTool|tool)\s*\(/g)) {
			const line = code.slice(0, m.index).split("\n").length;
			problems.push(
				`${relative(ROOT, f)}:${line} registers through .${m[1]}( directly, outside defineTool — invisible to the enumeration`,
			);
		}
	}
	if (lexicalTotal !== tools.length)
		problems.push(
			`expected ${lexicalTotal} tools (lexical defineTool( count across mcp-server/src), found ${tools.length} (AST enumeration)`,
		);
	problems.push(...astSkipped);
	// (4) every advertised core name is enumerated.
	const derived = new Set(tools.map((t) => t.name));
	const missingCore = exposure.core.filter((c) => !derived.has(c));
	if (missingCore.length)
		problems.push(
			`expected all ${exposure.core.length} core names of mcp-server/tool-exposure.json, ${missingCore.length} not enumerated: ${missingCore.join(", ")}`,
		);
	return problems;
}

{
	const problems = populationProblems();
	if (problems.length) refusePopulation(problems);
}

// ── per-tool column derivation ──────────────────────────────────────────────

/** day-158 audit vocabulary for each ToolScope kind (1:1 in that audit). */
function authorityOf(scope) {
	switch (scope.kind) {
		case "master":
			return {
				rbac: "fleet_interne",
				enforce: "bearer_scope_profile(isMasterScope)",
				ns: "global",
				tier: "master",
			};
		case "from":
			return {
				rbac: "toutes_orgs(identity-gated)",
				enforce: "bearer_scope_profile(checkFromAllowed)+checkActorBinding",
				ns: `clerkUserId/orchestratorId(arg=${scope.fromArg})`,
				tier: "identite",
			};
		case "read":
			return {
				rbac: "toutes_orgs(scope-filtered)",
				enforce: "bearer_scope_profile(checkNamespaceRead)",
				ns: `namespace(arg=${scope.namespaceArg})`,
				tier: "ns",
			};
		case "write":
			return {
				rbac: "toutes_orgs(scope-filtered)",
				enforce: "bearer_scope_profile(checkNamespaceWrite)",
				ns: `namespace(arg=${scope.namespaceArg})`,
				tier: "ns",
			};
		case "filtered":
			return {
				rbac: "toutes_orgs(in-handler-filtered)",
				enforce: "filterByOrgScope(in-handler, post-query)",
				ns: "orgId/allowedOrchestrators",
				tier: "org",
			};
		case "public":
			return {
				rbac: "toutes_orgs",
				enforce: "AUCUN(public_no_scope_check)",
				ns: "aucun",
				tier: "public",
			};
		default:
			return { rbac: UNKNOWN, enforce: UNKNOWN, ns: UNKNOWN, tier: UNKNOWN };
	}
}

function schemaFacts(schemaNode) {
	const props = objProps(schemaNode) ?? {};
	const limitText = props.limit ? props.limit.getText() : "";
	return {
		cursor: "cursor" in props,
		limitDefault: /\.default\(\s*(\d+)\s*\)/.exec(limitText)?.[1] ?? null,
		limitMax: /\.max\(\s*(\d+)\s*\)/.exec(limitText)?.[1] ?? null,
		text: schemaNode ? schemaNode.getText() : "",
	};
}

function handlerBound(text, re) {
	return re.exec(text)?.[1] ?? null;
}

function retrievalCell(verb, cf, sf, mcpText) {
	if (verb !== "READ-LIST" && verb !== "SEARCH") return "";
	let mechanism;
	let locus;
	if (
		cf.search.has("hybrid") ||
		(cf.search.has("vector") && cf.search.has("text"))
	) {
		mechanism = "hybrid RRF (RAG)";
		locus = "RAG namespace";
	} else if (cf.search.has("vector")) {
		mechanism = "vectoriel (RAG)";
		locus = "RAG namespace";
	} else if (cf.search.has("text")) {
		mechanism = "BM25 keyword (RAG)";
		locus = "RAG namespace";
	} else if (cf.search.has("bm25")) {
		mechanism = "BM25 keyword (Convex searchIndex)";
		locus = "index Convex";
	} else if (cf.reads.unindexedChains > 0) {
		mechanism = `unindexed scan (${cf.reads.unindexedChains} db.query chain(s) with .filter/.collect() and no withIndex)`;
		locus = "table entiere";
	} else if (cf.reads.indexedChains > 0) {
		mechanism =
			"indexed-range (withIndex or by_creation_time, no filter/collect scan)";
		locus = "index Convex";
	} else {
		mechanism = UNKNOWN;
		locus = UNKNOWN;
	}
	const all = `${mcpText}\n${cf.text}`;
	const def = sf.limitDefault ?? handlerBound(all, /\blimit\s*\?\?\s*(\d+)/);
	const max =
		sf.limitMax ??
		handlerBound(
			all,
			/Math\.min\(\s*[\w.]*limit[\w.]*\s*(?:\?\?\s*\d+\s*)?,\s*(\d+)\s*\)/i,
		) ??
		handlerBound(all, /Math\.min\(\s*(\d+)\s*,\s*[\w.]*limit/i);
	const cursor = sf.cursor || cf.paginate ? "curseur: oui" : "pas de curseur";
	const topK =
		locus === "RAG namespace" && cf.search.has("vector") && def
			? ` topK=${def}`
			: "";
	return `${mechanism} | ${locus} | ${cursor} | defaut:${def ?? UNKNOWN} max:${max ?? UNKNOWN}${topK}`;
}

function schemaPurposes() {
	const sf = sourceOf(join(CONVEX, "schema.ts"));
	const text = sf.getFullText();
	const purposes = new Map();
	forEachDeep(sf, (n) => {
		if (!ts.isPropertyAssignment(n) || !n.name || !ts.isIdentifier(n.name))
			return;
		const init = n.initializer;
		const head = ts.isCallExpression(init) ? init : null;
		let root = head;
		while (
			root &&
			ts.isPropertyAccessExpression(root.expression) &&
			ts.isCallExpression(root.expression.expression)
		)
			root = root.expression.expression;
		if (
			!root ||
			!ts.isIdentifier(root.expression) ||
			root.expression.text !== "defineTable"
		)
			return;
		const ranges = ts.getLeadingCommentRanges(text, n.getFullStart()) ?? [];
		const lines = ranges
			.map((r) => text.slice(r.pos, r.end))
			.flatMap((c) => c.split("\n"))
			.map((l) => l.replace(/^\s*(\/\/+|\/\*+|\*+\/?)\s?/, "").trim())
			.filter(
				(l) =>
					l !== "" &&
					!/^[─—-]{2,}/.test(l) &&
					!/^[─—-]+\s*\w+\s*[─—-]+$/.test(l),
			);
		purposes.set(n.name.text, lines.join(" ").replace(/\s+/g, " ").trim());
	});
	return purposes;
}

const READS = new Set(["READ-LIST", "READ-GET", "SEARCH", "AGGREGATE"]);
const WRITES = new Set([
	"CREATE",
	"UPDATE",
	"DELETE",
	"TRANSITION",
	"UPSERT",
	"BULK-WRITE",
]);

const purposes = schemaPurposes();
const rows = [];
for (const t of tools) {
	const { nodes: mcpNodes, convexRefs } = reach(t.file, t.handler, {
		followConvexRuns: false,
	});
	const mcpText = mcpNodes.map(([, n]) => n.getText()).join("\n");
	const cf = convexFacts([...convexRefs].sort());
	const verb = verbOf(cf);
	const tables = new Set(cf.tablesNamed);
	const byIdEffect =
		cf.reads.get || cf.writes.has("patch") || cf.writes.has("delete");
	if (byIdEffect) for (const tb of cf.idTables) tables.add(tb);
	const table = [...tables].sort().join("+");
	const auth = authorityOf(t.scope);
	const convexGuards = [...cf.guards].sort();
	const enforce = convexGuards.length
		? `${auth.enforce} + convex:${convexGuards.join("/")}`
		: auth.enforce;
	const sf = schemaFacts(t.schemaNode);
	const tokens = Math.ceil(
		((t.name ?? "").length + t.description.length + sf.text.length) / 4,
	);
	const reason =
		[
			t.justification ? `JUSTIFIED: ${t.justification}` : "",
			t.scope.reason
				? `source reason (${t.scope.kind}): ${t.scope.reason}`
				: "",
		]
			.filter(Boolean)
			.join(" | ") || UNKNOWN;
	const purpose = tables.size
		? [...tables]
				.sort()
				.map((tb) =>
					tables.size > 1
						? `${tb}: ${purposes.get(tb) || UNKNOWN}`
						: purposes.get(tb) || UNKNOWN,
				)
				.join(" | ")
		: UNKNOWN;
	const opDetail =
		[...cf.resolved, ...cf.unresolved.map((u) => `${u}(UNRESOLVED)`)].join(
			"; ",
		) || "(no Convex call reached)";
	rows.push({
		_tier: effectiveTier(auth.tier, cf),
		_verb: verb,
		_writer: WRITES.has(verb) ? writerTierOf(auth.tier, cf) : null,
		_doors: cf.writeDoors.map((d) => `${d.key}=${d.gate}`).join("; "),
		_src: `${relative(ROOT, t.file)}:${t.line}`,
		table,
		outil: t.name ?? UNKNOWN,
		T2_verdict: UNKNOWN,
		T2_composant_cible: UNKNOWN,
		crud: verb,
		operation_detail: opDetail,
		search_mecanisme: retrievalCell(verb, cf, sf, mcpText),
		surface: coreNames.has(t.name) ? "MCP-public" : "hors-MCP",
		rbac_qui: auth.rbac,
		scope_enforcement: enforce,
		namespace_ou_org: auth.ns,
		tokens_estime_contexte: String(tokens),
		doublon_alias: "",
		rbac_coherence_table: "",
		rbac_adjustment_needed: reason,
		table_purpose: purpose,
		table_conserver_supprimer: "",
		statut_suppression: "",
	});
}

// rbac_coherence_table — read tiers vs write tiers, per exact table group.
const groups = new Map();
for (const r of rows) {
	if (!r.table) continue;
	const g = groups.get(r.table) ?? [];
	g.push(r);
	groups.set(r.table, g);
}
for (const r of rows) {
	if (!r.table) {
		r.rbac_coherence_table = "n/a";
		continue;
	}
	const g = groups.get(r.table);
	const read = [
		...new Set(g.filter((x) => READS.has(x._verb)).map((x) => x._tier)),
	].sort();
	const write = [
		...new Set(g.filter((x) => WRITES.has(x._verb)).map((x) => x._tier)),
	].sort();
	if ([...read, ...write].includes(UNKNOWN)) r.rbac_coherence_table = UNKNOWN;
	else if (read.length && write.length && read.join("+") !== write.join("+"))
		r.rbac_coherence_table = `INCOHERENT read=${read.join("+")} write=${write.join("+")}`;
	else
		r.rbac_coherence_table = `COHERENT(${[...new Set([...read, ...write])].join("+") || "no-effect"})`;
}

rows.sort(
	(x, y) =>
		(x.table || "~").localeCompare(y.table || "~") ||
		x.outil.localeCompare(y.outil),
);

const cell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** The writer-authority side-car (see header): one row per write tool. */
const WRITER_COLUMNS = [
	"outil",
	"table",
	"crud",
	"writer_tier",
	"writer_gate",
	"write_doors",
];
const writerCsv = `${[
	WRITER_COLUMNS.join(","),
	...rows
		.filter((r) => r._writer)
		.map((r) =>
			[r.outil, r.table, r.crud, r._writer.tier, r._writer.gate, r._doors]
				.map(cell)
				.join(","),
		),
].join("\n")}\n`;
const csv = `${[COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => cell(r[c] ?? "")).join(","))].join("\n")}\n`;

if (process.argv.includes("--check")) {
	for (const [file, fresh] of [
		[OUT, csv],
		[WRITER_OUT, writerCsv],
	]) {
		const current = existsSync(file) ? readFileSync(file, "utf8") : "";
		if (current !== fresh) {
			console.error(
				`${relative(ROOT, file)} is stale: re-run node scripts/derive-backend-doctor-oracle.mjs`,
			);
			process.exit(1);
		}
	}
	console.log(
		`${relative(ROOT, OUT)} matches a fresh derivation (${rows.length} rows); ${relative(ROOT, WRITER_OUT)} too`,
	);
	process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, csv);
writeFileSync(WRITER_OUT, writerCsv);
const count = (pred) => rows.filter(pred).length;
console.log(
	`wrote ${relative(ROOT, OUT)}: ${rows.length} rows (one per defineTool registration)`,
);
console.log(
	`  surface MCP-public=${count((r) => r.surface === "MCP-public")} hors-MCP=${count((r) => r.surface === "hors-MCP")}`,
);
console.log(
	`  crud unknown(?)=${count((r) => r.crud === UNKNOWN)} table empty=${count((r) => !r.table)}`,
);
console.log(
	`  unresolved Convex refs=${count((r) => r.operation_detail.includes("UNRESOLVED"))} no Convex call=${count((r) => r.operation_detail.startsWith("(no Convex"))}`,
);
