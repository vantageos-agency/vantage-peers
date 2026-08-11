#!/usr/bin/env node
// Runs in a SEPARATE child process (spawned by tool-exposure.test.ts) so the
// node:module register() ESM loader hook actually intercepts the dynamic
// import() of the built dist/server.js bundle — vitest's vite-node SSR
// transform rewrites dynamic import() inside test files and bypasses native
// Node loader hooks, so this must run outside vite-node entirely.
//
// Prints one JSON line to stdout: the sorted array of every tool name the
// stub McpServer#tool recorded during module-top-level registerTools() call
// inside dist/server.ts (stdio entry point — no Bun.serve() side effects).
// A registration-time throw (e.g. an unknown core name in tool-exposure.json)
// propagates as an uncaught error and a non-zero exit code, with the message
// on stderr — the caller (spawnSync) reads exit code + stderr.
//
// Ported from vantage-registry/mcp-server/tests/support/dump-tool-names.mjs.
import { register } from "node:module";

const HERE = new URL(".", import.meta.url);
const LOADER_URL = new URL("./mcp-stub-loader.mjs", HERE);
const SERVER_JS = new URL("../../dist/server.js", HERE);

register(LOADER_URL, HERE);

// dist/server.js's loadConvexUrl() exits the process if CONVEX_URL is unset.
// The dump never touches the network (ConvexHttpClient is stubbed above), so
// any placeholder value satisfies the bootstrap check.
process.env.CONVEX_URL ??= "https://stub.convex.cloud";

globalThis.__VP_TOOLS__ = [];
await import(SERVER_JS.href);

// Only ENABLED tools are advertised — mirrors the real SDK's tools/list
// handler (server/mcp.js: `.filter(([, tool]) => tool.enabled)`). A
// non-CORE tool is registered (present in __VP_TOOLS__) but disabled by the
// tool-exposure filter, so it is excluded here exactly as a real client
// would never see it in tools/list.
const names = globalThis.__VP_TOOLS__.filter((t) => t.enabled)
	.map((t) => t.name)
	.sort();
process.stdout.write(JSON.stringify(names));
