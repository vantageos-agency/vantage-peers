/**
 * The list_tasks MCP App view, as a NON-MASTER OAuth seat sees it.
 * VantagePeers Cloud (HTTP /mcp entry): this is how Claude.ai and ChatGPT
 * connectors reach the server. Task k17dkh134a5a8nm2nqk8x2ddkh8hca7k (T6.1).
 *
 * Interaction with PR #1636 (src/ui-resources/register.ts): that gate guards
 * the `ui://vp/v1/{primitive}` TEMPLATE only, whose read callback queries
 * Convex. The view a tool links (`ui://vp/apps/v1/tasks-table`, apps.ts) is a
 * separate, STATIC resource: its read callback returns a fixed document and
 * reads nothing. Its rows are the tool result the host hands it, and that
 * result was produced through the caller's own per-request client
 * (`selectConvexClientForRequest`: the service account ACTING FOR the seat's
 * verified org, `__actingOrg` on every call). So the view is served to any
 * connected caller, and can show no row the text result did not.
 *
 * The server is built the way server-http.ts's buildServer builds it:
 * registerTools, then registerUiResources, on one McpServer, over the
 * production client selection. The backend is a FAKE two-organisation Convex:
 * a call carrying `__actingOrg` is served that org's rows only; a call carrying
 * nothing (the bare fleet service account) is served every org's rows.
 */

import { runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import { isMasterScope, type OAuthContext } from "../src/auth.js";
import { selectConvexClientForRequest } from "../src/authenticatedConvexClient.js";
import { registerTools } from "../src/tools.js";
import { MCP_UI_MIME_TYPE } from "../src/ui-resources/index.js";
import { registerUiResources } from "../src/ui-resources/register.js";

const ORG_A_ID = "org_AAAA";
const ORG_B_ID = "org_BBBB";
const APP_URI = "ui://vp/apps/v1/tasks-table";
const SNAPSHOT_URI = "ui://vp/v1/tasks-table";

const TASKS = [
	{
		_id: "t1",
		_creationTime: 1,
		title: "A-TASK",
		status: "todo",
		priority: "high",
		assignedTo: "alice",
		createdBy: "alice",
		actingOrg: ORG_A_ID,
	},
	{
		_id: "t2",
		_creationTime: 2,
		title: "B-TASK",
		status: "todo",
		priority: "high",
		assignedTo: "alice",
		createdBy: "alice",
		actingOrg: ORG_B_ID,
	},
];

type Call = { fn: string; args: Record<string, unknown> };

function fakeServiceAccount(calls: Call[]): ConvexHttpClient {
	const call = async (fn: unknown, rawArgs: unknown) => {
		const name = String(fn);
		const args = (rawArgs ?? {}) as Record<string, unknown>;
		calls.push({ fn: name, args });
		const acting = args.__actingOrg as string | undefined;
		if (name === "tasks:list") {
			const rows =
				acting === undefined
					? TASKS
					: TASKS.filter((t) => t.actingOrg === acting);
			return rows.map(({ actingOrg: _org, ...row }) => row);
		}
		// Tool-usage telemetry and any other write: accepted, no data.
		return null;
	};
	return {
		query: call,
		mutation: call,
		action: call,
		setAuth: () => undefined,
	} as unknown as ConvexHttpClient;
}

function baseCtx(over: Partial<OAuthContext>): OAuthContext {
	return {
		clientId: "claude-ai-connector",
		userId: "alice",
		scopes: ["vantage:read"],
		scopeProfile: "team-member",
		fromAllowList: ["alice"],
		namespaceReadPrefixes: ["team/org-a"],
		namespaceWritePrefixes: ["team/org-a"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		...over,
	};
}

/** An org-a seat: a non-master OAuth bearer whose token row resolved org-a. */
const SEAT_A = baseCtx({
	accessTokenHash: "a".repeat(64),
	clerkOrgSlug: "org-a",
	orgClerkId: ORG_A_ID,
});
/** A non-master OAuth bearer whose organisation resolves to no ID. */
const UNRESOLVED = baseCtx({ accessTokenHash: "b".repeat(64) });

/** server-http.ts buildServer, over a fake backend. */
async function connectAs(oauthCtx: OAuthContext) {
	const calls: Call[] = [];
	const convex = selectConvexClientForRequest(
		"https://t.convex.cloud",
		oauthCtx,
		{
			createServiceAccountClient: () => fakeServiceAccount(calls),
			createPlainClient: () => fakeServiceAccount(calls),
		},
	);
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerTools(server, convex, oauthCtx, { recordToolUsage: true });
	const master = isMasterScope(oauthCtx);
	registerUiResources(server, convex, oauthCtx, {
		master,
		callerIdentities: master ? undefined : oauthCtx.fromAllowList,
	});
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	return { client, calls };
}

// ── a minimal host for the served document (textContent-only DOM) ───────────

type FakeEl = {
	children: FakeEl[];
	textContent: string;
	className: string;
	appendChild(c: FakeEl): FakeEl;
	replaceChildren(...c: FakeEl[]): void;
	setAttribute(k: string, v: string): void;
};

function el(): FakeEl {
	const node: FakeEl = {
		children: [],
		textContent: "",
		className: "",
		appendChild(c) {
			node.children.push(c);
			return c;
		},
		replaceChildren(...c) {
			node.children = c;
			node.textContent = "";
		},
		setAttribute() {},
	};
	return node;
}

function textOf(n: FakeEl): string {
	return [n.textContent, ...n.children.map(textOf)].join(" ");
}

/** Run the document, complete the handshake, hand it `result`, return its text. */
function renderInHost(html: string, result: unknown): string {
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
	if (script === undefined) throw new Error("document carries no script");
	const root = el();
	const sent: Array<Record<string, unknown>> = [];
	const listeners: Array<(e: { data: unknown; source: unknown }) => void> = [];
	const parent = { postMessage: (m: Record<string, unknown>) => sent.push(m) };
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
		createElement: () => el(),
		documentElement: { scrollHeight: 120, scrollWidth: 400 },
	};
	runInNewContext(script, { window, document, JSON, Array, Object, String });
	const deliver = (data: unknown) => {
		for (const fn of listeners) fn({ data, source: parent });
	};
	deliver({ jsonrpc: "2.0", id: sent[0]?.id, result: {} });
	deliver({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: result,
	});
	return textOf(root);
}

describe("list_tasks MCP App view, non-master OAuth seat (Claude.ai / ChatGPT connector)", () => {
	it("tools/list links list_tasks to the static app URI, outside the ui://vp/v1/* template", async () => {
		const { client } = await connectAs(SEAT_A);
		const { tools } = await client.listTools();
		await client.close();
		const listTasks = tools.find((t) => t.name === "list_tasks");
		const meta = listTasks?._meta as { ui?: { resourceUri?: string } };
		expect(meta?.ui?.resourceUri).toBe(APP_URI);
		expect(APP_URI.startsWith("ui://vp/v1/")).toBe(false);
	});

	it("list_tasks is scoped to the seat's org, every Convex call acting for that org", async () => {
		const { client, calls } = await connectAs(SEAT_A);
		const res = await client.callTool({ name: "list_tasks", arguments: {} });
		await client.close();
		const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
		expect(res.isError).toBeFalsy();
		expect(text).toContain("A-TASK");
		expect(text).not.toContain("B-TASK");
		expect(calls.some((c) => c.fn === "tasks:list")).toBe(true);
		// Never the bare fleet service account: each call carries the seat's org.
		for (const c of calls) expect(c.args.__actingOrg).toBe(ORG_A_ID);
	});

	it("resources/read of the app URI is served with the MCP Apps MIME type and reads no Convex", async () => {
		const { client, calls } = await connectAs(SEAT_A);
		const read = await client.readResource({ uri: APP_URI });
		await client.close();
		const first = read.contents[0] as { mimeType?: string; text?: string };
		expect(first.mimeType).toBe(MCP_UI_MIME_TYPE);
		expect(first.mimeType).toBe("text/html;profile=mcp-app");
		expect(first.text).toContain("<!doctype html>");
		expect(first.text).not.toContain("A-TASK");
		expect(calls).toEqual([]);
	});

	it("the view renders exactly the seat's list_tasks rows, and no foreign row", async () => {
		const { client, calls } = await connectAs(SEAT_A);
		const result = await client.callTool({
			name: "list_tasks",
			arguments: {},
		});
		const callsAfterTool = calls.length;
		const read = await client.readResource({ uri: APP_URI });
		await client.close();
		expect(calls.length).toBe(callsAfterTool);
		const html = (read.contents[0] as { text: string }).text;
		const shown = renderInHost(html, result);
		expect(shown).toContain("A-TASK");
		expect(shown).not.toContain("B-TASK");
		expect(shown).toContain("1 row");
	});

	it("an unresolved-org bearer: the static view is still served (no data), list_tasks and the snapshot template refuse", async () => {
		const { client, calls } = await connectAs(UNRESOLVED);
		const read = await client.readResource({ uri: APP_URI });
		const first = read.contents[0] as { mimeType?: string };
		expect(first.mimeType).toBe("text/html;profile=mcp-app");
		const res = await client.callTool({ name: "list_tasks", arguments: {} });
		expect(res.isError).toBe(true);
		let snapshotErr: unknown;
		try {
			await client.readResource({ uri: SNAPSHOT_URI });
		} catch (err: unknown) {
			snapshotErr = err;
		}
		await client.close();
		expect((snapshotErr as Error | undefined)?.message).toContain(
			"RBAC_DENIED",
		);
		expect(calls.filter((c) => c.fn === "tasks:list")).toEqual([]);
		// Nothing reached Convex as the bare service account.
		for (const c of calls) expect(c.args.__actingOrg).toBeDefined();
	});
});
