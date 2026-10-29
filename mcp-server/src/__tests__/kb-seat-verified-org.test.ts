/**
 * VantagePeers Cloud MCP: the KB tools act for the bearer's VERIFIED organisation.
 *
 * Defect (prod MCP 6445c310, seat bearer probe-a, org probe-tenant-a):
 * generate_upload_url -> "AUTH_NO_ORG_ID: oauthCtx.namespaceWritePrefixes[0] =
 * 'orchestrator/probe-a' does not match ^team\/[^/]+$". The org was read from the
 * ORDER of namespaceWritePrefixes, which for a seat starts with its agent prefix.
 *
 * Poles: (1) a seat acts on its verified org; (2) a seat never reaches another
 * org's namespace; (3) no verified org -> AUTH_NO_ORG_ID; (4) the team/<org>
 * bearer path is unchanged.
 */
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { DOOR_SCOPE } from "../doorScope.js";
import { registerKbIngestTools } from "../tools/kbIngest.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function makeStubServer() {
	const handlers = new Map<string, ToolHandler>();
	return {
		tool(_n: string, _d: string, _s: unknown, _a: unknown, h: ToolHandler) {
			handlers.set(_n, h);
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
	const mutation = vi.fn().mockImplementation(async (ref: string) =>
		ref === "kbMutations:generateUploadUrlWithTicket"
			? { uploadUrl: "https://u", ticket: "t", expiresAt: 1 }
			: "https://upload.example/url",
	);
	return {
		stub: { action, mutation } as unknown as ConvexHttpClient,
		action,
		mutation,
	};
}

const now = Date.now();
const base = {
	userId: "u",
	scopes: ["mcp:full"],
	expiresAt: now + 3_600_000,
	isMaster: false,
};

/** A client seat bearer exactly as prod whoami shows it. */
const seatCtx = (verifiedSlug: string | undefined, extraPrefixes: string[] = []) =>
	({
		...base,
		clientId: "seat-probe-a",
		scopeProfile: "client-generic",
		fromAllowList: ["probe-a"],
		namespaceReadPrefixes: ["orchestrator/probe-a", "project/probe-tenant-a"],
		namespaceWritePrefixes: [
			"orchestrator/probe-a",
			"project/probe-tenant-a",
			...extraPrefixes,
		],
		...(verifiedSlug !== undefined ? { clerkOrgSlug: verifiedSlug } : {}),
		accessTokenHash: "hash-probe-a",
	}) as OAuthContext;

const teamACtx = {
	...base,
	clientId: "dcr-clerk-org-A",
	scopeProfile: "team-member",
	fromAllowList: [],
	namespaceReadPrefixes: ["team/org-A"],
	namespaceWritePrefixes: ["team/org-A"],
} as OAuthContext;

function setup(ctx: OAuthContext) {
	const server = makeStubServer();
	const convex = makeStubConvex();
	registerKbIngestTools(server as never, convex.stub, ctx);
	const tool = (name: string): ToolHandler => {
		const h = server.handlers.get(name);
		if (!h) throw new Error(`${name} not registered`);
		return h;
	};
	return { ...convex, tool };
}

const STORE_ARGS = { storageId: "sid", mimeType: "text/markdown", filename: "a.md" };

describe("pole 1: a seat acts on its verified org", () => {
	it("generate_upload_url issues the URL, forwarding the verified org", async () => {
		const { tool, mutation } = setup(seatCtx("probe-tenant-a"));
		await tool("generate_upload_url")({});
		expect(mutation).toHaveBeenCalledOnce();
		const [ref, args] = mutation.mock.calls[0] as [string, Record<string, unknown>];
		expect(ref).toBe("kbMutations:generateUploadUrl");
		expect(args).toMatchObject({
			orgId: "probe-tenant-a",
			namespace: "team/probe-tenant-a",
			verifiedOrg: { orgSlug: "probe-tenant-a" },
		});
	});

	it("generate_upload_url with sha256 mints the ticket for the verified org", async () => {
		const { tool, mutation } = setup(seatCtx("probe-tenant-a"));
		await tool("generate_upload_url")({ sha256: "a".repeat(64) });
		const [ref, args] = mutation.mock.calls[0] as [string, Record<string, unknown>];
		expect(ref).toBe("kbMutations:generateUploadUrlWithTicket");
		expect(args).toMatchObject({
			orgId: "probe-tenant-a",
			verifiedOrg: { orgSlug: "probe-tenant-a" },
		});
	});

	it("store_document_chunked and soft_delete_document act on the verified org", async () => {
		const { tool, action } = setup(seatCtx("probe-tenant-a"));
		await tool("store_document_chunked")(STORE_ARGS);
		await tool("soft_delete_document")({ docId: "doc-1" });
		for (const call of action.mock.calls as [string, Record<string, unknown>][]) {
			expect(call[1]).toMatchObject({
				orgId: "probe-tenant-a",
				namespace: "team/probe-tenant-a",
				verifiedOrg: { orgSlug: "probe-tenant-a" },
			});
		}
		expect(action).toHaveBeenCalledTimes(2);
	});

	it("claim_upload forwards the verified org", async () => {
		const { tool, mutation } = setup(seatCtx("probe-tenant-a"));
		await tool("claim_upload")({ storageId: "sid", ticket: "t" });
		const [, args] = mutation.mock.calls[0] as [string, Record<string, unknown>];
		expect(args).toMatchObject({ verifiedOrg: { orgSlug: "probe-tenant-a" } });
	});

	it("an agent credential's org is the verified org", async () => {
		const ctx = {
			...seatCtx(undefined),
			actor: { orgSlug: "probe-tenant-a", agentName: "probe-a" },
		} as OAuthContext;
		const { tool, mutation } = setup(ctx);
		await tool("generate_upload_url")({});
		expect(mutation.mock.calls[0]?.[1]).toMatchObject({ orgId: "probe-tenant-a" });
	});
});

describe("pole 2: a seat never reaches another org's namespace", () => {
	it("a team/<other> prefix in the seat's prefixes does not win over the verified org", async () => {
		const { tool, action, mutation } = setup(
			seatCtx("probe-tenant-a", ["team/probe-tenant-b"]),
		);
		await tool("store_document_chunked")(STORE_ARGS);
		await tool("soft_delete_document")({ docId: "doc-b" });
		await tool("generate_upload_url")({});
		const all = [...action.mock.calls, ...mutation.mock.calls] as [
			string,
			Record<string, unknown>,
		][];
		expect(all.length).toBe(3);
		for (const [, args] of all) {
			expect(args.orgId).toBe("probe-tenant-a");
			expect(args.namespace).toBe("team/probe-tenant-a");
			expect(JSON.stringify(args)).not.toContain("probe-tenant-b");
		}
	});

	it("soft_delete_document takes no org argument: a caller cannot name org B", async () => {
		const { tool, action } = setup(seatCtx("probe-tenant-a"));
		await tool("soft_delete_document")({ docId: "x", orgId: "probe-tenant-b" });
		expect((action.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({
			orgId: "probe-tenant-a",
		});
	});
});

describe("pole 3: no verified org still refuses AUTH_NO_ORG_ID", () => {
	it.each(["generate_upload_url", "store_document_chunked", "soft_delete_document"])(
		"%s on a seat with no verified org",
		async (name) => {
			const { tool, action, mutation } = setup(seatCtx(undefined));
			await expect(
				tool(name)({ ...STORE_ARGS, docId: "d" }),
			).rejects.toThrow(/AUTH_NO_ORG_ID/);
			expect(action).not.toHaveBeenCalled();
			expect(mutation).not.toHaveBeenCalled();
		},
	);

	it("an undefined context is refused", async () => {
		const { tool } = setup(undefined as unknown as OAuthContext);
		await expect(tool("generate_upload_url")({})).rejects.toThrow();
	});
});

describe("pole 4: the team/<org> bearer path is unchanged", () => {
	it("derives org-A from the team prefix and forwards no verifiedOrg", async () => {
		const { tool, action, mutation } = setup(teamACtx);
		await tool("store_document_chunked")(STORE_ARGS);
		await tool("generate_upload_url")({});
		expect((action.mock.calls[0] as [string, Record<string, unknown>])[1]).toEqual({
			...STORE_ARGS,
			docId: undefined,
			orgId: "org-A",
			namespace: "team/org-A",
		});
		expect((mutation.mock.calls[0] as [string, Record<string, unknown>])[1]).toEqual({
			orgId: "org-A",
			namespace: "team/org-A",
		});
	});
});

describe("DOOR_SCOPE pins the KB doors", () => {
	it.each([
		"kb:storeDocumentChunked",
		"kb:softDeleteDocument",
		"kbMutations:generateUploadUrl",
		"kbMutations:generateUploadUrlWithTicket",
		"kbMutations:claimUpload",
	])("%s forwards the verified org", (door) => {
		expect(DOOR_SCOPE[door]).toEqual({ verifiedOrg: "always" });
	});
});
