#!/usr/bin/env node
/**
 * client-seat-matrix.mjs — the client seat matrix (VantagePeers Cloud, task
 * k177e8dyrnykk3c56yf2b0pgfs8hhz06).
 *
 * In-process (always): runs mcp-server/test/client-seat-matrix.test.ts, which lists
 * every tool from `tools/list` and calls each, with the plain arguments a client
 * sends, as three seats (a person with a bound agent, a person with none, an agent
 * seat) through the real /mcp route against the real Convex functions
 * (convex-test). The matrix is written to --out.
 *
 * Live (--live): the AGENT seat part against production, with the existing probe
 * seats (~/.config/vantage-probe-tenants/prod/probe-tenant-a/probe-a.{bearer,secret},
 * probe-a2 = same org, probe-b = another org). Read-only tools are called as they
 * are; of the write tools only the five client write paths are called (store_memory,
 * store_episode, create_briefing_note, create_task, send_message to probe-a2), each
 * in the seat's own space, and every row written is erased afterwards with
 * erase_row. Every other write tool is reported SKIPPED, never guessed. A bearer
 * or secret is read from its file and never printed.
 *
 *   node scripts/client-seat-matrix.mjs --out qa/client-seat-matrix-before.md [--live]
 *     [--title "..."] [--mcp-url https://mcp.vantagepeers.com/mcp]
 *
 * Exit: 0 matrix written (the in-process invariants green), 1 an invariant failed
 * (the matrix is still written), 2 could not run (missing file, unreachable server).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i === -1 ? fallback : process.argv[i + 1];
}

const out = arg("--out");
if (out === undefined) {
	console.error(
		"usage: node scripts/client-seat-matrix.mjs --out <file.md> [--live]",
	);
	process.exit(2);
}
const outPath = resolve(process.cwd(), out);
const title = arg("--title", "Client seat matrix");
const live = process.argv.includes("--live");
const mcpUrl = arg("--mcp-url", "https://mcp.vantagepeers.com/mcp");
const probeDir = join(homedir(), ".config/vantage-probe-tenants/prod");

const rev = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
	encoding: "utf8",
}).trim();

// ── in-process ───────────────────────────────────────────────────────────────
const run = spawnSync(
	"npx",
	["vitest", "run", "test/client-seat-matrix.test.ts"],
	{
		cwd: join(ROOT, "mcp-server"),
		env: {
			...process.env,
			CLIENT_SEAT_MATRIX_OUT: outPath,
			CLIENT_SEAT_MATRIX_TITLE: title,
			CLIENT_SEAT_MATRIX_REV: rev,
			NO_COLOR: "1",
		},
		encoding: "utf8",
	},
);
const summary = `${run.stdout ?? ""}${run.stderr ?? ""}`
	.split("\n")
	.filter((l) => /Tests\s+\d|Test Files/.test(l))
	// NO_COLOR keeps vitest's summary free of terminal colour codes.
	.map((l) => l.trim());
if (!existsSync(outPath)) {
	console.error("the in-process matrix was not written:");
	console.error(run.stdout, run.stderr);
	process.exit(2);
}
console.log(`in-process matrix -> ${out} (${summary.join("; ")})`);

// ── live agent seat ──────────────────────────────────────────────────────────
const LIVE_WRITES = new Set([
	"store_memory",
	"store_episode",
	"create_briefing_note",
	"create_task",
	"send_message",
]);
const ERASE_TABLE = {
	store_memory: ["memories", "memoryId"],
	store_episode: ["memories", "memoryId"],
	create_briefing_note: ["briefingNotes", "noteId"],
	create_task: ["tasks", "taskId"],
	send_message: ["messages", "messageId"],
};

/**
 * A seat session: bearer plus its agent credential; when the server refuses the
 * credential (HTTP 401), the seat is opened on the bearer alone and the matrix says so.
 */
const credentialNotes = [];
async function seatSession(label, bearerFile, secretFile) {
	const bearer = readSecretFile(bearerFile);
	const secret = existsSync(secretFile)
		? readSecretFile(secretFile)
		: undefined;
	if (secret !== undefined) {
		try {
			return await mcpSession(bearer, secret);
		} catch (err) {
			if (!/Authentication required/.test(String(err?.message))) throw err;
			credentialNotes.push(
				`${label}: its agent credential was refused (HTTP 401); the seat was run on its bearer alone.`,
			);
		}
	}
	return await mcpSession(bearer, undefined);
}

function readSecretFile(path) {
	if (!existsSync(path)) {
		console.error(`File ${path} not found. Aborting the live part.`);
		process.exit(2);
	}
	return readFileSync(path, "utf8").trim();
}

