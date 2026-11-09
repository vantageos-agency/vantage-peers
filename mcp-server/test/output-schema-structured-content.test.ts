/**
 * Every tool that declares an outputSchema answers a REAL success with a
 * structuredContent that validates against it, and its text is the JSON of
 * that same object (VantagePeers Cloud, task k1793xkjhzh1xm23gmmwjgwfyx8htbv0,
 * PR C, finding 6).
 *
 * Real /mcp route (Hono app + bearer middleware + createMcpHandler), real Convex
 * functions (convex-test, reached as the fleet service account), the official
 * v2 client. Each call is made by the seat a client of that tool really is: the
 * person with a bound agent (ulysse), or the fleet master for a master-only door.
 *
 * The decided set is STRUCTURED_TOOLS (test/tool-documentation-quality.test.ts):
 * a tool added there without a call here fails the coverage assertion.
 *
 * The schema is also documentation an agent reads (task
 * k1766s9rdv2e98retx86ftpdjx8hvxrk, Manufact documentation 2/2): every
 * property, at every depth, says what it means, and the fields a tool
 * description lists after "Returns" are the fields its schema declares. The
 * form both follow is written down in src/outputSchemas.ts.
 *
 * The lists and searches (task k17592gg5t2tencwxks3kysghx8htqg8, outputs 1/3)
 * keep their text byte for byte; their structuredContent is the object form of
 * the same answer (LIST_FORMS): { items } for a bare array, { items,
 * nextCursor, truncated } for a page that capListResponseBytes may cut. Each is
 * called on seeded rows so that its item schema is validated on a real row, and
 * the cut itself is driven once through /mcp (list_memories over 60 KB).
 *
 * The null-able reads, check_messages and the Knowledge Base / OKF tools (task
 * k170byeq1nzzv2q1z6qpag5fp18hvj8a, outputs 2/3) keep their text too
 * (TEXT_FORMS): a read answers { found, item } or { found: false, id } (a
 * not-found pole per read), the inbox answers the values its text is written
 * from, and the KB / OKF chain runs for real on convex-test storage (ticket,
 * blob, claim, ingest, soft delete, export, import dry run).
 */

import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	CALLS,
	type CallResult,
	closeE2E,
	descriptions,
	NOT_FOUND,
	poles,
	results,
	runE2E,
	schemas,
	seeded,
} from "./lib/e2eWorld.js";
import {
	LIST_FORMS,
	STRUCTURED_TOOLS,
	TEXT_FORMS,
} from "./lib/toolMetadataDecisions.js";

vi.mock("convex/browser", async () => ({
	ConvexHttpClient: (await import("./lib/forwardingConvex.js"))
		.ForwardingConvexHttpClient,
}));

beforeAll(runE2E, 180_000);

afterAll(closeE2E);

describe("outputSchema: a real success carries structuredContent that validates", () => {
	it("every decided tool is called here (no tool declares a schema unexercised)", () => {
		const decided = new Set<string>(STRUCTURED_TOOLS);
		expect(
			[...new Set(CALLS.map((c) => c.tool))]
				.filter((t) => decided.has(t))
				.sort(),
		).toEqual([...STRUCTURED_TOOLS].sort());
	});

	const ajv = new Ajv2020({ strict: false, allErrors: true });

	for (const call of CALLS.filter((c) =>
		(STRUCTURED_TOOLS as readonly string[]).includes(c.tool),
	)) {
		it(`${call.tool} (${call.as})`, () => {
			const r = results.get(call.tool) as CallResult;
			expect(r.isError, r.content?.[0]?.text).not.toBe(true);
			const schema = schemas.get(call.tool);
			expect(schema, "tools/list declares an outputSchema").toBeDefined();
			expect(r.structuredContent, "structuredContent present").toBeDefined();
			const { $schema: _ignored, ...body } = schema as Record<string, unknown>;
			const validate = ajv.compile(body);
			expect(
				validate(r.structuredContent),
				JSON.stringify(validate.errors),
			).toBe(true);
			const other = (TEXT_FORMS as Record<string, OtherForm>)[call.tool];
			if (other !== undefined) {
				expectOtherTextAgrees(other, r, true);
				return;
			}
			expect(r.content).toHaveLength(1);
			expect(r.content[0].type).toBe("text");
			const form = (LIST_FORMS as Record<string, "array" | "page">)[call.tool];
			if (form === undefined) {
				// The text a client without structuredContent support reads is the
				// same two-space JSON of the same object: one answer, two encodings.
				expect(r.content[0].text).toBe(
					JSON.stringify(r.structuredContent, null, 2),
				);
				return;
			}
			const sc = r.structuredContent as ListStructured;
			// A real row reached the item schema, not only an empty list.
			expect(sc.items.length, "a list call validated on rows").toBeGreaterThan(
				0,
			);
			expectTextAgrees(form, r.content[0].text, sc);
		});
	}
});

