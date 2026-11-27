/**
 * list_repo_mappings accepts exactly the nextCursor it emits (task k17egc72db260vvsg39qvvcnd18jx3w3).
 *
 * githubRepoMapping:list answers nextCursor = btoa(JSON.stringify({ time, id })).
 * The tool's cursor decoder (paging.ts decodeCursor) knew only { createdBefore }
 * and { backendCursor }, so the cursor the tool itself returned was refused with
 * "invalid cursor: unrecognised payload shape" and page 2 was unreachable.
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
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
	structuredContent?: unknown;
	content: { text: string }[];
};
type Handler = (args: unknown) => Promise<Result>;

const CURSOR = btoa(
	JSON.stringify({
		time: 1795640950830.9185,
		id: "kx742eys9n259cbjrvgrxgsnjs8jx320",
	}),
);

function row(i: number, fields: "lite" | "full") {
	const base = {
		_id: `rm_${i}`,
		_creationTime: 1000 - i,
		repo: `acme/r${i}`,
		orchestrator: "sigma",
		project: "acme",
	};
	return fields === "lite" ? base : { ...base, active: true, orgId: "org-a" };
}

function setup() {
	const calls: Record<string, unknown>[] = [];
	let handler: Handler | undefined;
	const server = {
		registerTool: (name: string, _c: unknown, h: Handler) => {
			if (name === "list_repo_mappings") handler = h;
		},
	} as never;
	const convex = {
		query: async (path: string, args: Record<string, unknown>) => {
			if (path !== "githubRepoMapping:list") return null;
			calls.push(args);
			const fields = (args.fields as "lite" | "full") ?? "full";
			const second = args.cursor === CURSOR;
			return second
				? { items: [row(2, fields)], nextCursor: null }
				: { items: [row(1, fields)], nextCursor: CURSOR };
		},
		mutation: async () => null,
		action: async () => null,
	} as never;
	registerTools(server, convex, masterCtx);
	if (!handler) throw new Error("list_repo_mappings not registered");
	return { handler, calls };
}

describe.each([
	"lite",
	"full",
] as const)("list_repo_mappings cursor round-trip (%s)", (fields) => {
	it("serves page 2 from the nextCursor page 1 returned", async () => {
		const { handler, calls } = setup();
		const p1 = await handler({ limit: 1, fields });
		expect(p1.isError).toBeFalsy();
		const next = (p1.structuredContent as { nextCursor: string | null })
			.nextCursor;
		expect(next).toBe(CURSOR);

		const p2 = await handler({ limit: 1, fields, cursor: next });
		expect(p2.content[0]?.text ?? "").not.toMatch(/invalid cursor/i);
		expect(p2.isError).toBeFalsy();
		const body = p2.structuredContent as {
			items: { repo: string }[];
			nextCursor: string | null;
		};
		expect(body.items.map((r) => r.repo)).toEqual(["acme/r2"]);
		expect(body.nextCursor).toBeNull();
		// The Convex door received the cursor verbatim, not a createdBefore anchor.
		expect(calls[1]?.cursor).toBe(CURSOR);
		expect(calls[1]?.createdBefore).toBeUndefined();
	});

	it("still refuses a garbage cursor with invalid_cursor", async () => {
		const { handler } = setup();
		const r = await handler({ limit: 1, fields, cursor: "bm90LWpzb24" });
		expect(r.isError).toBe(true);
		expect(r.content[0]?.text).toMatch(/invalid cursor/i);
	});

	it("still honours the legacy { createdBefore } cursor", async () => {
		const { handler, calls } = setup();
		const legacy = Buffer.from(JSON.stringify({ createdBefore: 500 })).toString(
			"base64url",
		);
		const r = await handler({ limit: 1, fields, cursor: legacy });
		expect(r.isError).toBeFalsy();
		expect(calls[0]?.createdBefore).toBe(500);
	});
});
