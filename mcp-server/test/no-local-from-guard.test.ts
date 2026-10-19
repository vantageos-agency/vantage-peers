/**
 * No local `from` guard: `checkFromAllowed` and `guardFrom` are gone, and every
 * refusal they produced still happens.
 *
 * VantagePeers Cloud (multi-tenant). Task k1778c2hvae8e8vz9f5bbbbbb98g62hw,
 * deletion series, slice 1 of 4. Operator ruling: @vantageos/cloud-identity is
 * the only identity layer, and VP keeps no local caller-resolution or scope
 * primitive of its own.
 *
 * `checkFromAllowed` was two gates, and each survives without the deleted names:
 *   1. the actor binding: `defineTool`'s `bindActingNames` already runs
 *      `checkActorBinding` on every declared acting name before the scope check
 *      and before the handler, so the second call inside `checkFromAllowed`
 *      re-decided a question that had been answered;
 *   2. the roster (`fromAllowList`, deleted in slice 3): decided by the
 *      package's `passesScopeFilter`, at the `from` scope kind of `defineTool`,
 *      at `bulk_complete_tasks` (a `filtered` tool), and at the assignee
 *      self-name shortcut.
 *
 * (a) is RED on 418b6f2 (the names exist). (b) pins the refusal poles that
 * must survive the deletion; it is green before and after, by design.
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
const DELETED_NAMES = /\b(checkFromAllowed|guardFrom)\b/;

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

describe("(a) the local from-guard names are gone from mcp-server/src and convex", () => {
	it("checkFromAllowed and guardFrom have zero occurrences, code or comment", () => {
		const files = sourceFiles(SCANNED_ROOTS[0]).concat(
			sourceFiles(SCANNED_ROOTS[1]),
		);
		// The instrument sees the tree: a scan over nothing proves nothing.
		expect(files.length).toBeGreaterThan(100);
		const hits: string[] = [];
		for (const file of files) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (DELETED_NAMES.test(line)) {
					hits.push(`${relative(REPO, file)}:${i + 1}: ${line.trim()}`);
				}
			});
		}
		expect(hits, hits.join("\n")).toEqual([]);
	});
});

// ── (b) refusal poles, reached through the real registered handlers ────────

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

async function call(
	ctx: OAuthContext | undefined,
	tool: string,
	args: Record<string, unknown>,
): Promise<{ result: Result; text: string; mutations: number }> {
	const { handlers, convex } = register(ctx);
	const handler = handlers.get(tool);
	if (!handler) throw new Error(`${tool} is not registered`);
	const result = (await handler(args, {})) as Result;
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

/** An agent credential for alpha-role whose roster holds alpha AND beta. */
const ALPHA: OAuthContext = {
	...base,
	scopeProfile: "tenant",
	fromAllowList: ["alpha-role", "beta-role"],
	actor: { orgSlug: "org-fixture", agentName: "alpha-role" },
};

/** The same credential, but a roster that does not list its own agent. */
const ALPHA_OFF_ROSTER: OAuthContext = {
	...ALPHA,
	fromAllowList: ["gamma-role"],
};

/** No agent credential at all: only the roster can refuse (permissive mode). */
const ROSTER_ONLY: OAuthContext = {
	...base,
	scopeProfile: "tenant",
	fromAllowList: ["alpha-role"],
};

const MASTER: OAuthContext = {
	...base,
	clientId: "master",
	userId: "master",
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	isMaster: true,
	clerkOrgSlug: undefined,
};

