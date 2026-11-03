/**
 * The client seat matrix (VantagePeers Cloud, task k177e8dyrnykk3c56yf2b0pgfs8hhz06):
 * every tool the server lists, called by a seat with the PLAIN arguments a client
 * would send (no author, no namespace unless the schema requires it), classified
 * PASS / REFUSED(code) / ERROR.
 *
 * Nothing here is typed per tool except the few values a client cannot omit and the
 * schema cannot say (which recipient a message goes to, which row an ID names): the
 * tool list, the required keys and their types are read from `tools/list`.
 */

export type JsonSchema = {
	type?: string | string[];
	enum?: unknown[];
	const?: unknown;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	minItems?: number;
	minimum?: number;
	description?: string;
};

export type ListedTool = {
	name: string;
	description?: string;
	inputSchema: JsonSchema;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

export type Cell =
	| { kind: "PASS" }
	| { kind: "REFUSED"; code: string; text: string }
	| { kind: "ERROR"; text: string };

/** The rows and names a seat's plain call refers to (seeded in the seat's own org). */
export type Fixtures = {
	ids: Record<string, string>;
	strings: Record<string, string>;
};

/**
 * convex-test mints document IDs shaped `<n>;<table>`; a production ID (and every
 * MCP ID validator) is 32 lowercase alphanumerics. The bridge between the route's
 * Convex client and convex-test translates whole-string values both ways, so a
 * client sees and sends production-shaped IDs and the backend sees its own.
 */
export function makeIdAliaser(): {
	toBackend: (value: unknown) => unknown;
	fromBackend: (value: unknown) => unknown;
	alias: (backendId: string) => string;
} {
	const byBackend = new Map<string, string>();
	const byAlias = new Map<string, string>();
	// Inside a string too: a namespace `orchestrator/<agent ID>` carries an ID.
	const TEST_ID = /\b\d+;[A-Za-z_]+\b/g;
	const ALIAS = /\bid\d{30}\b/g;
	const alias = (backendId: string): string => {
		const known = byBackend.get(backendId);
		if (known !== undefined) return known;
		const made = `id${String(byBackend.size + 1).padStart(30, "0")}`;
		byBackend.set(backendId, made);
		byAlias.set(made, backendId);
		return made;
	};
	const walk = (value: unknown, leaf: (s: string) => string): unknown => {
		if (typeof value === "string") return leaf(value);
		if (Array.isArray(value)) return value.map((v) => walk(v, leaf));
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([k, v]) => [
					k,
					walk(v, leaf),
				]),
			);
		}
		return value;
	};
	return {
		alias,
		toBackend: (value) =>
			walk(value, (s) => s.replace(ALIAS, (m) => byAlias.get(m) ?? m)),
		fromBackend: (value) =>
			walk(value, (s) => s.replace(TEST_ID, (m) => alias(m))),
	};
}

/** Values a client cannot omit and the schema cannot name: the recipient of a message. */
const TOOL_OVERRIDES: Record<
	string,
	(fx: Fixtures) => Record<string, unknown>
> = {
	send_message: (fx) => ({ recipientAgentIds: [fx.strings.agentId] }),
};

function firstType(schema: JsonSchema): string | undefined {
	if (Array.isArray(schema.type)) {
		return schema.type.find((t) => t !== "null");
	}
	return schema.type;
}

function valueFor(
	key: string,
	schema: JsonSchema,
	fx: Fixtures,
	depth = 0,
): unknown {
	if (schema.const !== undefined) return schema.const;
	if (schema.enum !== undefined && schema.enum.length > 0)
		return schema.enum[0];
	const branch = schema.anyOf ?? schema.oneOf;
	if (branch !== undefined && branch.length > 0) {
		return valueFor(key, branch[0] as JsonSchema, fx, depth);
	}
	const type = firstType(schema);
	if (type === "string") {
		if (fx.ids[key] !== undefined) return fx.ids[key];
		if (fx.strings[key] !== undefined) return fx.strings[key];
		if (/date$/i.test(key)) return "2026-11-03";
		if (/(At|Time)$/.test(key)) return "2026-11-04T00:00:00Z";
		if (/url$/i.test(key)) return "https://example.test/x";
		return "matrix probe";
	}
	if (type === "number" || type === "integer") {
		return schema.minimum !== undefined && schema.minimum > 1
			? schema.minimum
			: 1;
	}
	if (type === "boolean") return false;
	if (type === "array") {
		const n = Math.max(1, schema.minItems ?? 1);
		const item = schema.items ?? { type: "string" };
		return Array.from({ length: n }, () => valueFor(key, item, fx, depth + 1));
	}
	if (type === "object" && depth < 4) {
		return requiredArgs(schema, fx, depth + 1);
	}
	return "matrix probe";
}

function requiredArgs(
	schema: JsonSchema,
	fx: Fixtures,
	depth = 0,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of schema.required ?? []) {
		const prop = schema.properties?.[key];
		if (prop === undefined) continue;
		out[key] = valueFor(key, prop, fx, depth);
	}
	return out;
}

/** The plain call a client makes: the required keys only, plus the few overrides. */
export function plainArgs(
	tool: ListedTool,
	fx: Fixtures,
): Record<string, unknown> {
	return {
		...requiredArgs(tool.inputSchema, fx),
		...TOOL_OVERRIDES[tool.name]?.(fx),
	};
}

