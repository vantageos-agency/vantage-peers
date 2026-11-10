/**
 * A field description says what the value MEANS; the schema says how it
 * validates. Neither repeats the other, and neither contradicts the other.
 * Task k172z2f2q3bgr9wwc3agj08xx98hv4h2 (Manufact documentation 1/2).
 *
 * Read from the SERVED tools/list (the real McpServer over an in-memory
 * transport), so every field of every tool is swept, at any depth, and a tool
 * registered tomorrow is covered without editing a list here.
 *
 *   1. restatement: no description repeats a constraint its schema already
 *      encodes (a default, an enum list, a bound, a pattern, requiredness, the
 *      JSON type), and no description carries a literal default the schema
 *      does not carry (a default lives in the schema);
 *   2. contradiction: a field described as having no effect is marked
 *      `deprecated` in its schema, and the reverse; a required field is never
 *      described as omissible; no accepted enum value is called "reserved"
 *      without saying what it does; every deprecated field is proven a no-op
 *      against the code that would read it (Convex door or MCP handler);
 *   3. tool descriptions do not restate a field's default or bound either, and
 *      no EXAMPLE passes a deprecated field;
 *   4. the titles and the three get_* descriptions named by the review.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";
import { REPORTED } from "./lib/manufactFixReport.js";

type JsonSchema = {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	anyOf?: JsonSchema[];
	enum?: unknown[];
	const?: unknown;
	default?: unknown;
	deprecated?: boolean;
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	minItems?: number;
	maxItems?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};

type ServedTool = {
	name: string;
	description?: string;
	inputSchema: JsonSchema;
	outputSchema?: JsonSchema;
	annotations?: Record<string, unknown>;
};

async function servedTools(): Promise<ServedTool[]> {
	const server = new McpServer({ name: "t", version: "0.0.0" });
	const convex = {
		query: async () => null,
		mutation: async () => null,
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, {
		clientId: "m",
		userId: "m",
		scopes: [],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3600_000,
		isMaster: true,
	} as OAuthContext);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools as ServedTool[];
}

let tools: ServedTool[] = [];
beforeAll(async () => {
	tools = await servedTools();
});

type Field = {
	tool: string;
	path: string;
	name: string;
	schema: JsonSchema;
	required: boolean;
};

function fieldsOf(tool: ServedTool): Field[] {
	const out: Field[] = [];
	const walk = (node: JsonSchema, prefix: string) => {
		const req = new Set(node.required ?? []);
		for (const [key, child] of Object.entries(node.properties ?? {})) {
			const path = prefix ? `${prefix}.${key}` : key;
			out.push({
				tool: tool.name,
				path,
				name: key,
				schema: child,
				required: req.has(key),
			});
			for (const branch of [child, child.items, ...(child.anyOf ?? [])]) {
				if (branch?.properties) walk(branch, path);
				if (branch?.items?.properties) walk(branch.items, `${path}[]`);
			}
		}
	};
	walk(tool.inputSchema, "");
	return out;
}

const allFields = () => tools.flatMap(fieldsOf);

const SAFE_INT = 9007199254740991;

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every string enum value a field accepts: its own, its items', its anyOf branches'. */
function enumValues(s: JsonSchema): string[] {
	const vals: unknown[] = [];
	for (const b of [s, s.items, ...(s.anyOf ?? [])]) {
		if (!b) continue;
		if (Array.isArray(b.enum)) vals.push(...b.enum);
		if (b.const !== undefined) vals.push(b.const);
	}
	return [...new Set(vals.filter((v): v is string => typeof v === "string"))];
}

function isType(s: JsonSchema, t: string): boolean {
	return Array.isArray(s.type) ? s.type.includes(t) : s.type === t;
}

