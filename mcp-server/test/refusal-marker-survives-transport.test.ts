/**
 * THE MCP TRANSPORT MUST NOT SWALLOW A REFUSAL.
 *
 * Task k1730ybh4j5dfmq2nkpdsmf7y98fb77a (the far end of k1749w7ecx2yffr1hbhjpk8v858fbrf1).
 *
 * PR #1353 made the backend answer an ORDINARY ORGANISATION MEMBER at the
 * fleet-master-only list reads with `{ refused: true, items: [] }`. The MCP
 * readers did `Array.isArray(x) ? x : []`: the envelope is "not an array", so
 * it became an EMPTY ARRAY and the marker was discarded at the last hop. This is
 * the pre-existing behaviour (mcp-server/src was deliberately untouched by
 * #1353) and not a regression; what changed is that the information now EXISTS
 * one layer down and was thrown away one layer up.
 *
 * An MCP tool result is read by a model AND a human, so "you may not" and
 * "there is nothing" must differ in the TEXT the caller sees. The refusal
 * surfaces as an error result (`isError: true`) whose text opens with
 * `REFUSED (RBAC_DENIED)`, names the tool and the backend door, and says in so
 * many words that it is NOT an empty result. An absence stays a plain `[]`.
 *
 * Every REFUSED pole here is an ORDINARY organisation member's context
 * (`isMaster: false`, a tenant scope) — never master.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";
import { deriveDoors, type Src, sweepCallSites } from "./lib/refusalDoors.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildFakeServer(): {
	server: McpServer;
	handlers: Map<string, ToolHandler>;
} {
	const handlers = new Map<string, ToolHandler>();
	const fake = {
		tool(...args: unknown[]): unknown {
			handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
			return {};
		},
		registerTool(...args: unknown[]): unknown {
			handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
			return {};
		},
	} as unknown as McpServer;
	return { server: fake, handlers };
}

/** The MCP-visible outcome of a call: what the model and the human READ. */
type Seen = { isError: boolean; text: string };

