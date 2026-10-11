/**
 * M17 (task k174ct4gmhcw4zj173ddesj6j98g26vg) — the caller's tenant is applied
 * INSIDE the read an MCP door delegates to, never as a filter after an unscoped
 * one.
 *
 * Twelve doors read through the fleet service account (master at Convex) and
 * used to drop foreign rows afterwards with `scopeFilterList`/`scopeFilterGet`,
 * then computed `nextCursor` from what survived. Two defects follow from that
 * shape: a foreign row crosses the Convex -> MCP boundary before it is dropped,
 * and a full page the filter then thins reads as an exhausted list.
 *
 * The fake backend below is the contract each door must meet. It serves the
 * rows of EVERY tenant unless the call carries the caller's verified org
 * (`verifiedOrg: { orgSlug }`), exactly as the real doors behave for the
 * service account with and without that claim, and it COUNTS every foreign row
 * it hands back. Poles, per door, under a scoped (non-master) bearer of org-a:
 *
 *   CLAIM   the read carries the bearer's verified org, never an argument.
 *   LEAK    no org-b row is ever returned by the backend to this process.
 *   OWN     the org-a row is served; the org-b row is not.
 *   PAGE    a page the foreign rows would have eaten still serves the own rows
 *           and still reports a next cursor (list doors).
 *   DENY    a bearer whose org cannot be resolved is refused BEFORE any read.
 *   MASTER  the master forwards no claim and reads unchanged.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildFakeServer(): {
	server: McpServer;
	handlers: Map<string, ToolHandler>;
} {
	const handlers = new Map<string, ToolHandler>();
	const capture = (...args: unknown[]): unknown => {
		handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
		return {};
	};
	return {
		server: { tool: capture, registerTool: capture } as unknown as McpServer,
		handlers,
	};
}

const text = (result: unknown): string =>
	(result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";

const isError = (result: unknown): boolean =>
	(result as { isError?: boolean })?.isError === true;

function bearerOf(org: string, owner: string): OAuthContext {
	return {
		clientId: `client-${org}`,
		userId: `user-${org}`,
		scopes: ["vantage:read"],
		scopeProfile: `scoped-${org}`,
		fromAllowList: [owner],
		namespaceReadPrefixes: [`team/${org}`],
		namespaceWritePrefixes: [`team/${org}`],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		clerkOrgSlug: org,
	};
}

/** A non-master bearer whose organisation cannot be resolved. */
function orglessBearer(): OAuthContext {
	const { clerkOrgSlug: _drop, ...rest } = bearerOf("org-a", "alice");
	return rest;
}

const OWN_ORG = "org-a";
const FOREIGN_ORG = "org-b";
const OWN = "alice";
const FOREIGN = "mallory";
const SECRET = "FOREIGN-SECRET-PAYLOAD";

type Row = Record<string, unknown> & {
	_id: string;
	_creationTime: number;
	org: string;
};

const id32 = (n: number): string => `row${String(n).padStart(29, "0")}`;

interface Door {
	tool: string;
	fn: string;
	/** The shape the Convex door answers with. */
	shape: "array" | "envelope" | "single-raises" | "single-null";
	/** Tool arguments for a call. */
	args: Record<string, unknown>;
	/** A row of `org`, owned by `owner`, created at `t`. */
	row: (org: string, owner: string, n: number, t: number) => Row;
	/** Extra assertion that an own row is served (substring of the output). */
	ownMarker: (n: number) => string;
	/** The list doors page; the search and by-id doors do not. */
	paged: boolean;
	/** Caller-arg that, when present on the read, is the roster claim. */
	rosterClaim?: boolean;
}

const base = (org: string, owner: string, n: number, t: number): Row => ({
	_id: id32(n),
	_creationTime: t,
	org,
	createdBy: owner,
});

