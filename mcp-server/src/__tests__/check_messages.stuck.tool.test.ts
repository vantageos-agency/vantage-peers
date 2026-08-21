/**
 * check_messages — stuckInProgress / peersStuckOnYou reader
 * (task k176w8hfeaxq07z500qk71xc2d8cw334, Day-156 reader-first).
 *
 * Convex checkNewMessagesEnvelope now returns stuckInProgress and
 * peersStuckOnYou (same {taskId, title, age} shape as staleInProgress).
 * The MCP reader must:
 *   - default missing keys to [] (old Convex prod must not throw .length)
 *   - render either array when non-empty, even if unread messages is empty
 *   - never emit "No new messages." / "Vide" when a stuck block is present
 *   - not revive pendingOnYou
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}>;

function buildFakeServer(): {
	server: McpServer;
	handlers: Map<string, ToolHandler>;
} {
	const handlers = new Map<string, ToolHandler>();
	const fakeServer = {
		tool(...args: unknown[]): unknown {
			const name = args[0] as string;
			const handler = args[args.length - 1] as ToolHandler;
			handlers.set(name, handler);
			return {};
		},
		registerTool(...args: unknown[]): unknown {
			const name = args[0] as string;
			const handler = args[args.length - 1] as ToolHandler;
			handlers.set(name, handler);
			return {};
		},
	} as unknown as McpServer;
	return { server: fakeServer, handlers };
}

const masterCtx: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

const STUCK_ENTRY = {
	taskId: "k176w8hfeaxq07z500qk71xc2d8cw334",
	title: "T4 stuck in minutes, not 24h",
	age: 5 * 60 * 1000,
};

const PEER_ENTRY = {
	taskId: "k176w8hfeaxq07z500qk71xc2d8cw335",
	title: "peer stuck on coordinator",
	age: 12 * 60 * 1000,
};

const UNREAD_MESSAGE = {
	receiptId: "j57dy3049btafda9m2f5d2ggk987ph3f",
	from: "pi",
	content: "hello",
	createdAt: 1_700_000_000_000,
};

function buildMockConvex(response: unknown): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue(response),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

async function callCheckMessages(
	envelope: unknown,
): Promise<{ text: string; isError?: boolean }> {
	const { server, handlers } = buildFakeServer();
	registerTools(server, buildMockConvex(envelope), masterCtx);
	const handler = handlers.get("check_messages");
	if (!handler) throw new Error("check_messages was not registered");
	const result = await handler({ recipient: "sigma" });
	return { text: result.content[0]?.text ?? "", isError: result.isError };
}

describe("check_messages stuckInProgress / peersStuckOnYou reader", () => {
	it("source wires stuckInProgress and peersStuckOnYou with ?? []", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(resolve(here, "../tools.ts"), "utf8");
		expect(src).toContain("stuckInProgress");
		expect(src).toContain("peersStuckOnYou");
		expect(src).toMatch(/stuckInProgress\s*\?\?\s*\[\]/);
		expect(src).toMatch(/peersStuckOnYou\s*\?\?\s*\[\]/);
	});

	it("empty unread + stuckInProgress renders the stuck block, not No new messages / Vide", async () => {
		const { text, isError } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: [STUCK_ENTRY],
			peersStuckOnYou: [],
		});

		expect(isError).not.toBe(true);
		expect(text).toContain("stuckInProgress");
		expect(text).toContain(STUCK_ENTRY.taskId);
		expect(text).toContain(STUCK_ENTRY.title);
		expect(text).not.toMatch(/No new messages/i);
		expect(text).not.toMatch(/\bVide\b/i);
	});

	it("empty unread + peersStuckOnYou renders the peers block, not No new messages / Vide", async () => {
		const { text, isError } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: [],
			peersStuckOnYou: [PEER_ENTRY],
		});

		expect(isError).not.toBe(true);
		expect(text).toContain("peersStuckOnYou");
		expect(text).toContain(PEER_ENTRY.taskId);
		expect(text).not.toMatch(/No new messages/i);
		expect(text).not.toMatch(/\bVide\b/i);
	});

	it("unread messages + stuck arrays append the stuck blocks after the payload", async () => {
		const { text, isError } = await callCheckMessages({
			messages: [UNREAD_MESSAGE],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: [STUCK_ENTRY],
			peersStuckOnYou: [PEER_ENTRY],
		});

		expect(isError).not.toBe(true);
		expect(text).toContain(UNREAD_MESSAGE.receiptId);
		expect(text).toContain("stuckInProgress");
		expect(text).toContain(STUCK_ENTRY.taskId);
		expect(text).toContain("peersStuckOnYou");
		expect(text).toContain(PEER_ENTRY.taskId);
		expect(text.indexOf(UNREAD_MESSAGE.receiptId)).toBeLessThan(
			text.indexOf("stuckInProgress"),
		);
	});

	it("Day-156: old Convex envelope missing stuck keys does not throw .length", async () => {
		const { text, isError } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
		});

		expect(isError).not.toBe(true);
		expect(text).toBe("No new messages.");
	});

	it("Day-156: stuck keys present but undefined do not throw .length", async () => {
		const { text, isError } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: undefined,
			peersStuckOnYou: undefined,
		});

		expect(isError).not.toBe(true);
		expect(text).toBe("No new messages.");
	});

	it("empty unread and empty stuck arrays still say No new messages.", async () => {
		const { text } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: [],
			peersStuckOnYou: [],
		});
		expect(text).toBe("No new messages.");
	});

	it("does not revive pendingOnYou even if the envelope still carries it", async () => {
		const { text } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: [STUCK_ENTRY],
			peersStuckOnYou: [],
			pendingOnYou: [
				{
					taskId: "k17c4ejer172fgj9t1h027hswn8bvv4w",
					title: "should not surface",
					assignee: "sigma",
					age: 1,
				},
			],
			pendingOnYouTotal: 1,
			slaBreachedTop: [],
		});

		expect(text).toContain("stuckInProgress");
		expect(text).not.toContain("pendingOnYou");
		expect(text).not.toContain("should not surface");
		expect(text).not.toContain("slaBreached");
	});
});