type ListStructured = {
	items: unknown[];
	nextCursor?: string | null;
	truncated?: boolean;
	scopeFiltered?: number;
};

/**
 * The text is unchanged and says the same thing as the structuredContent:
 * an "array" text is the two-space JSON of `items`; a "page" text is a bare
 * array (no further page), a { items, nextCursor?, scopeFiltered? } page, or
 * the cap's { _meta, items } envelope (truncated, no continuation).
 */
function expectTextAgrees(
	form: "array" | "page",
	text: string,
	sc: ListStructured,
): void {
	if (form === "array") {
		expect(Object.keys(sc)).toEqual(["items"]);
		expect(text).toBe(JSON.stringify(sc.items, null, 2));
		return;
	}
	const parsed = JSON.parse(text) as unknown;
	if (Array.isArray(parsed)) {
		expect(sc).toEqual({ items: parsed, nextCursor: null, truncated: false });
		expect(text).toBe(JSON.stringify(sc.items, null, 2));
		return;
	}
	const page = parsed as {
		items: unknown[];
		nextCursor?: string;
		scopeFiltered?: number;
		_meta?: { _truncated?: boolean };
	};
	if (page._meta?._truncated === true) {
		expect(sc).toEqual({
			items: page.items,
			nextCursor: null,
			truncated: true,
		});
		return;
	}
	expect(sc).toEqual({
		items: page.items,
		nextCursor: page.nextCursor ?? null,
		truncated: false,
		...(page.scopeFiltered !== undefined
			? { scopeFiltered: page.scopeFiltered }
			: {}),
	});
	expect(text).toBe(JSON.stringify(page, null, 2));
}

type OtherForm = "found" | "inbox" | "upload-url" | "compact";

type StuckList = {
	entries: unknown[];
	total: number;
	truncated: boolean;
	actionableStuckCount: number;
};

/**
 * The text is unchanged and says the same thing as the structuredContent, in
 * the form the tool has always written it (TEXT_FORMS). `present` asks that a
 * row (or a message) was really there, so the item schema met a real value.
 */
function expectOtherTextAgrees(
	form: OtherForm,
	r: CallResult,
	present: boolean,
): void {
	const sc = r.structuredContent as Record<string, unknown>;
	if (form === "found") {
		expect(r.content).toHaveLength(1);
		expect(sc.found).toBe(present);
		if (present) {
			expect(Object.keys(sc).sort()).toEqual(["found", "item"]);
			expect(r.content[0].text).toBe(JSON.stringify(sc.item, null, 2));
		} else {
			expect(Object.keys(sc).sort()).toEqual(["found", "id"]);
			expect(r.content[0].text).toBe("null");
		}
		return;
	}
	if (form === "inbox") {
		expect(r.content).toHaveLength(1);
		const messages = sc.messages as unknown[];
		expect(messages.length > 0).toBe(present);
		const stuck = (name: string) => {
			const l = sc[name] as StuckList;
			return l.entries.length > 0 || l.truncated
				? [`${name}:\n${JSON.stringify(l, null, 2)}`]
				: [];
		};
		const stuckText = [
			...stuck("stuckInProgress"),
			...stuck("peersStuckOnYou"),
		].join("\n\n");
		const expected =
			messages.length === 0
				? stuckText.length > 0
					? stuckText
					: "No new messages."
				: `${JSON.stringify(messages, null, 2)}${
						sc.truncated === true
							? `\n— truncated. Resume with check_messages since=${sc.nextSince}`
							: ""
					}${stuckText.length > 0 ? `\n\n${stuckText}` : ""}`;
		expect(r.content[0].text).toBe(expected);
		return;
	}
	if (form === "upload-url") {
		expect(r.content).toHaveLength(2);
		expect(r.content[0].text).toBe(sc.uploadUrl);
		const { uploadUrl: _url, ...rest } = sc;
		expect(r.content[1].text).toBe(JSON.stringify(rest));
		expect(typeof sc.ticket === "string").toBe(present);
		return;
	}
	expect(r.content).toHaveLength(1);
	expect(r.content[0].text).toBe(JSON.stringify(sc));
}

