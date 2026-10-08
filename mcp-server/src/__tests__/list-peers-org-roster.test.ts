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

function profile(
	orchestratorId: string,
	createdAt: number,
	instanceId?: string,
	currentTask = "idle-work",
) {
	return {
		_id: `profile-${instanceId ?? orchestratorId}`,
		_creationTime: createdAt,
		orchestratorId,
		instanceId,
		name: orchestratorId,
		static: { role: "agent", workspace: "/w", capabilities: [] },
		dynamic: { lastSeen: createdAt, sessionCount: 1, currentTask },
	};
}

// profiles of SEVERAL organisations live in the one global table, newest first.
// Production shape: 61 rows, the Iris agents sit at index 0, 20, 21 and 50, so a
// page of 20 holds only the first. 24 filler rows of other orgs push helios past
// the first page; victor has NO profile row at all.
const FILLERS = Array.from({ length: 24 }, (_, i) =>
	profile(`filler-${i}`, 1780000008500 - i, `filler-${i}-other`),
);
const PROFILES = [
	profile("clio", 1780000009000, "clio-iris-rh"),
	...FILLERS,
	profile(HELIOS, 1780000008000, `${HELIOS}-iris-rh`),
	// SAME NAME, OTHER ORG: must never lend its dynamic fields to Iris.
	profile("marie", 1780000007500, "marie-acme", "SECRET-ACME-TASK"),
	profile("marie", 1780000007000, "marie-iris-rh"),
	profile("zoe-other-org", 1780000005000, "zoe-other-org-acme"),
	profile("beta", 1780000004000, "beta-acme"),
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
	const query = vi.fn(async (door: string, args?: Record<string, unknown>) => {
		if (door === "profiles:listProfiles") {
			const only = args?.orchestratorId;
			if (typeof only === "string") {
				return PROFILES.filter((p) => p.orchestratorId === only);
			}
			return PROFILES.slice(0, (args?.limit as number | undefined) ?? 50);
		}
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

type Peer = Record<string, unknown> & { id: string };

async function peersOf(ctx: OAuthContext, roster: unknown): Promise<Peer[]> {
	const { raw } = await listPeers(ctx, roster);
	const parsed = JSON.parse(raw.content[0].text);
	return Array.isArray(parsed) ? parsed : parsed.items;
}

describe("list_peers - org roster listing for a non-master token with an org", () => {
	it("Iris-shaped token (fromAllowList [clio]) lists helios, marie, victor", async () => {
		const { ids } = await listPeers(seat({}), IRIS_ROSTER);
		expect(ids).toEqual(
			expect.arrayContaining(["clio", HELIOS, "marie", "victor"]),
		);
	});

	it("lists a roster agent whose profile sits BEYOND the first page of profiles", async () => {
		// helios is row 25 of 29: a page of 20 never contains it.
		expect(
			PROFILES.findIndex((p) => p.orchestratorId === HELIOS),
		).toBeGreaterThan(20);
		const peers = await peersOf(seat({}), IRIS_ROSTER);
		const helios = peers.find((p) => p.id === HELIOS);
		expect(helios).toBeDefined();
		expect(helios?.sessionCount).toBe(1);
	});

	it("lists a roster agent that has NO profile row, as a minimal entry", async () => {
		const peers = await peersOf(seat({}), IRIS_ROSTER);
		const victor = peers.find((p) => p.id === "victor");
		expect(victor).toEqual({
			id: "victor",
			instanceId: "victor",
			name: "victor",
			role: null,
			workspace: null,
			currentTask: null,
			lastSeen: null,
			sessionCount: null,
		});
	});

	it("a same-named profile of ANOTHER org does not leak its dynamic fields", async () => {
		const peers = await peersOf(seat({}), IRIS_ROSTER);
		const marie = peers.filter((p) => p.id === "marie");
		expect(marie).toHaveLength(1);
		expect(JSON.stringify(peers)).not.toContain("SECRET-ACME-TASK");
		expect(JSON.stringify(peers)).not.toContain("marie-acme");
		expect(marie[0].instanceId).toBe("marie-iris-rh");
	});

	it("a roster name with only another org's row is listed WITHOUT that row's data", async () => {
		const peers = await peersOf(seat({}), ["zoe-other-org"]);
		expect(peers).toHaveLength(1);
		expect(peers[0].sessionCount).toBeNull();
		expect(JSON.stringify(peers)).not.toContain("zoe-other-org-acme");
	});

	it("never lists an agent of another org that is not on the roster", async () => {
		const { ids } = await listPeers(seat({}), IRIS_ROSTER);
		expect(ids).not.toContain("zoe-other-org");
		expect(ids).not.toContain("beta");
		expect(ids.some((i) => i.startsWith("filler-"))).toBe(false);
		expect(ids).toHaveLength(4);
	});

	it("a wildcard roster entry never widens the directory to other orgs", async () => {
		const { ids } = await listPeers(seat({}), ["*"]);
		expect(ids).toEqual([]);
	});

	it("matches roster spellings NFC and case-folded, never accent-folded", async () => {
		const decomposed = await listPeers(seat({}), [HELIOS_DECOMPOSED, "MARIE"]);
		expect(decomposed.ids).toHaveLength(2);
		const folded = await peersOf(seat({}), ["helios"]);
		expect(folded).toHaveLength(1);
		expect(folded[0].sessionCount).toBeNull(); // no row for the unaccented spelling
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
		expect(ids).toHaveLength(20); // master path: first page (default limit 20), unchanged
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
