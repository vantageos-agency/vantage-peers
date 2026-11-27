/**
 * The last eight tools mcp-doctor 0.25.0 listed in S-51 (validate_okf_bundle,
 * soft_delete_mission_template, add_deployment, remove_deployment, list_errors,
 * get_error, validate_task_payload, get_repo_mapping) declare an outputSchema and
 * answer every success with a structuredContent that validates against it
 * (VantagePeers Cloud + Self-host, MCP server; S-51, S-53, S-54 of mcp-doctor),
 * and a registration without an outputSchema fails at registration.
 *
 * Call shape: as test/issue-tools-structured-content.test.ts. registerTools() is
 * the REAL production function; the server is a recording stand-in keeping each
 * tool's registered config and handler; the Convex client is a mock keyed by
 * function path, answering the shape each door's `returns:` validator promises
 * (convex/errorMonitor.ts, convex/githubRepoMapping.ts,
 * convex/okfBundleNode.ts, convex/missionTemplates.ts). The masked tools are
 * driven through their handlers.
 *
 * Each success: the text is unchanged (the two-space JSON of the answer) and
 * structuredContent is that same object. get_error answers { error: row | null }
 * (a missing entry stays a success whose text is null); list_errors answers the
 * page form { items, nextCursor, truncated }. Each refusal keeps isError (or
 * throws, for validate_okf_bundle) and carries no structuredContent.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { defineTool } from "../src/registerTool.js";
import { registerTools } from "../src/tools.js";

type Captured = {
	config: {
		outputSchema?: { safeParse: (v: unknown) => { success: boolean } };
	};
	handler: (args: Record<string, unknown>) => Promise<{
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
		structuredContent?: Record<string, unknown>;
	}>;
};

type Door = (args: Record<string, unknown>) => unknown;

function harness(
	doors: Record<string, Door>,
	oauthCtx: OAuthContext = LOCAL_STDIO_TRUST_CTX,
) {
	const tools = new Map<string, Captured>();
	const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
	const server = {
		registerTool: (
			name: string,
			config: Captured["config"],
			handler: never,
		) => {
			tools.set(name, { config, handler });
		},
	} as unknown as Parameters<typeof registerTools>[0];
	const door = async (fn: unknown, args: unknown) => {
		const path = String(fn);
		calls.push({ fn: path, args: args as Record<string, unknown> });
		const d = doors[path];
		if (d === undefined) throw new Error(`no door mocked for ${path}`);
		return d(args as Record<string, unknown>);
	};
	const convex = {
		query: door,
		mutation: door,
		action: door,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, oauthCtx);
	return {
		calls,
		tool: (name: string) => {
			const t = tools.get(name);
			if (t === undefined) throw new Error(`${name} not registered`);
			return t;
		},
	};
}


const REPO = "vantageos-agency/vantage-peers";
const ERR_ID = "j57dy3049btafda9m2f5d2ggk987ph3f";

const errorRow = (over: Record<string, unknown> = {}) => ({
	_id: ERR_ID,
	_creationTime: 1_700_000_000_000,
	hash: "h1",
	deployment: "vantage-prod",
	functionName: "tasks:create",
	errorMessage: "boom",
	stackTrace: "at tasks:create",
	firstSeen: 1_700_000_000_000,
	lastSeen: 1_700_000_000_001,
	count: 3,
	issueNumber: 12,
	githubRepo: REPO,
	issueCreated: true,
	issueHistory: [{ issueNumber: 12, linkedAt: 1_700_000_000_002 }],
	...over,
});

/** The tool answered a success whose structuredContent validates against its declared schema. */
async function success(
	h: ReturnType<typeof harness>,
	name: string,
	args: Record<string, unknown>,
) {
	const t = h.tool(name);
	const schema = t.config.outputSchema;
	expect(schema, `${name} declares an outputSchema`).toBeDefined();
	const res = await t.handler(args);
	expect(res.isError, res.content?.[0]?.text).not.toBe(true);
	expect(
		res.structuredContent,
		`${name} answers structuredContent`,
	).toBeDefined();
	const parsed = (schema as NonNullable<typeof schema>).safeParse(
		res.structuredContent,
	);
	expect(parsed.success, JSON.stringify(parsed)).toBe(true);
	expect(res.content).toHaveLength(1);
	expect(res.content[0].type).toBe("text");
	return res;
}

async function refused(
	name: string,
	door: string,
	args: Record<string, unknown>,
) {
	const h = harness({
		[door]: () => {
			throw new Error("RBAC_DENIED: master scope required");
		},
	});
	const res = await h.tool(name).handler(args);
	expect(res.isError).toBe(true);
	expect(res.structuredContent).toBeUndefined();
}

