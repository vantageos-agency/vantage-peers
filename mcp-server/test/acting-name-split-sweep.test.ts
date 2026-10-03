/**
 * The acting / assignment split, derived from each tool's OWN declaration.
 *
 * task k1748jbt7yfgrv747p8gky1f358fk1r5. VantagePeers Cloud (multi-tenant).
 *
 * A presented agent credential binds the ACTING name only — the arguments a
 * tool declares as "who is acting": `callerOrchestrator` by name, and the
 * `from` scope kind's `fromArg` (createdBy / from / requestedBy / ...). Every
 * OTHER argument — in particular a name that ASSIGNS work to somebody else
 * (pilot, agents, assignedTo, fulfilledBy, a BU's new lead) — is not an
 * identity claim and must never be refused as AGENT_IDENTITY_MISMATCH.
 *
 * Defect measured at 30e821b: create_mission ran `guardFrom(pilot)` in its
 * handler, and update_mission declared `fromArg: "pilot"`, so naming another
 * orchestrator as pilot was refused as an identity mismatch.
 *
 * No hand list: the acting keys of each tool are read from the scope and
 * schema it passed to defineTool (captured through a pass-through spy), and
 * computed by the SAME function the wrapper uses (actingNameKeys).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { OAuthContext } from "../src/auth.js";
import type { ToolScope } from "../src/registerTool.js";

type Declared = { scope: ToolScope; schema: z.ZodRawShape };
const declared = new Map<string, Declared>();

vi.mock("../src/registerTool.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/registerTool.js")>();
	return {
		...real,
		defineTool: (...args: Parameters<typeof real.defineTool>) => {
			const [, , scope, name, , schema] = args;
			declared.set(name, { scope, schema });
			Reflect.apply(real.defineTool, undefined, args);
		},
	};
});

const { actingNameKeys } = await import("../src/registerTool.js");
const { registerTools } = await import("../src/tools.js");

type Handler = (args: Record<string, unknown>, extra?: unknown) => unknown;

// An ORDINARY agent credential of a real org (never master, never the service
// account): alice of org-a, whose org roster is alice + bob.
const ACTOR_CTX: OAuthContext = {
	clientId: "client-x",
	userId: "user-x",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "team-member",
	fromAllowList: ["alice", "bob"],
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkJwt: "verified-clerk-jwt",
	actor: { orgSlug: "org-a", agentName: "alice" },
};

function register(): {
	handlers: Map<string, Handler>;
	mutations: string[];
} {
	declared.clear();
	const handlers = new Map<string, Handler>();
	const mutations: string[] = [];
	const server = {
		tool(...a: unknown[]) {
			handlers.set(a[0] as string, a[a.length - 1] as Handler);
			return {};
		},
		registerTool(...a: unknown[]) {
			handlers.set(a[0] as string, a[a.length - 1] as Handler);
			return {};
		},
	} as unknown as McpServer;
	const convex = {
		query: vi.fn(async (name: string) =>
			name === "orgRoster:getMyOrgRoster" ? ["alice", "bob"] : null,
		),
		mutation: vi.fn(async (name: string) => {
			mutations.push(name);
			return null;
		}),
		action: vi.fn(async () => null),
	};
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, convex as any, ACTOR_CTX);
	return { handlers, mutations };
}

async function textOf(h: Handler, args: Record<string, unknown>) {
	try {
		const r = (await h(args, {})) as {
			content?: Array<{ text?: string }>;
		};
		return r?.content?.[0]?.text ?? "";
	} catch (err) {
		return String(err);
	}
}

describe("acting / assignment split — derived from each tool's declaration", () => {
	it("EVERY declared acting name refuses another agent's name; NO other argument ever does", async () => {
		const { handlers, mutations } = register();
		const actingTools: string[] = [];
		const actingEscaped: string[] = [];
		const assignmentBound: string[] = [];
		let otherProbes = 0;

		for (const [name, { scope, schema }] of declared) {
			const handler = handlers.get(name);
			if (!handler) continue;
			const acting = new Set(actingNameKeys(scope, schema));
			if (acting.size > 0) actingTools.push(name);

			for (const key of Object.keys(schema)) {
				mutations.length = 0;
				const text = await textOf(handler, { [key]: "bob" });
				const mismatch = text.includes("AGENT_IDENTITY_MISMATCH");
				if (acting.has(key)) {
					if (!mismatch || mutations.length > 0)
						actingEscaped.push(`${name}.${key}`);
				} else {
					otherProbes += 1;
					if (mismatch) assignmentBound.push(`${name}.${key}`);
				}
			}
		}

		// Population read from the registrations, never from a list to trust.
		expect(actingTools.length).toBeGreaterThanOrEqual(35);
		expect(otherProbes).toBeGreaterThan(200);
		expect(
			actingEscaped,
			`acting names that let alice act as bob: ${actingEscaped.join(", ")}`,
		).toEqual([]);
		expect(
			assignmentBound,
			`non-acting arguments bound to the caller's identity: ${assignmentBound.join(", ")}`,
		).toEqual([]);
	});

	it("the assignment fields of the premise are NOT declared acting names", () => {
		register();
		const keysOf = (tool: string) => {
			const d = declared.get(tool);
			if (!d) throw new Error(`${tool} not registered`);
			return actingNameKeys(d.scope, d.schema);
		};
		expect(keysOf("create_mission")).toEqual(["createdBy"]);
		expect(keysOf("update_mission")).toEqual(["callerOrchestrator"]);
		expect(keysOf("create_task")).toEqual(["createdBy"]);
		expect(keysOf("create_mandate")).toEqual(["requestedBy"]);
		expect(keysOf("update_bu")).toEqual(["callerOrchestrator"]);
	});
});