async function call(
	tool: string,
	convexReturns: unknown,
	args: Record<string, unknown> = {},
): Promise<Seen> {
	const { server, handlers } = buildFakeServer();
	const convex = {
		query: vi.fn().mockResolvedValue(convexReturns),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
	registerTools(server, convex, MEMBER);
	const handler = handlers.get(tool);
	if (!handler) throw new Error(`${tool} is not registered`);
	const r = (await handler(args)) as {
		content: Array<{ text: string }>;
		isError?: boolean;
	};
	return { isError: r.isError === true, text: r.content[0].text };
}

/** An ORDINARY member of an organisation — never master. */
const MEMBER: OAuthContext = {
	clientId: "client-fixture-alpha",
	userId: "user-fixture-alpha",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["team/org-fixture-alpha"],
	namespaceWritePrefixes: ["team/org-fixture-alpha"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};

// What convex/mandates.ts and convex/profiles.ts answer an ordinary member with.
const ENVELOPE = { refused: true, items: [] };

const MANDATE = {
	_id: "mandate-fixture-001",
	_creationTime: 1780000002000,
	requestedBy: "alpha",
	fulfilledBy: "beta",
	service: "seo audit",
	budget: 1000,
	status: "in_progress",
};

const PROFILE = {
	_id: "profile-fixture-001",
	_creationTime: 1780000002000,
	orchestratorId: "alpha",
	name: "Alpha",
	static: { role: "infra", workspace: "/x", capabilities: [] },
	dynamic: { lastSeen: 1780000002000, sessionCount: 1 },
};

const BRIEFING_NOTE = {
	_id: "briefing-fixture-001",
	_creationTime: 1780000002000,
	topic: "update",
	title: "Fixture note",
	participants: ["alpha"],
	createdBy: "alpha",
};

const DIARY_ENTRY = {
	_id: "diary-fixture-001",
	_creationTime: 1780000003000,
	date: "2026-10-01",
	orchestrator: "client-fixture-alpha",
	content: "Fixture entry",
	createdAt: 1780000003000,
};

const READERS = [
	{
		tool: "list_briefing_notes",
		door: "briefingNotes:list",
		present: [BRIEFING_NOTE],
		presentNeedle: "briefing-fixture-001",
	},
	{
		tool: "list_mandates",
		door: "mandates:list",
		present: [MANDATE],
		presentNeedle: "mandate-fixture-001",
	},
	{
		tool: "list_peers",
		door: "profiles:listProfiles",
		present: [PROFILE],
		presentNeedle: "alpha",
	},
	{
		tool: "list_diaries",
		door: "diary:list",
		present: [DIARY_ENTRY],
		presentNeedle: "diary-fixture-001",
		args: { orchestrator: "user-fixture-alpha" },
	},
] as const;

describe("END TWO — the MCP reader says it was refused (ordinary organisation member)", () => {
	for (const r of READERS) {
		it(`${r.tool} — REFUSED / ABSENT / PRESENT, refused and absent asserted ADJACENT`, async () => {
			const args = (r as { args?: Record<string, unknown> }).args ?? {};
			const refused = await call(r.tool, ENVELOPE, args);
			const absent = await call(r.tool, [], args);
			const present = await call(r.tool, r.present, args);

			// ABSENT: a plain empty result, exactly what an empty list always was.
			expect(absent.isError).toBe(false);
			expect(JSON.parse(absent.text)).toEqual([]);

			// PRESENT: the rows still flow (no grant withheld to buy this).
			expect(present.isError).toBe(false);
			expect(present.text).toContain(r.presentNeedle);

			// REFUSED: the caller can TELL. Code, tool, door, and the sentence that
			// says it is not an absence — in the text a model actually reads.
			expect(refused.isError).toBe(true);
			expect(refused.text).toContain("REFUSED");
			expect(refused.text).toContain("RBAC_DENIED");
			expect(refused.text).toContain(r.tool);
			expect(refused.text).toContain(r.door);
			expect(refused.text).toMatch(/NOT an empty result/);

			// ADJACENT: the two cannot be the same bytes, nor the same kind.
			expect(refused.text).not.toBe(absent.text);
			expect(refused.isError).not.toBe(absent.isError);
			expect(() => JSON.parse(refused.text)).toThrow();
		});
	}
});

// ── THE SWEEP, as a gate: the CONTRACT, not the two named instances. ────────────────────
//
// The set of backend doors that can answer with the envelope is DERIVED from the
// `returns` VALIDATOR of every builder in convex/ (test/lib/refusalDoors.ts): a
// door is envelope-capable when its declared `returns` admits `refused:
// v.literal(true)`, optional or not, in a union, hoisted, imported or extended.
// It is never derived from how a handler happens to spell the value: the earlier
// regex `refused: true as const` lost `refused: true as true` (tsc exit 0) and
// the sweep reported 4/4 covered over a reader that discarded the marker.
//
// Every MCP call site of such a door must test the envelope in the ENCLOSING
// FUNCTION of the call (any length: there is no line window), on the very
// binding the result was assigned to. The limits that remain are named at the
// top of test/lib/refusalDoors.ts.

const HERE = dirname(fileURLToPath(import.meta.url));
const CONVEX_DIR = resolve(HERE, "../../convex");
const SRC_DIR = resolve(HERE, "../src");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "_generated" || e.name === "node_modules") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (
			p.endsWith(".ts") &&
			!p.endsWith(".test.ts") &&
			!p.endsWith(".d.ts")
		)
			out.push(p);
	}
	return out;
}

function load(dir: string, root: string): Src[] {
	return walk(dir).map((p) => ({
		name: relative(root, p),
		text: readFileSync(p, "utf8"),
	}));
}

const CONVEX_SRC = load(CONVEX_DIR, CONVEX_DIR);
const MCP_SRC = load(SRC_DIR, SRC_DIR);

