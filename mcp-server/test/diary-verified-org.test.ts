/**
 * VantagePeers Cloud, task k176723g3m5cczsq44ak9fbgm58hd0tx: the diary tools hand
 * the Convex diary doors the bearer's VERIFIED organisation.
 *
 * A non-master OAuth bearer reaches Convex as the fleet service account, so
 * without a claim the diary doors read master-wide: list_diaries returned every
 * tenant's rows whose orchestrator/createdBy equals the bearer's userId, and
 * get_diary returned the fleet's row of that name. The post-read filters
 * (`orchestrator === userId`, `scopeFilterGet`) compare NAMES, which collide
 * across organisations, so they cannot separate them.
 *
 * The fake backend below behaves as the real doors do for the service account:
 * with `verifiedOrg` it serves that tenant only, without it every tenant.
 *
 *   CLAIM   list_diaries, get_diary and write_diary carry `verifiedOrg` = the
 *           bearer's org, read from the verified context.
 *   LEAK    an org-a bearer whose userId collides with an org-b orchestrator
 *           never receives the org-b entry.
 *   DENY    a non-master bearer whose org cannot be resolved is refused before
 *           any Convex call.
 *   MASTER  the master forwards no claim.
 *   CLERK   a Clerk-JWT member (its own org is seen by Convex) forwards no claim.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildFakeServer() {
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

const SEAT = "seat-x";
const OWN_ORG = "org-a";
const FOREIGN_ORG = "org-b";
const DATE = "2026-10-01";
const SECRET = "ORG-B-DIARY-SECRET";

function bearerOf(org: string): OAuthContext {
	return {
		clientId: `client-${org}`,
		userId: SEAT,
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: `scoped-${org}`,
		fromAllowList: [SEAT],
		namespaceReadPrefixes: [`team/${org}`],
		namespaceWritePrefixes: [`team/${org}`],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		clerkOrgSlug: org,
	};
}

/**
 * A write names an orchestrator, so an org-level bearer must present the
 * per-agent credential of that agent (the acting-claim gate); its org is the
 * agent's own.
 */
function seatOf(org: string): OAuthContext {
	return {
		...bearerOf(org),
		actor: { agentId: `agent-${org}`, orgSlug: org, agentName: SEAT },
	};
}

const bearerFor = (tool: string, org: string): OAuthContext =>
	tool === "write_diary" ? seatOf(org) : bearerOf(org);

function orglessBearer(): OAuthContext {
	const { clerkOrgSlug: _drop, actor: _actor, ...rest } = seatOf(OWN_ORG);
	return rest;
}

const clerkMember = (): OAuthContext => ({
	...bearerOf(OWN_ORG),
	clerkJwt: "verified-clerk-jwt",
});

type Row = { _id: string; _creationTime: number; org: string } & Record<
	string,
	unknown
>;

const row = (org: string, n: number): Row => ({
	_id: `diary${String(n).padStart(27, "0")}`,
	_creationTime: 1_780_000_000_000 + n,
	org,
	date: DATE,
	orchestrator: SEAT,
	createdBy: SEAT,
	createdAt: 1,
	content: org === OWN_ORG ? `own-entry-${n}` : `${SECRET}-${n}`,
});

/** Newest first: the org-b entry is NEWER than the org-a one. */
const ROWS: Row[] = [row(FOREIGN_ORG, 2), row(OWN_ORG, 1)];

function backend() {
	const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
	const scoped = (args: Record<string, unknown>) => {
		const org = (args.verifiedOrg as { orgSlug?: string } | undefined)?.orgSlug;
		return ROWS.filter((r) => org === undefined || r.org === org);
	};
	const query = vi.fn(async (fn: string, args: Record<string, unknown>) => {
		calls.push({ fn, args });
		if (fn === "diary:list") return scoped(args);
		if (fn === "diary:get") return scoped(args)[0] ?? null;
		throw new Error(`unexpected query ${fn}`);
	});
	const mutation = vi.fn(async (fn: string, args: Record<string, unknown>) => {
		calls.push({ fn, args });
		if (fn === "diary:write") return "diary000000000000000000000000099";
		throw new Error(`unexpected mutation ${fn}`);
	});
	return {
		convex: { query, mutation, action: vi.fn() } as unknown as ConvexHttpClient,
		query,
		mutation,
		calls,
	};
}