const MESSAGE_ID = "j57dy3049btafda9m2f5d2ggk987ph3f";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("(b) the refusals of the deleted guard survive", () => {
	it("a caller claiming another agent's name is refused before any mutation (from-scoped and filtered tools)", async () => {
		const del = await call(ALPHA, "delete_message", {
			messageId: MESSAGE_ID,
			callerOrchestrator: "beta-role",
		});
		expect(del.result.isError).toBe(true);
		expect(del.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(del.mutations).toBe(0);

		const bulk = await call(ALPHA, "bulk_complete_tasks", {
			filter: { assignedTo: "beta-role" },
			dryRun: false,
			callerOrchestrator: "beta-role",
		});
		expect(bulk.result.isError).toBe(true);
		expect(bulk.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(bulk.mutations).toBe(0);
	});

	it("the roster still narrows the credential's own agent (from-scoped tool, filtered tool, derived name)", async () => {
		const del = await call(ALPHA_OFF_ROSTER, "delete_message", {
			messageId: MESSAGE_ID,
			callerOrchestrator: "alpha-role",
		});
		expect(del.result.isError).toBe(true);
		expect(del.text).toContain("is not in this client's allowlist");
		expect(del.text).toContain("Allowed: gamma-role");
		expect(del.mutations).toBe(0);

		// Omitted: the wrapper derives alpha-role from the credential, and the
		// roster still refuses the derived name.
		const derived = await call(ALPHA_OFF_ROSTER, "delete_message", {
			messageId: MESSAGE_ID,
		});
		expect(derived.result.isError).toBe(true);
		expect(derived.text).toContain("is not in this client's allowlist");
		expect(derived.mutations).toBe(0);

		const bulk = await call(ALPHA_OFF_ROSTER, "bulk_complete_tasks", {
			filter: { assignedTo: "alpha-role" },
			dryRun: true,
			callerOrchestrator: "alpha-role",
		});
		expect(bulk.result.isError).toBe(true);
		expect(bulk.text).toContain("is not in this client's allowlist");
		expect(bulk.mutations).toBe(0);
	});

	it("with no credential (permissive mode), a name off the roster is refused by the roster alone", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const del = await call(ROSTER_ONLY, "delete_message", {
			messageId: MESSAGE_ID,
			callerOrchestrator: "beta-role",
		});
		expect(del.result.isError).toBe(true);
		expect(del.text).toContain("is not in this client's allowlist");
		expect(del.mutations).toBe(0);

		const bulk = await call(ROSTER_ONLY, "bulk_complete_tasks", {
			filter: { assignedTo: "beta-role" },
			dryRun: true,
			callerOrchestrator: "beta-role",
		});
		expect(bulk.result.isError).toBe(true);
		expect(bulk.text).toContain("is not in this client's allowlist");
		expect(bulk.mutations).toBe(0);

		// Positive control: the roster's own name is served in this mode.
		const own = await call(ROSTER_ONLY, "delete_message", {
			messageId: MESSAGE_ID,
			callerOrchestrator: "alpha-role",
		});
		expect(own.result.isError).not.toBe(true);
		expect(own.mutations).toBe(1);
	});

	it("the assignee self-name shortcut admits the caller itself and nobody else unresolved", async () => {
		// ALPHA has no Clerk session and no token hash: its org roster cannot be
		// read, so only the self-name shortcut can admit an assignee.
		const self = await call(ALPHA, "create_mandate", {
			requestedBy: "alpha-role",
			fulfilledBy: "alpha-role",
			service: "review",
			budget: 10,
		});
		expect(self.result.isError).not.toBe(true);
		expect(self.mutations).toBe(1);

		// beta-role is on the roster but is NOT the credential's agent: not a
		// self-name, so the delegation gate decides, and it refuses unresolved.
		const other = await call(ALPHA, "create_mandate", {
			requestedBy: "alpha-role",
			fulfilledBy: "beta-role",
			service: "review",
			budget: 10,
		});
		expect(other.result.isError).toBe(true);
		expect(other.mutations).toBe(0);

		// The credential's own agent off the roster is not a self-name either.
		const offRoster = await call(ALPHA_OFF_ROSTER, "create_mandate", {
			requestedBy: "alpha-role",
			fulfilledBy: "alpha-role",
			service: "review",
			budget: 10,
		});
		expect(offRoster.result.isError).toBe(true);
		expect(offRoster.mutations).toBe(0);
	});

	it("a master caller with no claim passes (from-scoped and filtered tools)", async () => {
		const del = await call(MASTER, "delete_message", { messageId: MESSAGE_ID });
		expect(del.result.isError).not.toBe(true);
		expect(del.mutations).toBe(1);

		const bulk = await call(MASTER, "bulk_complete_tasks", {
			filter: { assignedTo: "alpha-role" },
			dryRun: true,
		});
		expect(bulk.result.isError).not.toBe(true);
		expect(bulk.mutations).toBe(1);
	});

	it("a missing oauthContext fails closed, with or without a claim", async () => {
		for (const args of [
			{ messageId: MESSAGE_ID, callerOrchestrator: "alpha-role" },
			{ messageId: MESSAGE_ID },
		]) {
			const del = await call(undefined, "delete_message", args);
			expect(del.result.isError).toBe(true);
			expect(del.mutations).toBe(0);
		}
		const bulk = await call(undefined, "bulk_complete_tasks", {
			filter: { assignedTo: "alpha-role" },
			dryRun: true,
			callerOrchestrator: "alpha-role",
		});
		expect(bulk.result.isError).toBe(true);
		expect(bulk.mutations).toBe(0);
	});
});
