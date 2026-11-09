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
import { registerTools } from "../src/tools.js";

type JsonSchema = {
	type?: string | string[];
	required?: string[];
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	anyOf?: JsonSchema[];
};
type ServedTool = {
	name: string;
	title?: string;
	description?: string;
	outputSchema?: JsonSchema;
	inputSchema?: {
		properties?: Record<
			string,
			{ description?: string; pattern?: string; default?: unknown }
		>;
	};
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
		expect(d).toMatch(/\bOmit/);
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
