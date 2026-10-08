/**
 * list_peers lists the caller's ORGANISATION roster, not its fromAllowList.
 *
 * VantagePeers Cloud, org Iris RH, client incident (task
 * k1716f01f9g1a0scz7nj30118h8fx32c). Each Iris RH seat token was narrowed to
 * its own name (clio -> ["clio"]) so that it only reads messages addressed to
 * it. list_peers filtered profiles on that same allowlist, so Clio saw only
 * herself and concluded Helios was not in the org. `fromAllowList` governs who
 * a token may ACT AS; it is not the org directory.
 *
 * Every pole runs the real registered handler over a mocked Convex client.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
type ToolResult = {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
};

const HELIOS = "hélios";
const HELIOS_DECOMPOSED = "hélios";

function buildFakeServer() {
	const handlers = new Map<string, ToolHandler>();
	const reg = (...args: unknown[]) => {
		handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
		return {};
	};
	return {
		server: { tool: reg, registerTool: reg } as unknown as McpServer,
		handlers,
	};
}

function profile(orchestratorId: string, createdAt: number) {
	return {
		_id: `profile-${orchestratorId}`,
		_creationTime: createdAt,
		orchestratorId,
		name: orchestratorId,
		static: { role: "agent", workspace: "/w", capabilities: [] },
		dynamic: { lastSeen: createdAt, sessionCount: 1 },
	};
}

// profiles of TWO organisations live in the one global table.
const PROFILES = [
	profile("clio", 1780000009000),
	profile(HELIOS, 1780000008000),
	profile("marie", 1780000007000),
	profile("victor", 1780000006000),
	profile("zoe-other-org", 1780000005000),
	profile("beta", 1780000004000),
];

function seat(over: Partial<OAuthContext>): OAuthContext {
	return {
		clientId: "client-clio",
		userId: "user-clio",
		scopes: ["mcp:full"],
		scopeProfile: "tenant",
		fromAllowList: ["clio"],
		namespaceReadPrefixes: ["team/iris-rh"],
		namespaceWritePrefixes: ["team/iris-rh"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		accessTokenHash: "hash-clio",
		clerkOrgSlug: "iris-rh",
		...over,
	};
}

function mockConvex(roster: unknown) {
	const query = vi.fn(async (door: string) => {
		if (door === "profiles:listProfiles") return PROFILES;
		if (door.startsWith("orgRoster:")) {
			if (roster instanceof Error) throw roster;
			return roster;
		}
		return [];
	});
	const mutation = vi.fn().mockResolvedValue(null);
	return {
		convex: { query, mutation, action: vi.fn() } as unknown as ConvexHttpClient,
		query,
		mutation,
	};
}

async function listPeers(
	ctx: OAuthContext,
	roster: unknown,
): Promise<{
	ids: string[];
	raw: ToolResult;
	query: ReturnType<typeof vi.fn>;
}> {
	const { server, handlers } = buildFakeServer();
	const m = mockConvex(roster);
	registerTools(server, m.convex, ctx);
	const raw = (await handlers.get("list_peers")?.({})) as ToolResult;
	let ids: string[] = [];
	if (!raw.isError) {
		const parsed = JSON.parse(raw.content[0].text);
		const rows = Array.isArray(parsed) ? parsed : parsed.items;
		ids = rows.map((r: { id: string }) => r.id);
	}
	return { ids, raw, query: m.query };
}

const IRIS_ROSTER = ["clio", HELIOS, "marie", "victor"];

describe("list_peers - org roster listing for a non-master token with an org", () => {
	it("Iris-shaped token (fromAllowList [clio]) lists helios, marie, victor", async () => {
		const { ids } = await listPeers(seat({}), IRIS_ROSTER);
		expect(ids).toEqual(
			expect.arrayContaining(["clio", HELIOS, "marie", "victor"]),
		);
	});

	it("never lists an agent of another org present in profiles", async () => {
		const { ids } = await listPeers(seat({}), IRIS_ROSTER);
		expect(ids).not.toContain("zoe-other-org");
		expect(ids).not.toContain("beta");
		expect(ids).toHaveLength(4);
	});

	it("a wildcard roster entry never widens the directory to other orgs", async () => {
		const { ids } = await listPeers(seat({}), ["*"]);
		expect(ids).toEqual([]);
	});

	it("matches accented and unaccented/decomposed roster spellings", async () => {
		const decomposed = await listPeers(seat({}), [HELIOS_DECOMPOSED, "MARIE"]);
		expect(decomposed.ids.sort()).toEqual([HELIOS, "marie"].sort());
		// No accent folding: "helios" is a different identifier from "hélios".
		const folded = await listPeers(seat({}), ["helios"]);
		expect(folded.ids).toEqual([]);
	});

	it("Clerk-JWT session reads the roster through getMyOrgRoster", async () => {
		const { ids, query } = await listPeers(
			seat({ accessTokenHash: undefined, clerkJwt: "jwt" }),
			IRIS_ROSTER,
		);
		expect(ids).toHaveLength(4);
		expect(query).toHaveBeenCalledWith("orgRoster:getMyOrgRoster", {});
	});

	it("token path reads only the roster of ITS OWN token hash (no org argument)", async () => {
		const { query } = await listPeers(seat({}), IRIS_ROSTER);
		expect(query).toHaveBeenCalledWith("orgRoster:getForAccessToken", {
			tokenHash: "hash-clio",
		});
	});

	it("a refusal envelope from the roster door is surfaced, not coalesced to []", async () => {
		const { raw } = await listPeers(seat({}), { refused: true, items: [] });
		expect(raw.isError).toBe(true);
		expect(raw.content[0].text).toContain("REFUSED (RBAC_DENIED)");
		expect(raw.content[0].text).toContain("orgRoster:getForAccessToken");
	});

	it("a roster door that raises is an error result, not an empty directory", async () => {
		const { raw } = await listPeers(
			seat({}),
			new Error("RBAC_DENIED: access token not found"),
		);
		expect(raw.isError).toBe(true);
	});
});

describe("list_peers - unchanged paths", () => {
	it("master token: every profile, roster door never consulted", async () => {
		const { ids, query } = await listPeers(LOCAL_STDIO_TRUST_CTX, IRIS_ROSTER);
		expect(ids).toHaveLength(PROFILES.length);
		expect(query).not.toHaveBeenCalledWith(
			expect.stringMatching(/^orgRoster:/),
			expect.anything(),
		);
	});

	it("token with no org: still filtered on fromAllowList, roster never consulted", async () => {
		const { ids, query } = await listPeers(
			seat({ clerkOrgSlug: undefined, fromAllowList: ["clio"] }),
			IRIS_ROSTER,
		);
		expect(ids).toEqual(["clio"]);
		expect(query).not.toHaveBeenCalledWith(
			expect.stringMatching(/^orgRoster:/),
			expect.anything(),
		);
	});
});

describe("send_message - acting is NOT widened by the directory change", () => {
	it("Clio's token still cannot send as helios, and nothing is written", async () => {
		const { server, handlers } = buildFakeServer();
		const m = mockConvex(IRIS_ROSTER);
		registerTools(server, m.convex, seat({}));
		const res = (await handlers.get("send_message")?.({
			from: HELIOS,
			to: "marie",
			content: "impersonation attempt",
		})) as ToolResult;
		expect(res.isError).toBe(true);
		expect(m.mutation).not.toHaveBeenCalled();
	});
});
