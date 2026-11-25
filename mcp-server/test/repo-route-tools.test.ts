/**
 * get_repo_route -> githubRepoMapping:getRoute and check_repo_routing -> getRoute (per repo) +
 * githubRepoMapping:list (all pages) — task k172cv547rpthxtv3geny7nqv58jwhmf; VantagePeers Cloud +
 * Self-host.
 *
 * Backend half: githubRepoMapping:getRoute answers routed | unreviewed | absent for the caller's own
 * org and RAISES a caller with no org. These tools forward the verified org, never hide a state
 * behind an empty success, and never read a repository list from memory: the completeness check
 * compares the caller's real repository list with every row of the org's table.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	ACTOR_CREDENTIAL_MODE_ENV,
	type OAuthContext,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const ORG = "acme-hr";
const CLIO_ID = "agentclio0000000000000000000001";

const base: OAuthContext = {
	clientId: "client-x",
	userId: "user-x",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "p",
	fromAllowList: ["clio"],
	namespaceReadPrefixes: ["orchestrator/clio"],
	namespaceWritePrefixes: ["orchestrator/clio"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	accessTokenHash: "hash-x",
};
const CLIENT_SEAT: OAuthContext = {
	...base,
	clerkOrgSlug: ORG,
	seatAgent: { agentId: CLIO_ID, orgId: ORG, agentName: "clio" },
};
const NO_ORG: OAuthContext = { ...base };

type Result = {
	isError?: boolean;
	content?: Array<{ text?: string }>;
	structuredContent?: Record<string, unknown>;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;
type Call = { name: string; args: Record<string, unknown> };
type Route =
	| {
			state: "routed";
			owner: string;
			reviewer: string;
			fallbackReviewer?: string;
	  }
	| { state: "unreviewed"; owner: string }
	| { state: "out-of-scope"; reason: string }
	| { state: "absent" };

/** One fake backend: getRoute answers from `routes`, list answers page by page from `pages`. */
async function run(
	tool: "get_repo_route" | "check_repo_routing",
	ctx: OAuthContext,
	args: Record<string, unknown>,
	backend: {
		routes?: Record<string, Route>;
		pages?: Array<{
			items: Array<{ repo: string }>;
			nextCursor: string | null;
		}>;
	} = {},
) {
	const tools = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		tools.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const server = { tool: reg, registerTool: reg } as unknown as McpServer;
	const calls: Call[] = [];
	const client = {
		query: vi.fn(async (name: string, a: Record<string, unknown>) => {
			calls.push({ name, args: a });
			if (name === "githubRepoMapping:getRoute") {
				return backend.routes?.[a.repo as string] ?? { state: "absent" };
			}
			if (name === "githubRepoMapping:list") {
				const pages = backend.pages ?? [{ items: [], nextCursor: null }];
				const at =
					a.cursor === undefined ? 0 : Number(String(a.cursor).slice(1));
				return pages[at];
			}
			return null;
		}),
		mutation: vi.fn(async () => null),
		action: vi.fn(async () => null),
	};
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, client as any, ctx);
	const handler = tools.get(tool);
	if (!handler) throw new Error(`${tool} was not registered`);
	const r = await handler(args);
	const text = r.content?.[0]?.text ?? "";
	return {
		calls,
		text,
		refused: r.isError === true,
		structured: r.structuredContent,
		body:
			r.isError === true ? null : (JSON.parse(text) as Record<string, unknown>),
	};
}

let savedMode: string | undefined;
beforeEach(() => {
	savedMode = process.env[ACTOR_CREDENTIAL_MODE_ENV];
	process.env[ACTOR_CREDENTIAL_MODE_ENV] = "permissive";
	_resetUnattributedClaimsForTest();
	vi.spyOn(console, "error").mockImplementation(() => {});
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	_setInternalClientForTest({ query: async () => null } as any);
});
afterEach(() => {
	if (savedMode === undefined) delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	else process.env[ACTOR_CREDENTIAL_MODE_ENV] = savedMode;
	vi.restoreAllMocks();
	_resetUnattributedClaimsForTest();
	_setInternalClientForTest(null);
});

