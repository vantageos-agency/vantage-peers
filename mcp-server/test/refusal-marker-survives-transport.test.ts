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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

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

const READERS = [
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
] as const;

describe("END TWO — the MCP reader says it was refused (ordinary organisation member)", () => {
	for (const r of READERS) {
		it(`${r.tool} — REFUSED / ABSENT / PRESENT, refused and absent asserted ADJACENT`, async () => {
			const refused = await call(r.tool, ENVELOPE);
			const absent = await call(r.tool, []);
			const present = await call(r.tool, r.present);

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

// ── THE SWEEP, as a gate: the SHAPE, not the two named instances. ───────────────────────
//
// The set of backend doors that can answer with the envelope is DERIVED from
// convex/*.ts (every handler that returns `{ refused: true as const, ... }`),
// never listed by hand. Every MCP call site of such a door must handle the
// envelope in the same handler, or a future `Array.isArray(x) ? x : []` reader
// swallows the marker again and this test names it.

const HERE = dirname(fileURLToPath(import.meta.url));
const CONVEX_DIR = resolve(HERE, "../../convex");
const SRC_DIR = resolve(HERE, "../src");

function envelopeDoors(): string[] {
	const doors: string[] = [];
	for (const f of readdirSync(CONVEX_DIR)) {
		if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
		const src = readFileSync(join(CONVEX_DIR, f), "utf8");
		for (const m of src.matchAll(/refused:\s*true\s+as\s+const/g)) {
			const before = src.slice(0, m.index);
			const names = [
				...before.matchAll(/export const (\w+)\s*=\s*(?:query|internalQuery)\(/g),
			];
			const last = names[names.length - 1];
			if (last) doors.push(`${f.slice(0, -3)}:${last[1]}`);
		}
	}
	return [...new Set(doors)].sort();
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
	}
	return out;
}

describe("END TWO sweep — no MCP reader of an envelope-capable door may swallow the marker", () => {
	const doors = envelopeDoors();

	it("the derived set is the three known envelope doors (a new one must be reviewed here)", () => {
		expect(doors).toEqual([
			"mandates:list",
			"messages:listByChannel",
			"profiles:listProfiles",
		]);
	});

	it("every call site of every envelope door handles `refused` within its own handler", () => {
		const offenders: string[] = [];
		let callSites = 0;
		for (const file of walk(SRC_DIR)) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				for (const door of doors) {
					if (!line.includes(`"${door}"`)) continue;
					// A CALL site: the door name is the first argument of a
					// query/action/fetchConvex call (on this line or the one above),
					// not a mention inside a message string.
					const callish = `${lines[i - 1] ?? ""}\n${line}`;
					if (!/(?:query|action|fetchConvex)\(\s*(?:as any)?\s*"?/.test(callish))
						continue;
					if (line.includes("mcpRefused(")) continue;
					callSites += 1;
					const window = lines.slice(i, i + 40).join("\n");
					if (!window.includes("isRefusedEnvelope(")) {
						offenders.push(`${file}:${i + 1} reads ${door} without isRefusedEnvelope`);
					}
				}
			});
		}
		// list_peers and list_mandates are the two known readers: guard the guard
		// against a vacuous pass.
		expect(callSites).toBeGreaterThanOrEqual(2);
		expect(offenders).toEqual([]);
	});
});
