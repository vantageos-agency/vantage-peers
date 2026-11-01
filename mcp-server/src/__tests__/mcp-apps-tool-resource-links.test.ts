/**
 * MCP Apps: a tool that has a UI names it, and the name resolves
 * (task k17dkh134a5a8nm2nqk8x2ddkh8hca7k).
 *
 * MCP Apps (SEP-1865, @modelcontextprotocol/ext-apps spec 2025-11-21): a host
 * renders a tool's UI only when the tool's tools/list entry carries
 * `_meta.ui.resourceUri`, that URI answers resources/read with a
 * `text/html;profile=mcp-app` document, and the document receives the tool's
 * result from the host over the postMessage bridge (`ui/initialize`, then
 * `ui/notifications/tool-result`). Before this task no tool named a resource,
 * so no host rendered one.
 *
 * Four poles, all through the REAL McpServer over an in-memory transport:
 *   1. LINKED   - each linked tool names a URI that resources/list and
 *                 resources/read serve with the MCP Apps MIME type.
 *   2. UNLINKED - a tool with no UI carries no `_meta.ui` at all.
 *   3. FALLBACK - each linked tool's content[0] is the same text item it
 *                 returned before the link (base d4278807), byte for byte:
 *                 a host that renders no UI (Claude Code terminal, Hermes)
 *                 sees exactly what it saw.
 *   4. BRIDGE   - the served document, run against a simulated host, performs
 *                 the handshake and renders the rows of the tool result it is
 *                 handed, from the result and never from a text marker.
 */

import { runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

const MCP_APP_MIME = "text/html;profile=mcp-app";
const ID = "k17dkh134a5a8nm2nqk8x2ddkh8hca7k";

// What each Convex door answers in this harness. Master caller, so the
// package scope filters pass every row through.
const ROWS: Record<string, unknown> = {
	"tasks:list": [
		{
			_id: ID,
			title: "Ship apps",
			status: "todo",
			priority: "high",
			assignedTo: "sigma",
			createdBy: "pi",
		},
	],
	"messages:listMessages": [
		{ _id: ID, from: "pi", to: "sigma", content: "hello", _creationTime: 1 },
	],
	"missions:list": [
		{
			_id: ID,
			name: "m",
			status: "execute",
			pilot: "sigma",
			createdBy: "sigma",
		},
	],
	"memories:listMemories": {
		value: [
			{
				_id: ID,
				namespace: "global",
				type: "fact",
				content: "c",
				createdBy: "sigma",
			},
		],
		isDone: true,
		continueCursor: null,
	},
	"diary:get": {
		_id: ID,
		date: "2026-10-01",
		orchestrator: "sigma",
		content: "d",
		createdBy: "sigma",
	},
	"briefingNotes:get": {
		_id: ID,
		title: "t",
		topic: "x",
		content: "b",
		createdBy: "sigma",
	},
};

// tool -> [arguments, primitive it links, text it returned at base d4278807]
const LINKED: ReadonlyArray<
	readonly [string, Record<string, unknown>, string, unknown]
> = [
	[
		"list_tasks",
		{},
		"tasks-table",
		[
			{
				_id: ID,
				title: "Ship apps",
				status: "todo",
				priority: "high",
				assignedTo: "sigma",
			},
		],
	],
	[
		"list_messages",
		{},
		"messages-feed",
		[{ _id: ID, from: "pi", to: "sigma", content: "hello", _creationTime: 1 }],
	],
	[
		"list_missions",
		{},
		"mission-timeline",
		[
			{
				_id: ID,
				name: "m",
				status: "execute",
				pilot: "sigma",
				createdBy: "sigma",
			},
		],
	],
	[
		"list_memories",
		{ namespace: "global" },
		"memory-quote",
		{
			items: [
				{
					_id: ID,
					namespace: "global",
					type: "fact",
					content: "c",
					createdBy: "sigma",
				},
			],
		},
	],
	[
		"get_diary",
		{ date: "2026-10-01", orchestrator: "sigma" },
		"diary-entry",
		{
			_id: ID,
			date: "2026-10-01",
			orchestrator: "sigma",
			content: "d",
			createdBy: "sigma",
		},
	],
	[
		"get_briefing_note",
		{ noteId: ID },
		"briefing-note",
		{ _id: ID, title: "t", topic: "x", content: "b", createdBy: "sigma" },
	],
];

function masterCtx(): OAuthContext {
	return {
		clientId: "m",
		userId: "m",
		scopes: [],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3600_000,
		isMaster: true,
	} as OAuthContext;
}

async function harness() {
	const convex = {
		query: async (name: string) => ROWS[name] ?? null,
		mutation: async () => null,
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerTools(server, convex, masterCtx());
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	return client;
}

type UiMeta = { ui?: { resourceUri?: string } } | undefined;

describe("pole 1, LINKED: a linked tool's resourceUri resolves to an MCP App", () => {
	for (const [tool, , primitive] of LINKED) {
		it(`${tool} -> ${primitive}`, async () => {
			const client = await harness();
			const { tools } = await client.listTools();
			const meta = tools.find((t) => t.name === tool)?._meta as UiMeta;
			const uri = meta?.ui?.resourceUri;
			expect(uri).toBe(`ui://vp/apps/v1/${primitive}`);

			const { resources } = await client.listResources();
			const listed = resources.find((r) => r.uri === uri);
			expect(listed?.mimeType).toBe(MCP_APP_MIME);

			const read = await client.readResource({ uri: uri as string });
			await client.close();
			const first = read.contents[0] as { mimeType?: string; text?: string };
			expect(first.mimeType).toBe(MCP_APP_MIME);
			expect(first.text?.toLowerCase().startsWith("<!doctype html>")).toBe(
				true,
			);
		});
	}
});

describe("pole 2, UNLINKED: a tool with no UI carries no _meta.ui", () => {
	for (const tool of ["whoami", "list_diaries", "create_task"]) {
		it(tool, async () => {
			const client = await harness();
			const { tools } = await client.listTools();
			await client.close();
			const entry = tools.find((t) => t.name === tool);
			expect(entry).toBeDefined();
			expect((entry?._meta as UiMeta)?.ui).toBeUndefined();
		});
	}
});

describe("pole 3, FALLBACK: the text result is unchanged by the link", () => {
	for (const [tool, args, , before] of LINKED) {
		it(`${tool} content[0] is the base text item`, async () => {
			const client = await harness();
			const res = await client.callTool({ name: tool, arguments: args });
			await client.close();
			expect(res.isError).toBeFalsy();
			expect(res.content).toEqual([
				{ type: "text", text: JSON.stringify(before, null, 2) },
			]);
			expect(res.structuredContent).toBeUndefined();
		});
	}
});

// ── pole 4: run the served document against a simulated host ───────────────

type FakeEl = {
	tag: string;
	children: FakeEl[];
	textContent: string;
	className: string;
	attrs: Record<string, string>;
	appendChild(c: FakeEl): FakeEl;
	replaceChildren(...c: FakeEl[]): void;
	setAttribute(k: string, v: string): void;
	innerHTML?: never;
};

function el(tag: string): FakeEl {
	const node: FakeEl = {
		tag,
		children: [],
		textContent: "",
		className: "",
		attrs: {},
		appendChild(c) {
			node.children.push(c);
			return c;
		},
		replaceChildren(...c) {
			node.children = c;
			node.textContent = "";
		},
		setAttribute(k, v) {
			node.attrs[k] = v;
		},
	};
	// A document that writes markup instead of building nodes is refused here.
	Object.defineProperty(node, "innerHTML", {
		set() {
			throw new Error("innerHTML is not used by the MCP App");
		},
	});
	return node;
}

function textOf(n: FakeEl): string {
	return [n.textContent, ...n.children.map(textOf)].join(" ");
}

function simulateHost(html: string) {
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
	if (script === undefined)
		throw new Error("document carries no inline script");
	const root = el("div");
	const sent: Array<Record<string, unknown>> = [];
	const listeners: Array<(e: { data: unknown; source: unknown }) => void> = [];
	const parent = {
		postMessage: (m: Record<string, unknown>) => sent.push(m),
	};
	const window = {
		parent,
		addEventListener: (
			type: string,
			fn: (e: { data: unknown; source: unknown }) => void,
		) => {
			if (type === "message") listeners.push(fn);
		},
	};
	const document = {
		getElementById: (id: string) => (id === "vp-app-root" ? root : null),
		createElement: (tag: string) => el(tag),
		documentElement: { scrollHeight: 120, scrollWidth: 400 },
	};
	runInNewContext(script, { window, document, JSON, Array, Object, String });
	const deliver = (data: unknown, source: unknown = parent) => {
		for (const fn of listeners) fn({ data, source });
	};
	return { root, sent, deliver };
}

describe("pole 4, BRIDGE: the document renders the tool result the host hands it", () => {
	for (const [tool, , primitive, before] of LINKED) {
		it(`${primitive} (${tool})`, async () => {
			const client = await harness();
			const uri = `ui://vp/apps/v1/${primitive}`;
			const read = await client.readResource({ uri });
			await client.close();
			const html = (read.contents[0] as { text: string }).text;
			const host = simulateHost(html);

			// Handshake: the app asks first, and says it is initialised only after
			// the host answered.
			const init = host.sent[0];
			expect(init?.method).toBe("ui/initialize");
			expect(
				(init?.params as { protocolVersion?: string }).protocolVersion,
			).toBe("2025-11-21");
			expect(
				host.sent.some((m) => m.method === "ui/notifications/initialized"),
			).toBe(false);
			host.deliver({
				jsonrpc: "2.0",
				id: init?.id,
				result: {
					protocolVersion: "2025-11-21",
					hostInfo: { name: "sim", version: "0" },
					hostCapabilities: {},
					hostContext: {},
				},
			});
			expect(
				host.sent.some((m) => m.method === "ui/notifications/initialized"),
			).toBe(true);

			// A message from anyone but the host is ignored.
			const foreign = {
				jsonrpc: "2.0",
				method: "ui/notifications/tool-result",
				params: { content: [{ type: "text", text: '[{"title":"FOREIGN"}]' }] },
			};
			host.deliver(foreign, {});
			expect(textOf(host.root)).not.toContain("FOREIGN");

			// The host hands over the tool result; the app renders its rows.
			host.deliver({
				jsonrpc: "2.0",
				method: "ui/notifications/tool-result",
				params: {
					content: [{ type: "text", text: JSON.stringify(before, null, 2) }],
				},
			});
			const rendered = textOf(host.root);
			const firstRow = (
				Array.isArray(before)
					? before[0]
					: ((before as { items?: unknown[] }).items?.[0] ?? before)
			) as Record<string, unknown>;
			const shown = ["title", "content", "name"].find(
				(k) => typeof firstRow[k] === "string",
			) as string;
			expect(rendered).toContain(firstRow[shown] as string);
		});
	}

	it("a refused or failed tool result is shown as an error, not as an empty list", async () => {
		const client = await harness();
		const read = await client.readResource({
			uri: "ui://vp/apps/v1/tasks-table",
		});
		await client.close();
		const host = simulateHost((read.contents[0] as { text: string }).text);
		host.deliver({ jsonrpc: "2.0", id: host.sent[0]?.id, result: {} });
		host.deliver({
			jsonrpc: "2.0",
			method: "ui/notifications/tool-result",
			params: {
				isError: true,
				content: [{ type: "text", text: "REFUSED (RBAC_DENIED): list_tasks" }],
			},
		});
		expect(textOf(host.root)).toContain("REFUSED (RBAC_DENIED)");
	});

	async function tasksTableHost() {
		const client = await harness();
		const read = await client.readResource({
			uri: "ui://vp/apps/v1/tasks-table",
		});
		await client.close();
		const host = simulateHost((read.contents[0] as { text: string }).text);
		host.deliver({ jsonrpc: "2.0", id: host.sent[0]?.id, result: {} });
		return host;
	}

	it("a refused envelope ({refused:true, items:[]}) is shown as a refusal, never as 'No results'", async () => {
		const host = await tasksTableHost();
		host.deliver({
			jsonrpc: "2.0",
			method: "ui/notifications/tool-result",
			params: {
				content: [
					{ type: "text", text: JSON.stringify({ refused: true, items: [] }) },
				],
			},
		});
		expect(textOf(host.root)).toContain("REFUSED (RBAC_DENIED)");
		expect(textOf(host.root)).not.toContain("No results");
	});

	it("a genuinely empty result is shown as 'No results'", async () => {
		const host = await tasksTableHost();
		host.deliver({
			jsonrpc: "2.0",
			method: "ui/notifications/tool-result",
			params: { content: [{ type: "text", text: "[]" }] },
		});
		expect(textOf(host.root)).toContain("No results");
	});

	it("rows come from the JSON before a __VP_TOOL_RESULT__ marker, never from the marker", async () => {
		const host = await tasksTableHost();
		const text = `${JSON.stringify([{ title: "FROM-JSON", status: "todo" }], null, 2)}\n__VP_TOOL_RESULT__{"kind":"tasks-table","items":[{"_id":"k","title":"FROM-MARKER","status":"todo"}]}__END__`;
		host.deliver({
			jsonrpc: "2.0",
			method: "ui/notifications/tool-result",
			params: { content: [{ type: "text", text }] },
		});
		expect(textOf(host.root)).toContain("FROM-JSON");
		expect(textOf(host.root)).not.toContain("FROM-MARKER");
	});

	it("the host's teardown request is answered", async () => {
		const client = await harness();
		const read = await client.readResource({
			uri: "ui://vp/apps/v1/tasks-table",
		});
		await client.close();
		const host = simulateHost((read.contents[0] as { text: string }).text);
		host.deliver({
			jsonrpc: "2.0",
			id: 99,
			method: "ui/resource-teardown",
			params: {},
		});
		expect(host.sent.find((m) => m.id === 99)).toEqual({
			jsonrpc: "2.0",
			id: 99,
			result: {},
		});
	});
});
