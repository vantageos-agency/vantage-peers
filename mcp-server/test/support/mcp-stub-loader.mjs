// Node ESM loader — intercepts the MCP SDK transport modules + ConvexHttpClient
// so importing the built dist/server.js RECORDS every s.tool(name, description,
// schema, ...) call instead of starting a real stdio server or touching the
// network.
//
// Ported from vantage-registry/mcp-server/tests/support/mcp-stub-loader.mjs
// (Omega's registration-point interception pattern, PR #293) for use by
// mcp-server/test/tool-exposure.test.ts.

const STUBS = {
	"@modelcontextprotocol/sdk/server/mcp.js": `
		globalThis.__VP_TOOLS__ = globalThis.__VP_TOOLS__ || [];
		export class McpServer {
			constructor() {}
			tool(name, ...rest) {
				// Mirrors the real SDK's RegisteredTool: enabled by default,
				// disable() flips the flag the dump script filters on — matching
				// server/mcp.js's own \`.filter(([, tool]) => tool.enabled)\`
				// used to build tools/list.
				const entry = { name, enabled: true };
				entry.disable = () => { entry.enabled = false; };
				entry.enable = () => { entry.enabled = true; };
				globalThis.__VP_TOOLS__.push(entry);
				return entry;
			}
			// \`server.registerTool(name, config, handler)\` — the config-object
			// entry point defineTool() uses since the Day-159 boot fix (an
			// already-built strict ZodObject schema instance fails the legacy
			// \`tool()\` overload's raw-shape/annotations disambiguation and
			// crashes registration; see registerTool.ts \`defineTool\` doc
			// comment). Same recording semantics as \`tool()\` above.
			registerTool(name, ...rest) {
				const entry = { name, enabled: true };
				entry.disable = () => { entry.enabled = false; };
				entry.enable = () => { entry.enabled = true; };
				globalThis.__VP_TOOLS__.push(entry);
				return entry;
			}
			async connect() {}
		}
	`,
	"@modelcontextprotocol/sdk/server/stdio.js": `
		export class StdioServerTransport {}
	`,
	"convex/browser": `
		export class ConvexHttpClient {
			constructor() {}
			query() { throw new Error("convex not called at registration"); }
			mutation() { throw new Error("convex not called at registration"); }
			action() { throw new Error("convex not called at registration"); }
		}
	`,
};

export async function resolve(specifier, context, nextResolve) {
	if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) {
		return { url: `vp-stub:${specifier}`, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url.startsWith("vp-stub:")) {
		const specifier = url.slice("vp-stub:".length);
		return { format: "module", source: STUBS[specifier], shortCircuit: true };
	}
	return nextLoad(url, context);
}
