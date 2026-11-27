/**
 * The issue tools (list_issues, get_issue, update_issue_status,
 * link_commit_to_issue, verify_issue, issue_stats) declare an outputSchema and
 * answer every success with a structuredContent that validates against it
 * (VantagePeers Cloud + Self-host, MCP server; S-51, S-53, S-54 of mcp-doctor).
 *
 * Call shape: registerTools() is the REAL production function; the server is a
 * recording stand-in that keeps each tool's registered config (so its declared
 * outputSchema is read from the registration itself) and its handler, and the
 * Convex client is a mock keyed by function path, answering the shape each
 * door's `returns:` validator promises (convex/issues.ts). The issue tools are
 * masked from tools/list (tool-exposure.json), so they are driven through their
 * handlers, as test/bu-tools-structured-content.test.ts does.
 *
 * Each success: the text is unchanged (the two-space JSON of the answer) and
 * structuredContent is that same object (get_issue: { issue: row | null }; a
 * missing issue stays a success whose text is { "error": "Issue not found" }).
 * Each refusal keeps isError and carries no structuredContent.
 */

import { describe, expect, it } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
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

const issueRow = (over: Record<string, unknown> = {}) => ({
	_id: "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	_creationTime: 1_700_000_000_000,
	repo: REPO,
	issueNumber: 667,
	title: "A tracked issue",
	body: "What is wrong",
	htmlUrl: "https://github.com/vantageos-agency/vantage-peers/issues/667",
	labels: ["bug"],
	status: "open",
	priority: "high",
	assignedOrchestrator: "sigma",
	project: "vantage-peers",
	githubCreatedAt: 1_700_000_000_000,
	githubUpdatedAt: 1_700_000_000_001,
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

describe("list_issues", () => {
	it("a page under the cap: structuredContent is the object the text shows", async () => {
		const rows = [issueRow(), issueRow({ issueNumber: 668, status: "fixed" })];
		const h = harness({ "issues:listByStatus": () => rows });
		const res = await success(h, "list_issues", { status: "open" });
		expect(res.structuredContent).toEqual({ count: 2, issues: rows });
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
	});

	it("a full page forwards nextCursor in both channels", async () => {
		const rows = [issueRow()];
		const h = harness({ "issues:listByProject": () => rows });
		const res = await success(h, "list_issues", {
			project: "vantage-peers",
			limit: 1,
		});
		const text = JSON.parse(res.content[0].text) as { nextCursor: string };
		expect(typeof text.nextCursor).toBe("string");
		expect((res.structuredContent as { nextCursor?: string }).nextCursor).toBe(
			text.nextCursor,
		);
		await success(h, "list_issues", {
			project: "vantage-peers",
			limit: 1,
			cursor: text.nextCursor,
		});
	});

	it("an empty page validates", async () => {
		const h = harness({ "issues:listByProject": () => [] });
		const res = await success(h, "list_issues", {});
		expect(res.structuredContent).toEqual({ count: 0, issues: [] });
	});

	it("a page over the cap is cut and says so in both channels", async () => {
		const big = "x".repeat(2000);
		const rows = Array.from({ length: 200 }, (_, i) =>
			issueRow({ issueNumber: i + 1, body: big }),
		);
		const h = harness({ "issues:listByProject": () => rows });
		const res = await success(h, "list_issues", { limit: 200 });
		const sc = res.structuredContent as {
			issues: unknown[];
			truncated?: boolean;
		};
		expect(sc.truncated).toBe(true);
		expect(sc.issues.length).toBeLessThan(200);
		const text = JSON.parse(res.content[0].text) as {
			_meta: { _truncated: boolean };
			issues: unknown[];
		};
		expect(text._meta._truncated).toBe(true);
		expect(text.issues).toEqual(sc.issues);
	});

	it("a cursor of an unknown shape is refused", async () => {
		const h = harness({ "issues:listByProject": () => [] });
		const res = await h.tool("list_issues").handler({ cursor: "not-a-cursor" });
		expect(res.isError).toBe(true);
		expect(h.calls).toHaveLength(0);
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("list_issues", "issues:listByProject", {});
	});
});

describe("get_issue", () => {
	it("answers { issue: row }, the text staying the row", async () => {
		const row = issueRow({ fixCommits: ["abc1234"], fixedBy: "alpha" });
		const h = harness({ "issues:getByRepoNumber": () => row });
		const res = await success(h, "get_issue", { repo: REPO, issueNumber: 667 });
		expect(res.structuredContent).toEqual({ issue: row });
		expect(res.content[0].text).toBe(JSON.stringify(row, null, 2));
	});

	it("an issue that is not there stays a success: text { error }, { issue: null }", async () => {
		const h = harness({ "issues:getByRepoNumber": () => null });
		const res = await success(h, "get_issue", { repo: REPO, issueNumber: 999 });
		expect(JSON.parse(res.content[0].text)).toEqual({
			error: "Issue not found",
		});
		expect(res.structuredContent).toEqual({ issue: null });
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("get_issue", "issues:getByRepoNumber", {
			repo: REPO,
			issueNumber: 667,
		});
	});
});

describe("update_issue_status", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const h = harness({ "issues:updateStatus": () => null });
		const res = await success(h, "update_issue_status", {
			repo: REPO,
			issueNumber: 667,
			status: "fixed",
		});
		expect(res.structuredContent).toEqual({
			repo: REPO,
			issueNumber: 667,
			status: "fixed",
			updated: true,
		});
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("update_issue_status", "issues:updateStatus", {
			repo: REPO,
			issueNumber: 667,
			status: "fixed",
		});
	});
});

describe("link_commit_to_issue (S-54: called)", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const h = harness({ "issues:linkCommit": () => null });
		const res = await success(h, "link_commit_to_issue", {
			repo: REPO,
			issueNumber: 667,
			commitSha: "abc1234",
			fixedBy: "alpha",
		});
		expect(res.structuredContent).toEqual({
			repo: REPO,
			issueNumber: 667,
			commitSha: "abc1234",
			fixedBy: "alpha",
			linked: true,
		});
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
		expect(h.calls.map((c) => c.fn)).toContain("issues:linkCommit");
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("link_commit_to_issue", "issues:linkCommit", {
			repo: REPO,
			issueNumber: 667,
			commitSha: "abc1234",
			fixedBy: "alpha",
		});
	});
});

describe("verify_issue (S-54: called)", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const h = harness({ "issues:verify": () => null });
		const res = await success(h, "verify_issue", {
			repo: REPO,
			issueNumber: 667,
			verifiedBy: "gamma",
		});
		expect(res.structuredContent).toEqual({
			repo: REPO,
			issueNumber: 667,
			verifiedBy: "gamma",
			verified: true,
		});
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
		expect(h.calls.map((c) => c.fn)).toContain("issues:verify");
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("verify_issue", "issues:verify", {
			repo: REPO,
			issueNumber: 667,
			verifiedBy: "gamma",
		});
	});
});

describe("issue_stats", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const stats = {
			open: 3,
			in_progress: 1,
			fixed: 2,
			verified: 1,
			closed: 5,
			total: 12,
		};
		const h = harness({ "issues:getStats": () => stats });
		const res = await success(h, "issue_stats", { project: "vantage-peers" });
		expect(res.structuredContent).toEqual(stats);
		expect(res.content[0].text).toBe(JSON.stringify(stats, null, 2));
		expect(h.calls[0].args).toEqual({ project: "vantage-peers" });
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		await refused("issue_stats", "issues:getStats", {});
	});
});
