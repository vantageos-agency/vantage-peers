/**
 * Output schemas tolerate added fields (task k17e9sx6e8wd951b47wvm0p5qn8hampb).
 *
 * A client validates `structuredContent` against the outputSchema it read from
 * tools/list when it connected. After the 2026-10-31 ship, every connection
 * opened BEFORE it rejected whoami ("data must NOT have additional properties"):
 * the new fields were refused by the old schema's `additionalProperties: false`.
 * A published object schema therefore never closes itself: an added field must
 * validate against every schema already in a client's hands.
 *
 * Runs the REAL McpServer through an in-memory transport and reads the served
 * schemas, as a remote client sees them.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

async function servedTools() {
	const server = new McpServer({ name: "t", version: "0.0.0" });
	const convex = {
		query: async () => null,
		mutation: async () => null,
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, {
		clientId: "m",
		userId: "m",
		scopes: [],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3600_000,
		isMaster: true,
	} as OAuthContext);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

/** Every path inside `schema` where an object schema closes itself. */
function closedObjects(schema: unknown, path: string, out: string[]): void {
	if (schema === null || typeof schema !== "object") return;
	const node = schema as Record<string, unknown>;
	if (node.additionalProperties === false) out.push(path);
	for (const [key, value] of Object.entries(node)) {
		if (Array.isArray(value)) {
			value.forEach((v, i) => closedObjects(v, `${path}.${key}[${i}]`, out));
		} else if (value !== null && typeof value === "object") {
			closedObjects(value, `${path}.${key}`, out);
		}
	}
}

describe("output schemas are open to added fields", () => {
	it("no served outputSchema contains additionalProperties: false, at any depth", async () => {
		const tools = await servedTools();
		const closed: string[] = [];
		for (const t of tools) {
			if (t.outputSchema) closedObjects(t.outputSchema, t.name, closed);
		}
		expect(closed).toEqual([]);
	});

	it("whoami's outputSchema admits an extra top-level and an extra actor field", async () => {
		const tools = await servedTools();
		const schema = tools.find((t) => t.name === "whoami")?.outputSchema as {
			additionalProperties?: unknown;
			properties: { actor: { anyOf?: Array<{ additionalProperties?: unknown }> } };
		};
		expect(schema.additionalProperties).not.toBe(false);
		for (const branch of schema.properties.actor.anyOf ?? []) {
			expect(branch.additionalProperties).not.toBe(false);
		}
	});
});