describe("validate_okf_bundle (S-54: called)", () => {
	const valid = {
		valid: true,
		schemaVersion: "0.1",
		stats: { memoryCount: 2, briefingCount: 1, taskCount: 0 },
	};
	it("a valid bundle: structuredContent is the result the text shows", async () => {
		const h = harness({ "okfBundleNode:validateOkfBundle": () => valid });
		const res = await success(h, "validate_okf_bundle", {
			bundleUrl: "https://example.com/bundle.tar",
		});
		expect(res.structuredContent).toEqual(valid);
		expect(res.content[0].text).toBe(JSON.stringify(valid, null, 2));
		expect(h.calls[0].args).toEqual({
			bundleUrl: "https://example.com/bundle.tar",
			storageId: null,
		});
	});

	it("an invalid bundle lists its violations in both channels", async () => {
		const invalid = {
			...valid,
			valid: false,
			errors: [{ path: "a.md", rule: "frontmatter", message: "missing" }],
		};
		const h = harness({ "okfBundleNode:validateOkfBundle": () => invalid });
		const res = await success(h, "validate_okf_bundle", { storageId: "kg2a" });
		expect(res.structuredContent).toEqual(invalid);
		expect(res.content[0].text).toBe(JSON.stringify(invalid, null, 2));
	});

	it("a refusal from the door is an error, never a structuredContent", async () => {
		const h = harness({
			"okfBundleNode:validateOkfBundle": () => {
				throw new Error("AUTH_STORAGE_NOT_OWNED");
			},
		});
		await expect(
			h.tool("validate_okf_bundle").handler({ storageId: "kg2a" }),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
	});
});

describe("soft_delete_mission_template (S-54: called)", () => {
	it("by name: structuredContent equals the text", async () => {
		const h = harness({ "missionTemplates:softDelete": () => null });
		const res = await success(h, "soft_delete_mission_template", {
			name: "_probe-1180-brief",
		});
		expect(res.structuredContent).toEqual({
			deleted: true,
			name: "_probe-1180-brief",
		});
		expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
		expect(h.calls.map((c) => c.fn)).toContain("missionTemplates:softDelete");
	});

	it("neither templateId nor name is refused", async () => {
		const h = harness({ "missionTemplates:softDelete": () => null });
		const res = await h.tool("soft_delete_mission_template").handler({});
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
		expect(h.calls).toHaveLength(0);
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("soft_delete_mission_template", "missionTemplates:softDelete", {
			name: "x",
		});
	});
});

describe("add_deployment", () => {
	const args = {
		name: "vantage-prod",
		deploymentUrl: "https://vantage-prod.convex.cloud",
		deployKeyEnvVar: "DEPLOY_KEY_PROD",
		githubRepo: REPO,
		orchestrator: "sigma",
	};
	it("answers the registered row's ID and echo, text equal", async () => {
		const h = harness({ "errorMonitor:addDeployment": () => "jd7abc" });
		const res = await success(h, "add_deployment", args);
		expect(res.structuredContent).toEqual({
			id: "jd7abc",
			name: "vantage-prod",
			deploymentUrl: args.deploymentUrl,
			githubRepo: REPO,
			orchestrator: "sigma",
		});
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
	});
	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("add_deployment", "errorMonitor:addDeployment", args);
	});
});

describe("remove_deployment", () => {
	it("answers { removed }, text equal", async () => {
		const h = harness({ "errorMonitor:removeDeployment": () => null });
		const res = await success(h, "remove_deployment", { name: "vantage-prod" });
		expect(res.structuredContent).toEqual({ removed: "vantage-prod" });
		expect(res.content[0].text).toBe(
			JSON.stringify({ removed: "vantage-prod" }, null, 2),
		);
	});
	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("remove_deployment", "errorMonitor:removeDeployment", {
			name: "x",
		});
	});
});

describe("list_errors", () => {
	it("a page under the cap: items, no cursor; the text stays the bare array", async () => {
		const rows = [errorRow(), errorRow({ hash: "h2" })];
		const h = harness({ "errorMonitor:listErrors": () => rows });
		const res = await success(h, "list_errors", {});
		expect(res.structuredContent).toEqual({
			items: rows,
			nextCursor: null,
			truncated: false,
		});
		expect(res.content[0].text).toBe(JSON.stringify(rows, null, 2));
	});

	it("a full page forwards nextCursor in both channels", async () => {
		const rows = [errorRow()];
		const h = harness({ "errorMonitor:listErrors": () => rows });
		const res = await success(h, "list_errors", { limit: 1 });
		const text = JSON.parse(res.content[0].text) as {
			items: unknown[];
			nextCursor: string;
		};
		expect(typeof text.nextCursor).toBe("string");
		expect((res.structuredContent as { nextCursor: string }).nextCursor).toBe(
			text.nextCursor,
		);
		await success(h, "list_errors", { limit: 1, cursor: text.nextCursor });
	});

	it("an empty page validates", async () => {
		const h = harness({ "errorMonitor:listErrors": () => [] });
		const res = await success(h, "list_errors", {});
		expect(res.structuredContent).toEqual({
			items: [],
			nextCursor: null,
			truncated: false,
		});
	});

	it("a page over the cap is cut and says so in both channels", async () => {
		const big = "x".repeat(2000);
		const rows = Array.from({ length: 200 }, (_, i) =>
			errorRow({ hash: `h${i}`, stackTrace: big, _creationTime: 1_000 - i }),
		);
		const h = harness({ "errorMonitor:listErrors": () => rows });
		const res = await success(h, "list_errors", { limit: 200 });
		const sc = res.structuredContent as { items: unknown[]; truncated: boolean };
		expect(sc.truncated).toBe(true);
		expect(sc.items.length).toBeLessThan(200);
		const text = JSON.parse(res.content[0].text) as {
			_meta: { _truncated: boolean };
			items: unknown[];
		};
		expect(text._meta._truncated).toBe(true);
		expect(text.items).toEqual(sc.items);
	});

	it("a cursor of an unknown shape is refused", async () => {
		const h = harness({ "errorMonitor:listErrors": () => [] });
		const res = await h.tool("list_errors").handler({ cursor: "not-a-cursor" });
		expect(res.isError).toBe(true);
		expect(h.calls).toHaveLength(0);
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("list_errors", "errorMonitor:listErrors", {});
	});
});

