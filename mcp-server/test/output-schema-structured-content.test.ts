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
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { encodeCursor } from "../src/paging.js";
import { registerTools } from "../src/tools.js";
import {
	CALLS,
	type CallResult,
	closeE2E,
	descriptions,
	inputSchemas,
	NOT_FOUND,
	poles,
	results,
	runE2E,
	schemas,
	seeded,
} from "./lib/e2eWorld.js";
import {
	LIST_FORMS,
	MIRRORED_TEXT,
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
		it(`${tool}: a key no visible row carries answers { found: false, id } and its text says so`, () => {
			const r = poles.get(`not-found:${tool}`) as CallResult;
			expect(r.isError, r.content?.[0]?.text).not.toBe(true);
			expect(r.structuredContent).toEqual({ found: false, id: id(seeded) });
			// "found": the text is JSON null; "compact" (get_profile,
			// MIRRORED_TEXT): the text is { found: false, id } itself.
			expectOtherTextAgrees(
				(TEXT_FORMS as Record<string, OtherForm>)[tool] ?? "found",
				r,
				false,
			);
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

	// Rule 6 (src/outputSchemas.ts): an error result carries no structuredContent,
	// except an invalid cursor argument, whose structuredContent is ONLY
	// { error: { code: "invalid_cursor", message } } (the test below).
	it("a refused read is an error and carries no structuredContent (only an invalid cursor carries one)", () => {
		const r = poles.get("refused") as CallResult;
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toBeUndefined();
	});

	it("an invalid cursor argument is an error whose structuredContent says invalid_cursor, through /mcp", () => {
		const r = poles.get("invalid-cursor") as CallResult;
		expect(r.isError, JSON.stringify(r)).toBe(true);
		expect(r.structuredContent).toEqual({
			error: { code: "invalid_cursor", message: expect.any(String) },
		});
		expect(r.content[0].text).toMatch(/invalid cursor/i);
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
		// task k178ty5ndzkyy8y4vd7c3jh0p58hxg2z: an orchestrator named with a
		// non-ASCII letter is counted under its real name.
		const byOrch = results.get("improvisation_digest")?.structuredContent as {
			countsByOrch: Record<string, number>;
		};
		expect(byOrch.countsByOrch["h\u00e9lios"]).toBe(1);
		expect(sc("debate_get_room").turns.length).toBeGreaterThan(0);
		expect(sc("bulk_complete_tasks").sampleIds.length).toBeGreaterThan(0);
		expect(sc("instantiate_template_into_mission").taskIds.length).toBe(1);
		// task k177d10zrqvw6gj9jef5hypayd8hxe34: the typed binding row met a real row
		expect(sc("get_github_owner_bindings").bindings.length).toBeGreaterThan(0);
	});
});

// ── Manufact 2250: the text is the structuredContent, as JSON ────────────────
//
// Task k17e90s1n85hjappy26vs2kww18hxjp1. Manufact flagged "Align the output
// schema with the tool's documented result" on 11 tools, all among those whose
// text is a different shape from their structuredContent. Three of them now
// write exactly JSON.stringify(structuredContent) as text (MIRRORED_TEXT).

describe("Manufact 2250: the text of the three experiment tools is their structuredContent as JSON", () => {
	const mirrors = (r: CallResult) => {
		expect(r.isError, r.content?.[0]?.text).not.toBe(true);
		expect(r.content).toHaveLength(1);
		expect(r.content[0].type).toBe("text");
		expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
		expect(r.content[0].text).toBe(JSON.stringify(r.structuredContent));
	};

	for (const tool of MIRRORED_TEXT) {
		it(`${tool}: a served call's text parses to its structuredContent, envelope included`, () => {
			const r = results.get(tool) as CallResult;
			mirrors(r);
			const sc = r.structuredContent as Record<string, unknown>;
			if (tool === "get_profile") {
				expect(sc.found).toBe(true);
			} else {
				// a real row, not only an empty list
				expect((sc.items as unknown[]).length).toBeGreaterThan(0);
			}
		});

		it(`${tool}: its description says the text is the same object as JSON, and no other shape`, () => {
			const d = descriptions.get(tool) ?? "";
			expect(d).toContain("The text is the same object as JSON");
			expect(d).not.toMatch(
				/bare JSON array|the text is the profile|or null when|else \{ items, nextCursor \}/,
			);
		});
	}

	it("get_profile not found: the text parses to { found: false, id }, never null", () => {
		const r = poles.get("not-found:get_profile") as CallResult;
		mirrors(r);
		expect(JSON.parse(r.content[0].text)).toEqual({
			found: false,
			id: "seatbot",
		});
	});
});

describe("Manufact 2250: the four text residues", () => {
	type Props = { properties?: Record<string, { description?: string }> };
	const field = (tool: string, name: string): string =>
		(inputSchemas.get(tool) as Props | undefined)?.properties?.[name]
			?.description ?? "";

	it("list_episodes.limit says what a page fetched with a cursor and no limit holds, without the misleading form", () => {
		const d = field("list_episodes", "limit");
		expect(d).not.toContain("With a cursor and no limit, a page holds 50 rows");
		expect(d).toContain("Pass the same limit with each cursor");
	});

	for (const tool of ["list_tasks", "list_tasks_by_mission", "list_missions"]) {
		it(`${tool}: the status field keeps meaning and usage; the stand-alone rule lives in the tool description`, () => {
			const d = field(tool, "status");
			expect(d).not.toBe("");
			expect(d).not.toMatch(/only entry of its list/);
			expect(descriptions.get(tool) ?? "").toContain(
				"A shorthand stands alone in the status list",
			);
		});
	}

	it("store_memory.type says what the episode kind stores through store_memory", () => {
		const d = field("store_memory", "type");
		expect(d).not.toContain("use store_episode instead");
		// The enum value itself is not restated (returns-envelope.test.ts
		// forbiddenTokens): the kind is named by the tools that read it.
		expect(d).toContain(
			"Written here with the kind list_episodes and get_episode read, the memory holds only this content",
		);
		expect(d).toContain("which only store_episode records");
	});
});

// ── One list contract (task k17e90s1n85hjappy26vs2kww18hxjp1) ────────────────
//
// Every paged list tool states its result through ONE generator
// (src/listContract.ts): the Returns { ... } clause names exactly the
// outputSchema's top-level properties, one sentence says what the text is, and
// a real answer on every code path (last page, a page with more behind it, a
// page the byte cap cut, rows withheld by scope) is what that sentence says.
// The oracle is the handler's real output, never the description.

type ListContractModule = {
	LIST_CONTRACTS: Record<
		string,
		{
			rows: string;
			form:
				| "array-on-last-page"
				| "array-unless-continued"
				| "page-cursor-omitted"
				| "page-cursor-always"
				| "mirrored";
			scopeFiltered?: true;
			cutResumes?: true;
		}
	>;
	listReturnsKeys: (
		c: ListContractModule["LIST_CONTRACTS"][string],
	) => string[];
	listContractText: (c: ListContractModule["LIST_CONTRACTS"][string]) => string;
};
type Contract = ListContractModule["LIST_CONTRACTS"][string];

/** The paged list tools: every one is governed by the list contract. */
const PAGED_LISTS = [
	"list_tasks",
	"list_tasks_by_mission",
	"list_memories",
	"list_episodes",
	"list_peers",
	"list_messages",
	"list_missions",
	"list_diaries",
	"list_briefing_notes",
	"list_recurring_tasks",
	"list_repo_mappings",
	"list_fix_patterns",
] as const;

let contractModule: ListContractModule | null = null;
beforeAll(async () => {
	contractModule = (await import("../src/listContract.js").catch(
		() => null,
	)) as ListContractModule | null;
});
const contractOf = (tool: string): Contract | undefined =>
	contractModule?.LIST_CONTRACTS[tool];

/**
 * What a list answer's text and structuredContent must be under a contract.
 * Returns the disagreements, as readable lines; empty when they agree.
 */
function contractDisagreements(
	c: Contract,
	keys: string[],
	text: string,
	sc: ListStructured,
): string[] {
	const out: string[] = [];
	for (const k of Object.keys(sc)) {
		if (!keys.includes(k)) out.push(`structuredContent.${k} is not in Returns`);
	}
	for (const k of ["items", "nextCursor", "truncated"]) {
		if (!(k in sc)) out.push(`structuredContent lacks ${k}`);
	}
	if (c.form === "mirrored") {
		if (text !== JSON.stringify(sc)) out.push("text is not the object as JSON");
		return out;
	}
	const parsed = JSON.parse(text) as unknown;
	const same = (a: unknown, b: unknown, what: string) => {
		if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${what} differs`);
	};
	if (Array.isArray(parsed)) {
		if (c.form !== "array-on-last-page" && c.form !== "array-unless-continued")
			out.push(`a bare-array text, but the contract is ${c.form}`);
		same(
			sc,
			{ items: parsed, nextCursor: null, truncated: false },
			"array page",
		);
		return out;
	}
	const page = parsed as Record<string, unknown>;
	const pageKeys = Object.keys(page).sort().join(",");
	if ((page._meta as { _truncated?: boolean } | undefined)?._truncated) {
		const want =
			c.cutResumes && sc.nextCursor !== null
				? "_meta,items,nextCursor"
				: "_meta,items";
		if (pageKeys !== want) out.push(`cut text keys ${pageKeys}, want ${want}`);
		if (sc.truncated !== true) out.push("cut page without truncated: true");
		if (!c.cutResumes && sc.nextCursor !== null)
			out.push("cut page carries a cursor the contract does not name");
		same(sc.items, page.items, "cut items");
		same(sc.nextCursor, page.nextCursor ?? null, "cut nextCursor");
		return out;
	}
	if (sc.truncated !== false) out.push("uncut page without truncated: false");
	same(sc.items, page.items, "items");
	same(sc.nextCursor, page.nextCursor ?? null, "nextCursor");
	same(sc.scopeFiltered, page.scopeFiltered, "scopeFiltered");
	const cursorIs = (t: string) => typeof page.nextCursor === t;
	switch (c.form) {
		case "array-on-last-page":
			if (pageKeys !== "items,nextCursor" || !cursorIs("string"))
				out.push(
					`text keys ${pageKeys}: only a page with more behind it is an object`,
				);
			break;
		case "array-unless-continued":
			if (
				![
					"items,nextCursor",
					"items,scopeFiltered",
					"items,nextCursor,scopeFiltered",
				].includes(pageKeys)
			)
				out.push(`text keys ${pageKeys}`);
			break;
		case "page-cursor-omitted":
			if (
				!(
					pageKeys === "items" ||
					(pageKeys === "items,nextCursor" && cursorIs("string"))
				)
			)
				out.push(`text keys ${pageKeys}`);
			break;
		case "page-cursor-always":
			if (pageKeys !== "items,nextCursor") out.push(`text keys ${pageKeys}`);
			break;
	}
	return out;
}

/** A row of each door, owned by `who`; `big` pads the field each projection keeps. */
const pad = (big: boolean) => (big ? "x".repeat(40_000) : "short");
const T0 = 1_760_000_000_000;
type Sweep = {
	door: string;
	args: Record<string, unknown>;
	row: (i: number, who: string, big: boolean) => Record<string, unknown>;
	wrap?: (rows: unknown[], more: boolean) => unknown;
};
const taskRow = (i: number, who: string, big: boolean) => ({
	_id: `task${i}`,
	_creationTime: T0 - i,
	title: pad(big),
	assignedTo: who,
	priority: "medium",
	status: "todo",
	createdBy: who,
	project: "p",
});
const memoryRow = (type: string) => (i: number, who: string, big: boolean) => ({
	_id: `mem${i}`,
	_creationTime: T0 - i,
	namespace: `orchestrator/${who}`,
	type,
	content: pad(big),
	createdBy: who,
	relations: [],
	isLatest: true,
	createdAt: T0 - i,
	updatedAt: T0 - i,
});
const paginated = (rows: unknown[], more: boolean) => ({
	value: rows,
	continueCursor: more ? "backend-next" : null,
	isDone: !more,
});
const SWEEP: Record<(typeof PAGED_LISTS)[number], Sweep> = {
	list_tasks: { door: "tasks:list", args: {}, row: taskRow },
	list_tasks_by_mission: {
		door: "tasks:listByMission",
		args: { missionId: "m".repeat(32) },
		row: taskRow,
	},
	list_memories: {
		door: "memories:listMemories",
		args: { namespace: "global" },
		row: memoryRow("project"),
		wrap: paginated,
	},
	list_episodes: {
		door: "memories:listMemories",
		args: { namespace: "global" },
		row: memoryRow("episode"),
		wrap: paginated,
	},
	list_peers: {
		door: "profiles:listProfiles",
		args: {},
		row: (i, who, big) => ({
			_id: `prof${i}`,
			_creationTime: T0 - i,
			orchestratorId: who,
			name: pad(big),
			static: { role: "r", workspace: "/w", capabilities: [] },
			dynamic: { lastSeen: T0, sessionCount: 1 },
		}),
	},
	list_messages: {
		door: "messages:listMessages",
		args: {},
		row: (i, who, big) => ({
			_id: `msg${i}`,
			_creationTime: T0 - i,
			from: who,
			content: pad(big),
			createdAt: T0 - i,
			channel: "beta",
		}),
	},
	list_missions: {
		door: "missions:list",
		args: {},
		row: (i, who, big) => ({
			_id: `mis${i}`,
			_creationTime: T0 - i,
			name: pad(big),
			status: "plan",
			pilot: who,
			priority: "high",
			project: "p",
		}),
	},
	list_diaries: {
		door: "diary:list",
		args: {},
		row: (i, who, big) => ({
			_id: `dia${i}`,
			_creationTime: T0 - i,
			date: "2026-11-10",
			orchestrator: who,
			content: pad(big),
			createdAt: T0 - i,
		}),
	},
	list_briefing_notes: {
		door: "briefingNotes:list",
		args: {},
		row: (i, who, big) => ({
			_id: `note${i}`,
			_creationTime: T0 - i,
			title: pad(big),
			topic: "t",
			participants: [],
			createdBy: who,
		}),
	},
	list_recurring_tasks: {
		door: "recurringTasks:list",
		args: {},
		row: (i, who, big) => ({
			_id: `rec${i}`,
			_creationTime: T0 - i,
			title: pad(big),
			assignedTo: who,
			priority: "medium",
			cronExpression: "0 9 * * *",
			nextRunAt: T0,
			active: true,
			createdBy: who,
		}),
	},
	list_repo_mappings: {
		door: "githubRepoMapping:list",
		args: {},
		row: (i, who, big) => ({
			_id: `map${i}`,
			_creationTime: T0 - i,
			repo: big ? `a/${pad(true)}` : "a/b",
			orchestrator: who,
			project: "p",
		}),
		wrap: (rows, more) => ({
			items: rows,
			nextCursor: more ? "door-next" : null,
		}),
	},
	list_fix_patterns: {
		door: "fixPatterns:listAll",
		args: {},
		row: (i, who, big) => ({
			_id: `fix${i}`,
			_creationTime: T0 - i,
			symptom: pad(big),
			rootCause: "r",
			tags: [],
			stack: [],
			sourceProject: "p",
			createdBy: who,
			severity: "low",
			createdAt: T0 - i,
			updatedAt: T0 - i,
		}),
	},
};

/** A non-master bearer of an organisation whose allow-list names only alpha. */
const ALPHA_CTX = {
	clientId: "client-alpha",
	userId: "user-alpha",
	scopes: ["vantage:read"],
	scopeProfile: "tenant-alpha",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["orchestrator/alpha"],
	namespaceWritePrefixes: ["orchestrator/alpha"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
	clerkOrgSlug: "org-fixture-alpha",
} as OAuthContext;

type ListHandler = (args: Record<string, unknown>) => Promise<CallResult>;

/** Registers the tools on a capturing server over a door that answers `answer`. */
function listHandlers(
	ctx: OAuthContext,
	answer: (door: string, args: Record<string, unknown>) => unknown,
	calls: Array<[string, Record<string, unknown>]> = [],
): Map<string, ListHandler> {
	const handlers = new Map<string, ListHandler>();
	const capture = (name: string, ...rest: unknown[]) => {
		handlers.set(name, rest[rest.length - 1] as ListHandler);
		return {};
	};
	const server = { tool: capture, registerTool: capture } as never;
	const convex = {
		query: async (door: string, args: Record<string, unknown>) => {
			calls.push([door, args]);
			return answer(door, args);
		},
		mutation: async () => null,
		action: async () => null,
	} as never;
	registerTools(server, convex, ctx);
	return handlers;
}

/** The four code paths of a paged list, as each tool really serves them. */
async function sweepPaths(
	tool: (typeof PAGED_LISTS)[number],
	contract: Contract | undefined,
): Promise<Array<[string, CallResult]>> {
	const s = SWEEP[tool];
	const serve = (rows: unknown[], more: boolean) =>
		s.wrap ? s.wrap(rows, more) : rows;
	const run = async (
		ctx: OAuthContext,
		rows: unknown[],
		more: boolean,
		limit: number,
	) =>
		(await listHandlers(ctx, (door) =>
			door === s.door ? serve(rows, more) : null,
		).get(tool)?.({ ...s.args, limit })) as CallResult;
	const two = (who: string, big = false) => [
		s.row(1, who, big),
		s.row(2, who, big),
	];
	const paths: Array<[string, CallResult]> = [
		["last page", await run(LOCAL_STDIO_TRUST_CTX, two("alpha"), false, 5)],
		[
			"page with more behind it",
			await run(LOCAL_STDIO_TRUST_CTX, two("alpha"), true, 2),
		],
		[
			"page the byte cap cut",
			await run(LOCAL_STDIO_TRUST_CTX, two("alpha", true), false, 5),
		],
	];
	if (contract?.scopeFiltered) {
		paths.push([
			"rows withheld by scope",
			await run(
				ALPHA_CTX,
				[s.row(1, "alpha", false), s.row(2, "beta", false)],
				false,
				5,
			),
		]);
	}
	return paths;
}

describe("one list contract: description, outputSchema and every real answer agree", () => {
	const ajv = new Ajv2020({ strict: false, allErrors: true });

	it("the paged list tools are the paged lists LIST_FORMS decides, plus list_diaries (mirrored)", () => {
		const decided = Object.entries(LIST_FORMS)
			.filter(([, form]) => form === "page")
			.map(([tool]) => tool);
		expect([...PAGED_LISTS].sort()).toEqual(
			[...decided, "list_diaries"].sort(),
		);
		expect(
			contractModule,
			"src/listContract.ts exports the list contract",
		).not.toBeNull();
		expect(Object.keys(contractModule?.LIST_CONTRACTS ?? {}).sort()).toEqual(
			[...PAGED_LISTS].sort(),
		);
	});

	for (const tool of PAGED_LISTS) {
		it(`${tool}: the description carries the generated contract, and Returns names exactly the outputSchema's top-level properties`, () => {
			const c = contractOf(tool);
			expect(c, `a list contract for ${tool}`).toBeDefined();
			const d = descriptions.get(tool) ?? "";
			expect(d).toContain(contractModule?.listContractText(c as Contract));
			// One statement of the text: never a second, different shape.
			expect(d.match(/The text is/g) ?? []).toHaveLength(1);
			const schema = schemas.get(tool) as JsonSchema;
			const listed = listedReturnFields(d);
			expect(listed, "a Returns { ... } clause").not.toBeNull();
			expect(listed?.fields.map((f) => f.name).sort()).toEqual(
				Object.keys(schema.properties ?? {}).sort(),
			);
			expect(contractModule?.listReturnsKeys(c as Contract).sort()).toEqual(
				Object.keys(schema.properties ?? {}).sort(),
			);
			// A row list, when given, is the row schema's WHOLE property set: a
			// partial list reads as the result while the schema says more.
			for (const f of listed?.fields ?? []) {
				if (f.children === undefined) continue;
				expect(
					f.children.map((x) => x.name).sort(),
					`${tool}.${f.name}`,
				).toEqual(
					Object.keys(
						objectOf(schema.properties?.[f.name])?.properties ?? {},
					).sort(),
				);
			}
		});

		it(`${tool}: on every code path the real answer validates, every row key is declared, and the text is what the contract says`, async () => {
			const c = contractOf(tool);
			const schema = schemas.get(tool) as JsonSchema & Record<string, unknown>;
			const { $schema: _ignored, ...body } = schema;
			const validate = ajv.compile(body);
			const rowProps = Object.keys(
				objectOf(schema.properties?.items)?.properties ?? {},
			);
			const wrong: Record<string, string[]> = {};
			for (const [path, r] of await sweepPaths(tool, c)) {
				const problems: string[] = [];
				if (r?.isError || r?.structuredContent === undefined) {
					wrong[path] = [`no structured answer: ${r?.content?.[0]?.text}`];
					continue;
				}
				const sc = r.structuredContent as ListStructured;
				if (!validate(sc)) problems.push(JSON.stringify(validate.errors));
				for (const row of sc.items as Array<Record<string, unknown>>) {
					for (const k of Object.keys(row)) {
						if (!rowProps.includes(k))
							problems.push(`row key ${k} is undeclared`);
					}
				}
				if (path === "page with more behind it" && sc.nextCursor === null)
					problems.push("the path did not run: no nextCursor");
				if (path === "page the byte cap cut" && sc.truncated !== true)
					problems.push("the path did not run: not truncated");
				if (
					path === "rows withheld by scope" &&
					!(Number(sc.scopeFiltered) > 0)
				)
					problems.push("the path did not run: no scopeFiltered");
				if (c === undefined) problems.push("no list contract");
				else {
					problems.push(
						...contractDisagreements(
							c,
							contractModule?.listReturnsKeys(c) ?? [],
							r.content[0].text,
							sc,
						),
					);
				}
				if (problems.length > 0) wrong[path] = problems;
			}
			expect(wrong).toEqual({});
		});
	}

	it("no paged list tool declares an input that has no effect (a no-op input is dropped, not described as useless)", () => {
		const noop = PAGED_LISTS.flatMap((tool) =>
			Object.entries(
				(
					inputSchemas.get(tool) as JsonSchema & {
						properties?: Record<
							string,
							{ deprecated?: boolean; description?: string }
						>;
					}
				)?.properties ?? {},
			)
				.filter(
					([, p]) =>
						p.deprecated === true || /^Has no effect/.test(p.description ?? ""),
				)
				.map(([name]) => `${tool}.${name}`),
		);
		expect(noop).toEqual([]);
	});

	it("no list tool's limit states a page size: the schema carries the default, and a page holds what limit says", async () => {
		const stated = PAGED_LISTS.flatMap((tool) => {
			const d =
				(
					inputSchemas.get(tool) as {
						properties?: Record<string, { description?: string }>;
					}
				)?.properties?.limit?.description ?? "";
			return /\b\d+ rows\b/.test(d) ? [`${tool}.limit: ${d}`] : [];
		});
		expect(stated).toEqual([]);
		// Measured: with a cursor and no limit, the page asked of the door is the
		// schema's default (20), not the 50 an earlier text claimed.
		for (const tool of ["list_memories", "list_episodes"] as const) {
			const calls: Array<[string, Record<string, unknown>]> = [];
			await listHandlers(
				LOCAL_STDIO_TRUST_CTX,
				() => paginated([], false),
				calls,
			).get(tool)?.({
				namespace: "global",
				cursor: encodeCursor({ backendCursor: "b" }),
			});
			expect(calls[0]?.[1].paginationOpts, tool).toEqual({
				numItems: 20,
				cursor: "b",
			});
		}
	});
});

describe("the found reads and update_profile: one statement of each field", () => {
	for (const tool of ["get_diary", "get_mission_template", "get_profile"]) {
		it(`${tool}: Returns names the schema's properties once, and the item's fields are not listed a second, different way`, () => {
			const d = descriptions.get(tool) ?? "";
			const listed = listedReturnFields(d);
			expect(listed?.fields.map((f) => f.name).sort()).toEqual(
				Object.keys((schemas.get(tool) as JsonSchema).properties ?? {}).sort(),
			);
			expect(d).not.toMatch(/item is the [a-z ]+ \(/);
		});
	}

	it("update_profile static.workspace says what it holds and where its value comes from and goes", () => {
		const d =
			(
				inputSchemas.get("update_profile") as {
					properties?: Record<
						string,
						{ properties?: Record<string, { description?: string }> }
					>;
				}
			)?.properties?.static?.properties?.workspace?.description ?? "";
		expect(d).toMatch(/stored as given/);
		expect(d).toMatch(/\blist_peers\b/);
		expect(d).toMatch(/\bget_profile\b/);
	});
});