const DOORS: Door[] = [
	{
		tool: "list_messages",
		fn: "messages:listMessages",
		shape: "array",
		args: { limit: 2 },
		paged: true,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			from: owner,
			tenantId: org,
			channel: "broadcast",
			createdAt: t,
			content: org === OWN_ORG ? `own-message-${n}` : `${SECRET}-${n}`,
		}),
		ownMarker: (n) => `own-message-${n}`,
	},
	{
		tool: "search_messages_by_keyword",
		fn: "messages:searchMessagesByKeyword",
		shape: "array",
		args: { query: "deploy", limit: 2 },
		paged: false,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			from: owner,
			tenantId: org,
			channel: "broadcast",
			createdAt: t,
			content: org === OWN_ORG ? `own-message-${n}` : `${SECRET}-${n}`,
		}),
		ownMarker: (n) => `own-message-${n}`,
	},
	{
		tool: "list_tasks",
		fn: "tasks:list",
		shape: "array",
		args: { limit: 2, fields: "full" },
		paged: true,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			orgId: org,
			assignedTo: owner,
			status: "todo",
			priority: "medium",
			title: org === OWN_ORG ? `own-task-${n}` : `${SECRET}-${n}`,
		}),
		ownMarker: (n) => `own-task-${n}`,
	},
	{
		tool: "search_tasks_by_keyword",
		fn: "tasks:searchTasksByKeyword",
		shape: "array",
		args: { query: "hook", limit: 2, fields: "full" },
		paged: false,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			orgId: org,
			assignedTo: owner,
			status: "todo",
			priority: "medium",
			title: org === OWN_ORG ? `own-task-${n}` : `${SECRET}-${n}`,
		}),
		ownMarker: (n) => `own-task-${n}`,
	},
	{
		tool: "list_briefing_notes",
		fn: "briefingNotes:list",
		shape: "array",
		args: { limit: 2 },
		paged: true,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			orgId: org,
			topic: "decision",
			participants: [owner],
			title: org === OWN_ORG ? `own-note-${n}` : `${SECRET}-${n}`,
		}),
		ownMarker: (n) => `own-note-${n}`,
	},
	{
		tool: "search_briefing_notes_by_keyword",
		fn: "briefingNotes:searchBriefingNotesByKeyword",
		shape: "array",
		args: { query: "decision", limit: 2 },
		paged: false,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			orgId: org,
			topic: "decision",
			participants: [owner],
			title: org === OWN_ORG ? `own-note-${n}` : `${SECRET}-${n}`,
		}),
		ownMarker: (n) => `own-note-${n}`,
	},
	{
		tool: "list_bus",
		fn: "businessUnits:list",
		shape: "envelope",
		args: { limit: 2 },
		paged: true,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			orchestratorId: owner,
			status: "building",
			name: org === OWN_ORG ? `own-bu-${n}` : `${SECRET}-${n}`,
		}),
		ownMarker: (n) => `own-bu-${n}`,
	},
	{
		tool: "list_repo_mappings",
		fn: "githubRepoMapping:list",
		shape: "envelope",
		args: { limit: 2 },
		paged: true,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			orchestrator: owner,
			orgId: org,
			repo: org === OWN_ORG ? `own/repo-${n}` : `${SECRET}/repo-${n}`,
		}),
		ownMarker: (n) => `own/repo-${n}`,
	},
	{
		tool: "get_message",
		fn: "messages:getById",
		shape: "single-raises",
		args: { messageId: id32(1) },
		paged: false,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			from: owner,
			tenantId: org,
			channel: "broadcast",
			createdAt: t,
			content: org === OWN_ORG ? `own-message-${n}` : `${SECRET}-${n}`,
		}),
		ownMarker: (n) => `own-message-${n}`,
	},
	{
		tool: "list_broadcast_status",
		fn: "messages:listBroadcastStatus",
		shape: "single-raises",
		args: { messageId: id32(1) },
		paged: false,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			messageId: id32(n),
			from: owner,
			channel: "broadcast",
			createdAt: t,
			truncated: false,
			receipts: [
				{
					recipient: owner,
					read: false,
					note: org === OWN_ORG ? `own-receipt-${n}` : `${SECRET}-${n}`,
				},
			],
		}),
		ownMarker: (n) => `own-receipt-${n}`,
	},
	{
		tool: "get_episode",
		fn: "memories:getMemory",
		shape: "single-null",
		args: { episodeId: id32(1) },
		paged: false,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			type: "episode",
			namespace: `team/${org}`,
			createdAt: t,
			content: org === OWN_ORG ? `own-episode-${n}` : `${SECRET}-${n}`,
		}),
		ownMarker: (n) => `own-episode-${n}`,
	},
	{
		tool: "get_fix_pattern",
		fn: "fixPatterns:get",
		shape: "single-null",
		args: { patternId: id32(1) },
		paged: false,
		rosterClaim: true,
		row: (org, owner, n, t) => ({
			...base(org, owner, n, t),
			createdAt: t,
			symptom: org === OWN_ORG ? `own-pattern-${n}` : `${SECRET}-${n}`,
		}),
		ownMarker: (n) => `own-pattern-${n}`,
	},
];

