/**
 * VantagePeers Cloud, task k1726h1v7hqdbk818bn8s1rgdx8hy0ts.
 *
 * The MCP post-query gates compare a row's label with the token's `fromAllowList`
 * by exact string (the package scopeFilterGet / scopeFilterList), but every label
 * a door stores is normalised (lowercase) while the token's list holds the
 * agent's exact stored name ("Ada", "Bram"). A client-org person acting as such a
 * consent agent got "Task not found" for the task Convex had just served it.
 *
 * Poles: OWN (served) / FOREIGN (a row of an unlisted name is still dropped).
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function fakeServer(): {
	server: McpServer;
	handlers: Map<string, ToolHandler>;
} {
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

const PERSON: OAuthContext = {
	clientId: "client-person",
	userId: "user_person",
	scopes: ["mcp:full"],
	scopeProfile: "team-member",
	fromAllowList: ["Ada", "Bram"],
	namespaceReadPrefixes: ["team/vp-directory-review"],
	namespaceWritePrefixes: ["team/vp-directory-review"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
	clerkOrgSlug: "vp-directory-review",
};

const ROW = {
	_id: "k17taskfixture0000000000000000aa",
	_creationTime: 1,
	title: "person task",
	assignedTo: "bram",
	createdBy: "ada",
	priority: "medium",
	status: "todo",
	createdAt: 1,
	updatedAt: 1,
	orgId: "vp-directory-review",
};

const text = (r: unknown): string =>
	(r as { content: Array<{ text: string }> }).content[0].text;
const isError = (r: unknown): boolean =>
	(r as { isError?: boolean }).isError === true;

function setup(ctx: OAuthContext, queryResult: unknown) {
	const { server, handlers } = fakeServer();
	const convex = {
		query: vi.fn().mockResolvedValue(queryResult),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
	registerTools(server, convex, ctx);
	return handlers;
}

describe("get_task, post-query roster gate", () => {
	it("OWN: a task assigned to the normalised name of a listed mixed-case agent is served", async () => {
		const handlers = setup(PERSON, ROW);
		const r = await handlers.get("get_task")?.({ taskId: ROW._id });
		expect(isError(r)).toBe(false);
		expect(JSON.parse(text(r))._id).toBe(ROW._id);
	});
	it("FOREIGN: a task of an unlisted name is still 'Task not found'", async () => {
		const handlers = setup(PERSON, {
			...ROW,
			assignedTo: "mallory",
			createdBy: "mallory",
		});
		const r = await handlers.get("get_task")?.({ taskId: ROW._id });
		expect(isError(r)).toBe(true);
		expect(text(r)).toContain("Task not found");
	});
});

describe("create_task delegation gate (checkDelegationAllowed)", () => {
	it("OWN: an assignee typed in lowercase is on a roster holding the exact name", async () => {
		const { checkDelegationAllowed } = await import("../auth.js");
		const refusal = await checkDelegationAllowed(
			{ ...PERSON, accessTokenHash: "h".repeat(64) },
			"bram",
			async () => ["Ada", "Bram"],
			"assignedTo",
		);
		expect(refusal).toBeNull();
	});
	it("FOREIGN: a name on no roster is still refused", async () => {
		const { checkDelegationAllowed } = await import("../auth.js");
		const refusal = await checkDelegationAllowed(
			{ ...PERSON, accessTokenHash: "h".repeat(64) },
			"mallory",
			async () => ["Ada", "Bram"],
			"assignedTo",
		);
		expect(refusal).not.toBeNull();
	});
});

describe("get_briefing_note participant gate", () => {
	const NOTE = {
		_id: "note-fixture-1",
		_creationTime: 1,
		title: "t",
		topic: "daily",
		participants: ["ada", "sigma"],
		content: "c",
		createdBy: "sigma",
		createdAt: 1,
	};
	it("OWN: a participant stored in lowercase is the listed mixed-case agent", async () => {
		const handlers = setup(PERSON, NOTE);
		const r = await handlers.get("get_briefing_note")?.({ noteId: NOTE._id });
		expect(isError(r)).toBe(false);
	});
	it("FOREIGN: a note whose participants name nobody on the list is dropped", async () => {
		const handlers = setup(PERSON, { ...NOTE, participants: ["mallory"] });
		const r = await handlers.get("get_briefing_note")?.({ noteId: NOTE._id });
		expect(isError(r)).toBe(true);
	});
});
