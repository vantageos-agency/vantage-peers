/**
 * MCP Apps: the tools that have a UI, and the documents those UIs are.
 *
 * Spec: MCP Apps (SEP-1865), @modelcontextprotocol/ext-apps, protocol
 * 2025-11-21. A host renders a tool's UI when:
 *   1. the tool's tools/list entry carries `_meta.ui.resourceUri`;
 *   2. resources/read on that URI answers a `text/html;profile=mcp-app`
 *      document, which the host loads in a sandboxed iframe;
 *   3. the document performs the `ui/initialize` handshake over postMessage,
 *      and the host then hands it the tool's CallToolResult in a
 *      `ui/notifications/tool-result` notification.
 *
 * The documents here are STATIC: they carry no data and call no backend. Every
 * row they show is the row the tool already returned to this caller, after the
 * tool's own scope filter, so a UI never shows more than the text result does.
 * That is why they are separate URIs from the `ui://vp/v1/<primitive>`
 * resources (index.ts), which render a server-side snapshot fetched at read
 * time from query parameters: such a snapshot is not the tool's result, and a
 * host reads a tool's UI resource once, before any call.
 *
 * A tool's text result is NOT changed by the link: a host that renders no UI
 * (Claude Code in a terminal, Hermes) shows content[0].text exactly as before.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { MCP_UI_MIME_TYPE, type Primitive } from "./index.js";

/** Each tool that has a UI, and the primitive it renders as. */
export const UI_APP_TOOL_LINKS: Readonly<Record<string, Primitive>> = {
	list_tasks: "tasks-table",
	list_messages: "messages-feed",
	list_missions: "mission-timeline",
	list_memories: "memory-quote",
	get_diary: "diary-entry",
	get_briefing_note: "briefing-note",
};

/** ext-apps' deprecated flat key; `registerAppTool` still emits it beside `_meta.ui`. */
const LEGACY_RESOURCE_URI_META_KEY = "ui/resourceUri";

/** The MCP Apps protocol version the documents speak. */
const MCP_APPS_PROTOCOL_VERSION = "2025-11-21";

export function uiAppUri(primitive: Primitive): string {
	return `ui://vp/apps/v1/${primitive}`;
}

/** The columns each primitive shows, in order: [field, header]. */
const COLUMNS: Record<Primitive, ReadonlyArray<readonly [string, string]>> = {
	"tasks-table": [
		["title", "Title"],
		["status", "Status"],
		["priority", "Priority"],
		["assignedTo", "Assigned to"],
	],
	"messages-feed": [
		["from", "From"],
		["to", "To"],
		["content", "Message"],
		["_creationTime", "Sent"],
	],
	"mission-timeline": [
		["name", "Mission"],
		["status", "Status"],
		["pilot", "Pilot"],
		["project", "Project"],
	],
	"memory-quote": [
		["namespace", "Namespace"],
		["type", "Type"],
		["content", "Memory"],
	],
	"diary-entry": [
		["date", "Date"],
		["orchestrator", "Orchestrator"],
		["content", "Entry"],
	],
	"briefing-note": [
		["title", "Title"],
		["topic", "Topic"],
		["content", "Note"],
	],
};

const TITLES: Record<Primitive, string> = {
	"tasks-table": "VantagePeers tasks",
	"messages-feed": "VantagePeers messages",
	"mission-timeline": "VantagePeers missions",
	"memory-quote": "VantagePeers memories",
	"diary-entry": "VantagePeers diary entry",
	"briefing-note": "VantagePeers briefing note",
};

/**
 * Merge the MCP Apps link into a tool's registration config. A tool with no
 * UI, or a config that is not an object, is returned untouched.
 */
export function withUiAppLink(name: string, config: unknown): unknown {
	const primitive = UI_APP_TOOL_LINKS[name];
	if (primitive === undefined) return config;
	if (config === null || typeof config !== "object") return config;
	const resourceUri = uiAppUri(primitive);
	const existing = (config as { _meta?: Record<string, unknown> })._meta ?? {};
	const existingUi = (existing.ui ?? {}) as Record<string, unknown>;
	return {
		...config,
		_meta: {
			...existing,
			ui: { ...existingUi, resourceUri },
			[LEGACY_RESOURCE_URI_META_KEY]: resourceUri,
		},
	};
}

