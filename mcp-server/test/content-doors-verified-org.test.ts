/**
 * Batch F1 (backend standard R-54, MCP half S-28): the content tools act for the
 * bearer's VERIFIED org.
 *
 * Every MCP caller reaches Convex as ONE service account, which resolves to master.
 * The Convex content doors (diary, memories, episodes, the knowledge base, the OKF
 * bundle doors) therefore refuse a service-account call that carries no verified
 * organisation (convex/contentClaims.ts). A tool that reaches one forwards the
 * bearer's `verifiedOrg`, read from the verified oauthContext ONLY (the agent
 * credential's org, else the org snapshotted on the access-token row), never from a
 * tool argument. The master and a Clerk-JWT caller forward none (the master has no
 * organisation; a Clerk session carries its own org to Convex). A door that refuses
 * claimless calls behind a tool that never forwards is an outage, not a leak: this
 * pins the tool half.
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Call = { kind: string; fn: string; args: Record<string, unknown> };
type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };

function harness(oauthCtx: OAuthContext) {
	const handlers = new Map<
		string,
		(a: Record<string, unknown>) => Promise<unknown>
	>();
	const calls: Call[] = [];
	const server = {
		tool: (name: string, _d: string, _s: unknown, _a: unknown, h: never) => {
			handlers.set(name, h);
		},
		registerTool: (name: string, _c: unknown, h: never) => {
			handlers.set(name, h);
		},
	} as Parameters<typeof registerTools>[0];
	const record = (kind: string) => async (fn: unknown, args: unknown) => {
		calls.push({ kind, fn: String(fn), args: args as Record<string, unknown> });
		if (String(fn) === "memories:getMemory")
			return { _id: "m1", namespace: "team/org-a", content: "x" };
		if (kind === "query") return { value: [], continueCursor: null, isDone: true };
		return "doc-id";
	};
	const convex = {
		query: record("query"),
		mutation: record("mutation"),
		action: record("action"),
	} as Parameters<typeof registerTools>[1];
	registerTools(server, convex, oauthCtx);
	return {
		calls,
		call: async (name: string, args: Record<string, unknown>) => {
			const h = handlers.get(name);
			if (!h) throw new Error(`${name} not registered`);
			return (await h(args)) as ToolResult;
		},
	};
}

const scoped = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "client-a",
	userId: "user-a",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "client-a-seat",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["orchestrator/alpha", "team/org-a"],
	namespaceWritePrefixes: ["team/org-a", "orchestrator/alpha"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkOrgSlug: "org-a",
	// the bearer carries an agent credential, as a seat naming itself does
	actor: { orgSlug: "org-a", agentName: "alpha" },
	...over,
});

const master = (): OAuthContext => ({
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: true,
});

const MEMORY_ID = "j57dy3049btafda9m2f5d2ggk987ph3f";
const SHA = "a".repeat(64);

/** [tool, convex function it reaches, args]. */
const doors: Array<[string, string, Record<string, unknown>]> = [
	[
		"store_memory",
		"memories:storeMemory",
		{ namespace: "team/org-a", type: "project", content: "x", createdBy: "alpha" },
	],
	["get_memory", "memories:getMemory", { memoryId: MEMORY_ID }],
	["list_memories", "memories:listMemories", { namespace: "orchestrator/alpha" }],
	[
		"store_episode",
		"episodes:storeEpisode",
		{
			namespace: "team/org-a",
			createdBy: "alpha",
			context: "c",
			goal: "g",
			action: "a",
			outcome: "o",
			insight: "i",
			severity: "minor",
		},
	],
	["list_episodes", "memories:listMemories", { namespace: "orchestrator/alpha" }],
	[
		"write_diary",
		"diary:write",
		{ date: "2026-10-01", orchestrator: "alpha", content: "x" },
	],
	["get_diary", "diary:get", { date: "2026-10-01", orchestrator: "alpha" }],
	["list_diaries", "diary:list", { orchestrator: "user-a" }],
	[
		"export_okf_bundle",
		"okfBundleNode:exportOkfBundle",
		{ namespace: "orchestrator/alpha", format: "tarball" },
	],
	[
		"import_okf_bundle",
		"okfBundleNode:importOkfBundle",
		{ targetNamespace: "team/org-a", mode: "dry-run", storageId: "st1" },
	],
	["validate_okf_bundle", "okfBundleNode:validateOkfBundle", { storageId: "st1" }],
	[
		"store_document_chunked",
		"kb:storeDocumentChunked",
		{ storageId: "st1", mimeType: "text/markdown", filename: "a.md" },
	],
	["soft_delete_document", "kb:softDeleteDocument", { docId: "doc-1" }],
	["generate_upload_url", "kbMutations:generateUploadUrl", {}],
	["claim_upload", "kbMutations:claimUpload", { storageId: "st1", ticket: SHA }],
];

