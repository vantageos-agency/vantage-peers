/**
 * What the public Server Card says about the server's surface (mcp-doctor
 * S-50, served discovery): the `capabilities` initialize declares and the
 * names tools/list serves. VantagePeers Cloud (HTTP entry, server-http.ts).
 *
 * One source: both are READ from a server built by the same factory the /mcp
 * route uses, by asking it `initialize` then `tools/list` over an in-process
 * transport. Nothing here keeps a list of its own, so the card cannot drift
 * from what a connected client is served.
 *
 * Disclosure: tool NAMES only, the minimal tool summary. No input schema, no
 * description, nothing caller- or tenant-specific: the advertised tool set is
 * the CORE allowlist (tool-exposure.json), identical for every caller, and the
 * server read here is built with no caller at all.
 */

import {
	InMemoryTransport,
	LATEST_PROTOCOL_VERSION,
	type McpServer,
	type ServerCapabilities,
} from "@modelcontextprotocol/server";

export type ServedDiscovery = {
	capabilities: ServerCapabilities;
	tools: string[];
};

type JsonRpcResponse = {
	jsonrpc: "2.0";
	id?: number | string;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

/** Bound on the whole in-process read; a hang is a failure, never a card. */
const READ_TIMEOUT_MS = 10_000;

/**
 * Ask `server` (fresh, not yet connected) what initialize declares and what
 * tools/list serves, following every page. Throws on any error response: a
 * card is never served with a guessed surface.
 */
export async function readServedDiscovery(
	server: McpServer,
): Promise<ServedDiscovery> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const pending = new Map<number, (r: JsonRpcResponse) => void>();
	clientSide.onmessage = (message) => {
		const m = message as JsonRpcResponse;
		if (typeof m.id === "number") pending.get(m.id)?.(m);
	};
	let nextId = 0;
	const request = (
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`server discovery: ${method} timed out`)),
				READ_TIMEOUT_MS,
			);
			pending.set(id, (r) => {
				clearTimeout(timer);
				pending.delete(id);
				if (r.error || !r.result) {
					reject(
						new Error(
							`server discovery: ${method} failed: ${r.error?.message ?? "no result"}`,
						),
					);
				} else {
					resolve(r.result);
				}
			});
			clientSide
				.send({ jsonrpc: "2.0", id, method, params })
				.catch((err: unknown) => {
					clearTimeout(timer);
					reject(err);
				});
		});
	};

	await server.connect(serverSide);
	await clientSide.start();
	try {
		const init = await request("initialize", {
			protocolVersion: LATEST_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "vantage-peers-server-card", version: "0" },
		});
		await clientSide.send({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		const tools: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await request("tools/list", cursor ? { cursor } : {});
			for (const tool of (page.tools ?? []) as Array<{ name: string }>) {
				tools.push(tool.name);
			}
			cursor =
				typeof page.nextCursor === "string" ? page.nextCursor : undefined;
		} while (cursor);
		return {
			capabilities: (init.capabilities ?? {}) as ServerCapabilities,
			tools,
		};
	} finally {
		await server.close();
	}
}
