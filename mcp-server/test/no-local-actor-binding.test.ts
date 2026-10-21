/**
 * No local actor binding: `checkActorBinding` is gone, the package decision
 * `decideActingClaim` (@vantageos/cloud-identity 0.22.0) takes its place, and
 * every row of the old decision table still decides the same way.
 *
 * VantagePeers Cloud (multi-tenant). Task k1778c2hvae8e8vz9f5bbbbbb98g62hw,
 * identity-zero slice 3a. Operator ruling: @vantageos/cloud-identity is the only
 * identity layer; VP keeps no local caller-resolution primitive of its own.
 *
 * (a) is RED while the name exists. (b) pins one pole per row of the table,
 * driven through real tools registered by defineTool. Every pole except the
 * no-context one already held before the swap: that is the proof the swap
 * widens nothing. The no-context pole is RED at first because the local
 * refusal carried no code; the package's carries RBAC_DENIED / no-context.
 *
 * Scan scope: mcp-server/src and convex (non-test), CODE AND COMMENTS alike.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SCANNED_ROOTS = [join(REPO, "mcp-server", "src"), join(REPO, "convex")];
const SKIPPED_DIRS = new Set(["node_modules", "_generated", "__tests__"]);
const DELETED_NAME = /\bcheckActorBinding\b/;

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (SKIPPED_DIRS.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
		else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(path);
	}
	return out;
}

describe("(a) the local actor-binding name is gone from mcp-server/src and convex", () => {
	it("checkActorBinding has zero occurrences, code or comment", () => {
		const files = sourceFiles(SCANNED_ROOTS[0]).concat(
			sourceFiles(SCANNED_ROOTS[1]),
		);
		// The instrument sees the tree: a scan over nothing proves nothing.
		expect(files.length).toBeGreaterThan(100);
		const hits: string[] = [];
		for (const file of files) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (DELETED_NAME.test(line)) {
					hits.push(`${relative(REPO, file)}:${i + 1}: ${line.trim()}`);
				}
			});
		}
		expect(hits, hits.join("\n")).toEqual([]);
	});
});

// ── (b) one pole per row, reached through the real registered handlers ─────

type Handler = (args: Record<string, unknown>, extra?: unknown) => unknown;
type Result = { isError?: boolean; content?: { text?: string }[] };

function register(ctx: OAuthContext | undefined): {
	handlers: Map<string, Handler>;
	convex: ConvexHttpClient;
} {
	const handlers = new Map<string, Handler>();
	const capture = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const server = {
		tool: capture,
		registerTool: capture,
	} as unknown as McpServer;
	const convex = {
		query: vi.fn().mockResolvedValue([]),
		mutation: vi.fn().mockResolvedValue({ ok: true }),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
	registerTools(server, convex, ctx);
	return { handlers, convex };
}

async function claim(
	ctx: OAuthContext | undefined,
	callerOrchestrator: string,
): Promise<{ result: Result; text: string; mutations: number }> {
	const { handlers, convex } = register(ctx);
	const handler = handlers.get("delete_message");
	if (!handler) throw new Error("delete_message is not registered");
	const result = (await handler(
		{ messageId: MESSAGE_ID, callerOrchestrator },
		{},
	)) as Result;
	return {
		result,
		text: result?.content?.[0]?.text ?? "",
		mutations: (convex.mutation as ReturnType<typeof vi.fn>).mock.calls.length,
	};
}

const base = {
	clientId: "client-fixture",
	userId: "user-fixture",
	scopes: ["vantage:read", "vantage:write"],
	namespaceReadPrefixes: ["team/org-fixture"],
	namespaceWritePrefixes: ["team/org-fixture"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkOrgSlug: "org-fixture",
} as const;

/** An agent credential for alpha-role, roster alpha + beta. */
const CREDENTIAL: OAuthContext = {
	...base,
	scopeProfile: "tenant",
	fromAllowList: ["alpha-role", "beta-role"],
	actor: { orgSlug: "org-fixture", agentName: "alpha-role" },
};

