/**
 * Per-tool documentation quality, read from the SERVED tools/list (task
 * k1793xkjhzh1xm23gmmwjgwfyx8htbv0, PR B).
 *
 * A client model chooses and fills a tool from what tools/list says, and from
 * nothing else. These assertions pin what that text must carry:
 *
 *   1. every tool declares `idempotentHint`, and the value is the one decided
 *      from the handler and the Convex function it calls (the table below,
 *      with the reason for each write);
 *   2. every tool whose handler returns `structuredContent` declares an
 *      `outputSchema`, and no other tool does;
 *   3. no input field description restates its own schema (an enum list, a
 *      min/max bound, a pattern length): the schema already says it;
 *   4. every optional top-level field says what OMITTING it does;
 *   5. every input field, at any depth, has a description;
 *   6. every tool description says what the call RETURNS;
 *   7. the mutating tools named by the quality report state the effect;
 *   8. the titles named by the report are short and free of jargon;
 *   9. the three description/schema mismatches say what the schema does.
 *
 * Runs the REAL McpServer through an in-memory transport, as a remote client
 * sees it, so a tool registered tomorrow is covered without editing a list
 * here (except the idempotency table, which fails on any unknown tool).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";
import {
	COERCIVE_PATTERNS,
	STRUCTURED_TOOLS,
	UNSTRUCTURED_TOOLS,
} from "./lib/toolMetadataDecisions.js";

type JsonSchema = {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	anyOf?: JsonSchema[];
	enum?: unknown[];
	const?: unknown;
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};

type ServedTool = {
	name: string;
	title?: string;
	description?: string;
	inputSchema: JsonSchema;
	outputSchema?: unknown;
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. idempotentHint — decided per write tool from the handler and its Convex
//    door. A read-only tool changes nothing, so a repeat leaves the same state.
//    Convention: a bookkeeping timestamp re-stamped to "now" on a repeat
//    (updatedAt, lastSeen) is not counted as a change; a re-stamped domain
//    clock (completedAt, which billing reads) IS counted.
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_IDEMPOTENCY: Record<string, boolean> = {
	// false: a repeat creates, appends or re-applies.
	store_memory: false, // memories:storeMemory inserts a new row each call
	erase_memory: false, // a replaceWith that contains its find string re-applies on every call
	store_episode: false, // episodes:storeEpisode inserts a new row each call
	send_message: false, // messages:sendMessage inserts a message + receipts each call
	create_task: false, // tasks:create inserts
	bulk_complete_tasks: false, // a live call inserts a bulk_complete_runs row each call
	update_task: false, // status='done' re-stamps completedAt (no already-done guard in tasks:update)
	complete_task: false, // re-stamps completedAt; may insert a fixPattern and post a GitHub comment again
	create_mission: false, // missions:create inserts
	create_briefing_note: false, // briefingNotes:create inserts
	create_recurring_task: false, // recurringTasks:create inserts
	debate_post_turn: false, // a repeat is refused AND appends a refused turn + bumps the room's refusal counter
	create_fix_pattern: false, // fixPatterns:create inserts
	add_fix_attempt: false, // fixPatterns:addAttempt inserts a fixAttempts row
	instantiate_template_into_mission: false, // inserts one task per step each call
	export_okf_bundle: false, // writes a new storage object and schedules its purge each call
	store_document_chunked: false, // supersedes the prior chunks and inserts new ones each call
	generate_upload_url: false, // inserts an uploadTickets row (with sha256) each call
	// true: a repeat with the same arguments leaves the same state.
	soft_delete_memory: true, // isLatest=false again
	erase_row: true, // the row is gone; a repeat is refused, nothing written
	update_profile: true, // upsert of the given fields
	mark_as_read: true, // readAt is set only when still unset
	delete_message: true, // the message is gone; a repeat is refused
	set_summary: true, // overwrites currentTask (lastSeen re-stamped)
	fail_task: true, // a closed task is refused (CANNOT_FAIL_CLOSED_TASK)
	start_task: true, // an open segment is refused (START_REFUSED_OPEN_SEGMENT)
	pause_task: true, // no open segment is refused (PAUSE_REFUSED_NO_OPEN_SEGMENT)
	resume_task: true, // a task not paused is refused (RESUME_REFUSED_NOT_PAUSED)
	correct_task_segment: true, // one correction per segment; a repeat is refused
	checkout_task: true, // a task no longer todo returns claimed:false, nothing written
	delete_task: true, // the task is gone
	block_task: true, // same blocked fields; blockedBy is appended de-duplicated
	add_task_dependency: true, // appended de-duplicated
	update_mission: true, // patch of the given fields
	update_mission_status: true, // same status
	write_diary: true, // upsert by (orchestrator, date)
	update_briefing_note: true, // patch of the given fields
	pause_recurring_task: true, // active=false again
	resume_recurring_task: true, // active=true, nextRunAt recomputed from the same cron
	delete_recurring_task: true, // the row is gone
	update_recurring_task: true, // patch of the given fields
	add_repo_mapping: true, // upsert by repo
	remove_repo_mapping: true, // the mapping is gone; a repeat returns deleted:false
	validate_fix: true, // overwrites validatedFix; the search entry is keyed by patternId
	link_issue_to_pattern: true, // appended only when absent
	update_mission_template: true, // upsert by name
	import_okf_bundle: true, // every entry is de-duplicated by content; a replay imports nothing
	soft_delete_document: true, // isLatest=false again
	claim_upload: true, // the ticket is consumed; a repeat is refused
};

describe("idempotentHint", () => {
	it("every served tool declares idempotentHint as a boolean", () => {
		const missing = tools
			.filter((t) => typeof t.annotations?.idempotentHint !== "boolean")
			.map((t) => t.name);
		expect(missing).toEqual([]);
	});

	it("a read-only tool is idempotent", () => {
		const wrong = tools
			.filter(
				(t) =>
					t.annotations?.readOnlyHint === true &&
					t.annotations?.idempotentHint !== true,
			)
			.map((t) => t.name);
		expect(wrong).toEqual([]);
	});

	it("every write tool carries the decided value, and no write tool is undecided", () => {
		const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true);
		const undecided = writes
			.filter((t) => !(t.name in WRITE_IDEMPOTENCY))
			.map((t) => t.name);
		expect(undecided, "write tools with no idempotency decision").toEqual([]);
		const wrong = writes
			.filter(
				(t) => t.annotations?.idempotentHint !== WRITE_IDEMPOTENCY[t.name],
			)
			.map(
				(t) =>
					`${t.name}: served ${String(t.annotations?.idempotentHint)}, decided ${String(WRITE_IDEMPOTENCY[t.name])}`,
			);
		expect(wrong).toEqual([]);
	});

	it("the table names no tool that is not served (no stale decision)", () => {
		const served = new Set(tools.map((t) => t.name));
		expect(
			Object.keys(WRITE_IDEMPOTENCY).filter((n) => !served.has(n)),
		).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. outputSchema where, and only where, the handler returns structuredContent.
//    Read from the registration source: the defineTool(...) call whose name
//    argument is the tool, and whether its text mentions structuredContent.
// ─────────────────────────────────────────────────────────────────────────────

function toolsReturningStructuredContent(): Set<string> {
	const src = join(__dirname, "..", "src");
	const files = [
		join(src, "tools.ts"),
		...readdirSync(join(src, "tools"))
			.filter((f) => f.endsWith(".ts"))
			.map((f) => join(src, "tools", f)),
	];
	const out = new Set<string>();
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const consts = new Map<string, string>();
		for (const st of sf.statements) {
			if (!ts.isVariableStatement(st)) continue;
			for (const d of st.declarationList.declarations) {
				if (
					ts.isIdentifier(d.name) &&
					d.initializer &&
					ts.isStringLiteralLike(d.initializer)
				)
					consts.set(d.name.text, d.initializer.text);
			}
		}
		const visit = (n: ts.Node) => {
			if (
				ts.isCallExpression(n) &&
				ts.isIdentifier(n.expression) &&
				n.expression.text === "defineTool"
			) {
				const a = n.arguments[3];
				const name =
					a && ts.isStringLiteralLike(a)
						? a.text
						: a && ts.isIdentifier(a)
							? consts.get(a.text)
							: undefined;
				if (name && n.getText(sf).includes("structuredContent")) out.add(name);
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return out;
}

describe("outputSchema", () => {
	it("the scan sees the known structuredContent tool (not degenerate)", () => {
		expect(toolsReturningStructuredContent().has("whoami")).toBe(true);
	});

	it("every tool returning structuredContent declares an outputSchema", () => {
		const structured = toolsReturningStructuredContent();
		const missing = tools
			.filter((t) => structured.has(t.name) && !t.outputSchema)
			.map((t) => t.name);
		expect(missing).toEqual([]);
	});

	it("no tool declares an outputSchema its handler does not honour", () => {
		const structured = toolsReturningStructuredContent();
		const extra = tools
			.filter((t) => t.outputSchema && !structured.has(t.name))
			.map((t) => t.name);
		expect(extra).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Field walk
// ─────────────────────────────────────────────────────────────────────────────

type Field = {
	tool: string;
	path: string;
	schema: JsonSchema;
	optional: boolean;
	topLevel: boolean;
};

function fieldsOf(tool: ServedTool): Field[] {
	const out: Field[] = [];
	const walk = (node: JsonSchema, prefix: string, topLevel: boolean) => {
		const req = new Set(node.required ?? []);
		for (const [key, child] of Object.entries(node.properties ?? {})) {
			const path = prefix ? `${prefix}.${key}` : key;
			out.push({
				tool: tool.name,
				path,
				schema: child,
				optional: !req.has(key),
				topLevel,
			});
			for (const branch of [child, child.items, ...(child.anyOf ?? [])]) {
				if (branch?.properties) walk(branch, path, false);
				if (branch?.items?.properties) walk(branch.items, `${path}[]`, false);
			}
		}
	};
	walk(tool.inputSchema, "", true);
	return out;
}

const SAFE_INT = 9007199254740991;

/** Every enum value of a field: its own, its items', its anyOf branches'. */
function enumValues(s: JsonSchema): string[] {
	const vals: unknown[] = [];
	for (const b of [s, s.items, ...(s.anyOf ?? [])]) {
		if (!b) continue;
		if (Array.isArray(b.enum)) vals.push(...b.enum);
		if (b.const !== undefined) vals.push(b.const);
		if (Array.isArray(b.items?.enum)) vals.push(...b.items.enum);
	}
	return [...new Set(vals.filter((v): v is string => typeof v === "string"))];
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What a description restates of its own schema, if anything. */
function restatements(s: JsonSchema): string[] {
	const desc = s.description ?? "";
	const found: string[] = [];
	const values = enumValues(s);
	if (values.length >= 2) {
		const tok = `["'\`\\[]?(?:${values.map(escapeRe).join("|")})["'\`\\]]?`;
		const list = new RegExp(`${tok}\\s*(?:\\||/|,|\\+|\\bor\\b)\\s*${tok}`);
		const m = desc.match(list);
		if (m) found.push(`enum list "${m[0]}"`);
	}
	const bounds: Array<[string, number | undefined]> = [
		["maximum", s.maximum],
		["minimum", s.minimum],
		["maxItems", s.maxItems],
		["minItems", s.minItems],
		["maxLength", s.maxLength],
		["minLength", s.minLength],
	];
	for (const [k, n] of bounds) {
		if (n === undefined || Math.abs(n) === SAFE_INT || n === 0 || n === 1)
			continue;
		if (new RegExp(`(?<!\\d|\\d\\.)${n}(?!\\d|\\.\\d)`).test(desc))
			found.push(`${k} ${n}`);
	}
	const pat = s.pattern ?? s.items?.pattern;
	if (pat) {
		const len = pat.match(/\{(\d+)\}/)?.[1];
		if (
			len &&
			new RegExp(`\\b${len}[- ]?(char|character|digit|hex)`, "i").test(desc)
		)
			found.push(`pattern length ${len}`);
		if (/\[0-9a-f\]|\[a-f0-9\]/.test(pat) && /\bhex\b/i.test(desc))
			found.push("pattern alphabet (hex)");
	}
	if (/^\s*optional\b/i.test(desc)) found.push('opens with "Optional"');
	return found;
}

describe("input field descriptions", () => {
	it("the restatement detector is bipolar", () => {
		expect(
			restatements({
				enum: ["lite", "full"],
				description: 'Field projection ("lite"|"full")',
			}),
		).not.toEqual([]);
		expect(
			restatements({
				enum: ["lite", "full"],
				description:
					"How much of each row comes back: 'lite' is compact. Omit for lite; 'full' is everything.",
			}),
		).toEqual([]);
		expect(
			restatements({ maximum: 200, description: "Max items. Cap 200." }),
		).not.toEqual([]);
		expect(
			restatements({
				maximum: 200,
				description: "How many rows. Omit for 20.",
			}),
		).toEqual([]);
		expect(
			restatements({
				pattern: "^[a-z0-9]{32}$",
				description: "a 32-char ID",
			}),
		).not.toEqual([]);
	});

	it("every input field, at any depth, has a description", () => {
		const missing = tools.flatMap((t) =>
			fieldsOf(t)
				.filter((f) => !(f.schema.description ?? "").trim())
				.map((f) => `${f.tool}.${f.path}`),
		);
		expect(missing).toEqual([]);
	});

	it("no field description restates its enum, bounds or pattern", () => {
		const offenders = tools.flatMap((t) =>
			fieldsOf(t).flatMap((f) => {
				const r = restatements(f.schema);
				return r.length ? [`${f.tool}.${f.path}: ${r.join("; ")}`] : [];
			}),
		);
		expect(offenders).toEqual([]);
	});

	it("every optional top-level field says what omitting it does", () => {
		const OMISSION =
			/\b(omit|omitted|omitting|omission|without it|absent|not given|left out|leave it out|unset|by default|defaults? to)\b/i;
		const silent = tools.flatMap((t) =>
			fieldsOf(t)
				.filter(
					(f) =>
						f.topLevel &&
						f.optional &&
						!OMISSION.test(f.schema.description ?? ""),
				)
				.map((f) => `${f.tool}.${f.path}`),
		);
		expect(silent).toEqual([]);
	});

	it("the fields named by the report say what omission does", () => {
		const named: Array<[string, string]> = [
			["store_memory", "ttl"],
			["debate_post_turn", "done"],
			["update_mission_template", "isDefault"],
			...tools.flatMap((t) =>
				"callerOrchestrator" in (t.inputSchema.properties ?? {})
					? [[t.name, "callerOrchestrator"] as [string, string]]
					: [],
			),
		];
		expect(named.length).toBeGreaterThan(10);
		const silent = named.filter(([tool, field]) => {
			const d =
				tools.find((t) => t.name === tool)?.inputSchema.properties?.[field]
					?.description ?? "";
			return !/\bomit/i.test(d);
		});
		expect(silent).toEqual([]);
	});

	it("an ID field says where the ID comes from (names the tool that returns it)", () => {
		const names = tools.map((t) => t.name);
		const ID_FIELD =
			/(Id|Ids)$|^(sessionDay|tenantId|commit|bulkRunId|storageId|ticket|docId)$/;
		const silent = tools.flatMap((t) =>
			fieldsOf(t)
				.filter((f) => f.topLevel && ID_FIELD.test(f.path))
				.filter((f) => {
					const d = f.schema.description ?? "";
					return !(
						names.some((n) => d.includes(n)) ||
						/\[DEBATE-TURN\] message|whoami|git commit/.test(d)
					);
				})
				.map((f) => `${f.tool}.${f.path}`),
		);
		expect(silent).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool descriptions and titles
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_RETURN_TOOLS = [
	"store_memory",
	"hybrid_search",
	"get_episode",
	"get_profile",
	"list_memories",
	"send_message",
	"list_broadcast_status",
	"list_tasks",
	"checkout_task",
	"list_missions",
	"write_diary",
	"list_briefing_notes",
	"debate_get_room",
	"list_repo_mappings",
	"get_github_owner_bindings",
	"list_fix_patterns",
	"get_tool_usage",
	"get_owner_tool_usage",
	"whoami",
	"export_okf_bundle",
];

const RETURNS = /(^|[.:;)]\s+|\n)Returns\b/;

describe("tool descriptions", () => {
	it("the 20 tools named by the report say what they return", () => {
		const silent = REPORT_RETURN_TOOLS.filter(
			(n) => !RETURNS.test(tools.find((t) => t.name === n)?.description ?? ""),
		);
		expect(silent).toEqual([]);
	});

	it("every served tool says what it returns", () => {
		const silent = tools
			.filter((t) => !RETURNS.test(t.description ?? ""))
			.map((t) => t.name);
		expect(silent).toEqual([]);
	});

	it("the mutating tools named by the report state their effect and prerequisites", () => {
		const d = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
		expect(d("update_mission")).toMatch(/overwrit|replac/i);
		expect(d("update_mission")).toMatch(/cancel/i);
		expect(d("validate_fix")).toMatch(/overwrit|replac/i);
		expect(d("validate_fix")).toMatch(/fleet master/i);
		expect(d("update_mission_template")).toMatch(/overwrit|replac/i);
		expect(d("update_mission_template")).toMatch(/fleet master/i);
	});

	it("the titles named by the report are short and carry no jargon", () => {
		const title = (n: string) =>
			(tools.find((t) => t.name === n)?.annotations?.title as string) ?? "";
		for (const n of [
			"whoami",
			"search_episodes_by_semantic",
			"search_tasks_by_keyword",
			"search_briefing_notes_by_keyword",
		]) {
			expect(title(n).length, n).toBeGreaterThan(0);
			expect(title(n).length, n).toBeLessThanOrEqual(32);
			expect(title(n), n).not.toMatch(/BM25|vector cosine|introspection|\(/);
		}
		const jargon = tools
			.filter((t) =>
				/BM25|\(vector|introspection/.test(String(t.annotations?.title)),
			)
			.map((t) => t.name);
		expect(jargon).toEqual([]);
	});
});

describe("description/schema mismatches named by the report", () => {
	const field = (tool: string, f: string) =>
		tools.find((t) => t.name === tool)?.inputSchema.properties?.[f] ?? {};

	it("list_tasks_by_mission.status is described as the list the schema takes", () => {
		const s = field("list_tasks_by_mission", "status");
		expect(s.type).toBe("array");
		expect(s.description).toMatch(/\blist\b/i);
		expect(s.description).not.toMatch(/single/i);
	});

	it("create_briefing_note.participants is described as a list, never a bare string", () => {
		const s = field("create_briefing_note", "participants");
		expect(s.type).toBe("array");
		expect(s.description).not.toMatch(/or 'pi'|or "pi"/);
	});

	it("correct_task_segment.callerOrchestrator says omission is refused without a resolved agent", () => {
		const s = field("correct_task_segment", "callerOrchestrator");
		expect(s.description).not.toMatch(/if provided/i);
		expect(s.description).toMatch(/refused/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// PR C (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0) — the Manufact "Improve" report
// re-run on the live server after PR B. Each block below is one finding class.
// ─────────────────────────────────────────────────────────────────────────────

const toolByName = (n: string) => {
	const t = tools.find((x) => x.name === n);
	if (!t) throw new Error(`tool not served: ${n}`);
	return t;
};

/** The schema at a dotted path, e.g. "deliverable.pkg" or "filter.status". */
function fieldAt(tool: string, path: string): JsonSchema {
	let node: JsonSchema | undefined = toolByName(tool).inputSchema;
	for (const key of path.split(".")) {
		const props: Record<string, JsonSchema> | undefined =
			node?.properties ?? node?.anyOf?.find((b) => b.properties)?.properties;
		node = props?.[key];
	}
	if (!node) throw new Error(`no field ${tool}.${path}`);
	return node;
}

const descOf = (tool: string, path: string) =>
	fieldAt(tool, path).description ?? "";

describe("finding 1 — a field says what its value MEANS, never only how it validates", () => {
	it("every page-size `limit` says what happens to the rows beyond it", () => {
		const silent = tools.flatMap((t) => {
			const limit = t.inputSchema.properties?.limit;
			if (!limit) return [];
			const d = limit.description ?? "";
			const paged = "cursor" in (t.inputSchema.properties ?? {});
			const ok = paged
				? /nextCursor/.test(d)
				: /\b(rest|beyond|not returned|truncated|total|since)\b/.test(d);
			return ok && !/^How many rows to return/.test(d)
				? []
				: [`${t.name}.limit: ${d}`];
		});
		expect(silent).toEqual([]);
	});

	it("no field states a time as bare 'Unix milliseconds': it names the moment and how to make one", () => {
		const offenders = tools.flatMap((t) =>
			fieldsOf(t)
				.filter((f) => /Unix (ms|milli)/i.test(f.schema.description ?? ""))
				.map((f) => `${f.tool}.${f.path}`),
		);
		expect(offenders).toEqual([]);
		for (const [tool, path] of [
			["billing_summary_by_project", "from"],
			["billing_summary_by_project", "to"],
			["list_briefing_notes", "updatedSince"],
		] as const) {
			const d = descOf(tool, path);
			expect(d, `${tool}.${path}`).toMatch(/\bmoment\b/);
			expect(d, `${tool}.${path}`).toMatch(/Date\.now\(\)/);
		}
		expect(descOf("billing_summary_by_project", "from")).toMatch(/completed/);
		expect(descOf("billing_summary_by_project", "to")).toMatch(/completed/);
	});

	it("a lite/full `fields` switch says what each projection is for, not the enum in prose", () => {
		const offenders = tools.flatMap((t) => {
			const f = t.inputSchema.properties?.fields;
			if (!f || !enumValues(f).includes("lite")) return [];
			const d = f.description ?? "";
			return /'lite' returns|^Accepted for compatibility/.test(d)
				? [`${t.name}.fields: ${d}`]
				: [];
		});
		expect(offenders).toEqual([]);
	});

	// Field → what the rewritten description must carry (its meaning) and the
	// flagged phrasing it must no longer use.
	const MEANING: Array<[string, string, RegExp[], RegExp[]]> = [
		["store_memory", "type", [/recall|list_memories/], []],
		[
			"send_message",
			"fromAgentId",
			[/whoami/, /recipients/],
			[/^The sender by agent ID/],
		],
		["list_peers", "fields", [/every stored field/], []],
		["create_task", "project", [/billing/, /spell|exact/i], []],
		["create_task", "assignedToAgentId", [/who does the work/], []],
		[
			"create_task",
			"deliverable.pkg",
			[/npm/, /publish/],
			[/^npm package name/],
		],
		[
			"create_task",
			"deliverable.export",
			[/publish/, /delivered-but-open|done/],
			[/^Exported identifier/],
		],
		["list_tasks", "status", [/any of/], [/as a list of statuses/]],
		[
			"bulk_complete_tasks",
			"filter.status",
			[/not started|under way|review|blocked/],
			[/in this open state/],
		],
		["update_task", "assignedToAgentId", [/who does the work/], []],
		["correct_task_segment", "segmentIndex", [/position/], [/counting from 0/]],
		[
			"correct_task_segment",
			"reason",
			[/stored|kept/],
			[/^Why the correction is honest/],
		],
		["update_mission", "status", [/list_missions/], [/^A new lifecycle stage/]],
		[
			"create_recurring_task",
			"priority",
			[/queue/],
			[/^The priority every generated task gets\.$/],
		],
		[
			"create_recurring_task",
			"tags",
			[/copied/],
			[/^Tags every generated task gets/],
		],
		[
			"improvisation_digest",
			"windowDays",
			[/ending now/],
			[/^How many days back to scan/],
		],
		[
			"improvisation_digest",
			"orchestrators",
			[/count|sample/],
			[/^Scan only these orchestrators/],
		],
	];

	for (const [tool, path, must, mustNot] of MEANING) {
		it(`${tool}.${path} says what the value means`, () => {
			const d = descOf(tool, path);
			for (const re of must) expect(d, `${tool}.${path}`).toMatch(re);
			for (const re of mustNot) expect(d, `${tool}.${path}`).not.toMatch(re);
		});
	}

	it("an enum field named by the report names at most three of its values in its prose", () => {
		const named: Array<[string, string]> = [
			["store_memory", "type"],
			["list_tasks", "status"],
			["bulk_complete_tasks", "filter.status"],
			["update_mission", "status"],
			["create_recurring_task", "priority"],
			["list_peers", "fields"],
			["list_briefing_notes", "fields"],
			["search_briefing_notes_by_keyword", "fields"],
			["list_repo_mappings", "fields"],
		];
		const offenders = named.flatMap(([tool, path]) => {
			const s = fieldAt(tool, path);
			const d = s.description ?? "";
			const hit = enumValues(s).filter((v) =>
				new RegExp(`(^|[^a-z_])${escapeRe(v)}([^a-z_]|$)`).test(d),
			);
			return hit.length > 3 ? [`${tool}.${path}: ${hit.join(", ")}`] : [];
		});
		expect(offenders).toEqual([]);
	});
});

describe("finding 2 — where a value comes from and its convention", () => {
	it("a project on an update names the billing line it is and where it was first set", () => {
		for (const [tool, origin] of [
			["update_task", "create_task"],
			["update_mission", "create_mission"],
			["update_recurring_task", "create_recurring_task"],
		] as const) {
			const d = descOf(tool, "project");
			expect(d, tool).toMatch(/billing/);
			expect(d, tool).toContain(origin);
		}
	});

	it("update_recurring_task.assignedTo says it is an agent name, not an agent ID", () => {
		const d = descOf("update_recurring_task", "assignedTo");
		expect(d).toMatch(/agent name/);
		expect(d).toMatch(/not (an )?agent ID/);
		expect(d).toMatch(/list_peers/);
	});
});

describe("finding 3 — what a changed value does", () => {
	it("update_mission.name says the mission keeps its identity", () => {
		expect(descOf("update_mission", "name")).toMatch(/missionId/);
	});
	it("update_mission.priority says what reads it and what it does not drive", () => {
		const d = descOf("update_mission", "priority");
		expect(d).toMatch(/list_missions|get_mission/);
		expect(d).toMatch(/nothing|not inherited|label/);
	});
	it("update_briefing_note.topic says which filters see the note under it", () => {
		const d = descOf("update_briefing_note", "topic");
		expect(d).toMatch(/list_briefing_notes/);
		expect(d).toMatch(/search_briefing_notes_by_keyword/);
	});
});

describe("finding 4 — update_mission_status says what its schema and handler do", () => {
	it("status admits 'cancelled' here, and says no reason is recorded", () => {
		const s = fieldAt("update_mission_status", "status");
		expect(enumValues(s)).toContain("cancelled");
		expect(s.description).not.toMatch(/goes through update_mission/);
		expect(s.description).toMatch(/cancelled/);
		expect(s.description).toMatch(/no (cancel )?reason/);
	});
	it("the tool says it is the fleet master's", () => {
		expect(toolByName("update_mission_status").description).toMatch(
			/fleet master/,
		);
	});
});

describe("finding 5 — improvisation_digest says what it returns", () => {
	it("names every key of its answer and what a sample carries", () => {
		const d = toolByName("improvisation_digest").description ?? "";
		for (const key of [
			"countsByOrch",
			"countsByCategory",
			"samples",
			"snippet",
			"artifactId",
		]) {
			expect(d, key).toContain(key);
		}
		expect(d).toMatch(/complete_task.*send_message.*store_memory/);
		expect(d).toMatch(/fleet master/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// finding 6 — outputSchema. Decided per tool from the handler and its Convex
// door. A tool declares one ONLY when every success path returns
// structuredContent equal to the JSON of its text; the real calls that prove it
// are in test/output-schema-structured-content.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

describe("finding 6 — outputSchema decided per tool", () => {
	it("every served tool is decided exactly once", () => {
		const served = tools.map((t) => t.name).sort();
		const decided = [
			...STRUCTURED_TOOLS,
			...Object.keys(UNSTRUCTURED_TOOLS),
		].sort();
		expect(decided).toEqual(served);
	});

	it("exactly the decided tools declare an outputSchema", () => {
		const declared = tools
			.filter((t) => t.outputSchema)
			.map((t) => t.name)
			.sort();
		expect(declared).toEqual([...STRUCTURED_TOOLS].sort());
	});

	it("every declared outputSchema is an object schema open to added fields", () => {
		const bad = tools
			.filter((t) => t.outputSchema)
			.filter((t) => {
				const s = t.outputSchema as {
					type?: string;
					additionalProperties?: unknown;
				};
				return s.type !== "object" || s.additionalProperties === false;
			})
			.map((t) => t.name);
		expect(bad).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Policy finding (Manufact policy-review-d26bfdfb4c66, Anthropic Software
// Directory Policy D): tool metadata describes the tool's OWN behaviour, inputs
// and outputs; it never tells the model to call another tool before or after it,
// nor prescribes how the model words its answer. The optional citation workflow
// is user documentation (README), not tool metadata.
// ─────────────────────────────────────────────────────────────────────────────

/** Every metadata string a client model reads, per served tool. */
function metadataTexts(
	t: ServedTool & { _meta?: unknown },
): Array<[string, string]> {
	const out: Array<[string, string]> = [
		[`${t.name} description`, t.description ?? ""],
		[`${t.name} title`, String(t.title ?? "")],
		[`${t.name} annotations`, JSON.stringify(t.annotations ?? {})],
		[`${t.name} _meta`, JSON.stringify(t._meta ?? {})],
	];
	for (const f of fieldsOf(t))
		out.push([`${t.name}.${f.path}`, f.schema.description ?? ""]);
	return out;
}

describe("policy — no tool metadata coerces the model into calling other tools", () => {
	it("the denylist is bipolar", () => {
		const hit = (s: string) => COERCIVE_PATTERNS.some((re) => re.test(s));
		expect(
			hit("VP-Sources doctrine: MUST be called before any factual claim"),
		).toBe(true);
		expect(hit("Cite returned ids in the answer footer")).toBe(true);
		expect(hit("1. Call whoami first.")).toBe(true);
		expect(hit("Messages: call check_messages at session start")).toBe(true);
		expect(hit("Returns a JSON array of memories, best match first.")).toBe(
			false,
		);
		expect(hit("check_messages returns your unread messages.")).toBe(false);
	});

	it("no description, title, annotation, _meta or input description carries a denylisted pattern", () => {
		const offenders = tools.flatMap((t) =>
			metadataTexts(t).flatMap(([where, text]) =>
				COERCIVE_PATTERNS.filter((re) => re.test(text)).map(
					(re) => `${where}: ${re.source}`,
				),
			),
		);
		expect(offenders).toEqual([]);
	});

	it("the server instructions carry no denylisted pattern", async () => {
		const { SERVER_INSTRUCTIONS } = await import("../src/brand.js");
		expect(
			COERCIVE_PATTERNS.filter((re) => re.test(SERVER_INSTRUCTIONS)).map(
				(re) => re.source,
			),
		).toEqual([]);
	});
});