describe("null-able reads, the inbox and the upload URL: the absent poles", () => {
	const ajv = new Ajv2020({ strict: false, allErrors: true });
	const validates = (tool: string, sc: unknown) => {
		const { $schema: _ignored, ...body } = schemas.get(tool) as Record<
			string,
			unknown
		>;
		const validate = ajv.compile(body);
		expect(validate(sc), JSON.stringify(validate.errors)).toBe(true);
	};

	for (const [tool, , , id] of NOT_FOUND) {
		it(`${tool}: a key no visible row carries answers { found: false, id } and the text null`, () => {
			const r = poles.get(`not-found:${tool}`) as CallResult;
			expect(r.isError, r.content?.[0]?.text).not.toBe(true);
			expect(r.structuredContent).toEqual({ found: false, id: id(seeded) });
			expectOtherTextAgrees("found", r, false);
			validates(tool, r.structuredContent);
		});
	}

	it("check_messages on a drained inbox: no messages, the text unchanged, and it validates", () => {
		const r = poles.get("inbox-empty") as CallResult;
		expect(r.isError, r.content?.[0]?.text).not.toBe(true);
		expectOtherTextAgrees("inbox", r, false);
		validates("check_messages", r.structuredContent);
	});

	it("generate_upload_url with no sha256: ticket null and the note, and it validates", () => {
		const r = poles.get("upload-url-no-ticket") as CallResult;
		expect(r.isError, r.content?.[0]?.text).not.toBe(true);
		expectOtherTextAgrees("upload-url", r, false);
		expect((r.structuredContent as { note?: unknown }).note).toBeTypeOf(
			"string",
		);
		validates("generate_upload_url", r.structuredContent);
	});
});

describe("lists: the cut page and the refusal", () => {
	const ajv = new Ajv2020({ strict: false, allErrors: true });

	it("a page the byte cap cut says truncated: true, carries the rows the text shows, and validates", () => {
		const r = poles.get("truncated") as CallResult;
		expect(r.isError, r.content?.[0]?.text).not.toBe(true);
		const text = r.content[0].text;
		const envelope = JSON.parse(text) as {
			_meta: { _truncated: boolean; _total: number; _showing: number };
			items: unknown[];
		};
		expect(envelope._meta._truncated).toBe(true);
		expect(envelope._meta._total).toBe(3);
		const sc = r.structuredContent as ListStructured;
		expect(sc.truncated).toBe(true);
		expect(sc.nextCursor).toBeNull();
		expect(sc.items).toEqual(envelope.items);
		expect(sc.items.length).toBe(envelope._meta._showing);
		expect(sc.items.length).toBeLessThan(3);
		const { $schema: _ignored, ...body } = schemas.get(
			"list_memories",
		) as Record<string, unknown>;
		const validate = ajv.compile(body);
		expect(validate(sc), JSON.stringify(validate.errors)).toBe(true);
	});

	it("an uncut page says truncated: false (the same tool, under the cap)", () => {
		const sc = results.get("list_memories")
			?.structuredContent as ListStructured;
		expect(sc.truncated).toBe(false);
	});

	it("a refused read is an error and carries no structuredContent", () => {
		const r = poles.get("refused") as CallResult;
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toBeUndefined();
	});
});

// ── the schema as documentation ──────────────────────────────────────────────

type JsonSchema = {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
};