/**
 * The Convex doors, as the service account meets them. With the caller's
 * verified org (or, for the fleet-internal fix pattern, its roster) the door
 * reads that tenant only; without it, it reads every tenant. `leaked` counts
 * the foreign rows handed back to this process.
 */
function backendFor(door: Door, rows: Row[]) {
	const leaked: Row[] = [];
	const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
	const query = vi.fn(async (fn: string, args: Record<string, unknown>) => {
		calls.push({ fn, args });
		expect(fn).toBe(door.fn);
		const scopedOrg = (args.verifiedOrg as { orgSlug?: string } | undefined)
			?.orgSlug;
		const roster = args.callerIdentities as string[] | undefined;
		const readable = (r: Row): boolean =>
			scopedOrg !== undefined
				? r.org === scopedOrg
				: roster !== undefined
					? roster.includes(r.createdBy as string)
					: true;
		const hand = <T extends Row>(served: T[]): T[] => {
			for (const r of served) if (r.org !== OWN_ORG) leaked.push(r);
			return served;
		};

		if (door.shape === "single-raises" || door.shape === "single-null") {
			const row = rows[0];
			if (!readable(row)) {
				if (door.shape === "single-null") return null;
				throw new Error(
					"RBAC_DENIED: refuses a caller outside the organisation (cross-tenant)",
				);
			}
			hand([row]);
			return row;
		}

		const limit = (args.limit as number | undefined) ?? 20;
		const before = args.createdBefore as number | undefined;
		const visible = rows
			.filter(readable)
			.filter((r) => before === undefined || r._creationTime < before)
			.sort((a, b) => b._creationTime - a._creationTime);
		const page = hand(visible.slice(0, limit));
		if (door.shape === "envelope") {
			return {
				items: page,
				nextCursor: visible.length > limit ? "scoped-next-cursor" : null,
			};
		}
		return page;
	});
	return {
		convex: {
			query,
			mutation: vi.fn(),
			action: vi.fn(),
		} as unknown as ConvexHttpClient,
		query,
		leaked,
		calls,
	};
}

/** Newest-first world: foreign rows are NEWER than every own row. */
function worldFor(door: Door): Row[] {
	const t0 = 1_780_000_000_000;
	return [
		door.row(FOREIGN_ORG, FOREIGN, 11, t0 + 5000),
		door.row(FOREIGN_ORG, FOREIGN, 12, t0 + 4000),
		door.row(OWN_ORG, OWN, 1, t0 + 3000),
		door.row(FOREIGN_ORG, FOREIGN, 13, t0 + 2000),
		door.row(OWN_ORG, OWN, 2, t0 + 1000),
		door.row(OWN_ORG, OWN, 3, t0),
	];
}

/** One own row and one foreign row (the by-id doors read a single row). */
function singleWorld(door: Door, org: string): Row[] {
	return [
		door.row(
			org,
			org === OWN_ORG ? OWN : FOREIGN,
			org === OWN_ORG ? 1 : 11,
			1_780_000_000_000,
		),
	];
}

async function callDoor(
	door: Door,
	ctx: OAuthContext | undefined,
	rows: Row[],
	argsOverride?: Record<string, unknown>,
) {
	const { server, handlers } = buildFakeServer();
	const backend = backendFor(door, rows);
	registerTools(server, backend.convex, ctx);
	const handler = handlers.get(door.tool);
	expect(handler, `${door.tool} is registered`).toBeDefined();
	const result = await handler?.({ ...door.args, ...argsOverride });
	return { result, ...backend };
}

// ─────────────────────────────────────────────────────────────────────────────
// Poles
// ─────────────────────────────────────────────────────────────────────────────

