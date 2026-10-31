/**
 * Status filters are published in ONE shape (task k179shtbbwr3dfztebzrbee9nn8hb79c,
 * standard S-43): an array of one or more status tokens. A bare string, an
 * alias, or a JSON-string list is normalised to that array before validation;
 * the backend still receives what it receives today (a single status or alias
 * as a string, several statuses as an array).
 *
 * Runs the REAL McpServer through an in-memory transport, so the SDK applies
 * the declared input schema exactly as it does for a remote client.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

const MISSION = "k5774cayct61qh9xwgnh662w158h5ya7";

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
	registerTools(server, convex, masterCtx());
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	return { client, queries };
}

const TOOLS = [
	["list_tasks", {}],
	["list_tasks_by_mission", { missionId: MISSION }],
	["list_missions", {}],
] as const;

describe("status filters: one published shape", () => {
	for (const [tool] of TOOLS) {
		it(`${tool}.status is advertised as an array, never an anyOf/oneOf union`, async () => {
			const { client } = await harness();
			const { tools } = await client.listTools();
			await client.close();
			const prop = (
				tools.find((t) => t.name === tool)?.inputSchema.properties as Record<
					string,
					Record<string, unknown>
				>
			).status;
			expect(prop.anyOf).toBeUndefined();
			expect(prop.oneOf).toBeUndefined();
			expect(prop.type).toBe("array");
		});
	}
});

describe("list_tasks: every call form the backend receives as today", () => {
	async function sentStatus(status: unknown) {
		const { client, queries } = await harness();
		const res = await client.callTool({
			name: "list_tasks",
			arguments: { status },
		});
		await client.close();
		return { res, sent: queries.find((q) => q.name.startsWith("tasks:"))?.args.status };
	}

	it('an alias as a bare string ("open") reaches the backend as "open"', async () => {
		const { res, sent } = await sentStatus("open");
		expect(res.isError).toBeFalsy();
		expect(sent).toBe("open");
	});

	it('an alias as a list of one (["open"]) reaches the backend as "open"', async () => {
		const { res, sent } = await sentStatus(["open"]);
		expect(res.isError).toBeFalsy();
		expect(sent).toBe("open");
	});

	it('a list (["todo","in_progress"]) reaches the backend as that list', async () => {
		const { res, sent } = await sentStatus(["todo", "in_progress"]);
		expect(res.isError).toBeFalsy();
		expect(sent).toEqual(["todo", "in_progress"]);
	});

	it("a JSON-string list reaches the backend as the list", async () => {
		const { res, sent } = await sentStatus('["todo"]');
		expect(res.isError).toBeFalsy();
		expect(sent).toBe("todo");
	});

	it("an alias mixed with other tokens is refused with a message naming the rule", async () => {
		const { res, sent } = await sentStatus(["open", "todo"]);
		expect(res.isError).toBe(true);
		expect(JSON.stringify(res.content)).toMatch(/alias/i);
		expect(sent).toBeUndefined();
	});

	it("an empty list is refused", async () => {
		const { res, sent } = await sentStatus([]);
		expect(res.isError).toBe(true);
		expect(sent).toBeUndefined();
	});
});