/** The object schema a property holds: itself, its array items, or a nullable branch. */
function objectOf(s: JsonSchema | undefined): JsonSchema | undefined {
	if (s === undefined) return undefined;
	if (s.properties !== undefined) return s;
	if (s.items !== undefined) return objectOf(s.items);
	for (const alt of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) {
		const o = objectOf(alt);
		if (o !== undefined) return o;
	}
	return undefined;
}

/** Every property at every depth (objects inside arrays and nullable branches included). */
function everyProperty(schema: JsonSchema): Array<[string, JsonSchema]> {
	const out: Array<[string, JsonSchema]> = [];
	const visit = (s: JsonSchema | undefined, at: string) => {
		if (s === undefined) return;
		for (const alt of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) visit(alt, at);
		if (s.items !== undefined) visit(s.items, `${at}[]`);
		for (const [k, p] of Object.entries(s.properties ?? {})) {
			const path = at === "" ? k : `${at}.${k}`;
			out.push([path, p]);
			visit(p, path);
		}
	};
	visit(schema, "");
	return out;
}

function descriptionOf(p: JsonSchema): string {
	if (typeof p.description === "string") return p.description;
	for (const alt of [...(p.anyOf ?? []), ...(p.oneOf ?? [])]) {
		if (typeof alt.description === "string") return alt.description;
	}
	return "";
}

type Listed = { name: string; children?: Listed[] };

/** Splits on `sep` outside any (), [], {} pair. */
function splitTopLevel(body: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of body) {
		if ("([{".includes(ch)) depth++;
		if (")]}".includes(ch)) depth--;
		if (ch === sep && depth === 0) {
			parts.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur.trim() !== "") parts.push(cur);
	return parts;
}

function parseListed(body: string): Listed[] {
	return splitTopLevel(body, ",").flatMap((item) => parseItem(item.trim()));
}

/**
 * One listed item: `name`, `name?`, `name: <literal>`, `a or b`, or a nested
 * `name[{ ... }]` / `name: [{ ... }]` / `name { ... }`. Anything else (prose
 * such as "episode fields", or a label that is not a field such as "author")
 * is refused: a listed field is a field name the schema can be checked against.
 */