/** The typed code a refusal opens with (`CODE: ...`), else the RBAC_DENIED / Forbidden marker. */
export function refusalCode(raw: string): string | null {
	const text = raw.replace(/^Error:\s*"?/, "");
	const lead = text.match(/^(?:REFUSED \()?([A-Z][A-Z0-9_]{3,})[):]/);
	if (lead) return lead[1] as string;
	const inner = text.match(
		/\b(RBAC_DENIED|AGENT_CREDENTIAL_REQUIRED|PERSON_NO_HUMAN_DOOR|PERSON_ACTS_AS_ITSELF|ACTING_NAME_REQUIRED|AGENT_IDENTITY_MISMATCH|AUTH_REQUIRED|ORG_MISMATCH|NAMESPACE_REQUIRED)\b/,
	);
	if (inner) return inner[1] as string;
	if (/^Forbidden\b/.test(text)) return "Forbidden";
	if (/^createdBy is required\b/.test(text)) return "CREATED_BY_REQUIRED";
	return null;
}

export function classify(result: {
	isError?: boolean;
	content?: { type?: string; text?: string }[];
}): Cell {
	const text = (result.content ?? [])
		.map((c) => c.text ?? "")
		.join(" ")
		.slice(0, 400);
	if (result.isError !== true) return { kind: "PASS" };
	const code = refusalCode(text);
	return code !== null
		? { kind: "REFUSED", code, text }
		: { kind: "ERROR", text };
}

/**
 * The refusals that say "a person may not act here without an agent": the cells a
 * person seat must never meet on a tool whose own text promises it may omit the author.
 */
export const PERSON_DOOR_REFUSALS = new Set([
	"PERSON_NO_HUMAN_DOOR",
	"AGENT_CREDENTIAL_REQUIRED",
	"ACTING_NAME_REQUIRED",
	"CREATED_BY_REQUIRED",
]);

/**
 * Does the tool's own advertised text promise a signed-in person may omit the author?
 * Read from the listed description and every parameter description.
 */
export function promisesPersonMayOmitAuthor(tool: ListedTool): boolean {
	const texts = [
		tool.description ?? "",
		...Object.values(tool.inputSchema.properties ?? {}).map(
			(p) => p.description ?? "",
		),
	];
	return texts.some(
		(t) =>
			/A person signed in to its organisation omits it/.test(t) ||
			/Omit it when you are a signed-in person/.test(t) ||
			/a signed-in person may omit/i.test(t),
	);
}

export function cellText(cell: Cell): string {
	if (cell.kind === "PASS") return "PASS";
	if (cell.kind === "REFUSED") return `REFUSED(${cell.code})`;
	return "ERROR";
}

export type SeatColumn = { seat: string; cells: Map<string, Cell> };

/** The matrix as Markdown: one row per tool, one column per seat, then the counts. */
export function renderMatrix(
	title: string,
	tools: ListedTool[],
	columns: SeatColumn[],
	notes: string[],
): string {
	const lines: string[] = [];
	lines.push(`# ${title}`, "");
	for (const n of notes) lines.push(n);
	lines.push("");
	lines.push("## Counts", "");
	lines.push("| seat | PASS | REFUSED | ERROR | promised-but-refused |");
	lines.push("|---|---|---|---|---|");
	for (const col of columns) {
		let pass = 0;
		let refused = 0;
		let error = 0;
		let promised = 0;
		for (const tool of tools) {
			const cell = col.cells.get(tool.name);
			if (cell === undefined) continue;
			if (cell.kind === "PASS") pass++;
			else if (cell.kind === "REFUSED") refused++;
			else error++;
			if (isPromisedButRefused(col.seat, tool, cell)) promised++;
		}
		lines.push(
			`| ${col.seat} | ${pass} | ${refused} | ${error} | ${promised} |`,
		);
	}
	lines.push("");
	lines.push("## Cells", "");
	lines.push(
		`| tool | ${columns.map((c) => c.seat).join(" | ")} | promises person may omit author |`,
	);
	lines.push(`|---|${columns.map(() => "---").join("|")}|---|`);
	for (const tool of tools) {
		const cells = columns.map((c) => {
			const cell = c.cells.get(tool.name);
			if (cell === undefined) return "-";
			const mark = isPromisedButRefused(c.seat, tool, cell)
				? " **promised**"
				: "";
			return `${cellText(cell)}${mark}`;
		});
		lines.push(
			`| ${tool.name} | ${cells.join(" | ")} | ${promisesPersonMayOmitAuthor(tool) ? "yes" : "no"} |`,
		);
	}
	lines.push("");
	lines.push("## What each non-PASS cell said (first 200 characters)", "");
	for (const col of columns) {
		lines.push(`### ${col.seat}`, "");
		for (const tool of tools) {
			const cell = col.cells.get(tool.name);
			if (cell === undefined || cell.kind === "PASS") continue;
			const said = cell.text
				.replace(/\s+/g, " ")
				.replace(/\|/g, "/")
				.slice(0, 200);
			lines.push(`- \`${tool.name}\` ${cellText(cell)}: ${said}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

/** A person seat refused for want of an agent on a tool whose text promises otherwise. */
export function isPromisedButRefused(
	seat: string,
	tool: ListedTool,
	cell: Cell,
): boolean {
	return (
		seat.startsWith("person") &&
		cell.kind === "REFUSED" &&
		PERSON_DOOR_REFUSALS.has(cell.code) &&
		promisesPersonMayOmitAuthor(tool)
	);
}