describe("get_error", () => {
	it("answers { error: row }, the text staying the row", async () => {
		const row = errorRow();
		const h = harness({ "errorMonitor:getError": () => row });
		const res = await success(h, "get_error", { errorId: ERR_ID });
		expect(res.structuredContent).toEqual({ error: row });
		expect(res.content[0].text).toBe(JSON.stringify(row, null, 2));
	});

	it("an entry that is not there stays a success: text null, { error: null }", async () => {
		const h = harness({ "errorMonitor:getError": () => null });
		const res = await success(h, "get_error", { errorId: ERR_ID });
		expect(res.content[0].text).toBe("null");
		expect(res.structuredContent).toEqual({ error: null });
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("get_error", "errorMonitor:getError", { errorId: ERR_ID });
	});
});

describe("validate_task_payload (S-54: called)", () => {
	it("a payload that needs injection: structuredContent is the result, text equal", async () => {
		const h = harness({});
		const res = await success(h, "validate_task_payload", {
			tool_name: "create_task",
			payload: { title: "t", description: "no markers" },
		});
		const sc = res.structuredContent as {
			valid: boolean;
			auto_inject_applied: string[];
			modified_payload?: Record<string, unknown>;
		};
		expect(sc.auto_inject_applied.length).toBeGreaterThan(0);
		expect(sc.modified_payload).toBeDefined();
		expect(JSON.parse(res.content[0].text)).toEqual(sc);
	});

	it("a hard-block violation is still a success: valid false, errors listed", async () => {
		const h = harness({});
		const res = await success(h, "validate_task_payload", {
			tool_name: "complete_task",
			payload: { taskId: "k1", completionNote: "done" },
		});
		const sc = res.structuredContent as {
			valid: boolean;
			errors: Array<{ field: string }>;
		};
		expect(sc.valid).toBe(false);
		expect(sc.errors.length).toBeGreaterThan(0);
		expect(JSON.parse(res.content[0].text)).toEqual(sc);
		expect(h.calls).toHaveLength(0);
	});
});

describe("get_repo_mapping", () => {
	const row = {
		_id: "j57mapping",
		_creationTime: 1_700_000_000_000,
		repo: REPO,
		orchestrator: "sigma",
		project: "vantage-peers",
		active: true,
		reviewer: "minos",
	};
	it("answers the row itself, text equal", async () => {
		const h = harness({ "githubRepoMapping:getByRepo": () => row });
		const res = await success(h, "get_repo_mapping", { repo: REPO });
		expect(res.structuredContent).toEqual(row);
		expect(res.content[0].text).toBe(JSON.stringify(row, null, 2));
	});

	it("a mapping that is not there stays an error with no structuredContent", async () => {
		const h = harness({ "githubRepoMapping:getByRepo": () => null });
		const res = await h.tool("get_repo_mapping").handler({ repo: REPO });
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("get_repo_mapping", "githubRepoMapping:getByRepo", {
			repo: REPO,
		});
	});
});

describe("a registration without an outputSchema fails at registration", () => {
	const server = () =>
		({ registerTool: () => undefined }) as unknown as Parameters<
			typeof defineTool
		>[0];

	it("names the tool and refuses", () => {
		expect(() =>
			defineTool(
				server(),
				{},
				{ kind: "public", reason: "test" },
				"probe_no_output_schema",
				"A probe.",
				{},
				{ readOnlyHint: true },
				async () => ({ content: [{ type: "text", text: "{}" }] }),
			),
		).toThrow(/probe_no_output_schema.*outputSchema/s);
	});

	it("a registration that declares one still registers", () => {
		expect(() =>
			defineTool(
				server(),
				{},
				{ kind: "public", reason: "test" },
				"probe_with_output_schema",
				"A probe.",
				{},
				{
					readOnlyHint: true,
					outputSchema: { ok: z.boolean().describe("ok") },
				},
				async () => ({
					content: [{ type: "text", text: "{}" }],
					structuredContent: { ok: true },
				}),
			),
		).not.toThrow();
	});
});