describe("get_repo_route", () => {
	it("a routed repo returns owner, reviewer and fallbackReviewer", async () => {
		const r = await run(
			"get_repo_route",
			CLIENT_SEAT,
			{ repo: "acme/app" },
			{
				routes: {
					"acme/app": {
						state: "routed",
						owner: "clio",
						reviewer: "eta",
						fallbackReviewer: "pi",
					},
				},
			},
		);
		expect(r.refused, r.text).toBe(false);
		expect(r.body).toMatchObject({
			state: "routed",
			repo: "acme/app",
			owner: "clio",
			reviewer: "eta",
			fallbackReviewer: "pi",
		});
		expect(r.structured).toEqual(r.body);
	});

	it("an unreviewed repo returns state unreviewed and its owner, no reviewer", async () => {
		const r = await run(
			"get_repo_route",
			CLIENT_SEAT,
			{ repo: "acme/app" },
			{
				routes: { "acme/app": { state: "unreviewed", owner: "clio" } },
			},
		);
		expect(r.body).toMatchObject({
			state: "unreviewed",
			repo: "acme/app",
			owner: "clio",
		});
		expect(r.body).not.toHaveProperty("reviewer");
	});

	it("an out-of-scope repo returns its state and reason, no owner", async () => {
		const r = await run(
			"get_repo_route",
			CLIENT_SEAT,
			{ repo: "acme/fork" },
			{
				routes: {
					"acme/fork": {
						state: "out-of-scope",
						reason: "no owning station, no activity in 30 days",
					},
				},
			},
		);
		expect(r.refused, r.text).toBe(false);
		expect(r.body).toEqual({
			state: "out-of-scope",
			reason: "no owning station, no activity in 30 days",
			repo: "acme/fork",
		});
		expect(r.structured).toEqual(r.body);
	});

	it("an absent repo is a typed absent state, never an empty success", async () => {
		const r = await run(
			"get_repo_route",
			CLIENT_SEAT,
			{ repo: "acme/none" },
			{},
		);
		expect(r.refused).toBe(false);
		expect(r.body).toEqual({ state: "absent", repo: "acme/none" });
		expect(r.text.length).toBeGreaterThan(2);
	});

	it("a caller with no verified organisation is refused before any read", async () => {
		const r = await run("get_repo_route", NO_ORG, { repo: "acme/app" });
		expect(r.refused).toBe(true);
		expect(r.text).toContain("RBAC_DENIED");
		expect(r.calls).toHaveLength(0);
	});

	it("a client seat forwards its verifiedOrg to the door with the repo", async () => {
		const r = await run("get_repo_route", CLIENT_SEAT, { repo: "acme/app" });
		const door = r.calls.filter((c) => c.name === "githubRepoMapping:getRoute");
		expect(door).toHaveLength(1);
		expect(door[0].args.repo).toBe("acme/app");
		expect(door[0].args.verifiedOrg).toEqual({ orgSlug: ORG });
	});
});