/** A minimal Streamable HTTP MCP client: initialize, then JSON-RPC calls. */
async function mcpSession(bearer, secret) {
	let session;
	let id = 0;
	const headers = () => ({
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		authorization: `Bearer ${bearer}`,
		...(secret ? { "x-vantage-agent-credential": secret } : {}),
		...(session ? { "mcp-session-id": session } : {}),
	});
	async function rpc(method, params, notify = false) {
		const body = notify
			? { jsonrpc: "2.0", method, params }
			: { jsonrpc: "2.0", id: ++id, method, params };
		let res;
		for (let attempt = 0; attempt < 3; attempt++) {
			res = await fetch(mcpUrl, {
				method: "POST",
				headers: headers(),
				body: JSON.stringify(body),
			});
			if (res.status !== 429 && res.status !== 503) break;
			await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
		}
		if (res.status === 401 || res.status === 403) {
			throw new Error(
				`Authentication required for ${mcpUrl} (HTTP ${res.status}).`,
			);
		}
		const sid = res.headers.get("mcp-session-id");
		if (sid) session = sid;
		if (notify) return null;
		const text = await res.text();
		const type = res.headers.get("content-type") ?? "";
		const payload = type.includes("text/event-stream")
			? text
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => JSON.parse(l.slice(5)))
					.find((m) => m.id === body.id)
			: JSON.parse(text);
		if (payload?.error) throw new Error(payload.error.message);
		return payload?.result;
	}
	await rpc("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "client-seat-matrix", version: "0.0.0" },
	});
	await rpc("notifications/initialized", {}, true);
	return {
		list: async () => (await rpc("tools/list", {})).tools,
		call: (name, args) => rpc("tools/call", { name, arguments: args }),
	};
}

