/**
 * S-35 -- get_mission_template decides a caller's scope before the read when the answer does not
 * depend on the row. A caller that is neither master nor org-bound and names nobody (no
 * oauthCtx; a bearer with no org, an empty roster and no namespace prefix) gets null for every
 * row, so the door is never called. Master/local trust and an org member are forwarded.
 * The answers are pinned by s35-template-in-read-pin.test.ts.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Handler = (a: Record<string, unknown>) => Promise<unknown>;

async function run(ctx: OAuthContext | undefined) {
	const handlers = new Map<string, Handler>();
	const capture = (...a: unknown[]): unknown => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const query = vi.fn().mockResolvedValue({
		_id: "t1",
		name: "x",
		createdBy: "alpha",
	});
	registerTools(
		{ tool: capture, registerTool: capture } as unknown as McpServer,
		{ query, mutation: vi.fn(), action: vi.fn() } as unknown as ConvexHttpClient,
		ctx,
	);
	await (handlers.get("get_mission_template") as Handler)({ name: "x" });
	return query;
}

const NO_ONE: OAuthContext = {
	clientId: "c",
	userId: "u",
	scopes: [],
	scopeProfile: "legacy-tenant-generic",
	fromAllowList: [],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};
const MEMBER: OAuthContext = {
	...NO_ONE,
	fromAllowList: ["alpha"],
	clerkOrgSlug: "org-alpha",
	actor: { orgSlug: "org-alpha", agentName: "alpha" },
};

describe("S-35 -- get_mission_template door call", () => {
	it("no oauthCtx never reaches missionTemplates:getByName", async () => {
		expect(await run(undefined)).not.toHaveBeenCalled();
	});
	it("a bearer that names nobody never reaches the door", async () => {
		expect(await run(NO_ONE)).not.toHaveBeenCalled();
	});
	it("local trust is forwarded", async () => {
		expect(await run(LOCAL_STDIO_TRUST_CTX)).toHaveBeenCalledTimes(1);
	});
	it("an org member is forwarded with its verifiedOrg", async () => {
		const q = await run(MEMBER);
		expect(q).toHaveBeenCalledWith("missionTemplates:getByName", {
			name: "x",
			verifiedOrg: { orgSlug: "org-alpha" },
		});
	});
});