describe("check_repo_routing", () => {
	const routes: Record<string, Route> = {
		"acme/a": { state: "routed", owner: "clio", reviewer: "eta" },
		"acme/b": { state: "unreviewed", owner: "clio" },
	};

	it("sorts the input into routed / unreviewed / missing and reports stale rows across every page", async () => {
		const r = await run(
			"check_repo_routing",
			CLIENT_SEAT,
			{ repos: ["acme/a", "acme/b", "acme/c"] },
			{
				routes,
				pages: [
					{
						items: [{ repo: "acme/a" }, { repo: "acme/old1" }],
						nextCursor: "c1",
					},
					{ items: [{ repo: "acme/b" }], nextCursor: "c2" },
					{ items: [{ repo: "acme/old2" }], nextCursor: null },
				],
			},
		);
		expect(r.refused, r.text).toBe(false);
		expect(r.body).toEqual({
			routed: ["acme/a"],
			unreviewed: ["acme/b"],
			missing: ["acme/c"],
			outOfScope: [],
			stale: ["acme/old1", "acme/old2"],
			complete: false,
		});
		expect(r.structured).toEqual(r.body);
	});

	it("follows nextCursor until it is null, passing each cursor on", async () => {
		const r = await run(
			"check_repo_routing",
			CLIENT_SEAT,
			{ repos: ["acme/a"] },
			{
				routes,
				pages: [
					{ items: [{ repo: "acme/a" }], nextCursor: "c1" },
					{ items: [], nextCursor: "c2" },
					{ items: [{ repo: "acme/late" }], nextCursor: null },
				],
			},
		);
		const lists = r.calls.filter((c) => c.name === "githubRepoMapping:list");
		expect(lists.map((c) => c.args.cursor)).toEqual([undefined, "c1", "c2"]);
		expect(
			lists.every(
				(c) => (c.args.verifiedOrg as { orgSlug: string }).orgSlug === ORG,
			),
		).toBe(true);
		expect(r.body?.stale).toEqual(["acme/late"]);
	});

	it("is complete only when every repo is routed and no row is stale", async () => {
		const r = await run(
			"check_repo_routing",
			CLIENT_SEAT,
			{ repos: ["acme/a", "acme/a"] },
			{
				routes,
				pages: [{ items: [{ repo: "acme/a" }], nextCursor: null }],
			},
		);
		expect(r.body).toEqual({
			routed: ["acme/a"],
			unreviewed: [],
			missing: [],
			outOfScope: [],
			stale: [],
			complete: true,
		});
	});

	it("an out-of-scope repo has its own bucket: it is not missing and does not make the check incomplete", async () => {
		const withFork: Record<string, Route> = {
			...routes,
			"acme/fork": {
				state: "out-of-scope",
				reason: "no owning station, no activity in 30 days",
			},
		};
		const r = await run(
			"check_repo_routing",
			CLIENT_SEAT,
			{ repos: ["acme/a", "acme/fork"] },
			{
				routes: withFork,
				pages: [
					{
						items: [{ repo: "acme/a" }, { repo: "acme/fork" }],
						nextCursor: null,
					},
				],
			},
		);
		expect(r.body).toEqual({
			routed: ["acme/a"],
			unreviewed: [],
			missing: [],
			outOfScope: ["acme/fork"],
			stale: [],
			complete: true,
		});
		expect(r.structured).toEqual(r.body);
	});

	it("an absent repo is still missing and still blocks completeness beside an out-of-scope one", async () => {
		const r = await run(
			"check_repo_routing",
			CLIENT_SEAT,
			{ repos: ["acme/fork", "acme/c"] },
			{
				routes: {
					"acme/fork": {
						state: "out-of-scope",
						reason: "no owning station, no activity in 30 days",
					},
				},
				pages: [{ items: [{ repo: "acme/fork" }], nextCursor: null }],
			},
		);
		expect(r.body?.outOfScope).toEqual(["acme/fork"]);
		expect(r.body?.missing).toEqual(["acme/c"]);
		expect(r.body?.complete).toBe(false);
	});

	it("an unreviewed repo alone makes the check incomplete", async () => {
		const r = await run(
			"check_repo_routing",
			CLIENT_SEAT,
			{ repos: ["acme/b"] },
			{ routes, pages: [{ items: [{ repo: "acme/b" }], nextCursor: null }] },
		);
		expect(r.body?.complete).toBe(false);
		expect(r.body?.unreviewed).toEqual(["acme/b"]);
	});

	it("a stale row alone makes the check incomplete", async () => {
		const r = await run(
			"check_repo_routing",
			CLIENT_SEAT,
			{ repos: ["acme/a"] },
			{
				routes,
				pages: [
					{
						items: [{ repo: "acme/a" }, { repo: "acme/gone" }],
						nextCursor: null,
					},
				],
			},
		);
		expect(r.body?.complete).toBe(false);
		expect(r.body?.stale).toEqual(["acme/gone"]);
	});

	it("a caller with no verified organisation is refused before any read", async () => {
		const r = await run("check_repo_routing", NO_ORG, { repos: ["acme/a"] });
		expect(r.refused).toBe(true);
		expect(r.text).toContain("RBAC_DENIED");
		expect(r.calls).toHaveLength(0);
	});

	it("forwards verifiedOrg on every getRoute call", async () => {
		const r = await run(
			"check_repo_routing",
			CLIENT_SEAT,
			{ repos: ["acme/a", "acme/b"] },
			{ routes },
		);
		const doors = r.calls.filter(
			(c) => c.name === "githubRepoMapping:getRoute",
		);
		expect(doors).toHaveLength(2);
		for (const d of doors) expect(d.args.verifiedOrg).toEqual({ orgSlug: ORG });
	});
});