describe("END TWO sweep — no MCP reader of an envelope-capable door may swallow the marker", () => {
	const derived = deriveDoors(CONVEX_SRC);

	it("S1a the derived set is the known envelope doors (a new one must be reviewed here)", () => {
		expect(derived.doors).toEqual([
			// Subscribed by components/briefings/briefing-list.tsx; its MCP readers
			// (tools.ts list_briefing_notes, ui-resources/primitives/briefing-note.ts)
			// test isRefusedEnvelope. The signed-in-no-organisation caller gets the envelope.
			"briefingNotes:list",
			// Dashboard-only project summary (pre-org envelope, #1406); no MCP reader
			// (grep -rn getProjectSummary mcp-server/src -> 0), so S1b is unchanged.
			"dashboard:getProjectSummary",
			// Subscribed by components/diary/diary-feed.tsx:67 and
			// components/activity/unified-activity-feed.tsx:158; its MCP reader
			// (tools.ts list_diaries) tests isRefusedEnvelope.
			"diary:list",
			"mandates:list",
			"messages:getUnreadCount",
			"messages:listByChannel",
			// Dashboard-only paginated history read; no MCP reader exists, so S1b's
			// call-site set below is unchanged.
			"messages:listByChannelPaginated",
			// A person's own unread replies (client portal reply path); no MCP reader
			// (grep -rn listMyInbox mcp-server/src -> 0), so S1b is unchanged.
			"messages:listMyInbox",
			"profiles:listProfiles",
		]);
	});

	it("S1d no handler emits `refused: true` from a builder whose `returns` does not declare it", () => {
		// The validator is the contract. A handler that emits the envelope without
		// declaring it is either a runtime validation failure or an undeclared door;
		// either way it must not be able to hide from S1a by omitting the validator.
		expect(derived.undeclaredEnvelopes).toEqual([]);
	});

	it("S1b every call site of every envelope door tests the envelope in its own function", () => {
		const { sites } = sweepCallSites(MCP_SRC, derived.doors);
		const offenders = sites
			.filter((s) => !s.ok)
			.map((s) => `${s.file}:${s.line} ${s.why}`);
		// list_peers, list_mandates and list_briefing_notes are the known readers: guard the guard
		// against a vacuous pass.
		expect(offenders).toEqual([]);
		expect(sites.length).toBeGreaterThanOrEqual(2);
		expect(new Set(sites.map((s) => s.door))).toEqual(
			new Set([
				"briefingNotes:list",
				"diary:list",
				"mandates:list",
				"profiles:listProfiles",
			]),
		);
	});
});

// ── FIXTURES: the spellings the derivation must survive, each in memory. ────────────────
//
// Every fixture is checked on BOTH sides. The sweep must find the door however it
// is spelled; and a reader that swallows the marker must go RED.

const doorSrc = (body: string): Src[] => [{ name: "fx.ts", text: body }];

const BASE = `
import { query } from "./_generated/server";
import { v } from "convex/values";
const row = v.object({ a: v.string() });
`;

const SPELLINGS: Array<{ name: string; src: string }> = [
	{
		name: "the original spelling: refused: v.literal(true) with `as const` in the handler",
		src: `${BASE}
export const list = query({
	args: {},
	returns: v.union(v.array(row), v.object({ refused: v.literal(true), items: v.array(row) })),
	handler: async () => ({ refused: true as const, items: [] }),
});`,
	},
	{
		name: "the reviewer's spelling: handler says `refused: true as true` (tsc exit 0)",
		src: `${BASE}
export const list = query({
	args: {},
	returns: v.union(v.array(row), v.object({ refused: v.literal(true), items: v.array(row) })),
	handler: async () => ({ refused: true as true, items: [] }),
});`,
	},
	{
		name: "third spelling: hoisted validator, optional flag, handler never writes the word (helper builds it)",
		src: `${BASE}
const REFUSAL = v.object({ refused: v.optional(v.literal(true)), items: v.array(row) });
function envelopeFor() { return { ["ref" + "used"]: true, items: [] }; }
export const list = query({
	args: {},
	returns: v.union(v.array(row), REFUSAL),
	handler: async () => envelopeFor(),
});`,
	},
	{
		name: "fourth spelling: the validator reached through .extend on an imported-style named const",
		src: `${BASE}
const withMarker = v.object({ items: v.array(row) });
const returnsShape = withMarker.extend({ refused: v.literal(true) });
export const list = query({ args: {}, returns: returnsShape, handler: async () => ({ items: [] }) });`,
	},
];

const READER_SWALLOWS = (call: string) => `
export function reader(convex: any) {
	return async () => {
		const r = ${call};
		return Array.isArray(r) ? r : [];
	};
}`;

const READER_TESTS = (call: string) => `
export function reader(convex: any) {
	return async () => {
		const r = ${call};
		if (isRefusedEnvelope(r)) return "refused";
		return Array.isArray(r) ? r : [];
	};
}`;

