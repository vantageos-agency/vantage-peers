/**
 * create_briefing_note forwards the bearer's VERIFIED org to Convex.
 *
 * A one-agent seat reaches Convex as the fleet service account, whose `ctx.auth`
 * carries no org; `briefingNotes:create` therefore stored the seat's note
 * fleet-owned and the seat could not read it back (prod, 2026-10-13). The org now
 * rides on the write (`verifiedOrg`), read from the verified oauthContext only.
 *
 * PRESENT  a scoped seat forwards { orgSlug } from its oauthContext.
 * REFUSED  the org is never taken from a tool argument; a non-master bearer whose
 *          org cannot be resolved is refused before Convex.
 * ABSENT   the fleet master forwards no org (its notes stay fleet-owned).
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Call = { fn: string; args: Record<string, unknown> };
type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };

function harness(oauthCtx: OAuthContext) {
	const handlers = new Map<
		string,
		(a: Record<string, unknown>) => Promise<unknown>
	>();
	const calls: Call[] = [];
	const server = {
		tool: (name: string, _d: string, _s: unknown, _a: unknown, h: never) => {
			handlers.set(name, h);
		},
		registerTool: (name: string, _c: unknown, h: never) => {
			handlers.set(name, h);
		},
	} as Parameters<typeof registerTools>[0];
	const record = async (fn: unknown, args: unknown) => {
		calls.push({ fn: String(fn), args: args as Record<string, unknown> });
		return "note-id";
	};
	const convex = {
		query: record,
		mutation: record,
		action: record,
	} as Parameters<typeof registerTools>[1];
	registerTools(server, convex, oauthCtx);
	return {
		calls,
		call: async (name: string, args: Record<string, unknown>) => {
			const h = handlers.get(name);
			if (!h) throw new Error(`${name} not registered`);
			return (await h(args)) as ToolResult;
		},
	};
}

const seat = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "client-a",
	userId: "user-a",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "alpha-org-a",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkOrgSlug: "org-a",
	actor: { agentId: "ag1", orgSlug: "org-a", agentName: "alpha" },
	...over,
});

const master = (): OAuthContext => ({
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: true,
});

const args = {
	title: "t",
	topic: "handoff",
	participants: ["alpha"],
	content: "c",
	createdBy: "alpha",
};

describe("create_briefing_note -> briefingNotes:create", () => {
	it("PRESENT: a seat forwards its verified org", async () => {
		const h = harness(seat());
		const r = await h.call("create_briefing_note", args);
		expect(r.isError, JSON.stringify(r)).not.toBe(true);
		const call = h.calls.find((c) => c.fn === "briefingNotes:create");
		expect(call?.args.verifiedOrg).toEqual({ orgSlug: "org-a" });
	});

	it("REFUSED: the org is never taken from a tool argument", async () => {
		const h = harness(seat());
		await h.call("create_briefing_note", {
			...args,
			verifiedOrg: { orgSlug: "org-b" },
		});
		const call = h.calls.find((c) => c.fn === "briefingNotes:create");
		expect(call?.args.verifiedOrg).toEqual({ orgSlug: "org-a" });
	});

	it("REFUSED: a non-master bearer with no resolvable org never reaches Convex", async () => {
		const h = harness(seat({ clerkOrgSlug: undefined, actor: undefined }));
		const r = await h.call("create_briefing_note", args);
		expect(r.isError).toBe(true);
		expect(h.calls.filter((c) => c.fn === "briefingNotes:create")).toEqual([]);
	});

	it("ABSENT: the fleet master forwards no org", async () => {
		const h = harness(master());
		const r = await h.call("create_briefing_note", args);
		expect(r.isError, JSON.stringify(r)).not.toBe(true);
		const call = h.calls.find((c) => c.fn === "briefingNotes:create");
		expect(call).toBeDefined();
		expect(call?.args).not.toHaveProperty("verifiedOrg");
	});
});