describe.each(DOORS)("$tool — tenant applied inside the read", (door) => {
	const world = (): Row[] =>
		door.shape === "single-raises" || door.shape === "single-null"
			? singleWorld(door, OWN_ORG)
			: worldFor(door);

	it("CLAIM: the read carries the bearer's verified org (or roster), from the context", async () => {
		const { calls } = await callDoor(door, bearerOf(OWN_ORG, OWN), world());
		expect(calls).toHaveLength(1);
		if (door.rosterClaim) {
			expect(calls[0].args.callerIdentities).toEqual([OWN]);
		} else {
			expect(calls[0].args.verifiedOrg).toEqual({ orgSlug: OWN_ORG });
		}
	});

	it("OWN: the own-org row is served", async () => {
		const { result } = await callDoor(door, bearerOf(OWN_ORG, OWN), world());
		expect(isError(result)).toBe(false);
		expect(text(result)).toContain(door.ownMarker(1));
	});

	it("LEAK: no foreign-org row is ever handed back to the MCP process", async () => {
		const { result, leaked } = await callDoor(
			door,
			bearerOf(OWN_ORG, OWN),
			world(),
		);
		expect(leaked).toHaveLength(0);
		expect(text(result)).not.toContain(SECRET);
	});

	it("FOREIGN ROW: a row of another org is not served, and never read", async () => {
		const rows =
			door.shape === "single-raises" || door.shape === "single-null"
				? singleWorld(door, FOREIGN_ORG)
				: worldFor(door).filter((r) => r.org === FOREIGN_ORG);
		const { result, leaked } = await callDoor(
			door,
			bearerOf(OWN_ORG, OWN),
			rows,
		);
		expect(leaked).toHaveLength(0);
		expect(text(result)).not.toContain(SECRET);
	});

	// The fleet-internal fix pattern has no tenant: its claim is the roster.
	it.skipIf(door.rosterClaim === true)(
		"DENY: a bearer whose org cannot be resolved is refused before any read",
		async () => {
			const { result, query } = await callDoor(door, orglessBearer(), world());
			expect(query).not.toHaveBeenCalled();
			expect(isError(result)).toBe(true);
			expect(text(result)).toContain("verified-org-unresolved");
		},
	);

	it("MASTER: forwards no claim and reads unchanged", async () => {
		const { calls } = await callDoor(door, LOCAL_STDIO_TRUST_CTX, world());
		expect(calls).toHaveLength(1);
		expect(calls[0].args.verifiedOrg).toBeUndefined();
		expect(calls[0].args.callerIdentities).toBeUndefined();
	});
});

const PAGED = DOORS.filter((d) => d.paged);
const NON_NULL_NEXT_CURSOR = /"nextCursor":\s*"/;

describe.each(
	PAGED,
)("$tool — pagination is derived from the scoped read", (door) => {
	it("PAGE: foreign rows that would have filled the page do not hide the own rows", async () => {
		const { result } = await callDoor(
			door,
			bearerOf(OWN_ORG, OWN),
			worldFor(door),
		);
		const out = text(result);
		// Both of the page's own rows are served although two foreign rows are
		// newer than every own row.
		expect(out).toContain(door.ownMarker(1));
		expect(out).toContain(door.ownMarker(2));
		// A third own row exists behind a full page: not exhausted.
		expect(out).toMatch(NON_NULL_NEXT_CURSOR);
	});

	it("PAGE: a full scoped page reports a next cursor even when the narrowing filter keeps nothing of it", async () => {
		// Same org, but the page's rows belong to a colleague the bearer's own
		// roster (fromAllowList) does not name: the narrowing filter drops the
		// whole page, and the list is still not exhausted.
		const colleague = (n: number, t: number): Row =>
			door.row(OWN_ORG, "bob", n, t);
		const t0 = 1_780_000_000_000;
		const rows = [
			colleague(21, t0 + 3000),
			colleague(22, t0 + 2000),
			door.row(OWN_ORG, OWN, 1, t0 + 1000),
		];
		const { result } = await callDoor(door, bearerOf(OWN_ORG, OWN), rows);
		expect(text(result)).toMatch(NON_NULL_NEXT_CURSOR);
	});
});

describe("search doors — the page is not eaten by foreign rows", () => {
	for (const door of DOORS.filter((d) => d.shape === "array" && !d.paged)) {
		it(`${door.tool}: limit 2 returns the two own rows, not the foreign newest`, async () => {
			const { result } = await callDoor(
				door,
				bearerOf(OWN_ORG, OWN),
				worldFor(door),
			);
			const out = text(result);
			expect(out).toContain(door.ownMarker(1));
			expect(out).toContain(door.ownMarker(2));
		});
	}
});

describe("list_broadcast_status — the message is gated at the door", () => {
	it("a broadcast of another org is refused at the door, its receipts never read", async () => {
		const door = DOORS.find((d) => d.tool === "list_broadcast_status") as Door;
		const { result, leaked } = await callDoor(
			door,
			bearerOf(OWN_ORG, OWN),
			singleWorld(door, FOREIGN_ORG),
		);
		expect(leaked).toHaveLength(0);
		expect(isError(result)).toBe(true);
		expect(text(result)).not.toContain(SECRET);
	});
});
