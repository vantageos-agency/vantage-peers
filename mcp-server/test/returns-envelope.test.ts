/**
 * Every tool's description states the result it really returns: its
 * "Returns { ... }" clause names exactly the TOP-LEVEL properties of the
 * tool's output schema (the envelope: items / truncated / found / ...), and
 * the row fields only inside it (items[{ ... }], item{ ... }). VantagePeers
 * Cloud, task k1708xy6dwrb8xx36ztkxfd9d58hwf0t.
 *
 * Class addressed (Manufact re-review of a56cb06a, measured by Pi): a clause
 * that names the ROW fields while the schema's top level is an envelope reads
 * as a different result from the one the client validates.
 *
 * Read from the SERVED tools/list, so a tool registered tomorrow is covered.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { LIST_CONTRACTS } from "../src/listContract.js";
import { registerTools } from "../src/tools.js";
import {
	CONTRADICTIONS,
	FLAGGED_FIELDS,
	OUTPUTS_ALIGN,
} from "./lib/manufactReview2141.js";

type JsonSchema = {
	type?: string | string[];
	required?: string[];
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	anyOf?: JsonSchema[];
};
/** An input schema node, as served. */
type InputNode = {
	type?: string | string[];
	description?: string;
	pattern?: string;
	default?: unknown;
	enum?: unknown[];
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	items?: InputNode;
	properties?: Record<string, InputNode>;
};

