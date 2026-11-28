#!/usr/bin/env node
/**
 * print-tools.mjs — derives the README tool reference from the BUILT server.
 *
 * Starts dist/server.js over its real stdio transport (the same transport
 * `npx vantage-peers-mcp` uses), calls `tools/list`, and renders every tool
 * the server actually advertises (the `core` list of tool-exposure.json,
 * intersected with the registered tools) as Markdown, grouped by domain.
 * It then runs the built registerTools() against a recording stub to list
 * the tools that are registered but disabled (not advertised, not callable),
 * so the README documents the whole registered set that
 * scripts/check-tool-counts.mjs compares it against.
 * Nothing in the output is typed by hand: names, descriptions and hints all
 * come from the server's own registration.
 *
 * Usage (after `npm run build`):
 *   node scripts/print-tools.mjs           # print the Markdown block
 *   node scripts/print-tools.mjs --write   # replace the block in README.md
 *   node scripts/print-tools.mjs --check   # exit 1 if README.md has drifted
 *
 * Exit codes (every mode):
 *   0  clean (printed, written, or README matches tools/list)
 *   1  README.md tool reference has drifted (--check only)
 *   2  could not judge: the server did not boot, gave no tools/list answer,
 *      the registerTools import failed, the README markers are missing, or the
 *      option is unknown. A tool that cannot judge never reports "stale".
 *
 * Test seams (env, all optional; the defaults are the real build and README):
 *   PRINT_TOOLS_SERVER_ENTRY     path of the server script to spawn
 *                                (default dist/server.js)
 *   PRINT_TOOLS_README           path of the README to read/write
 *                                (default README.md)
 *   PRINT_TOOLS_REGISTER_MODULE  path of the module exporting registerTools
 *                                (default dist/src/tools.js)
 *
 * The README block sits between `<!-- tools:start -->` and `<!-- tools:end -->`.
 * CONVEX_URL only needs to be a syntactically valid URL: tools/list never
 * reaches Convex.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = process.env.PRINT_TOOLS_SERVER_ENTRY
	? resolve(process.env.PRINT_TOOLS_SERVER_ENTRY)
	: resolve(root, "dist", "server.js");
const README = process.env.PRINT_TOOLS_README
	? resolve(process.env.PRINT_TOOLS_README)
	: resolve(root, "README.md");
const REGISTER_MODULE = process.env.PRINT_TOOLS_REGISTER_MODULE
	? resolve(process.env.PRINT_TOOLS_REGISTER_MODULE)
	: resolve(root, "dist", "src", "tools.js");
const START = "<!-- tools:start -->";
const END = "<!-- tools:end -->";
const TIMEOUT_MS = 15_000;

async function listTools() {
	const child = spawn(process.execPath, [SERVER_ENTRY], {
		env: {
			...process.env,
			CONVEX_URL: process.env.CONVEX_URL ?? "https://example.convex.cloud",
		},
		stdio: ["pipe", "pipe", "inherit"],
	});
	let buffer = "";
	const waiters = new Map();
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf-8");
		for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
			const line = buffer.slice(0, i).trim();
			buffer = buffer.slice(i + 1);
			if (!line) continue;
			try {
				const msg = JSON.parse(line);
				waiters.get(msg.id)?.(msg);
			} catch {
				// not JSON-RPC — ignore
			}
		}
	});
	// Reject every pending call as soon as the child is gone, instead of
	// waiting out the timeout.
	let gone = null;
	const rejecters = new Set();
	const fail = (reason) => {
		gone ??= reason;
		for (const r of rejecters) r(new Error(gone));
		rejecters.clear();
	};
	child.on("exit", (code, signal) =>
		fail(
			`server exited with ${signal ? `signal ${signal}` : `code ${code}`} before answering`,
		),
	);
	child.on("error", (err) => fail(`server could not start (${err.message})`));
	child.stdin.on("error", () => {});
	const call = (id, method, params) =>
		new Promise((res, rej) => {
			if (gone) return rej(new Error(`${method}: ${gone}`));
			rejecters.add((e) => {
				clearTimeout(t);
				rej(new Error(`${method}: ${e.message}`));
			});
			const t = setTimeout(
				() => rej(new Error(`${method}: no answer in ${TIMEOUT_MS} ms`)),
				TIMEOUT_MS,
			);
			waiters.set(id, (m) => {
				clearTimeout(t);
				m.error
					? rej(new Error(`${method}: ${m.error.message}`))
					: res(m.result);
			});
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	try {
		await call(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "print-tools", version: "0" },
		});
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);
		const result = await call(2, "tools/list", {});
		if (!Array.isArray(result?.tools)) {
			throw new Error("tools/list: answer carries no tools array");
		}
		return result.tools;
	} finally {
		child.kill();
	}
}

// Every name registerTools() registers, through either registrar entry point,
// recorded on a stub server. The Convex client is never called at
// registration time, so an empty object stands in for it.
async function listRegisteredNames() {
	const { registerTools } = await import(pathToFileURL(REGISTER_MODULE).href);
	const names = new Set();
	const record = (name) => {
		names.add(name);
		return { disable() {}, enable() {}, update() {}, remove() {} };
	};
	const stub = new Proxy(
		{ tool: record, registerTool: record },
		{ get: (target, prop) => target[prop] ?? (() => ({})) },
	);
	registerTools(stub, {}, undefined);
	return names;
}

// Domain grouping is a rule over the tool NAME, applied in order — never a
// hand-typed list of tools. A tool no rule matches lands in "Other".
const GROUPS = [
	["Memory and search", /memor|recall|text_search|hybrid_search|document/],
	["Fix patterns", /fix_pattern|fix_attempt|validate_fix|link_issue/],
	["Missions and templates", /mission/],
	["Recurring tasks", /recurring/],
	["Tasks", /task/],
	["Messages", /message|mark_as_read|broadcast/],
	["Briefing notes", /briefing/],
	["Episodes", /episode/],
	["Diary", /diar/],
	["Billing", /billing/],
	["Profiles and peers", /profile|peers|summary/],
	["Knowledge bundles (OKF)", /okf/],
	["Other", /./],
];

// The first sentence of the registered description, before any usage notes.
// A sentence ends at ". " followed by a capital; a leading clause before " — "
// is kept alone when it is a sentence in its own right (40+ characters).
function summary(description = "") {
	let head = description
		.split(/\s+WHEN:/)[0]
		.replace(/\s+/g, " ")
		.trim();
	const end = head.search(/\.\s+(?=[A-Z])/);
	if (end !== -1) head = head.slice(0, end + 1);
	const dash = head.indexOf(" — ");
	if (dash >= 40) head = `${head.slice(0, dash)}.`;
	return head;
}

function hint(a = {}) {
	if (a.readOnlyHint) return "read";
	if (a.destructiveHint) return "write, destructive";
	return "write";
}

function render(tools, registered) {
	const byGroup = new Map(GROUPS.map(([g]) => [g, []]));
	for (const t of tools) {
		const [g] = GROUPS.find(([, re]) => re.test(t.name));
		byGroup.get(g).push(t);
	}
	const out = [
		`${tools.length} tools are advertised to clients. This reference is generated from the server's own \`tools/list\` by \`scripts/print-tools.mjs\`; do not edit it by hand.`,
		"",
	];
	for (const [g, list] of byGroup) {
		if (list.length === 0) continue;
		list.sort((a, b) => a.name.localeCompare(b.name));
		out.push(`### ${g} (${list.length})`, "");
		for (const t of list) {
			out.push(
				`- \`${t.name}\` (${hint(t.annotations)}) — ${summary(t.description)}`,
			);
		}
		out.push("");
	}
	const advertised = new Set(tools.map((t) => t.name));
	const hidden = [...registered].filter((n) => !advertised.has(n)).sort();
	if (hidden.length > 0) {
		out.push(
			"The tools below are present in the server code but disabled in this release: a client can neither list nor call them. They are named so this reference matches the code exactly.",
			"",
			`### Registered, not advertised (${hidden.length})`,
			"",
			hidden.map((n) => `\`${n}\``).join(", "),
			"",
		);
	}
	return out.join("\n").trimEnd();
}

const mode = process.argv[2];

// A discovery failure is never a drift verdict: say what failed and exit 2.
async function discover(what, fn) {
	try {
		return await fn();
	} catch (err) {
		process.stderr.write(
			`could not judge: ${what} (${err instanceof Error ? err.message : String(err)})\n`,
		);
		process.exit(2);
	}
}

if (mode && mode !== "--write" && mode !== "--check") {
	process.stderr.write(`could not judge: unknown option ${mode}\n`);
	process.exit(2);
}

const tools = await discover(`tools/list from ${SERVER_ENTRY}`, listTools);
const registered = await discover(
	`registerTools import from ${REGISTER_MODULE}`,
	listRegisteredNames,
);
const block = render(tools, registered);

if (!mode) {
	process.stdout.write(`${block}\n`);
	process.exit(0);
}

const readme = await discover(`read ${README}`, async () =>
	readFileSync(README, "utf-8"),
);
const s = readme.indexOf(START);
const e = readme.indexOf(END);
if (s === -1 || e === -1 || e < s) {
	process.stderr.write(
		`could not judge: ${README}: markers ${START} / ${END} not found\n`,
	);
	process.exit(2);
}
const next = `${readme.slice(0, s + START.length)}\n${block}\n${readme.slice(e)}`;

if (mode === "--write") {
	writeFileSync(README, next);
	process.stdout.write("README.md tool reference rewritten.\n");
} else if (mode === "--check") {
	if (next !== readme) {
		process.stderr.write(
			"README.md tool reference is stale: run node scripts/print-tools.mjs --write\n",
		);
		process.exit(1);
	}
	process.stdout.write("README.md tool reference matches tools/list.\n");
}