async function call(
	tool: string,
	ctx: OAuthContext | undefined,
	args: Record<string, unknown>,
) {
	const { server, handlers } = buildFakeServer();
	const b = backend();
	registerTools(server, b.convex, ctx);
	const handler = handlers.get(tool);
	expect(handler, `${tool} is registered`).toBeDefined();
	const result = await handler?.(args);
	return { result, ...b };
}

const TOOLS: Array<{
	tool: string;
	fn: string;
	args: Record<string, unknown>;
}> = [
	{ tool: "list_diaries", fn: "diary:list", args: { orchestrator: SEAT } },
	{ tool: "list_diaries", fn: "diary:list", args: { createdBy: SEAT } },
	{
		tool: "get_diary",
		fn: "diary:get",
		args: { date: DATE, orchestrator: SEAT },
	},
	{
		tool: "write_diary",
		fn: "diary:write",
		args: { date: DATE, orchestrator: SEAT, content: "today" },
	},
];

describe.each(
	TOOLS,
)("$tool $args — the diary door runs under the bearer's verified org", (t) => {
	it("CLAIM: the call carries verifiedOrg = the bearer's org", async () => {
		const { calls, result } = await call(
			t.tool,
			bearerFor(t.tool, OWN_ORG),
			t.args,
		);
		expect(isError(result), text(result)).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0].fn).toBe(t.fn);
		expect(calls[0].args.verifiedOrg).toEqual({ orgSlug: OWN_ORG });
	});

	it("DENY: a bearer whose org cannot be resolved is refused before any Convex call", async () => {
		const { calls, result } = await call(t.tool, orglessBearer(), t.args);
		expect(calls).toHaveLength(0);
		expect(isError(result)).toBe(true);
		// The write is refused earlier still, by the acting-claim gate (an
		// org-level bearer without an agent credential); an agent credential
		// always carries its org, so on the write the org denial is defence in depth.
		expect(text(result)).toContain(
			t.tool === "write_diary"
				? "agent-credential-required"
				: "verified-org-unresolved",
		);
	});

	it("MASTER: forwards no claim", async () => {
		const { calls } = await call(t.tool, LOCAL_STDIO_TRUST_CTX, t.args);
		expect(calls).toHaveLength(1);
		expect(calls[0].args.verifiedOrg).toBeUndefined();
	});

	// write_diary under a Clerk session without a per-agent credential is refused
	// earlier by the acting-claim gate (AGENT_CREDENTIAL_REQUIRED), before any
	// door call; that refusal predates this change and is not what is pinned here.
	it.skipIf(t.tool === "write_diary")(
		"CLERK: a Clerk-JWT member forwards no claim (Convex sees its own org)",
		async () => {
			const { calls } = await call(t.tool, clerkMember(), t.args);
			expect(calls).toHaveLength(1);
			expect(calls[0].args.verifiedOrg).toBeUndefined();
		},
	);
});

describe("LEAK: a colliding userId never reaches another org's diary", () => {
	it("list_diaries (orchestrator=userId) serves the own entry, never org-b's", async () => {
		const { result } = await call("list_diaries", bearerOf(OWN_ORG), {
			orchestrator: SEAT,
		});
		expect(text(result)).toContain("own-entry-1");
		expect(text(result)).not.toContain(SECRET);
	});

	it("list_diaries (createdBy=userId) serves the own entry, never org-b's", async () => {
		const { result } = await call("list_diaries", bearerOf(OWN_ORG), {
			createdBy: SEAT,
		});
		expect(text(result)).toContain("own-entry-1");
		expect(text(result)).not.toContain(SECRET);
	});

	it("get_diary serves the own entry, never org-b's newer same-name entry", async () => {
		const { result } = await call("get_diary", bearerOf(OWN_ORG), {
			date: DATE,
			orchestrator: SEAT,
		});
		expect(text(result)).toContain("own-entry-1");
		expect(text(result)).not.toContain(SECRET);
	});
});
