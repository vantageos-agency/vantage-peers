/**
 * Cursor sweep over the list_* tools (task k17f2p30aamw3xhwhp146w3hrx8k1y0j).
 *
 * Two doors emit a Convex-owned { time, id } nextCursor (btoa(JSON.stringify)):
 * githubRepoMapping:list and businessUnits:list. Their tools must accept it back
 * (recognise + forward verbatim). A cursor of any shape a tool does not own must
 * answer invalid_cursor, never restart the listing at page 1.
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { encodeCursor } from "../src/paging.js";
import { registerTools } from "../src/tools.js";

const masterCtx: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

type Result = {
	isError?: boolean;
	structuredContent?: { error?: { code?: string } } & Record<string, unknown>;
	content: { text: string }[];
};
type Handler = (args: unknown) => Promise<Result>;

const TIME_ID = btoa(
	JSON.stringify({ time: 1795640950830.9185, id: "kx742eys9n259cbjrvgrxgsnjs8jx320" }),
);
const BACKEND_CURSOR = encodeCursor({ backendCursor: "opaque-convex-cursor" });
const CREATED_BEFORE = encodeCursor({ createdBefore: 500 });

function setup(door: string, tool: string) {
	const calls: Record<string, unknown>[] = [];
	let handler: Handler | undefined;
	const server = {
		registerTool: (name: string, _c: unknown, h: Handler) => {
			if (name === tool) handler = h;
		},
	} as never;
	const convex = {
		query: async (path: string, args: Record<string, unknown>) => {
			if (path !== door) return null;
			calls.push(args);
			const row = (i: number) => ({
				_id: `r${i}`,
				_creationTime: 1000 - i,
				name: `bu${i}`,
				status: "active",
				orchestratorId: "sigma",
				repo: `acme/r${i}`,
				orchestrator: "sigma",
			});
			return args.cursor === TIME_ID
				? { items: [row(2)], nextCursor: null }
				: { items: [row(1)], nextCursor: TIME_ID };
		},
		mutation: async () => null,
		action: async () => null,
	} as never;
	registerTools(server, convex, masterCtx);
	if (!handler) throw new Error(`${tool} not registered`);
	return { handler, calls };
}

describe("list_bus accepts the nextCursor businessUnits:list emits", () => {
	it("serves page 2 and forwards the cursor verbatim", async () => {
		const { handler, calls } = setup("businessUnits:list", "list_bus");
		const p1 = await handler({ limit: 1 });
		expect(p1.isError).toBeFalsy();
		const body1 = JSON.parse(p1.content[0]?.text ?? "{}") as {
			nextCursor: string | null;
		};
		expect(body1.nextCursor).toBe(TIME_ID);

		const p2 = await handler({ limit: 1, cursor: body1.nextCursor });
		expect(p2.content[0]?.text ?? "").not.toMatch(/invalid cursor/i);
		expect(p2.isError).toBeFalsy();
		const body2 = JSON.parse(p2.content[0]?.text ?? "{}") as {
			items: { _id: string }[];
			nextCursor: string | null;
		};
		expect(body2.items.map((r) => r._id)).toEqual(["r2"]);
		expect(body2.nextCursor).toBeNull();
		expect(calls[1]?.cursor).toBe(TIME_ID);
		expect(calls[1]?.createdBefore).toBeUndefined();
	});

	it("still honours the legacy { createdBefore } cursor", async () => {
		const { handler, calls } = setup("businessUnits:list", "list_bus");
		const r = await handler({ limit: 1, cursor: CREATED_BEFORE });
		expect(r.isError).toBeFalsy();
		expect(calls[0]?.createdBefore).toBe(500);
		expect(calls[0]?.cursor).toBeUndefined();
	});
});

describe.each([
	["list_bus", "businessUnits:list"],
	["list_repo_mappings", "githubRepoMapping:list"],
] as const)("%s refuses a cursor of a shape it does not own", (tool, door) => {
	it.each([
		["a {backendCursor} token", BACKEND_CURSOR],
		["garbage", "bm90LWpzb24"],
		["a JSON object of no known shape", btoa(JSON.stringify({ foo: 1 }))],
	])("answers invalid_cursor for %s and reads nothing", async (_n, cursor) => {
		const { handler, calls } = setup(door, tool);
		const r = await handler({ limit: 1, cursor });
		expect(r.isError).toBe(true);
		expect(r.structuredContent?.error?.code).toBe("invalid_cursor");
		expect(calls).toHaveLength(0);
	});
});