/** A phrase that states a default: "Omit for 20", "defaults to lite", "by default true". */
const DEFAULT_PHRASE =
	/\b(?:omit(?:ted)?(?: it)?(?: for| and you get| to get)|defaults? (?:to |is )?|by default,? )\s*(?:the last |an? )?['"`]?([A-Za-z0-9_.-]+)['"`]?/gi;

const NO_EFFECT =
	/\b(changes nothing|has no effect|no effect on|is ignored|ignored,|ignored:|kept for compatibility|is a no-op|makes no difference)\b/i;

/** What a field description restates of its own schema, or states that only the schema should. */
function restatements(s: JsonSchema, required: boolean): string[] {
	const d = s.description ?? "";
	const found: string[] = [];
	const values = enumValues(s);

	// default: a literal default in prose, whether or not the schema carries it
	for (const m of d.matchAll(DEFAULT_PHRASE)) {
		const lit = m[1].replace(/[.,;:]+$/, "");
		const literal =
			/^\d+(\.\d+)?$/.test(lit) ||
			lit === "true" ||
			lit === "false" ||
			values.includes(lit);
		if (literal)
			found.push(
				s.default !== undefined
					? `default "${m[0].trim()}" restates schema default ${JSON.stringify(s.default)}`
					: `default "${m[0].trim()}" lives only in prose (put it in the schema)`,
			);
	}
	if (typeof s.default === "number" && s.default > 1) {
		if (new RegExp(`(?<![\\d.])${s.default}(?![\\d]|\\.\\d)`).test(d))
			found.push(`schema default ${s.default} repeated in prose`);
	}

	// enum: values listed as alternatives
	if (values.length >= 2) {
		const tok = `["'\`\\[]?(?:${values.map(escapeRe).join("|")})["'\`\\]]?`;
		const list = new RegExp(`${tok}\\s*(?:\\||/|,|\\+|\\bor\\b)\\s*${tok}`);
		const m = d.match(list);
		if (m) found.push(`enum list "${m[0]}"`);
	}

	// bounds: the number itself, or a bound phrase
	const bounds: Array<[string, number | undefined]> = [
		["maximum", s.maximum ?? s.items?.maximum],
		["minimum", s.minimum ?? s.items?.minimum],
		["exclusiveMinimum", s.exclusiveMinimum],
		["maxItems", s.maxItems],
		["minItems", s.minItems],
		["maxLength", s.maxLength ?? s.items?.maxLength],
		["minLength", s.minLength ?? s.items?.minLength],
	];
	for (const [k, n] of bounds) {
		if (n === undefined || Math.abs(n) === SAFE_INT || n === 0 || n === 1)
			continue;
		if (new RegExp(`(?<![\\d.])${n}(?![\\d]|\\.\\d)`).test(d))
			found.push(`${k} ${n}`);
	}
	if (
		/\b(cap(?:ped)? (?:at )?\d+|max(?:imum)? \d+|min(?:imum)? \d+|between \d+ and \d+)\b/i.test(
			d,
		)
	)
		found.push("bound phrase");
	// a bound said in words, with or without its number (task
	// k177d10zrqvw6gj9jef5hypayd8hxe34: "At most this many rows come back" on
	// a field whose schema carries `maximum` restates that maximum)
	const real = (n: number | undefined) =>
		n !== undefined && Math.abs(n) !== SAFE_INT;
	const hasBound =
		real(s.maximum) ||
		real(s.minimum) ||
		real(s.maxItems) ||
		real(s.maxLength) ||
		real(s.items?.maximum);
	const boundWords = d.match(
		/\b(at most|at least|up to|no more than|not more than|no fewer than)\b/i,
	);
	if (hasBound && boundWords) found.push(`bound in words "${boundWords[0]}"`);
	const minOne =
		s.minItems === 1 ||
		s.minLength === 1 ||
		s.items?.minLength === 1 ||
		s.exclusiveMinimum === 0;
	if (
		minOne &&
		/\b(at least one|one or more|non-?empty|must not be empty|an empty one is refused|positive)\b/i.test(
			d,
		)
	)
		found.push("minimum-one restated");

	// pattern / format
	const pat = s.pattern ?? s.items?.pattern;
	if (pat) {
		const len = pat.match(/\{(\d+)\}/)?.[1];
		if (
			len &&
			new RegExp(`\\b${len}[- ]?(char|character|digit|hex)`, "i").test(d)
		)
			found.push(`pattern length ${len}`);
		if (/\b(lowercase|alphanumeric|hex(adecimal)?)\b/i.test(d))
			found.push("pattern alphabet");
	}

	// requiredness and type
	if (
		required &&
		/\b(required|mandatory|is refused without|without (it|one) is refused|must be (given|provided|supplied))\b/i.test(
			d,
		)
	)
		found.push("requiredness restated");
	if (/^\s*optional\b/i.test(d)) found.push('opens with "Optional"');
	if (
		isType(s, "boolean") &&
		/\b(true or false|true\/false|a boolean)\b/i.test(d)
	)
		found.push("boolean type restated");
	if (isType(s, "integer") && /\ban integer\b/i.test(d))
		found.push("integer type restated");
	return found;
}

/** What a field description says that its schema contradicts. */
function contradictions(s: JsonSchema, required: boolean): string[] {
	const d = s.description ?? "";
	const found: string[] = [];
	const noEffect = NO_EFFECT.test(d);
	if (noEffect && s.deprecated !== true)
		found.push("described as having no effect, schema not deprecated");
	if (!noEffect && s.deprecated === true)
		found.push("schema deprecated, description does not say it has no effect");
	if (required && /\b(omit|may be omitted|can be left out)\b/i.test(d))
		found.push("required field described as omissible");
	for (const v of enumValues(s)) {
		if (new RegExp(`\\b${escapeRe(v)} is reserved\\b`).test(d))
			found.push(`accepted value "${v}" called reserved without its effect`);
	}
	return found;
}

describe("the detectors are bipolar", () => {
	it("restatements: each class has a PASS and a BLOCK pole", () => {
		const r = (s: JsonSchema, req = false) => restatements(s, req);
		// default
		expect(r({ description: "How many. Omit for 20." })).not.toEqual([]);
		expect(r({ default: 20, description: "How many rows come back." })).toEqual(
			[],
		);
		expect(
			r({ default: 20, description: "How many. Omit for 20." }),
		).not.toEqual([]);
		expect(
			r({ default: 7, description: "Omit for the last 7 days." }),
		).not.toEqual([]);
		expect(
			r({ enum: ["lite", "full"], description: "How much. Omit for lite." }),
		).not.toEqual([]);
		expect(
			r({
				enum: ["lite", "full"],
				default: "lite",
				description: "lite is the ID and title; full is every stored field.",
			}),
		).toEqual([]);
		expect(r({ description: "Omit for every assignee." })).toEqual([]);
		// enum
		expect(r({ enum: ["lite", "full"], description: "lite|full" })).not.toEqual(
			[],
		);
		// bounds
		expect(r({ maximum: 200, description: "Rows. Cap 200." })).not.toEqual([]);
		expect(
			r({ maximum: 200, description: "At most this many rows." }),
		).not.toEqual([]);
		expect(
			r({
				maximum: 200,
				description: "The page size: how many rows this page holds.",
			}),
		).toEqual([]);
		expect(r({ description: "Keep at most one row per owner." })).toEqual([]);
		expect(
			r({ minLength: 1, description: "The project; an empty one is refused." }),
		).not.toEqual([]);
		// pattern
		expect(
			r({ pattern: "^[a-z0-9]{32}$", description: "a 32-char ID" }),
		).not.toEqual([]);
		expect(
			r({
				pattern: "^[a-z0-9]{32}$",
				description: "its taskId, as list_tasks returns it",
			}),
		).toEqual([]);
		// required and type
		expect(r({ description: "The project. Required." }, true)).not.toEqual([]);
		expect(r({ description: "The project." }, true)).toEqual([]);
		expect(r({ type: "boolean", description: "true or false" })).not.toEqual(
			[],
		);
	});

	it("contradictions: each class has a PASS and a BLOCK pole", () => {
		const c = (s: JsonSchema, req = false) => contradictions(s, req);
		expect(
			c({ description: "Changes nothing on this tool. Omit it." }),
		).not.toEqual([]);
		expect(
			c({ deprecated: true, description: "Has no effect on this tool." }),
		).toEqual([]);
		expect(
			c({ deprecated: true, description: "How much comes back." }),
		).not.toEqual([]);
		expect(
			c({ description: "The task. Omit it to use yours." }, true),
		).not.toEqual([]);
		expect(c({ description: "The task." }, true)).toEqual([]);
		expect(
			c({ enum: ["merge", "replace"], description: "replace is reserved." }),
		).not.toEqual([]);
		expect(
			c({
				enum: ["merge", "replace"],
				description: "replace is accepted and behaves as merge.",
			}),
		).toEqual([]);
	});
});

describe("field descriptions — class sweep over every served field", () => {
	it("the sweep is not degenerate (sees every tool and hundreds of fields)", () => {
		expect(tools.length).toBeGreaterThanOrEqual(90);
		expect(allFields().length).toBeGreaterThan(300);
	});

	it("no field description restates its schema", () => {
		const offenders = allFields().flatMap((f) => {
			const r = restatements(f.schema, f.required);
			return r.length ? [`${f.tool}.${f.path}: ${r.join("; ")}`] : [];
		});
		expect(offenders).toEqual([]);
	});

	it("no field description contradicts its schema", () => {
		const offenders = allFields().flatMap((f) => {
			const c = contradictions(f.schema, f.required);
			return c.length ? [`${f.tool}.${f.path}: ${c.join("; ")}`] : [];
		});
		expect(offenders).toEqual([]);
	});

	it("a lite/full switch that changes the output says what each returns, and carries its default", () => {
		const offenders = allFields().flatMap((f) => {
			if (f.name !== "fields" || f.schema.deprecated) return [];
			if (!enumValues(f.schema).includes("lite")) return [];
			const d = f.schema.description ?? "";
			const problems: string[] = [];
			// Says what each projection returns. Pi ruling (task
			// k1708xy6dwrb8xx36ztkxfd9d58hwf0t): a description may name the two
			// values, or describe them without the enum words (the short form /
			// every stored field); it always says what the full form is.
			if (!/every stored field/.test(d))
				problems.push("says what full returns");
			if (f.schema.default === undefined) problems.push("schema default");
			if (/always receives full rows/.test(d))
				problems.push("claims full rows for some callers");
			return problems.length
				? [`${f.tool}.${f.path}: ${problems.join("; ")}`]
				: [];
		});
		expect(offenders).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Every deprecated (no-effect) field, proven a no-op against the code that would
// read it. A door field: the Convex function body never reads args.<field>. A
// handler field: the MCP handler never destructures it.
// ─────────────────────────────────────────────────────────────────────────────

const NO_EFFECT_FIELDS: Record<string, { door?: string; handler?: true }> = {
	"recall.fields": { door: "search:recall" },
	"text_search.fields": { door: "search:textSearch" },
	"hybrid_search.fields": { door: "search:hybridSearch" },
	"search_episodes_by_keyword.fields": { door: "search:textSearch" },
	"search_episodes_by_semantic.fields": { door: "search:recall" },
	"list_broadcast_status.fields": { door: "messages:listBroadcastStatus" },
	"search_fix_patterns.fields": { door: "search:searchFixPatterns" },
	"list_blocked_on_me.recipient": { handler: true },
	"import_okf_bundle.idempotencyKey": { door: "okfBundleNode:importOkfBundle" },
};

const REPO = join(__dirname, "..", "..");

function convexFunctionBody(door: string): string {
	const [mod, fn] = door.split(":");
	const text = readFileSync(join(REPO, "convex", `${mod}.ts`), "utf8");
	const start = text.search(new RegExp(`^export const ${fn} = `, "m"));
	if (start < 0) throw new Error(`no export ${fn} in convex/${mod}.ts`);
	const rest = text.slice(start + 1);
	const next = rest.search(/^export (const|function) /m);
	return next < 0 ? rest : rest.slice(0, next);
}

function handlerParams(tool: string): string {
	const srcDir = join(REPO, "mcp-server", "src");
	for (const file of [
		"tools.ts",
		"tools/importOkfBundle.ts",
		"tools/exportOkfBundle.ts",
		"tools/kbIngest.ts",
	]) {
		const text = readFileSync(join(srcDir, file), "utf8");
		const at = text.indexOf(`"${tool}",`);
		if (at < 0) continue;
		const m = text.slice(at).match(/async \(\s*(\{[^}]*\})/);
		if (m) return m[1];
	}
	throw new Error(`no handler found for ${tool}`);
}

describe("a deprecated field changes nothing, measured in the code", () => {
	it("the set of served deprecated fields is exactly the no-effect table", () => {
		const served = allFields()
			.filter((f) => f.schema.deprecated === true)
			.map((f) => `${f.tool}.${f.path}`)
			.sort();
		expect(served).toEqual(Object.keys(NO_EFFECT_FIELDS).sort());
	});

	it("the door scan is bipolar: it sees a door that does read its field", () => {
		expect(convexFunctionBody("messages:searchMessagesByKeyword")).toMatch(
			/\bargs\.fields\b/,
		);
		expect(handlerParams("list_tasks")).toMatch(/\bfields\b/);
	});

	for (const [key, where] of Object.entries(NO_EFFECT_FIELDS)) {
		it(`${key} is read nowhere`, () => {
			const [tool, field] = key.split(".");
			if (where.door) {
				const body = convexFunctionBody(where.door);
				expect(body, where.door).not.toMatch(
					new RegExp(`\\bargs\\.${field}\\b`),
				);
				expect(body, where.door).not.toMatch(
					new RegExp(`\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=\\s*args\\b`),
				);
			}
			if (where.handler)
				expect(handlerParams(tool)).not.toMatch(new RegExp(`\\b${field}\\b`));
		});
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool descriptions
// ─────────────────────────────────────────────────────────────────────────────

describe("tool descriptions agree with their input schema", () => {
	it("no tool description restates a field's default or bound", () => {
		const offenders = tools.flatMap((t) => {
			const d = t.description ?? "";
			const hits: string[] = [];
			if (/\bDefault limit\b|\bcap \d+\b|\blimit default\b/i.test(d))
				hits.push("limit default/cap");
			for (const f of fieldsOf(t)) {
				if (f.schema.default === undefined) continue;
				const v = escapeRe(String(f.schema.default));
				if (
					new RegExp(
						`\\b${escapeRe(f.name)}\\b[^.;]{0,24}\\bdefaults? (?:to |is )?['"\`]?${v}\\b`,
						"i",
					).test(d)
				)
					hits.push(`${f.name} default`);
			}
			return hits.length ? [`${t.name}: ${hits.join("; ")}`] : [];
		});
		expect(offenders).toEqual([]);
	});

	it("no tool description lists a field's enum values as a slash list", () => {
		const offenders = tools.flatMap((t) =>
			fieldsOf(t).flatMap((f) => {
				const values = enumValues(f.schema);
				if (values.length < 3) return [];
				const list = new RegExp(
					`\\((?:${values.map(escapeRe).join("|")})(?:/(?:${values.map(escapeRe).join("|")})){2,}\\)`,
				);
				return list.test(t.description ?? "") ? [`${t.name}: ${f.name}`] : [];
			}),
		);
		expect(offenders).toEqual([]);
	});

	it("no EXAMPLE passes a deprecated field", () => {
		const offenders = tools.flatMap((t) => {
			const example = (t.description ?? "").split("EXAMPLE:")[1] ?? "";
			return fieldsOf(t)
				.filter((f) => f.schema.deprecated === true)
				.filter((f) => new RegExp(`\\b${escapeRe(f.name)}=`).test(example))
				.map((f) => `${t.name}: ${f.name}`);
		});
		expect(offenders).toEqual([]);
	});

	it("no tool description says 'Convex document ID' (an ID is the one the listing tools return)", () => {
		const offenders = tools
			.filter((t) => /Convex document ID/.test(t.description ?? ""))
			.map((t) => t.name);
		expect(offenders).toEqual([]);
	});
});

/** The stored fields of a table, read from convex/schema.ts. */
function tableFields(table: string): Set<string> {
	const text = readFileSync(join(REPO, "convex", "schema.ts"), "utf8");
	const start = text.indexOf(`\t${table}: defineTable({`);
	if (start < 0) throw new Error(`no table ${table}`);
	const end = text.indexOf("\n\t})", start);
	const block = text.slice(start, end);
	const names = [...block.matchAll(/^\t\t([a-zA-Z_]+):/gm)].map((m) => m[1]);
	return new Set(["_id", "_creationTime", ...names]);
}

describe("the three get_* tools: description, schema and annotations say the same thing", () => {
	const CASES: Array<[string, string, string]> = [
		["get_task", "tasks", "taskId"],
		["get_briefing_note", "briefingNotes", "noteId"],
		["get_recurring_task", "recurringTasks", "recurringTaskId"],
	];

	for (const [tool, table, idField] of CASES) {
		it(`${tool}: one list of returned fields, every one a stored field of ${table}`, () => {
			const t = tools.find((x) => x.name === tool);
			if (!t) throw new Error(`not served: ${tool}`);
			const d = t.description ?? "";
			expect(d, "a second, different field list").not.toMatch(
				/with all fields:/,
			);
			// Returns { a, b? } (the whole result) or Returns ... (a, b) (a selection)
			const whole = returnsList(d).get("");
			const m = d.match(/Returns[^(]*\(([^)]*)\)/);
			expect(
				whole ?? m,
				"Returns { <fields> } or Returns (<fields>)",
			).toBeTruthy();
			const stored = tableFields(table);
			const named = (whole ?? (m?.[1] ?? "").split(/,\s*|\s+and\s+/))
				.map((s) => s.trim())
				.filter(Boolean);
			expect(named.length).toBeGreaterThan(2);
			// A stored field, or a field the output schema declares beside the row
			// (derived by the door: deliverableDivergence, contentTruncated).
			const declared = new Set(Object.keys(t.outputSchema?.properties ?? {}));
			expect(named.filter((n) => !stored.has(n) && !declared.has(n))).toEqual(
				[],
			);
			expect(t.annotations?.readOnlyHint).toBe(true);
			// a read-only fetch names no write tool as its purpose
			expect(d).not.toMatch(/before (pause|update|delete)_/);
		});

		it(`${tool}.${idField} names where the ID comes from, never the tool itself`, () => {
			const t = tools.find((x) => x.name === tool);
			const d = t?.inputSchema.properties?.[idField]?.description ?? "";
			expect(d).not.toMatch(new RegExp(`\\b${tool}\\b`));
			expect(d).toMatch(/\b(list|create|search)_[a-z_]+/);
		});
	}
});

describe("titles name the capability performed", () => {
	const title = (n: string) =>
		String(tools.find((t) => t.name === n)?.annotations?.title ?? "");

	it("set_summary: the title names the summary peers read, not a task", () => {
		expect(title("set_summary")).toMatch(/summary/i);
		expect(title("set_summary")).not.toMatch(/\btask\b/i);
	});

	it("export_okf_bundle / import_okf_bundle: the title names the namespace bundle, not memories only", () => {
		for (const n of ["export_okf_bundle", "import_okf_bundle"]) {
			expect(title(n), n).toMatch(/namespace|OKF/i);
			expect(title(n), n).not.toMatch(/memor/i);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Manufact's documentation fix report, item by item (task
// k177d10zrqvw6gj9jef5hypayd8hxe34). Its judge is not reproducible from text
// alone (identical descriptions on two tools, one flagged and one not), so each
// named item is pinned as well as caught by a class rule where one exists.
// ─────────────────────────────────────────────────────────────────────────────

function at(t: ServedTool, pointer: string): JsonSchema | undefined {
	let node: unknown = t.inputSchema;
	for (const seg of pointer.replace(/^#\/?/, "").split("/").filter(Boolean)) {
		node = (node as Record<string, unknown> | undefined)?.[seg];
	}
	return node as JsonSchema | undefined;
}

describe("Manufact fix report: every named input item is rewritten", () => {
	it("the fixture holds the 27 restated fields, the source field and get_message", () => {
		expect(
			REPORTED.filter((r) => r[2] === "restates" && r[1] !== "#"),
		).toHaveLength(27);
		expect(REPORTED.filter((r) => r[2] === "source")).toHaveLength(1);
		expect(REPORTED.filter((r) => r[1] === "#").map((r) => r[0])).toEqual([
			"get_message",
		]);
	});

	for (const [tool, pointer, kind, flagged] of REPORTED) {
		it(`${tool} ${pointer} (${kind}): no longer the flagged text, and restates nothing`, () => {
			const t = tools.find((x) => x.name === tool);
			if (!t) throw new Error(`not served: ${tool}`);
			const now =
				pointer === "#"
					? (t.description ?? "")
					: (at(t, pointer)?.description ?? "");
			expect(now.trim()).not.toBe("");
			expect(now).not.toBe(flagged);
			if (pointer !== "#") {
				const s = at(t, pointer) as JsonSchema;
				expect(restatements(s, false)).toEqual([]);
			}
		});
	}

	// Each identity field below names the tool (or the field of a previous reply)
	// its value is copied from. The first is Manufact's "source" item; the other
	// three are mcp-doctor C-40 (6) inputs-sourced reds (report 56425010, mcp-doctor
	// 39a5d0adce; task k17a9k0qneagqkp4wsp486xbh58hx7nj).
	const SOURCED: [tool: string, field: string, sources: RegExp[]][] = [
		[
			"search_briefing_notes_by_keyword",
			"createdBy",
			[/\blist_peers\b/, /user:<subject>/],
		],
		["list_tasks_by_mission", "createdBy", [/\blist_peers\b/, /\bwhoami\b/]],
		["list_diaries", "createdBy", [/\blist_peers\b/, /\bwhoami\b/]],
		[
			"get_github_owner_bindings",
			"unprovenCursor",
			[/\bget_github_owner_bindings\b/, /\bunprovenNextCursor\b/],
		],
	];
	for (const [tool, field, sources] of SOURCED) {
		it(`${tool}.${field} says where the value comes from`, () => {
			const t = tools.find((x) => x.name === tool);
			const d = t?.inputSchema.properties?.[field]?.description ?? "";
			for (const s of sources) expect(d).toMatch(s);
		});
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// mcp-doctor C-40 criterion (6) inputs-sourced, as a class rule over every
// served field: an `…Id` / `…Ids` / `…Cursor` / `…By` field says where its value
// comes from or what form it takes. Mirrors `sourced()` in mcp-doctor
// src/detectors/c40-tool-documentation.ts at 39a5d0adce, so a field the doctor
// would score red fails here first (task k17a9k0qneagqkp4wsp486xbh58hx7nj).
// ─────────────────────────────────────────────────────────────────────────────

const IDENTITY_FIELD = /(Id|Ids|Cursor|By)$/;

function sourcedLikeDoctor(d: string, served: string[]): boolean {
	if (served.some((name) => new RegExp(`\\b${escapeRe(name)}\\b`).test(d)))
		return true;
	if (/\b(returned by|returns?|carried by|given by|from)\b/i.test(d))
		return true;
	if (/["'`][^"'`\s]{1,64}["'`]/.test(d)) return true;
	return /\b(name|ID)\b/.test(d);
}

describe("mcp-doctor C-40 inputs-sourced: every identity field names its source", () => {
	it("no served …Id / …Ids / …Cursor / …By field lacks a source, example or convention", () => {
		const served = tools.map((t) => t.name);
		const unsourced = allFields()
			.filter((f) => IDENTITY_FIELD.test(f.name))
			.filter((f) => !sourcedLikeDoctor(f.schema.description ?? "", served))
			.map((f) => `${f.tool}.${f.path}`);
		expect(unsourced).toEqual([]);
	});
});

/** The fields a Returns { ... } clause lists at its top level, and per listed child. */
function returnsList(description: string): Map<string, string[]> {
	const at0 = description.search(/\bReturns \{/);
	if (at0 < 0) return new Map();
	const rest = description.slice(at0 + "Returns ".length);
	let depth = 0;
	let end = 0;
	for (let i = 0; i < rest.length; i++) {
		if ("{[(".includes(rest[i])) depth++;
		if ("}])".includes(rest[i])) depth--;
		if (depth === 0) {
			end = i;
			break;
		}
	}
	const out = new Map<string, string[]>();
	const parse = (body: string, key: string) => {
		const names: string[] = [];
		let d = 0;
		let cur = "";
		const items: string[] = [];
		for (const ch of body) {
			if ("{[(".includes(ch)) d++;
			if ("}])".includes(ch)) d--;
			if (ch === "," && d === 0) {
				items.push(cur);
				cur = "";
			} else cur += ch;
		}
		items.push(cur);
		for (const raw of items) {
			const m =
				/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*(?::\s*true)?\s*(\[?\{([\s\S]*)\}\]?)?\s*$/.exec(
					raw,
				);
			if (!m) throw new Error(`not a field: "${raw}"`);
			names.push(m[1]);
			if (m[3] !== undefined) parse(m[3], key === "" ? m[1] : `${key}.${m[1]}`);
		}
		out.set(key, names.sort());
	};
	parse(rest.slice(1, end), "");
	return out;
}

describe("Manufact fix report: the output schema and the documented result agree", () => {
	// "Align the output schema with the tool's documented result", and
	// get_github_owner_bindings "Describe the returned fields".
	const ALIGNED = [
		"correct_task_segment",
		"get_fix_pattern",
		"get_message",
		"get_recurring_task",
		"get_github_owner_bindings",
	];

	for (const tool of ALIGNED) {
		it(`${tool}: Returns { ... } names exactly the schema's properties, nested lists included`, () => {
			const t = tools.find((x) => x.name === tool);
			if (!t?.outputSchema) throw new Error(`no outputSchema: ${tool}`);
			const listed = returnsList(t.description ?? "");
			expect(listed.get(""), "a Returns { ... } clause").toBeDefined();
			const props = (s: JsonSchema | undefined) =>
				Object.keys(s?.properties ?? s?.items?.properties ?? {}).sort();
			expect(listed.get("")).toEqual(props(t.outputSchema));
			for (const [key, names] of listed) {
				if (key === "") continue;
				let s: JsonSchema | undefined = t.outputSchema;
				for (const seg of key.split(".")) s = s?.properties?.[seg];
				expect(names, key).toEqual(props(s));
			}
		});
	}

	it("get_github_owner_bindings types each binding and each unproven mapping", () => {
		const t = tools.find((x) => x.name === "get_github_owner_bindings");
		const item = (k: string) =>
			Object.keys(
				t?.outputSchema?.properties?.[k]?.items?.properties ?? {},
			).sort();
		expect(item("bindings")).toEqual(
			[
				"accountType",
				"active",
				"boundAt",
				"githubUserLogin",
				"installationId",
				"orgId",
				"owner",
			].sort(),
		);
		expect(item("unprovenMappings")).toEqual(
			["orgId", "project", "reason", "repo"].sort(),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The no-op `fields` key the list contract removed from seven published input
// schemas (task k17e90s1n85hjappy26vs2kww18hxjp1, Pi ruling 2026-11-10): it is
// not advertised, and a caller that still sends it is not refused either. One
// declared list drops that one key before strict validation; every other
// unknown key on those tools is still refused, and every other tool keeps its
// behaviour. Driven through the real McpServer (the SDK's own input
// validation), over a Convex that records what each call asked of it.
// ─────────────────────────────────────────────────────────────────────────────

const FIELDS_IGNORED = [
	"list_recurring_tasks",
	"list_peers",
	"list_fix_patterns",
	"list_messages",
	"list_memories",
	"list_episodes",
	"list_diaries",
] as const;

const NOOP_ARGS: Record<
	(typeof FIELDS_IGNORED)[number],
	Record<string, unknown>
> = {
	list_recurring_tasks: {},
	list_peers: {},
	list_fix_patterns: {},
	list_messages: {},
	list_memories: { namespace: "global" },
	list_episodes: { namespace: "global" },
	list_diaries: {},
};

/** One row carrying what every door's handler projection reads. */
const NOOP_ROW = {
	_id: "row1",
	_creationTime: 1_760_000_000_000,
	orchestratorId: "alpha",
	name: "n",
	static: { role: "r", workspace: "/w", capabilities: [] },
	dynamic: { lastSeen: 1_760_000_000_000, sessionCount: 1 },
	from: "alpha",
	content: "c",
	createdBy: "alpha",
	createdAt: 1_760_000_000_000,
	updatedAt: 1_760_000_000_000,
	namespace: "global",
	type: "project",
	relations: [],
	isLatest: true,
	title: "t",
	assignedTo: "alpha",
	priority: "medium",
	status: "todo",
	cronExpression: "0 9 * * *",
	nextRunAt: 1_760_000_000_000,
	active: true,
	symptom: "s",
	rootCause: "r",
	tags: [],
	stack: [],
	sourceProject: "p",
	severity: "low",
	date: "2026-11-10",
	orchestrator: "alpha",
};

type Called = {
	content: Array<{ text: string }>;
	isError?: boolean;
	structuredContent?: unknown;
};

async function recordingClient(): Promise<{
	call: (name: string, args: Record<string, unknown>) => Promise<Called>;
	doors: Array<[string, unknown]>;
	close: () => Promise<void>;
}> {
	const doors: Array<[string, unknown]> = [];
	const server = new McpServer({ name: "t", version: "0.0.0" });
	const convex = {
		query: async (door: string, args: unknown) => {
			doors.push([door, args]);
			return door === "memories:listMemories"
				? { value: [NOOP_ROW], continueCursor: null, isDone: true }
				: [NOOP_ROW];
		},
		mutation: async () => null,
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, {
		clientId: "m",
		userId: "m",
		scopes: [],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3600_000,
		isMaster: true,
	} as OAuthContext);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	return {
		call: async (name, args) =>
			(await client.callTool({ name, arguments: args })) as unknown as Called,
		doors,
		close: () => client.close(),
	};
}

describe("a no-op `fields` key is ignored on the seven list tools that no longer declare it", () => {
	it("the seven published input schemas do not contain fields", () => {
		const declared = FIELDS_IGNORED.filter(
			(n) =>
				tools.find((t) => t.name === n)?.inputSchema.properties?.fields !==
				undefined,
		);
		expect(declared).toEqual([]);
	});

	for (const tool of FIELDS_IGNORED) {
		it(`${tool}: a call WITH fields ("lite", "full") answers exactly what the call without it answers, and asks Convex the same`, async () => {
			const answers: Called[] = [];
			const asked: string[] = [];
			for (const extra of [{}, { fields: "lite" }, { fields: "full" }]) {
				const c = await recordingClient();
				answers.push(await c.call(tool, { ...NOOP_ARGS[tool], ...extra }));
				asked.push(JSON.stringify(c.doors));
				await c.close();
			}
			expect(answers[0].isError, answers[0].content?.[0]?.text).not.toBe(true);
			expect(answers[1]).toEqual(answers[0]);
			expect(answers[2]).toEqual(answers[0]);
			expect(asked[1]).toBe(asked[0]);
			expect(asked[2]).toBe(asked[0]);
		});

		it(`${tool}: any OTHER unknown key is still refused as unrecognized`, async () => {
			const c = await recordingClient();
			const r = await c.call(tool, {
				...NOOP_ARGS[tool],
				fields: "lite",
				fieldz: "lite",
			});
			await c.close();
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/Unrecognized key/);
			expect(r.content[0].text).toMatch(/fieldz/);
			expect(r.content[0].text).not.toMatch(/"fields"/);
			expect(c.doors).toEqual([]);
		});
	}

	it("a tool outside the list keeps its behaviour: list_tasks still reads fields, get_task still refuses it", async () => {
		const c = await recordingClient();
		const full = await c.call("list_tasks", { fields: "full" });
		expect(full.isError, full.content?.[0]?.text).not.toBe(true);
		const refused = await c.call("get_task", {
			taskId: "a".repeat(32),
			fields: "lite",
		});
		await c.close();
		expect(refused.isError).toBe(true);
		expect(refused.content[0].text).toMatch(/Unrecognized key/);
		expect(refused.content[0].text).toMatch(/fields/);
		expect(
			tools.find((t) => t.name === "list_tasks")?.inputSchema.properties
				?.fields,
		).toBeDefined();
	});
});