/** A seat token that resolved to alpha-role BY ID in its own org. */
const SEAT: OAuthContext = {
	...base,
	scopeProfile: "tenant",
	fromAllowList: ["alpha-role"],
	accessTokenHash: "hash-fixture",
	seatAgent: {
		agentId: "agent-alpha",
		orgId: "org-fixture",
		agentName: "alpha-role",
	},
};

/** A seat token whose provider could not stamp (the stamp is ABSENT). */
const SEAT_UNSTAMPED: OAuthContext = {
	...base,
	scopeProfile: "tenant",
	fromAllowList: ["alpha-role"],
	accessTokenHash: "hash-fixture",
};

/** An organisation-level caller: no credential, no seat agent. */
const ORG_MEMBER: OAuthContext = {
	...base,
	scopeProfile: "tenant",
	fromAllowList: ["alpha-role"],
};

const MASTER_BASE = {
	...base,
	clientId: "master",
	userId: "master",
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	isMaster: true,
	clerkOrgSlug: undefined,
} as const;

/** The fleet's HTTP master bearer. */
const MASTER_BEARER: OAuthContext = { ...MASTER_BASE, viaMasterBearer: true };
/** The local stdio trust context: master, and not the bearer population. */
const STDIO_MASTER: OAuthContext = { ...MASTER_BASE };

const MESSAGE_ID = "j57dy3049btafda9m2f5d2ggk987ph3f";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("(b) every row of the acting-claim table decides as before", () => {
	it("an agent credential naming another agent: AGENT_IDENTITY_MISMATCH, 0 mutations", async () => {
		const r = await claim(CREDENTIAL, "beta-role");
		expect(r.result.isError).toBe(true);
		expect(r.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(r.mutations).toBe(0);
	});

	it("the same, in permissive mode: a credential is never overridden by a typed name", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const r = await claim(CREDENTIAL, "beta-role");
		expect(r.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(r.mutations).toBe(0);
	});

	it("a seat resolved by ID naming another agent: AGENT_IDENTITY_MISMATCH, 0 mutations", async () => {
		const r = await claim(SEAT, "beta-role");
		expect(r.result.isError).toBe(true);
		expect(r.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(r.mutations).toBe(0);
	});

	it("the master bearer claiming a name: AGENT_CREDENTIAL_REQUIRED, in strict and in permissive", async () => {
		for (const mode of ["strict", "permissive"]) {
			vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", mode);
			const r = await claim(MASTER_BEARER, "alpha-role");
			expect(r.result.isError).toBe(true);
			expect(r.text).toContain("AGENT_CREDENTIAL_REQUIRED");
			expect(r.mutations).toBe(0);
		}
	});

	it("the stdio master passes with a claim", async () => {
		const r = await claim(STDIO_MASTER, "alpha-role");
		expect(r.result.isError).not.toBe(true);
		expect(r.mutations).toBe(1);
	});

	it("permissive, no credential: a rostered name passes", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const r = await claim(ORG_MEMBER, "alpha-role");
		expect(r.result.isError).not.toBe(true);
		expect(r.mutations).toBe(1);
	});

	it("strict (mode absent), no credential and not a seat: AGENT_CREDENTIAL_REQUIRED", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "");
		const r = await claim(ORG_MEMBER, "alpha-role");
		expect(r.result.isError).toBe(true);
		expect(r.text).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(r.mutations).toBe(0);
	});

	it("a seat naming its own agent passes, stamped and unstamped", async () => {
		for (const seat of [SEAT, SEAT_UNSTAMPED]) {
			const r = await claim(seat, "alpha-role");
			expect(r.result.isError).not.toBe(true);
			expect(r.mutations).toBe(1);
		}
	});

	it("an organisation-level seat (stamped null) is never exempt in strict", async () => {
		const r = await claim({ ...SEAT_UNSTAMPED, seatAgent: null }, "alpha-role");
		expect(r.text).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(r.mutations).toBe(0);
	});

	it("no context at all: refused with the code RBAC_DENIED and the reason no-context, 0 mutations", async () => {
		const r = await claim(undefined, "alpha-role");
		expect(r.result.isError).toBe(true);
		expect(r.text).toContain("RBAC_DENIED");
		expect(r.text).toContain("no-context");
		expect(r.mutations).toBe(0);
	});
});
