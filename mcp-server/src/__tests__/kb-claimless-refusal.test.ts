/**
 * S-28 batch 3: a KB door that takes the caller's verified organisation is never
 * called claimless. A bearer that resolves no verified organisation (it carries
 * only a team/<org> write prefix, no verified slug, and no Clerk session) is
 * refused with a typed RBAC_DENIED / verified-org-unresolved before the door is
 * reached. The master and a Clerk-session caller keep the paths they have today.
 *
 * Per site (door -> tool):
 *   kb:storeDocumentChunked                    store_document_chunked
 *   kb:softDeleteDocument                      soft_delete_document
 *   kbMutations:generateUploadUrl              generate_upload_url (no sha256)
 *   kbMutations:generateUploadUrlWithTicket    generate_upload_url (sha256)
 *   kbMutations:claimUpload                    claim_upload
 */
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerKbIngestTools } from "../tools/kbIngest.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function makeStubServer() {
	const handlers = new Map<string, ToolHandler>();
	return {
		tool(n: string, _d: string, _s: unknown, _a: unknown, h: ToolHandler) {
			handlers.set(n, h);
		},
		registerTool(name: string, _config: unknown, handler: ToolHandler) {
			handlers.set(name, handler);
		},
		handlers,
	};
}

function makeStubConvex() {
	const action = vi
		.fn()
		.mockResolvedValue({ docId: "d", chunkCount: 1, storageId: "s" });
	const mutation = vi.fn().mockImplementation(async (ref: string) => {
		if (ref === "kbMutations:generateUploadUrlWithTicket")
			return { uploadUrl: "https://u", ticket: "t", expiresAt: 1 };
		if (ref === "kbMutations:claimUpload")
			return { storageId: "sid", orgId: "org-A" };
		return "https://upload.example/url";
	});
	return { stub: { action, mutation } as unknown as ConvexHttpClient, action, mutation };
}

const base = {
	userId: "u",
	scopes: ["mcp:full"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
};

/** Verified: the token row names the organisation. */
const verifiedCtx = {
	...base,
	clientId: "seat-a",
	scopeProfile: "client-generic",
	fromAllowList: ["a"],
	namespaceReadPrefixes: ["team/org-A"],
	namespaceWritePrefixes: ["team/org-A"],
	clerkOrgSlug: "org-A",
	accessTokenHash: "hash-a",
} as OAuthContext;

/** Claimless: a team/<org> write prefix, no verified slug, no Clerk session. */
const claimlessCtx = {
	...base,
	clientId: "dcr-prefix-only",
	scopeProfile: "team-member",
	fromAllowList: [],
	namespaceReadPrefixes: ["team/org-A"],
	namespaceWritePrefixes: ["team/org-A"],
} as OAuthContext;

/** A Clerk session: its own org is seen by Convex, no verified slug here. */
const clerkCtx = {
	...claimlessCtx,
	clerkJwt: "jwt-a",
} as OAuthContext;

function setup(ctx: OAuthContext | undefined) {
	const server = makeStubServer();
	const convex = makeStubConvex();
	registerKbIngestTools(server as never, convex.stub, ctx as OAuthContext);
	const tool = (name: string): ToolHandler => {
		const h = server.handlers.get(name);
		if (!h) throw new Error(`${name} not registered`);
		return h;
	};
	return { ...convex, tool };
}

const SHA = "a".repeat(64);

const SITES: ReadonlyArray<{
	site: string;
	door: string;
	tool: string;
	args: Record<string, unknown>;
	kind: "action" | "mutation";
}> = [
	{
		site: "kbIngest.ts:314",
		door: "kb:storeDocumentChunked",
		tool: "store_document_chunked",
		args: { storageId: "sid", mimeType: "text/markdown", filename: "a.md" },
		kind: "action",
	},
	{
		site: "kbIngest.ts:374",
		door: "kb:softDeleteDocument",
		tool: "soft_delete_document",
		args: { docId: "doc-1" },
		kind: "action",
	},
	{
		site: "kbIngest.ts:436",
		door: "kbMutations:generateUploadUrl",
		tool: "generate_upload_url",
		args: {},
		kind: "mutation",
	},
	{
		site: "kbIngest.ts:457",
		door: "kbMutations:generateUploadUrlWithTicket",
		tool: "generate_upload_url",
		args: { sha256: SHA },
		kind: "mutation",
	},
	{
		site: "kbIngest.ts:524",
		door: "kbMutations:claimUpload",
		tool: "claim_upload",
		args: { storageId: "sid", ticket: "t" },
		kind: "mutation",
	},
];

describe.each(SITES)("$site $door via $tool", (s) => {
	it("a verified caller: the door receives the verified org claim", async () => {
		const h = setup(verifiedCtx);
		await h.tool(s.tool)(s.args);
		const calls = (s.kind === "action" ? h.action : h.mutation).mock
			.calls as [string, Record<string, unknown>][];
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe(s.door);
		expect(calls[0][1]).toMatchObject({ verifiedOrg: { orgSlug: "org-A" } });
	});

	it("a claimless bearer: typed refusal, no door call", async () => {
		const h = setup(claimlessCtx);
		await expect(h.tool(s.tool)(s.args)).rejects.toThrow(
			/RBAC_DENIED[\s\S]*verified-org-unresolved/,
		);
		expect(h.action).not.toHaveBeenCalled();
		expect(h.mutation).not.toHaveBeenCalled();
	});

	it("a Clerk-session caller is not refused (Convex sees its org)", async () => {
		const h = setup(clerkCtx);
		await h.tool(s.tool)(s.args);
		const calls = (s.kind === "action" ? h.action : h.mutation).mock.calls;
		expect(calls).toHaveLength(1);
	});
});

describe("claim_upload has no org context of its own", () => {
	it("an undefined context is refused before the door", async () => {
		const h = setup(undefined);
		await expect(
			h.tool("claim_upload")({ storageId: "sid", ticket: "t" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(h.mutation).not.toHaveBeenCalled();
	});
});