type ServedTool = {
	name: string;
	title?: string;
	description?: string;
	outputSchema?: JsonSchema;
	inputSchema?: InputNode;
	annotations?: { title?: string };
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

/** Splits on commas outside any (), [], {} pair. */
function splitTopLevel(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of body) {
		if ("([{".includes(ch)) depth++;
		if (")]}".includes(ch)) depth--;
		if (ch === "," && depth === 0) {
			parts.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur.trim() !== "") parts.push(cur);
	return parts;
}

/**
 * The top-level names of the description's "Returns { ... }" clause, or a
 * reason it has none. The clause is the first "Returns" followed (within a
 * few words) by "{".
 */
function returnsTopLevel(
	description: string,
):
	| { names: string[]; children: Record<string, string[]> }
	| { problem: string } {
	const at = description.search(/\bReturns\b/);
	if (at < 0) return { problem: "no Returns clause" };
	const rest = description.slice(at);
	const open = rest.indexOf("{");
	if (open < 0 || open > 40) {
		return {
			problem: `Returns clause names no envelope: "${rest.slice(0, 60)}"`,
		};
	}
	let depth = 0;
	for (let i = open; i < rest.length; i++) {
		if ("([{".includes(rest[i])) depth++;
		if (")]}".includes(rest[i])) depth--;
		if (depth === 0) {
			const names: string[] = [];
			const children: Record<string, string[]> = {};
			for (const raw of splitTopLevel(rest.slice(open + 1, i))) {
				const m =
					/^\s*(?:plus\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*(?::\s*\w*)?\s*\??\s*\[?\s*(?:\{([\s\S]*)\})?/.exec(
						raw,
					);
				if (m === null) {
					names.push(`?${raw.trim()}`);
					continue;
				}
				names.push(m[1]);
				if (m[2] !== undefined) {
					children[m[1]] = splitTopLevel(m[2])
						.map((c) => /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(c)?.[1] ?? `?${c}`)
						.filter(Boolean);
				}
			}
			return { names, children };
		}
	}
	return { problem: "unbalanced Returns clause" };
}

/** No-op inputs the list contract dropped (task k17e90s1n85hjappy26vs2kww18hxjp1). */
const DROPPED_INPUTS = new Set(["list_peers #/properties/fields"]);

/**
 * Tools whose row fields are stated ONCE, by their outputSchema, and not in
 * the Returns clause (task k17e90s1n85hjappy26vs2kww18hxjp1): the paged lists
 * governed by src/listContract.ts, and the four found reads. Measured by
 * Manufact (baseline 2026-11-09 -> 2026-11-10T13:03Z): adding a partial row
 * list to these clauses lowered their description score (list_recurring_tasks
 * 97 -> 80) and output score (86 -> 65); the clause names the envelope only.
 */
const ROWS_STATED_BY_SCHEMA = new Set<string>([
	...Object.keys(LIST_CONTRACTS),
	"get_diary",
	"get_mission",
	"get_mission_template",
	"get_profile",
]);

/** Where a description's Returns clause and its schema's top level disagree. */
function envelopeMismatch(tool: ServedTool): string | null {
	const top = Object.keys(tool.outputSchema?.properties ?? {}).sort();
	if (top.length === 0) return "no output schema properties";
	const r = returnsTopLevel(tool.description ?? "");
	if ("problem" in r) return r.problem;
	const listed = [...new Set(r.names)].sort();
	const missing = top.filter((n) => !listed.includes(n));
	const extra = listed.filter((n) => !top.includes(n));
	// Then the row fields: a top-level property that holds rows (an array of
	// objects) or one row (an object) is named with its fields, every required
	// one, none the row lacks.
	const rows: string[] = [];
	for (const name of top) {
		const p = tool.outputSchema?.properties?.[name];
		const row = p?.items?.properties ? p.items : p?.properties ? p : undefined;
		if (row === undefined) continue;
		const named = r.children[name];
		const fields = Object.keys(row.properties ?? {});
		if (named === undefined && ROWS_STATED_BY_SCHEMA.has(tool.name)) continue;
		if (named === undefined) {
			rows.push(`${name}: row fields not named`);
			continue;
		}
		const lacking = (row.required ?? []).filter((f) => !named.includes(f));
		const unknown = named.filter((f) => !fields.includes(f));
		if (lacking.length)
			rows.push(
				`${name}: required row fields not named: ${lacking.join(", ")}`,
			);
		if (unknown.length)
			rows.push(`${name}: named, the row lacks: ${unknown.join(", ")}`);
	}
	if (missing.length === 0 && extra.length === 0 && rows.length === 0)
		return null;
	return [
		...rows,
		missing.length ? `schema has, clause omits: ${missing.join(", ")}` : "",
		extra.length ? `clause names, schema lacks: ${extra.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("; ");
}

let tools: ServedTool[] = [];
beforeAll(async () => {
	tools = await servedTools();
});

describe("the detector is bipolar", () => {
	const schema = {
		properties: { items: {}, nextCursor: {}, truncated: {} },
	};
	it("an envelope clause passes, a row clause and a missing clause fail", () => {
		expect(
			envelopeMismatch({
				name: "t",
				description:
					"List. Returns { items[{ a, b }], nextCursor, truncated? }: rows.",
				outputSchema: schema,
			}),
		).toBeNull();
		expect(
			envelopeMismatch({
				name: "t",
				description: "List. Returns { a, b }, newest first.",
				outputSchema: schema,
			}),
		).not.toBeNull();
		expect(
			envelopeMismatch({
				name: "t",
				description: "List the rows.",
				outputSchema: schema,
			}),
		).toBe("no Returns clause");
		expect(
			envelopeMismatch({
				name: "t",
				description: "Returns the rows as a JSON array.",
				outputSchema: schema,
			}),
		).toMatch(/names no envelope/);
	});
});

describe("every Returns clause names the output schema's top level", () => {
	it("covers every served tool", () => {
		expect(tools.length).toBeGreaterThanOrEqual(90);
		expect(tools.filter((t) => !t.outputSchema)).toEqual([]);
	});

	it("0 mismatches between a Returns clause and its schema's top-level properties", () => {
		const mismatches = tools.flatMap((t) => {
			const m = envelopeMismatch(t);
			return m === null ? [] : [`${t.name}: ${m}`];
		});
		expect(mismatches).toEqual([]);
	});
});

// The other actionable items of the same re-review, one each.
describe("Manufact re-review of a56cb06a: the remaining actionable items", () => {
	const tool = (name: string) => {
		const t = tools.find((x) => x.name === name);
		if (!t) throw new Error(`not served: ${name}`);
		return t;
	};

	it("correct_task_segment.reason: the 12-non-space-character rule lives in the schema, not in prose", () => {
		const reason = tool("correct_task_segment").inputSchema?.properties?.reason;
		expect(reason?.pattern).toBeDefined();
		const re = new RegExp(reason?.pattern as string);
		// the door's own rule: reason.replace(/\s/g, "").length >= 12 (convex/tasks.ts)
		for (const [text, ok] of [
			["unrecorded break, real work was 5 hours", true],
			["abcdefghijkl", true],
			[" a b c d e f g h i j k l ", true],
			["abcdefghijk", false],
			["a b c d e f g h i j k     ", false],
			["", false],
		] as const) {
			expect(re.test(text), JSON.stringify(text)).toBe(ok);
			expect(text.replace(/\s/g, "").length >= 12).toBe(ok);
		}
		expect(reason?.description ?? "").not.toMatch(/\b12\b|non-space/);
	});

	it("export_okf_bundle.urlTtl says what happens when it is omitted", () => {
		const d =
			tool("export_okf_bundle").inputSchema?.properties?.urlTtl?.description ??
			"";
		// Pi ruling (task k1708xy6dwrb8xx36ztkxfd9d58hwf0t): says what omission
		// does without restating the schema's default or the word "omit"
		expect(d).toMatch(/\bWithout it\b/);
	});

	it("soft_delete_document says what each returned field means", () => {
		const d = tool("soft_delete_document").description ?? "";
		expect(d).toMatch(/markedCount (is|counts|says)/);
		expect(d).toMatch(/docId (is|echoes|names)/);
	});

	it("list_peers: the title names what the tool lists for every caller, not only an organisation's agents", () => {
		const title =
			tool("list_peers").annotations?.title ?? tool("list_peers").title ?? "";
		expect(title).not.toBe("List my organisation's agents");
		expect(title).toMatch(/peer/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Manufact re-review of live 406c3994 (2026-11-09T21:41), task
// k1708xy6dwrb8xx36ztkxfd9d58hwf0t. Pi's ruling: a field description keeps
// meaning and usage only; what its own schema carries (enum values, bounds,
// default, type) and validation cross-references ("omit", "filter on it",
// "must be") are not repeated in it.
// ─────────────────────────────────────────────────────────────────────────────

const SAFE = 9007199254740991;
const TYPE_WORDS = ["integer", "string", "boolean", "array", "number"];

function nodeAt(t: ServedTool, pointer: string): InputNode | undefined {
	let node: unknown = t.inputSchema;
	for (const seg of pointer.replace(/^#\//, "").split("/")) {
		node = (node as Record<string, unknown> | undefined)?.[seg];
	}
	return node as InputNode | undefined;
}

/** The tokens a description may not carry, derived from the field's own schema. */
function forbiddenTokens(n: InputNode): RegExp[] {
	const out: RegExp[] = [];
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const values = [...(n.enum ?? []), ...(n.items?.enum ?? [])];
	if (n.default !== undefined) values.push(n.default);
	for (const v of values) {
		if (typeof v === "string")
			out.push(new RegExp(`(?<![\\w-])${esc(v)}(?![\\w-])`));
		if (typeof v === "number" || typeof v === "boolean")
			out.push(new RegExp(`(?<![\\w.])${esc(String(v))}(?![\\w]|\\.\\d)`));
	}
	for (const b of [
		n.minimum,
		n.maximum,
		n.exclusiveMinimum,
		n.minLength,
		n.maxLength,
		n.minItems,
		n.maxItems,
		n.items?.minimum,
		n.items?.maximum,
	]) {
		if (b === undefined || Math.abs(b) === SAFE) continue;
		out.push(new RegExp(`(?<![\\d.])${b}(?![\\d]|\\.\\d)`));
	}
	for (const w of TYPE_WORDS) out.push(new RegExp(`\\b${w}\\b`, "i"));
	out.push(/\bomit/i, /\bfilter on it\b/i, /\bmust be\b/i);
	return out;
}

describe("Manufact 2141: the 35 flagged field descriptions keep meaning and usage only", () => {
	it("the fixture holds the 35 flagged fields", () => {
		expect(FLAGGED_FIELDS).toHaveLength(35);
	});

	for (const [tool, pointer, flagged] of FLAGGED_FIELDS) {
		it(`${tool} ${pointer}: rewritten, and carries nothing its schema already says`, () => {
			const t = tools.find((x) => x.name === tool);
			if (!t) throw new Error(`not served: ${tool}`);
			const n = nodeAt(t, pointer);
			// A no-op input dropped from its tool (task k17e90s1n85hjappy26vs2kww18hxjp1,
			// list_peers.fields) is the strongest rewrite: nothing left to restate.
			if (n === undefined && DROPPED_INPUTS.has(`${tool} ${pointer}`)) return;
			const d = n?.description ?? "";
			expect(d.trim()).not.toBe("");
			expect(d).not.toBe(flagged);
			const hits = forbiddenTokens(n as InputNode)
				.filter((re) => re.test(d))
				.map(String);
			expect(hits).toEqual([]);
		});
	}
});

/** Every field name an output schema declares, at the top level and in its rows. */
function outputFieldNames(s: JsonSchema | undefined): Set<string> {
	const out = new Set<string>();
	const visit = (n: JsonSchema | undefined, depth: number) => {
		if (n === undefined || depth > 3) return;
		for (const alt of n.anyOf ?? []) visit(alt, depth);
		if (n.items) visit(n.items, depth);
		for (const [k, p] of Object.entries(n.properties ?? {})) {
			out.add(k);
			visit(p, depth + 1);
		}
	};
	visit(s, 0);
	return out;
}

/**
 * The field-like names a description lists in parentheses to describe the
 * returned row, e.g. "item is the profile (orchestratorId, name, static
 * identity)": a parenthesised list of at least three short comma-separated
 * parts right after "item is the …", outside the EXAMPLE.
 */
function parenthesisedNames(description: string): string[] {
	const text = description.split("EXAMPLE:")[0];
	const out: string[] = [];
	for (const m of text.matchAll(/\(([^()]*)\)/g)) {
		// only a list that describes the result itself: "item is the <thing> (…)"
		const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
		if (!/\bitem is the\b/.test(before)) continue;
		const parts = m[1]
			.split(/,\s*|\s+and\s+/)
			.map((p) => p.trim().replace(/^and\s+/, ""))
			.filter(Boolean);
		if (parts.length < 3) continue;
		if (parts.some((p) => p.split(/\s+/).length > 3)) continue;
		out.push(...parts);
	}
	return out;
}

describe("Manufact 2141: every result field a description names exists in its output schema", () => {
	it("the 16 'align' tools are served", () => {
		for (const name of OUTPUTS_ALIGN)
			expect(
				tools.some((t) => t.name === name),
				name,
			).toBe(true);
	});

	it("no description lists, as part of its result, a name its output schema lacks", () => {
		const wrong = tools.flatMap((t) => {
			const fields = outputFieldNames(t.outputSchema);
			const bad = parenthesisedNames(t.description ?? "").filter(
				(n) => !fields.has(n),
			);
			return bad.length ? [`${t.name}: ${bad.join(", ")}`] : [];
		});
		expect(wrong).toEqual([]);
	});

	it("a null-able read is not described as answering null where it answers found: false", () => {
		const wrong = tools
			.filter((t) => t.outputSchema?.properties?.found !== undefined)
			.filter((t) =>
				/\b(returning null|or null if not found)\b/.test(t.description ?? ""),
			)
			.map((t) => t.name);
		expect(wrong).toEqual([]);
	});
});

describe("Manufact 2141: description, input schema and annotations agree on list_tasks and list_missions", () => {
	it("the two contradiction items are served", () => {
		for (const name of CONTRADICTIONS)
			expect(
				tools.some((t) => t.name === name),
				name,
			).toBe(true);
	});

	it("no EXAMPLE passes a single quoted value to an input whose schema is an array", () => {
		const wrong = tools.flatMap((t) => {
			const example = (t.description ?? "").split("EXAMPLE:")[1] ?? "";
			return Object.entries(t.inputSchema?.properties ?? {})
				.filter(([, n]) => n.type === "array")
				.filter(([k]) => new RegExp(`\\b${k}='`).test(example))
				.map(([k]) => `${t.name}.${k}`);
		});
		expect(wrong).toEqual([]);
	});

	it("list_missions says that a caller other than the fleet master must name its own pilot", () => {
		const t = tools.find((x) => x.name === "list_missions");
		expect(t?.description ?? "").toMatch(/fleet master/);
		expect(t?.description ?? "").toMatch(/\bpilot\b[^.]*\b(own|yours?)\b/);
	});

	it("list_tasks says which assignedTo / createdBy a caller other than the fleet master may name", () => {
		const t = tools.find((x) => x.name === "list_tasks");
		expect(t?.description ?? "").toMatch(/fleet master/);
		expect(t?.description ?? "").toMatch(/fromAllowList/);
	});
});
