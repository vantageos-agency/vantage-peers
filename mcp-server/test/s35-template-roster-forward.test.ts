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

async function call(ctx: OAuthContext, row: unknown) {
	const handlers = new Map<string, (a: any) => any>();
	const queries: { path: string; args: any }[] = [];
	const server = {
		tool: (
			n: string,
			_d: string,
			_s: unknown,
			_a: unknown,
			h: (a: any) => any,
		) => handlers.set(n, h),
		registerTool: (n: string, _c: unknown, h: (a: any) => any) =>
			handlers.set(n, h),
	} as any;
	const convex = {
		query: async (path: string, args: any) => {
			queries.push({ path, args });
			return row;
		},
		mutation: async () => null,
		action: async () => null,
	} as any;
	registerTools(server, convex, ctx);
	const res = await handlers.get("get_mission_template")!({ name: "t" });
	return {
		res,
		door: queries.find((q) => q.path === "missionTemplates:getByName")!,
	};
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
