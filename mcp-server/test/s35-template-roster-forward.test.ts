/**
 * S-35 (task k17edzy4wpq0ng4cbytgj8ev6n8k0hsd): get_mission_template forwards the
 * caller's own roster to the door as `callerRoster` when no `verifiedOrg` is
 * derived, so the door decides inside the read. The after-read scopeFilterGet stays.
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const base = {
	clientId: "c",
	userId: "u",
	scopes: ["vantage:read"],
	namespaceReadPrefixes: [] as string[],
	namespaceWritePrefixes: [] as string[],
	expiresAt: Date.now() + 3_600_000,
};
const rosterCtx = (): OAuthContext => ({
	...base,
	scopeProfile: "team-member",
	fromAllowList: ["alpha"],
	isMaster: false,
});
const masterCtx = (): OAuthContext => ({
	...base,
	scopeProfile: "master",
	fromAllowList: ["*"],
	isMaster: true,
});
const orgCtx = (): OAuthContext => ({
	...rosterCtx(),
	clerkOrgSlug: "org-a",
	orgClerkId: "org_A1",
});

type ToolArgs = Record<string, unknown>;
type ToolResult = { content: { text: string }[] };
type Handler = (a: ToolArgs) => Promise<ToolResult>;
type DoorCall = { path: string; args: Record<string, unknown> };

async function call(ctx: OAuthContext, row: unknown) {
	const handlers = new Map<string, Handler>();
	const queries: DoorCall[] = [];
	const server = {
		tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) =>
			handlers.set(n, h),
		registerTool: (n: string, _c: unknown, h: Handler) => handlers.set(n, h),
	} as unknown as Parameters<typeof registerTools>[0];
	const convex = {
		query: async (path: string, args: Record<string, unknown>) => {
			queries.push({ path, args });
			return row;
		},
		mutation: async () => null,
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, ctx);
	const handler = handlers.get("get_mission_template");
	if (handler === undefined)
		throw new Error("get_mission_template not registered");
	const res = await handler({ name: "t" });
	const door = queries.find((q) => q.path === "missionTemplates:getByName");
	if (door === undefined)
		throw new Error("missionTemplates:getByName not called");
	return { res, door };
}

describe("get_mission_template forwards callerRoster", () => {
	it("non-master with a roster and no verified org: callerRoster is the caller's roster", async () => {
		const { door, res } = await call(rosterCtx(), {
			name: "t",
			createdBy: "alpha",
		});
		expect(door.args.callerRoster).toEqual(["alpha"]);
		expect(door.args.verifiedOrg).toBeUndefined();
		expect(res.content[0].text).toContain('"createdBy": "alpha"');
	});
	it("after-read filter is kept: a foreign row the door returned is still dropped", async () => {
		const { res } = await call(rosterCtx(), { name: "t", createdBy: "beta" });
		expect(res.content[0].text).toBe("null");
	});
	it("master: no callerRoster", async () => {
		const { door } = await call(masterCtx(), { name: "t", createdBy: "beta" });
		expect(door.args.callerRoster).toBeUndefined();
	});
	it("a verified org is derived: verifiedOrg only, no callerRoster", async () => {
		const { door } = await call(orgCtx(), { name: "t", createdBy: "alpha" });
		expect(door.args.verifiedOrg).toBeDefined();
		expect(door.args.callerRoster).toBeUndefined();
	});
});