function codeOf(text) {
	const t = text.replace(/^Error:\s*"?/, "");
	const lead = t.match(/^(?:REFUSED \()?([A-Z][A-Z0-9_]{3,})[):]/);
	if (lead) return lead[1];
	const inner = t.match(
		/\b(RBAC_DENIED|AGENT_CREDENTIAL_REQUIRED|PERSON_NO_HUMAN_DOOR|ACTING_NAME_REQUIRED|AGENT_IDENTITY_MISMATCH|ORG_MISMATCH)\b/,
	);
	if (inner) return inner[1];
	if (/^Forbidden\b/.test(t)) return "Forbidden";
	return null;
}

function cell(result) {
	const text = (result?.content ?? []).map((c) => c.text ?? "").join(" ");
	if (result?.isError !== true) return { kind: "PASS", text };
	const code = codeOf(text);
	return code ? { kind: "REFUSED", code, text } : { kind: "ERROR", text };
}

const show = (c) =>
	c.kind === "PASS"
		? "PASS"
		: c.kind === "REFUSED"
			? `REFUSED(${c.code})`
			: c.kind;

function firstValue(key, schema, fx) {
	if (schema.enum?.length) return schema.enum[0];
	const branch = schema.anyOf ?? schema.oneOf;
	if (branch?.length) return firstValue(key, branch[0], fx);
	const type = Array.isArray(schema.type)
		? schema.type.find((x) => x !== "null")
		: schema.type;
	if (type === "string") return fx[key] ?? "matrix probe (live, erased)";
	if (type === "number" || type === "integer") return 1;
	if (type === "boolean") return false;
	if (type === "array")
		return [firstValue(key, schema.items ?? { type: "string" }, fx)];
	if (type === "object") return required(schema, fx);
	return "matrix probe";
}
function required(schema, fx) {
	const o = {};
	for (const k of schema.required ?? []) {
		if (schema.properties?.[k]) o[k] = firstValue(k, schema.properties[k], fx);
	}
	return o;
}

async function livePart() {
	const a = await seatSession(
		"probe-a",
		join(probeDir, "probe-tenant-a/probe-a.bearer"),
		join(probeDir, "probe-tenant-a/probe-a.secret"),
	);
	const a2 = await seatSession(
		"probe-a2",
		join(probeDir, "probe-tenant-a/probe-a2.bearer"),
		join(probeDir, "probe-tenant-a/probe-a2.secret"),
	);
	const who = JSON.parse((await a.call("whoami", {})).content[0].text);
	const who2 = JSON.parse((await a2.call("whoami", {})).content[0].text);
	const tools = await a.list();
	const fx = {
		severity: "minor",
		priority: "low",
		assignedTo: who.actor?.agentName ?? "probe-a",
		namespace: who.default_write_namespace ?? undefined,
		recipient: who.actor?.agentName ?? "probe-a",
	};
	const cells = new Map();
	const written = [];
	for (const tool of tools) {
		const ro = tool.annotations?.readOnlyHint === true;
		if (!ro && !LIVE_WRITES.has(tool.name)) {
			cells.set(tool.name, {
				kind: "SKIPPED",
				text: "live: write tool not run on production",
			});
			continue;
		}
		let args = required(tool.inputSchema ?? {}, fx);
		if (tool.name === "send_message") {
			args = {
				recipientAgentIds: [who2.agent_id],
				content: "client-seat-matrix live probe (erased)",
			};
		}
		if (tool.name === "create_task")
			args = { ...args, assignedTo: who.actor?.agentName };
		if (tool.name === "create_briefing_note")
			args = { ...args, participants: [who.actor?.agentName] };
		let c;
		try {
			const r = await a.call(tool.name, args);
			c = cell(r);
			if (c.kind === "PASS" && LIVE_WRITES.has(tool.name)) {
				const [table, key] = ERASE_TABLE[tool.name];
				let parsed = {};
				try {
					parsed = JSON.parse(c.text);
				} catch {
					/* a non-JSON answer names no row */
				}
				const rowId = parsed[key] ?? parsed.id ?? parsed._id;
				written.push({ tool: tool.name, table, rowId });
			}
		} catch (err) {
			c = { kind: "ERROR", text: String(err?.message ?? err) };
		}
		cells.set(tool.name, c);
	}
	const erased = [];
	for (const w of written) {
		if (!w.rowId) {
			erased.push(`${w.tool}: row ID not returned, NOT erased`);
			continue;
		}
		const r = cell(
			await a.call("erase_row", { table: w.table, rowId: w.rowId }),
		);
		erased.push(`${w.tool}: ${w.table}/${w.rowId} erase_row -> ${show(r)}`);
	}
	// Cross-org pole: probe-b (another org) must not read probe-a's own namespace.
	const b = await seatSession(
		"probe-b",
		join(probeDir, "probe-tenant-b/probe-b.bearer"),
		join(probeDir, "probe-tenant-b/probe-b.secret"),
	);
	const cross = cell(
		await b.call("list_memories", { namespace: who.default_write_namespace }),
	);
	return { who, tools, cells, erased, cross };
}

let exit = summary.some((l) => /failed/.test(l)) ? 1 : 0;
if (live) {
	try {
		const r = await livePart();
		const lines = [
			"",
			"## Live agent seat (production, probe-a)",
			"",
			`MCP: ${mcpUrl}. Seat: probe-a (org ${r.who.org_slug}), agent ${r.who.agent_name ?? r.who.actor?.agentName ?? "none"}. Revision of this harness: ${rev}.`,
			"Read-only tools called as a client would; of the write tools only the five client write paths, each row erased afterwards. SKIPPED = not run on production.",
			"This column measures the MCP and Convex AS DEPLOYED on production at run time, not the working tree: a change not yet rolled out does not appear here (the in-process columns above measure the tree).",
			"",
			...credentialNotes,
			"",
			"whoami (probe-a, bearer and credential not shown):",
			"",
			"```json",
			JSON.stringify(r.who, null, 2),
			"```",
			"",
		];
		const counts = { PASS: 0, REFUSED: 0, ERROR: 0, SKIPPED: 0 };
		for (const c of r.cells.values()) counts[c.kind]++;
		lines.push(
			`Counts: PASS ${counts.PASS}, REFUSED ${counts.REFUSED}, ERROR ${counts.ERROR}, SKIPPED ${counts.SKIPPED} (of ${r.tools.length} listed).`,
			"",
			"| tool | agent-seat (live) | said (first 160 characters) |",
			"|---|---|---|",
		);
		for (const t of [...r.tools].sort((x, y) => x.name.localeCompare(y.name))) {
			const c = r.cells.get(t.name);
			const said =
				c.kind === "PASS" || c.kind === "SKIPPED"
					? ""
					: c.text.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 160);
			lines.push(
				`| ${t.name} | ${c.kind === "SKIPPED" ? "SKIPPED" : show(c)} | ${said} |`,
			);
		}
		lines.push("", "Cleanup:", "", ...r.erased.map((e) => `- ${e}`), "");
		lines.push(
			`Cross-org pole: probe-b list_memories namespace=${r.who.default_write_namespace} -> ${show(r.cross)}${r.cross.kind === "PASS" ? " (a PASS here must return no probe-a row)" : ""}.`,
			"",
		);
		writeFileSync(outPath, readFileSync(outPath, "utf8") + lines.join("\n"));
		console.log(`live agent seat appended (${JSON.stringify(counts)})`);
	} catch (err) {
		console.error(`live part failed: ${err?.message ?? err}`);
		writeFileSync(
			outPath,
			`${readFileSync(outPath, "utf8")}\n## Live agent seat (production)\n\nFailed: live — reason: ${err?.message ?? err}\n`,
		);
		exit = 2;
	}
}
process.exit(exit);