describe("S1c — the derivation reads the validator, whatever the spelling (fixtures)", () => {
	for (const f of SPELLINGS) {
		it(`finds the door: ${f.name}`, () => {
			expect(deriveDoors(doorSrc(f.src)).doors).toEqual(["fx:list"]);
		});
		it(`goes RED on a reader that swallows it, GREEN on one that tests it: ${f.name}`, () => {
			const { doors } = deriveDoors(doorSrc(f.src));
			const bad = sweepCallSites(
				[
					{
						name: "r.ts",
						text: READER_SWALLOWS('await convex.query("fx:list" as any, {})'),
					},
				],
				doors,
			);
			const good = sweepCallSites(
				[
					{
						name: "r.ts",
						text: READER_TESTS('await convex.query("fx:list" as any, {})'),
					},
				],
				doors,
			);
			expect(bad.sites.map((s) => s.ok)).toEqual([false]);
			expect(good.sites.map((s) => s.ok)).toEqual([true]);
		});
	}

	it("an undeclared envelope (handler emits it, `returns` does not) is reported, not silently absent", () => {
		const d = deriveDoors(
			doorSrc(`${BASE}
export const list = query({
	args: {},
	returns: v.object({ items: v.array(row) }),
	handler: async () => ({ refused: true as true, items: [] }),
});`),
		);
		expect(d.doors).toEqual([]);
		expect(d.undeclaredEnvelopes).toEqual(["fx:list"]);
	});

	it("an ordinary query that never mentions a refusal is not a door (no over-reach)", () => {
		const d = deriveDoors(
			doorSrc(`${BASE}
export const list = query({ args: {}, returns: v.array(row), handler: async () => [] });`),
		);
		expect(d).toEqual({
			doors: [],
			undeclaredEnvelopes: [],
			doorsWithoutReturns: [],
		});
	});

	it("a builder with no `returns` is listed, not skipped", () => {
		const d = deriveDoors(
			doorSrc(`${BASE}
export const list = query({ args: {}, handler: async () => [] });`),
		);
		expect(d.doorsWithoutReturns).toEqual(["fx:list"]);
	});
});

describe("S1c — call-site forms the earlier check did not recognise", () => {
	const doors = ["fx:list"];
	const forms: Array<[string, string]> = [
		["api.x.y reference", "await convex.query(api.fx.list, {})"],
		["anyApi.x.y reference", "await convex.query(anyApi.fx.list, {})"],
		[
			'api["x"]["y"] element access',
			'await convex.query(api["fx"]["list"], {})',
		],
		[
			"makeFunctionReference",
			'await convex.query(makeFunctionReference("fx:list"), {})',
		],
		["a const string door name", "await convex.query(DOOR, {})"],
		[
			"a plain string with `as any`",
			'await convex.query("fx:list" as any, {})',
		],
		["fetchConvex helper", 'await fetchConvex("fx:list", {})'],
	];
	for (const [name, call] of forms) {
		it(`${name}: a swallowing reader is RED, a testing reader GREEN`, () => {
			const pre = 'const DOOR = "fx:list";\n';
			const bad = sweepCallSites(
				[{ name: "r.ts", text: pre + READER_SWALLOWS(call) }],
				doors,
			);
			const good = sweepCallSites(
				[{ name: "r.ts", text: pre + READER_TESTS(call) }],
				doors,
			);
			expect(bad.sites.map((s) => s.ok)).toEqual([false]);
			expect(good.sites.map((s) => s.ok)).toEqual([true]);
		});
	}

	it("a test that sits FAR beyond 40 lines of the call is still found (no line window)", () => {
		const filler = "\t\tvoid 0;\n".repeat(200);
		const src = `export function reader(convex: any) {
	return async () => {
		const r = await convex.query("fx:list" as any, {});
${filler}		if (isRefusedEnvelope(r)) return "refused";
		return [];
	};
}`;
		const res = sweepCallSites([{ name: "r.ts", text: src }], doors);
		expect(res.sites.map((s) => s.ok)).toEqual([true]);
	});

	it("a swallowing reader is RED even with `isRefusedEnvelope` applied to some OTHER value", () => {
		const src = `export function reader(convex: any) {
	return async (other: unknown) => {
		const r = await convex.query("fx:list" as any, {});
		if (isRefusedEnvelope(other)) return "refused";
		return Array.isArray(r) ? r : [];
	};
}`;
		const res = sweepCallSites([{ name: "r.ts", text: src }], doors);
		expect(res.sites.map((s) => s.ok)).toEqual([false]);
	});

	it("a door name mentioned only in a message string is not a call site", () => {
		const src = `export const m = "reads fx:list somewhere"; export function f(convex: any) { return convex.query("other:door" as any, {}); }`;
		expect(sweepCallSites([{ name: "r.ts", text: src }], doors).sites).toEqual(
			[],
		);
	});

	it("a computed door name is COUNTED as unresolved, never silently dropped", () => {
		const src = `export function f(convex: any, n: string) { return convex.query(n as any, {}); }`;
		expect(
			sweepCallSites([{ name: "r.ts", text: src }], doors).unresolved,
		).toBe(1);
	});
});