// The script below runs in the host's sandboxed iframe. It builds nodes with
// textContent only (never markup), accepts messages from the host frame only,
// and reads the rows from the CallToolResult the host hands over: the JSON in
// its first text item, cut before a `__VP_TOOL_RESULT__` marker if the server
// appended one (VP_EMIT_UI_MARKERS), never from the marker itself.
const APP_SCRIPT = String.raw`(function () {
  "use strict";
  var CFG = __VP_APP_CONFIG__;
  var MARKER = "__VP_TOOL_RESULT__";
  var host = window.parent;
  var root = document.getElementById("vp-app-root");
  var nextId = 1;
  var initId = null;

  function send(m) { m.jsonrpc = "2.0"; host.postMessage(m, "*"); }
  function notify(method, params) { send({ method: method, params: params }); }
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function firstText(result) {
    var c = result && Array.isArray(result.content) ? result.content : [];
    for (var i = 0; i < c.length; i++) {
      if (c[i] && c[i].type === "text" && typeof c[i].text === "string") return c[i].text;
    }
    return "";
  }
  function payloadOf(result) {
    if (result && result.structuredContent !== undefined) return result.structuredContent;
    var text = firstText(result);
    var cut = text.indexOf(MARKER);
    try { return JSON.parse((cut === -1 ? text : text.slice(0, cut)).trim()); }
    catch (e) { return undefined; }
  }
  function rowsOf(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return Array.isArray(v.items) ? v.items : [v];
    return [];
  }
  function cell(key, v) {
    if (v === null || v === undefined) return "";
    if ((key === "_creationTime" || key === "createdAt") && typeof v === "number") {
      return new Date(v).toISOString();
    }
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  function show(n) { root.replaceChildren(n); sizeChanged(); }
  function sizeChanged() {
    var d = document.documentElement;
    if (d && typeof d.scrollHeight === "number") {
      notify("ui/notifications/size-changed", { width: d.scrollWidth, height: d.scrollHeight });
    }
  }
  function render(result) {
    if (result && result.isError) return show(node("p", "vp-error", firstText(result) || "The tool call failed."));
    var payload = payloadOf(result);
    if (payload === undefined) return show(node("pre", "vp-raw", firstText(result)));
    if (payload && payload.refused === true) {
      return show(node("p", "vp-error", "REFUSED (RBAC_DENIED): the server declined to serve this caller. This is not an empty result."));
    }
    var rows = rowsOf(payload);
    if (rows.length === 0) return show(node("p", "vp-empty", "No results."));
    var wrap = node("div", "vp-app");
    var table = node("table");
    var head = node("tr");
    for (var h = 0; h < CFG.columns.length; h++) {
      var th = node("th", "", CFG.columns[h][1]);
      th.setAttribute("scope", "col");
      head.appendChild(th);
    }
    var thead = node("thead"); thead.appendChild(head); table.appendChild(thead);
    var tbody = node("tbody");
    for (var r = 0; r < rows.length; r++) {
      var tr = node("tr");
      for (var c = 0; c < CFG.columns.length; c++) {
        var key = CFG.columns[c][0];
        tr.appendChild(node("td", "vp-col-" + key, cell(key, rows[r] && rows[r][key])));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    wrap.appendChild(node("p", "vp-count", rows.length + (rows.length === 1 ? " row" : " rows")));
    show(wrap);
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== host) return;
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined) {
      if (m.id !== undefined && m.id === initId) notify("ui/notifications/initialized", {});
      return;
    }
    if (m.method === "ui/notifications/tool-result") return render(m.params || {});
    if (m.id === undefined) return;
    if (m.method === "ui/resource-teardown" || m.method === "ping") return send({ id: m.id, result: {} });
    send({ id: m.id, error: { code: -32601, message: "Method not found" } });
  });

  initId = nextId++;
  send({ id: initId, method: "ui/initialize", params: {
    appInfo: { name: "vantage-peers-" + CFG.primitive, version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: CFG.protocolVersion
  } });
})();`;

const APP_STYLE = `
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #1f2328; background: transparent; }
  #vp-app-root { padding: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 6px 10px; border-bottom: 1px solid #d0d7de; font-weight: 600; background: #f6f8fa; }
  td { padding: 6px 10px; border-bottom: 1px solid #eaeef2; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; }
  .vp-count, .vp-empty { color: #656d76; font-size: 12px; margin: 8px 0 0; }
  .vp-error { color: #cf222e; margin: 0; }
  .vp-raw { white-space: pre-wrap; margin: 0; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6edf3; }
    th { background: #161b22; border-bottom-color: #30363d; }
    td { border-bottom-color: #21262d; }
    .vp-count, .vp-empty { color: #8d96a0; }
    .vp-error { color: #ff7b72; }
  }`;

/** The MCP App document for one primitive. Static: no data, no network. */
export function renderUiAppHtml(primitive: Primitive): string {
	// A JSON literal spliced into the script; `<` is escaped so no value can
	// close the script element early.
	const config = JSON.stringify({
		primitive,
		protocolVersion: MCP_APPS_PROTOCOL_VERSION,
		columns: COLUMNS[primitive],
	}).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLES[primitive]}</title>
<style>${APP_STYLE}
</style>
</head>
<body>
<div id="vp-app-root" role="region" aria-label="${TITLES[primitive]}" aria-live="polite">Waiting for the tool result.</div>
<script>${APP_SCRIPT.replace("__VP_APP_CONFIG__", () => config)}</script>
</body>
</html>`;
}

/**
 * Register one static MCP App resource per linked primitive. Called from
 * registerTools, so wherever a linked tool is registered (HTTP and stdio), the
 * URI it names resolves on the same server.
 */
export function registerUiAppResources(server: McpServer): void {
	// A real McpServer always has registerResource. Unit-test doubles that
	// capture tool registrations only (`{ registerTool }`) have no resource
	// surface to serve, so there is nothing to register on them.
	if (typeof (server as Partial<McpServer>).registerResource !== "function") {
		return;
	}
	const primitives = [...new Set(Object.values(UI_APP_TOOL_LINKS))];
	for (const primitive of primitives) {
		const uri = uiAppUri(primitive);
		const meta = { ui: { prefersBorder: true } };
		server.registerResource(
			`vp-app-${primitive}`,
			uri,
			{
				title: TITLES[primitive],
				description: `MCP App rendering a VantagePeers tool result as ${primitive}. Static document; the rows come from the tool result the host hands it.`,
				mimeType: MCP_UI_MIME_TYPE,
				_meta: meta,
			},
			async () => ({
				contents: [
					{
						uri,
						mimeType: MCP_UI_MIME_TYPE,
						text: renderUiAppHtml(primitive),
						_meta: meta,
					},
				],
			}),
		);
	}
}