function parseItem(raw: string): Listed[] {
	const item = raw.replace(/^plus\s+/, "");
	if (/\sor\s/.test(item) && !/[[{(]/.test(item)) {
		return item.split(/\s+or\s+/).flatMap((x) => parseItem(x.trim()));
	}
	const m = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*(:?)\s*([\s\S]*)$/.exec(item);
	if (m === null) throw new Error(`not a field name: "${raw}"`);
	const [, name, colon, tail] = m;
	if (tail === "") return [{ name }];
	const nested = /^\[?\s*\{([\s\S]*)\}\s*\]?$/.exec(tail);
	if (nested !== null) return [{ name, children: parseListed(nested[1]) }];
	if (colon === ":") return [{ name }];
	throw new Error(`not a field name: "${raw}"`);
}

/**
 * The fields a tool description lists in its "Returns" clause, and whether
 * the list is the whole envelope (`{ ... }`) or a selection of a stored row
 * (`( ... )`). null when the description lists no fields.
 */
function listedReturnFields(
	description: string,
): { exact: boolean; fields: Listed[] } | null {
	const at = description.search(/\bReturns\b/);
	if (at < 0) return null;
	const rest = description.slice(at);
	const open = rest.search(/[{(]/);
	if (open < 0 || open > 80) return null;
	const close = rest[open] === "{" ? "}" : ")";
	let depth = 0;
	for (let i = open; i < rest.length; i++) {
		if ("([{".includes(rest[i])) depth++;
		if (")]}".includes(rest[i])) depth--;
		if (depth === 0) {
			if (rest[i] !== close) return null;
			return {
				exact: close === "}",
				fields: parseListed(rest.slice(open + 1, i)),
			};
		}
	}
	return null;
}

/** Where the listed fields and the schema disagree, as readable paths. */
function disagreements(
	listed: Listed[],
	schema: JsonSchema | undefined,
	exact: boolean,
	at = "",
): string[] {
	const out: string[] = [];
	const obj = objectOf(schema);
	const props = obj?.properties ?? {};
	for (const f of listed) {
		const path = at === "" ? f.name : `${at}.${f.name}`;
		if (!(f.name in props)) {
			out.push(`listed but not in the schema: ${path}`);
			continue;
		}
		if (f.children !== undefined) {
			out.push(...disagreements(f.children, props[f.name], exact, path));
		}
	}
	if (exact) {
		const names = new Set(listed.map((f) => f.name));
		for (const r of obj?.required ?? []) {
			if (!names.has(r)) {
				out.push(
					`always returned but not listed: ${at === "" ? r : `${at}.${r}`}`,
				);
			}
		}
	}
	return out;
}

describe("outputSchema: the schema documents the result (Manufact documentation 2/2)", () => {
	it("every property of every served outputSchema, at every depth, says what it means", () => {
		const undescribed: string[] = [];
		let total = 0;
		for (const [tool, schema] of schemas) {
			for (const [path, p] of everyProperty(schema as JsonSchema)) {
				total++;
				if (descriptionOf(p).trim() === "") undescribed.push(`${tool}:${path}`);
			}
		}
		expect(schemas.size).toBe(STRUCTURED_TOOLS.length);
		expect(total).toBeGreaterThan(0);
		expect(undescribed).toEqual([]);
	});

	it("the fields a description lists after 'Returns' are the fields its schema declares", () => {
		const wrong: Record<string, string[]> = {};
		for (const [tool, schema] of schemas) {
			let listed: ReturnType<typeof listedReturnFields>;
			try {
				listed = listedReturnFields(descriptions.get(tool) ?? "");
			} catch (e) {
				wrong[tool] = [(e as Error).message];
				continue;
			}
			if (listed === null) continue;
			const d = disagreements(
				listed.fields,
				schema as JsonSchema,
				listed.exact,
			);
			if (d.length > 0) wrong[tool] = d;
		}
		expect(wrong).toEqual({});
	});

	it("list_blocked_on_me declares each waiter's fields and their types, and a real waiter validates", () => {
		const schema = schemas.get("list_blocked_on_me") as JsonSchema;
		const entry = objectOf(schema.properties?.entries);
		const types = Object.fromEntries(
			Object.entries(entry?.properties ?? {}).map(([k, p]) => [k, p.type]),
		);
		expect(types).toEqual({
			blockedTaskId: "string",
			blockedTitle: "string",
			blockedAssignee: "string",
			onTaskId: "string",
			onTaskTitle: "string",
			age: "number",
		});
		const sc = results.get("list_blocked_on_me")?.structuredContent as {
			entries: unknown[];
		};
		expect(sc.entries.length).toBeGreaterThan(0);
	});

	it("billing_summary_by_project types its noDurationTasks rows, and a real row validates", () => {
		const schema = schemas.get("billing_summary_by_project") as JsonSchema;
		const row = objectOf(schema.properties?.noDurationTasks);
		expect(Object.keys(row?.properties ?? {}).sort()).toEqual([
			"assignedTo",
			"completedAt",
			"project",
			"taskId",
		]);
		const sc = results.get("billing_summary_by_project")?.structuredContent as {
			noDurationTasks?: unknown[];
		};
		expect(sc.noDurationTasks?.length ?? 0).toBeGreaterThan(0);
	});
});

describe("the last ten: their item schemas met real rows", () => {
	it("improvisation_digest flagged a real artifact, the room has a turn, the bulk preview and the instantiation name tasks", () => {
		const sc = (tool: string) =>
			results.get(tool)?.structuredContent as Record<string, unknown[]>;
		expect(sc("improvisation_digest").samples.length).toBeGreaterThan(0);
		expect(sc("debate_get_room").turns.length).toBeGreaterThan(0);
		expect(sc("bulk_complete_tasks").sampleIds.length).toBeGreaterThan(0);
		expect(sc("instantiate_template_into_mission").taskIds.length).toBe(1);
		// task k177d10zrqvw6gj9jef5hypayd8hxe34: the typed binding row met a real row
		expect(sc("get_github_owner_bindings").bindings.length).toBeGreaterThan(0);
	});
});
