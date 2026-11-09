/**
 * An invalid cursor on a protocol list method is -32602 Invalid params.
 * VantagePeers Cloud (HTTP /mcp entry) and the stdio entry: both build their
 * server through registerTools. Task k171rk9evy8yy48tfx765zqwk18hwdvh
 * (mcp-doctor C11).
 *
 * MCP 2025-06-18, utilities/pagination, "Error Handling": "Invalid cursors
 * SHOULD result in an error with code -32602 (Invalid params)."
 *
 * tools/list, resources/list and resources/templates/list are served whole:
 * the SDK never returns a nextCursor for them, so this server has never issued
 * a cursor for those methods and every cursor a client sends there is invalid.
 * Before this fix the SDK ignored the cursor and answered with the full list,
 * a silent page indistinguishable from a real one.
 *
 * Poles, per method: an unparseable cursor and a well-formed but never-issued
 * cursor are refused with -32602; a request with no cursor still answers the
 * whole list, and that answer carries no nextCursor (so no valid cursor exists
 * to page with).
 *
 * The server is built the way server-http.ts's buildServer builds it:
 * registerTools, then registerUiResources, on one McpServer.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { encodeCursor } from "../src/paging.js";
import { registerTools } from "../src/tools.js";
import { registerUiResources } from "../src/ui-resources/register.js";

const INVALID_PARAMS = -32602;

/** A backend that answers nothing: the list methods read no row. */
function nullConvex(): ConvexHttpClient {
	const call = async () => null;
	return {
		query: call,
		mutation: call,
		action: call,
		setAuth: () => undefined,
	} as unknown as ConvexHttpClient;
}

/** A non-master OAuth seat, the caller the doctor probed with. */
const SEAT: OAuthContext = {
	clientId: "claude-ai-connector",
	userId: "alice",
	scopes: ["vantage:read"],
	scopeProfile: "team-member",
	fromAllowList: ["alice"],
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
	accessTokenHash: "a".repeat(64),
	clerkOrgSlug: "org-a",
	orgClerkId: "org_AAAA",
};

async function connect(): Promise<Client> {
	const convex = nullConvex();
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerTools(server, convex, SEAT);
	registerUiResources(server, convex, SEAT, {
		master: false,
		callerIdentities: SEAT.fromAllowList,
	});
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	return client;
}

const INVALID_CURSORS: ReadonlyArray<[string, string]> = [
	["unparseable", "%%%not-a-cursor%%%"],
	["well-formed but never issued", encodeCursor({ createdBefore: 1 })],
];

type Lister = (
	client: Client,
	cursor: string | undefined,
) => Promise<{ nextCursor?: string; items: unknown[] }>;

const METHODS: ReadonlyArray<[string, Lister]> = [
	[
		"tools/list",
		async (c, cursor) => {
			const r = await c.listTools(cursor === undefined ? {} : { cursor });
			return { nextCursor: r.nextCursor, items: r.tools };
		},
	],
	[
		"resources/list",
		async (c, cursor) => {
			const r = await c.listResources(cursor === undefined ? {} : { cursor });
			return { nextCursor: r.nextCursor, items: r.resources };
		},
	],
	[
		"resources/templates/list",
		async (c, cursor) => {
			const r = await c.listResourceTemplates(
				cursor === undefined ? {} : { cursor },
			);
			return { nextCursor: r.nextCursor, items: r.resourceTemplates };
		},
	],
];

describe("protocol list methods refuse a cursor this server never issued (C11)", () => {
	for (const [method, list] of METHODS) {
		for (const [label, cursor] of INVALID_CURSORS) {
			it(`${method}: a ${label} cursor is -32602 Invalid params, not a silent page`, async () => {
				const client = await connect();
				await expect(list(client, cursor)).rejects.toMatchObject({
					code: INVALID_PARAMS,
				});
			});
		}

		it(`${method}: no cursor still answers the whole list, with no nextCursor`, async () => {
			const client = await connect();
			const page = await list(client, undefined);
			expect(page.items.length).toBeGreaterThan(0);
			expect(page.nextCursor).toBeUndefined();
		});
	}
});
