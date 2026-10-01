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
 * The README block sits between `<!-- tools:start -->` and `<!-- tools:end -->`.
 * CONVEX_URL only needs to be a syntactically valid URL: tools/list never
 * reaches Convex.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = resolve(root, "dist", "server.js");
const README = resolve(root, "README.md");
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
		let i;
		// eslint-disable-next-line no-cond-assign
		while ((i = buffer.indexOf("\n")) !== -1) {
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
	const call = (id, method, params) =>
		new Promise((res, rej) => {
			const t = setTimeout(
				() => rej(new Error(`${method}: no answer in ${TIMEOUT_MS} ms`)),
				TIMEOUT_MS,
			);
			waiters.set(id, (m) => {
				clearTimeout(t);
				m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
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
		return result.tools;
	} finally {
		child.kill();
	}
}

// Every name registerTools() registers, through either registrar entry point,
// recorded on a stub server. The Convex client is never called at
// registration time, so an empty object stands in for it.
async function listRegisteredNames() {
	const { registerTools } = await import(
		pathToFileURL(resolve(root, "dist", "src", "tools.js")).href
	);
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
	let head = description.split(/\s+WHEN:/)[0].replace(/\s+/g, " ").trim();
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
			out.push(`- \`${t.name}\` (${hint(t.annotations)}) — ${summary(t.description)}`);
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
const block = render(await listTools(), await listRegisteredNames());

if (!mode) {
	process.stdout.write(`${block}\n`);
	process.exit(0);
}

const readme = readFileSync(README, "utf-8");
const s = readme.indexOf(START);
const e = readme.indexOf(END);
if (s === -1 || e === -1 || e < s) {
	process.stderr.write(`README.md: markers ${START} / ${END} not found\n`);
	process.exit(2);
}
const next = `${readme.slice(0, s + START.length)}\n${block}\n${readme.slice(e)}`;

if (mode === "--write") {
	writeFileSync(README, next);
	process.stdout.write("README.md tool reference rewritten.\n");
} else if (mode === "--check") {
	if (next !== readme) {
		process.stderr.write("README.md tool reference is stale: run node scripts/print-tools.mjs --write\n");
		process.exit(1);
	}
	process.stdout.write("README.md tool reference matches tools/list.\n");
} else {
	process.stderr.write(`unknown option ${mode}\n`);
	process.exit(2);
}
