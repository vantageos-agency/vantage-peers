/**
 * VantagePeers Cloud MCP: a seat reads the documents it ingested.
 *
 * Defect (prod, probe-tenant-a seat): store_document_chunked files a document under
 * team/<clerkOrgId>/<docId>, but hybrid_search namespace="team/<clerkOrgId>" was
 * refused "is not readable by scope_profile=probe-a-probe-tenant-a" because the
 * seat's read prefixes are orchestrator/<agent> and project/<org>. The read
 * authority over team/<own org ID> is derived from the VERIFIED org (the org ID
 * Convex resolves from the token's org mapping, `orgClerkId`), prefix lists
 * unchanged, never another org's namespace.
 *
 * Poles: (1) own org's doc namespace is readable; (2) another org's is REFUSED
 * with the Forbidden message (not empty); (3) no verified org -> unchanged
 * refusal; (4) master unchanged; plus the tool-level path of hybrid_search /
 * recall / text_search.
 */
import { describe, expect, it, vi } from "vitest";
import { checkNamespaceRead, type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const X_ID = "org_3LNrkwDqi5j1lIf5ZSN1DPaMAYW";
const Y_ID = "org_OTHERTENANT0000000000000001";

const seat = (extra: Partial<OAuthContext> = {}): OAuthContext =>
	({
		clientId: "seat-probe-a",
		userId: "u",
		scopes: ["mcp:full"],
		scopeProfile: "probe-a-probe-tenant-a",
		fromAllowList: ["probe-a"],
		namespaceReadPrefixes: ["orchestrator/probe-a", "project/probe-tenant-a"],
		namespaceWritePrefixes: ["orchestrator/probe-a", "project/probe-tenant-a"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		clerkOrgSlug: "probe-tenant-a",
		accessTokenHash: "h",
		...extra,
	}) as OAuthContext;

describe("checkNamespaceRead: a seat reads team/<its verified org ID>", () => {
	it("pole 1: the org's own namespace and the doc namespaces under it are readable", () => {
		const ctx = seat({ orgClerkId: X_ID });
		expect(checkNamespaceRead(ctx, `team/${X_ID}`)).toBeNull();
		expect(checkNamespaceRead(ctx, `team/${X_ID}/doc-1`)).toBeNull();
	});

	it("pole 2: another org's namespace is REFUSED with a Forbidden message, never null", () => {
		const ctx = seat({ orgClerkId: X_ID });
		for (const ns of [
			`team/${Y_ID}`,
			`team/${Y_ID}/doc-1`,
			`team/${X_ID}extra`,
			`team/${X_ID}-2/doc`,
			"team/probe-tenant-a",
			"team",
			"team/",
		]) {
			expect(checkNamespaceRead(ctx, ns), ns).toMatch(/^Forbidden: namespace=/);
		}
	});

	it("pole 3: no verified org ID -> the unchanged refusal", () => {
		const ctx = seat();
		expect(checkNamespaceRead(ctx, `team/${X_ID}`)).toBe(
			"Forbidden: namespace='team/org_3LNrkwDqi5j1lIf5ZSN1DPaMAYW' is not readable by scope_profile=probe-a-probe-tenant-a.",
		);
	});

	it("the prefix lists are unchanged and still admit their own namespaces", () => {
		const ctx = seat({ orgClerkId: X_ID });
		expect(checkNamespaceRead(ctx, "project/probe-tenant-a/x")).toBeNull();
		expect(checkNamespaceRead(ctx, "global")).toMatch(/^Forbidden/);
	});

	it("pole 4: master is unchanged", () => {
		const master = {
			...seat(),
			isMaster: true,
			scopeProfile: "master",
			namespaceReadPrefixes: ["*"],
		} as OAuthContext;
		expect(checkNamespaceRead(master, `team/${Y_ID}`)).toBeNull();
	});

	it("an org ID cannot be claimed by a master-less context that has none, nor by an empty one", () => {
		expect(checkNamespaceRead(seat({ orgClerkId: "" }), "team/")).toMatch(/^Forbidden/);
		expect(checkNamespaceRead(undefined, `team/${X_ID}`)).toMatch(/^Forbidden/);
	});
});

describe("hybrid_search / text_search / recall reach Convex for the seat's own org only", () => {
	function setup(ctx: OAuthContext) {
		const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
		const server = {
			registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h),
			tool: (n: string, _d: unknown, _s: unknown, _a: unknown, h: never) => handlers.set(n, h),
		};
		const action = vi.fn().mockResolvedValue([]);
		const convex = { action, query: vi.fn(), mutation: vi.fn() };
		registerTools(server as never, convex as never, ctx);
		return { handlers, action };
	}

	for (const tool of ["hybrid_search", "text_search", "recall"]) {
		it(`${tool}: own org namespace is searched; another org's is refused before Convex`, async () => {
			const { handlers, action } = setup(seat({ orgClerkId: X_ID }));
			const h = handlers.get(tool);
			if (!h) throw new Error(`${tool} not registered`);
			await h({ query: "q", namespace: `team/${X_ID}` });
			expect(action).toHaveBeenCalledTimes(1);
			const refused = (await h({ query: "q", namespace: `team/${Y_ID}` })) as {
				isError?: boolean;
				content: { text: string }[];
			};
			expect(action).toHaveBeenCalledTimes(1);
			expect(refused.isError).toBe(true);
			expect(refused.content[0]?.text).toMatch(/Forbidden: namespace=/);
		});
	}
});
