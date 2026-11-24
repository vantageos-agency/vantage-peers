/**
 * A list tool refuses a backend reply that breaks its `returns:` contract
 * (task k170nqga06wj4268dg9rfkdk958jvm8s, VantagePeers Cloud + Self-host).
 *
 * Class: a non-array reply (null, an object that is not the refusal envelope)
 * read as an empty list by `Array.isArray(x) ? x : []` or `x ?? []`. Each tool
 * below now answers `BACKEND_SHAPE_MISMATCH`; a well-formed empty reply still
 * returns an empty list (the other pole). The census at the bottom derives the
 * tool set from the source, so a new defaulting site is a failing test.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const MASTER: OAuthContext = {
	clientId: "client-master",
	userId: "user-master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "p",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: true,
	accessTokenHash: "hash-master",
};

type Handler = (args: Record<string, unknown>) => Promise<{
	isError?: boolean;
	content?: Array<{ text?: string }>;
}>;

async function call(tool: string, args: Record<string, unknown>, reply: unknown) {
	const handlers = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const server = { tool: reg, registerTool: reg } as unknown as McpServer;
	const make = () => vi.fn(async () => reply);
	const client = { query: make(), mutation: make(), action: make() };
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, client as any, MASTER);
	const h = handlers.get(tool);
	if (!h) throw new Error(`${tool} was not registered`);
	const r = await h(args);
	return { isError: r.isError === true, text: r.content?.[0]?.text ?? "" };
}

const MISSION = "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAGE_EMPTY = { value: [], continueCursor: null, isDone: true };

// tool, args, the well-formed EMPTY reply.
const CASES: Array<[string, Record<string, unknown>, unknown]> = [
	["list_peers", {}, []],
	["list_messages", { recipient: "dedale" }, []],
	["search_messages_by_keyword", { query: "x" }, []],
	["list_tasks", {}, []],
	["list_tasks", { assignedTo: "dedale" }, []],
	["search_tasks_by_keyword", { query: "x" }, []],
	["list_tasks_by_mission", { missionId: MISSION }, []],
	["list_missions", {}, []],
	["list_briefing_notes", {}, []],
	["search_briefing_notes_by_keyword", { query: "x" }, []],
	["list_recurring_tasks", {}, []],
	["list_mandates", {}, []],
	["list_issues", {}, []],
	["search_fix_patterns", { query: "x" }, []],
	["list_fix_patterns", {}, []],
	["list_fix_patterns", { project: "p" }, []],
	["list_errors", {}, []],
	["get_tool_usage", {}, []],
	["get_owner_tool_usage", { ownerUserId: "u" }, []],
	["list_blocked_on_me", {}, { entries: [], total: 0 }],
	["list_diaries", {}, []],
	["list_diaries", {}, { partial: true, items: [], nextCreatedBefore: 1 }],
	["list_bus", {}, []],
	["list_bus", {}, { items: [], nextCursor: null }],
	["list_repo_mappings", {}, []],
	["list_repo_mappings", {}, { items: [], nextCursor: null }],
	["get_github_owner_bindings", {}, { items: [], nextCursor: null }],
	["list_episodes", {}, PAGE_EMPTY],
	["list_memories", {}, PAGE_EMPTY],
];

describe("a broken list reply is refused, never read as an empty list", () => {
	for (const [tool, args, empty] of CASES) {
		const label = `${tool} ${JSON.stringify(args)}`;
		for (const [what, bad] of [
			["null", null],
			["a shapeless object", { oops: 1 }],
			["a string", "oops"],
			["an envelope whose items is not an array", { items: "oops", nextCursor: null }],
		] as const) {
			it(`${label}: ${what} -> BACKEND_SHAPE_MISMATCH`, async () => {
				const r = await call(tool, args, bad);
				expect(r.isError, r.text).toBe(true);
				expect(r.text).toContain("BACKEND_SHAPE_MISMATCH");
				expect(r.text).toContain(tool);
				expect(r.text).toContain("does not match its contract");
			});
		}
		it(`${label}: a well-formed empty reply is still an empty list`, async () => {
			const r = await call(tool, args, empty);
			expect(r.isError, r.text).toBe(false);
			expect(r.text).not.toContain("BACKEND_SHAPE_MISMATCH");
		});
	}
});

describe("get_github_owner_bindings takes the envelope only", () => {
	it("a bare array is refused (its door returns { items, nextCursor })", async () => {
		const r = await call("get_github_owner_bindings", {}, []);
		expect(r.isError).toBe(true);
		expect(r.text).toContain("BACKEND_SHAPE_MISMATCH");
	});
});

describe("census: no Convex list reply is defaulted to an empty array", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const src = readFileSync(join(here, "..", "src", "tools.ts"), "utf8");
	// Form 1: `Array.isArray(x) ? x : []` (also with an `as` cast on the true arm).
	const FORM_COND = /Array\.isArray\(([\w.]+)\)\s*\?\s*(?:\()?\1(?:\s+as\s+[^:]+?\))?\s*:\s*\[\]/g;
	// Form 2: a reply coalesced with `?? []` (a call result or a bound reply).
	const FORM_COALESCE = /\b(?:rows|results|result|reply|replies|envelope|tasks|messages|profiles|missions|notes|mandates|errors)\s*\?\?\s*\[\]/g;
	const code = src
		.split("\n")
		.map((l, i) => [i + 1, l.trim()] as const)
		.filter(([, l]) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
	const hits = (re: RegExp) =>
		code.filter(([, l]) => new RegExp(re.source).test(l)).map(([, l]) => l);

	it("`Array.isArray(x) ? x : []` survives only in capListResponse (a presentation helper)", () => {
		// capListResponse takes an already-read `items` argument, not a raw Convex reply.
		expect(hits(FORM_COND)).toEqual(["shown: Array.isArray(items) ? items : [],"]);
	});

	it("`<reply> ?? []` survives only in capPage's own rows and check_messages' declared compat read", () => {
		// capPage: `rows` is the helper's own derived array. check_messages: the
		// day-156 reader-first read, which must tolerate an older backend envelope.
		expect(hits(FORM_COALESCE)).toEqual([
			"shown: rows ?? [],",
			"const messages = envelope.messages ?? [];",
		]);
	});

	it("positive control: the census patterns do match the shapes they are named for", () => {
		expect(new RegExp(FORM_COND.source).test("const a = Array.isArray(x) ? x : [];")).toBe(true);
		expect(new RegExp(FORM_COALESCE.source).test("capPage(rows ?? [], 'x')")).toBe(true);
	});
});