describe("a scoped bearer forwards its verified org to every content door", () => {
	for (const [tool, fn, args] of doors) {
		it(`${tool} -> ${fn} carries verifiedOrg { orgSlug: org-a }`, async () => {
			const h = harness(scoped({ namespaceWritePrefixes: ["team/org-a"] }));
			const r = await h.call(tool, args);
			expect(r.isError, JSON.stringify(r)).not.toBe(true);
			const call = h.calls.find((c) => c.fn === fn);
			expect(call, `${fn} was never reached`).toBeDefined();
			expect(call?.args.verifiedOrg).toEqual({ orgSlug: "org-a" });
		});

		it(`${tool}: the org is never taken from a tool argument`, async () => {
			const h = harness(scoped({ namespaceWritePrefixes: ["team/org-a"] }));
			await h.call(tool, { ...args, verifiedOrg: { orgSlug: "org-b" } });
			const call = h.calls.find((c) => c.fn === fn);
			expect(call?.args.verifiedOrg).toEqual({ orgSlug: "org-a" });
		});
	}

	it("the agent credential's org wins over the token row's (verified actor)", async () => {
		const h = harness(
			scoped({
				namespaceWritePrefixes: ["team/org-a"],
				actor: { agentId: "ag1", orgSlug: "org-actor", agentName: "alpha" },
			}),
		);
		await h.call("get_diary", { date: "2026-10-01", orchestrator: "alpha" });
		expect(h.calls[0]?.args.verifiedOrg).toEqual({ orgSlug: "org-actor" });
	});
});

describe("the fleet master has no organisation to forward", () => {
	for (const [tool, fn, args] of doors.filter(([t]) =>
		["store_memory", "get_memory", "list_memories", "write_diary", "get_diary"].includes(t),
	)) {
		it(`${tool} -> ${fn} carries no verifiedOrg (the door decides what a claimless call is)`, async () => {
			const h = harness(master());
			await h.call(tool, args);
			const call = h.calls.find((c) => c.fn === fn);
			expect(call).toBeDefined();
			expect(call?.args.verifiedOrg).toBeUndefined();
		});
	}
});

describe("a bearer whose org cannot be resolved is refused before Convex", () => {
	for (const [tool, , args] of doors.filter(([t]) =>
		[
			"store_memory",
			"get_memory",
			"list_memories",
			"store_episode",
			"list_episodes",
			"write_diary",
			"get_diary",
			"list_diaries",
		].includes(t),
	)) {
		it(`${tool}`, async () => {
			const h = harness(scoped({ clerkOrgSlug: undefined, actor: undefined }));
			const r = await h.call(tool, args);
			expect(r.isError).toBe(true);
			expect(r.content?.[0]?.text).toMatch(
				/verified-org-unresolved|AGENT_CREDENTIAL_REQUIRED|Forbidden/,
			);
			expect(h.calls).toEqual([]);
		});
	}
});
