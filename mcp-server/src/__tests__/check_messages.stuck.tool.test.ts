/**
 * check_messages — stuckInProgress / peersStuckOnYou reader
 * (task k176w8hfeaxq07z500qk71xc2d8cw334, Day-156 reader-first).
 *
 * Convex checkNewMessagesEnvelope returns stuckInProgress /
 * peersStuckOnYou as any of:
 *   - missing / null / undefined (old Convex prod) → empty
 *   - Array<{taskId, title, age}> (already-deployed MCP)
 *   - { entries, total, truncated } (new capped Convex)
 * The MCP reader must:
 *   - never throw .length on a missing key (defaulting, not a raw ?? [])
 *   - treat entries.length > 0 OR truncated === true as a stuck SIGNAL
 *   - never emit "No new messages." / "Vide" when a stuck SIGNAL is present
 *   - not revive pendingOnYou
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { asCappedStuckList, registerTools } from "../tools.js";

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

describe("asCappedStuckList", () => {
	it("missing / null / undefined → empty, no throw", () => {
		expect(asCappedStuckList(undefined)).toEqual({
			entries: [],
			total: 0,
			truncated: false,
		});
		expect(asCappedStuckList(null)).toEqual({
			entries: [],
			total: 0,
			truncated: false,
		});
	});

	it("array shape → entries + total=length + truncated false", () => {
		expect(asCappedStuckList([STUCK_ENTRY])).toEqual({
			entries: [STUCK_ENTRY],
			total: 1,
			truncated: false,
		});
	});

	it("object shape is passed through", () => {
		expect(
			asCappedStuckList({
				entries: [STUCK_ENTRY],
				total: 1,
				truncated: false,
			}),
		).toEqual({
			entries: [STUCK_ENTRY],
			total: 1,
			truncated: false,
		});
	});

	it("object truncated with empty entries is still a cap signal", () => {
		expect(
			asCappedStuckList({ entries: [], total: 0, truncated: true }),
		).toEqual({ entries: [], total: 0, truncated: true });
	});

	it("junk / non-object → empty, no throw", () => {
		expect(asCappedStuckList("nope")).toEqual({
			entries: [],
			total: 0,
			truncated: false,
		});
		expect(asCappedStuckList(42)).toEqual({
			entries: [],
			total: 0,
			truncated: false,
		});
	});
});

describe("check_messages stuckInProgress / peersStuckOnYou reader", () => {
	it("source defaults stuck lists via asCappedStuckList (never .length on undefined)", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(resolve(here, "../tools.ts"), "utf8");
		expect(src).toContain("stuckInProgress");
		expect(src).toContain("peersStuckOnYou");
		expect(src).toContain("asCappedStuckList");
		expect(src).toMatch(/result\s*\?\?\s*\{\s*\}/);
		expect(src).toMatch(/asCappedStuckList\(\s*envelope\.stuckInProgress\s*\)/);
		expect(src).toMatch(/asCappedStuckList\(\s*envelope\.peersStuckOnYou\s*\)/);
		expect(src).not.toMatch(/envelope\.stuckInProgress\.length/);
		expect(src).not.toMatch(/envelope\.peersStuckOnYou\.length/);
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

	it("object shape {entries,total,truncated} + empty unread renders stuck block, not Vide", async () => {
		const { text, isError } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: {
				entries: [STUCK_ENTRY],
				total: 1,
				truncated: false,
			},
			peersStuckOnYou: { entries: [], total: 0, truncated: false },
		});

		expect(isError).not.toBe(true);
		expect(text).toContain("stuckInProgress");
		expect(text).toContain(STUCK_ENTRY.taskId);
		expect(text).toContain(STUCK_ENTRY.title);
		expect(text).toContain('"total": 1');
		expect(text).toContain('"truncated": false');
		expect(text).not.toMatch(/No new messages/i);
		expect(text).not.toMatch(/\bVide\b/i);
	});

	it("object shape peersStuckOnYou + empty unread renders peers block, not Vide", async () => {
		const { text, isError } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: { entries: [], total: 0, truncated: false },
			peersStuckOnYou: {
				entries: [PEER_ENTRY],
				total: 1,
				truncated: false,
			},
		});

		expect(isError).not.toBe(true);
		expect(text).toContain("peersStuckOnYou");
		expect(text).toContain(PEER_ENTRY.taskId);
		expect(text).toContain('"total": 1');
		expect(text).not.toMatch(/No new messages/i);
		expect(text).not.toMatch(/\bVide\b/i);
	});

	it("empty entries + truncated true + empty unread prints truncated flag, not No new messages / Vide", async () => {
		const { text, isError } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: { entries: [], total: 0, truncated: true },
			peersStuckOnYou: { entries: [], total: 0, truncated: false },
		});

		expect(isError).not.toBe(true);
		expect(text).toContain("stuckInProgress");
		expect(text).toContain('"entries": []');
		expect(text).toContain('"truncated": true');
		expect(text).not.toMatch(/No new messages/i);
		expect(text).not.toMatch(/\bVide\b/i);
	});

	it("Day-156: stuck keys present but null do not throw .length", async () => {
		const { text, isError } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: null,
			peersStuckOnYou: null,
		});

		expect(isError).not.toBe(true);
		expect(text).toBe("No new messages.");
	});

	it("empty entries + truncated false + no unread still says No new messages.", async () => {
		const { text } = await callCheckMessages({
			messages: [],
			truncated: false,
			nextSince: null,
			staleInProgress: [],
			stuckInProgress: { entries: [], total: 0, truncated: false },
			peersStuckOnYou: { entries: [], total: 0, truncated: false },
		});
		expect(text).toBe("No new messages.");
	});
});
