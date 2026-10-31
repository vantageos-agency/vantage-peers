/**
 * mark_as_read accepts a list of receipt IDs from every client (task
 * k172pt7ync7d6vw8a5gc7h03098hb7b7). Hélios on Claude.ai could only mark one
 * receipt per call: `receiptIds` was advertised as anyOf [array, string], and a
 * client that serialises the list as a JSON string failed the 32-char pattern
 * before the handler's own JSON.parse branch was ever reached.
 *
 * Runs the REAL McpServer through an in-memory transport, so the SDK applies
 * the declared input schema exactly as it does for a remote client.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

const A = "k97201zt9pa5qae5yagexrz4xh8h8jtx";
const B = "k971rad16grrt0tge1vz59sdnx8hbn8c";

function marieCtx(): OAuthContext {
	return {
		clientId: "client-1",
		userId: "user_3KrDIUId3qN4ANWphSicL6RsSHr",
		scopes: ["mcp:full"],
		scopeProfile: "team-member",
		fromAllowList: ["hélios"],
		namespaceReadPrefixes: ["team/iris-rh"],
		namespaceWritePrefixes: ["team/iris-rh"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		accessTokenHash: "a".repeat(64),
		clerkOrgSlug: "iris-rh",
		principal: "person",
		actor: {
			orgSlug: "iris-rh",
			agentName: "hélios",
			agentId: "r57d7scvxejmb6fbdpxxx32ndn8fcnat",
		},
	};
}

async function harness() {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const convex = {
		query: async () => null,
		mutation: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			return Array.isArray(args.receiptIds) ? args.receiptIds.length : 0;
		},
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerTools(server, convex, marieCtx());
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	return { client, calls };
}

function markCalls(
	calls: Array<{ name: string; args: Record<string, unknown> }>,
) {
	return calls.filter((c) => c.name === "messages:markAsRead");
}

describe("mark_as_read takes a list on every client", () => {
	it("advertises receiptIds as a plain array, no anyOf union", async () => {
		const { client } = await harness();
		const tools = await client.listTools();
		const tool = tools.tools.find((t) => t.name === "mark_as_read");
		const prop = (
			tool?.inputSchema.properties as Record<string, Record<string, unknown>>
		).receiptIds;
		await client.close();
		expect(prop.type).toBe("array");
		expect(prop.anyOf).toBeUndefined();
		expect(prop.oneOf).toBeUndefined();
	});

	it("a list sent as a JSON string (Claude.ai shape) marks every receipt in one call", async () => {
		const { client, calls } = await harness();
		const res = await client.callTool({
			name: "mark_as_read",
			arguments: { receiptIds: JSON.stringify([A, B]) },
		});
		await client.close();
		expect(res.isError).toBeFalsy();
		expect(markCalls(calls)).toHaveLength(1);
		expect(markCalls(calls)[0]?.args.receiptIds).toEqual([A, B]);
	});

	it("a real array still works", async () => {
		const { client, calls } = await harness();
		const res = await client.callTool({
			name: "mark_as_read",
			arguments: { receiptIds: [A, B] },
		});
		await client.close();
		expect(res.isError).toBeFalsy();
		expect(markCalls(calls)[0]?.args.receiptIds).toEqual([A, B]);
	});

	it("a single bare id is a list of one", async () => {
		const { client, calls } = await harness();
		const res = await client.callTool({
			name: "mark_as_read",
			arguments: { receiptIds: A },
		});
		await client.close();
		expect(res.isError).toBeFalsy();
		expect(markCalls(calls)[0]?.args.receiptIds).toEqual([A]);
	});

	it("a malformed id inside the list is refused and nothing is written", async () => {
		const { client, calls } = await harness();
		const res = await client.callTool({
			name: "mark_as_read",
			arguments: { receiptIds: JSON.stringify([A, "not-an-id"]) },
		});
		await client.close();
		expect(res.isError).toBe(true);
		expect(markCalls(calls)).toHaveLength(0);
	});

	it("an empty list is refused", async () => {
		const { client, calls } = await harness();
		const res = await client.callTool({
			name: "mark_as_read",
			arguments: { receiptIds: "[]" },
		});
		await client.close();
		expect(res.isError).toBe(true);
		expect(markCalls(calls)).toHaveLength(0);
	});
});

// The class, swept: a client-filled argument advertised as an anyOf/oneOf union
// is allowed only where each branch carries its own meaning, and each of those
// accepts a list sent as a JSON string (acceptsJsonArrayString, src/listArgs.ts).
const TRACED_UNIONS = new Set([
	// (the three status filters left this set: one shape, statusListSchema)
	// a choice of string constants: every branch is a string a client can send
	"block_task.blockedCause",
	// null = every family, OR a list of type tokens
	"export_okf_bundle.types",
]);

describe("client-filled list arguments, every tool", () => {
	it("no new anyOf/oneOf union on a tool input beyond the traced set", async () => {
		const { client } = await harness();
		const { tools } = await client.listTools();
		await client.close();
		const unions: string[] = [];
		for (const t of tools) {
			const props = (t.inputSchema.properties ?? {}) as Record<
				string,
				Record<string, unknown>
			>;
			for (const [k, v] of Object.entries(props)) {
				if (v.anyOf || v.oneOf) unions.push(`${t.name}.${k}`);
			}
		}
		expect(unions.sort()).toEqual([...TRACED_UNIONS].sort());
	});

	it("list_tasks takes a status list sent as a JSON string", async () => {
		const queries: Array<{ name: string; args: Record<string, unknown> }> = [];
		const convex = {
			query: async (name: string, args: Record<string, unknown>) => {
				queries.push({ name, args });
				return [];
			},
			mutation: async () => null,
			action: async () => null,
		} as unknown as Parameters<typeof registerTools>[1];
		const server = new McpServer({ name: "t", version: "0.0.0" });
		registerTools(server, convex, marieCtx());
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "c", version: "0.0.0" });
		await Promise.all([server.connect(st), client.connect(ct)]);
		const res = await client.callTool({
			name: "list_tasks",
			arguments: { status: JSON.stringify(["todo", "review"]) },
		});
		await client.close();
		expect(res.isError).toBeFalsy();
		const sent = queries.find((q) => q.name.startsWith("tasks:"));
		expect(sent?.args.status).toEqual(["todo", "review"]);
	});

	it("a free-text list (create_briefing_note participants) is a plain array", async () => {
		const { client } = await harness();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "create_briefing_note");
		const prop = (
			tool?.inputSchema.properties as Record<string, Record<string, unknown>>
		).participants;
		expect(prop.type).toBe("array");
	});
});
