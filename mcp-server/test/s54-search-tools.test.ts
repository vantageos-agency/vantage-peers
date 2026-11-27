/**
 * The search tools (text_search, hybrid_search, search_episodes_by_keyword,
 * search_episodes_by_semantic, get_episode) are called through the real
 * registerTools() against a mocked Convex client (VantagePeers Cloud +
 * Self-host, MCP server; S-54 of mcp-doctor "tools-tested").
 *
 * Each tool: one success (the door answer reaches the caller as text and as a
 * structuredContent that validates against its declared outputSchema, the door
 * receiving the arguments the tool is documented to forward) and one refusal
 * (a namespace the bearer may not read is refused before any door; an id that is
 * not an episode is a typed not-found).
 */

import { describe, expect, it } from "vitest";
import { CLIENT_CTX, expectRefused, expectServed, harness } from "./lib/s54Harness.js";

const kw = [
	{ memoryId: "m1", namespace: "project/ops", type: "episode", content: "convex deploy schema" },
];

describe("text_search", () => {
	it("serves the BM25 matches and forwards query, namespace, type and limit to search:textSearch", async () => {
		const h = harness({ "search:textSearch": () => kw });
		const res = await h.tools.get("text_search")!.handler({
			query: "deploy",
			namespace: "project/ops",
			type: "project",
			limit: 5,
		});
		const out = expectServed(h.tools, "text_search", res);
		expect(out.items).toEqual(kw);
		expect(JSON.parse(res.content[0].text)).toEqual(kw);
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0].fn).toBe("search:textSearch");
		expect(h.calls[0].args).toMatchObject({
			query: "deploy",
			namespace: "project/ops",
			type: "project",
			limit: 5,
		});
	});

	it("refuses a namespace the bearer may not read, before any door", async () => {
		const h = harness({ "search:textSearch": () => kw }, CLIENT_CTX);
		const res = await h.tools.get("text_search")!.handler({
			query: "deploy",
			namespace: "orchestrator/sigma",
		});
		expectRefused(res, /Forbidden|namespace/i);
		expect(h.calls).toHaveLength(0);
	});
});

describe("hybrid_search", () => {
	const hy = [
		{ memoryId: "m2", rrfScore: 0.031, namespace: "project/ops", type: "reference", content: "rrf" },
	];

	it("serves the fused matches and forwards the two weights to search:hybridSearch", async () => {
		const h = harness({ "search:hybridSearch": () => hy });
		const res = await h.tools.get("hybrid_search")!.handler({
			query: "intent",
			namespace: "project/ops",
			vectorWeight: 0.7,
			textWeight: 0.3,
		});
		const out = expectServed(h.tools, "hybrid_search", res);
		expect(out.items).toEqual(hy);
		expect(h.calls[0].fn).toBe("search:hybridSearch");
		expect(h.calls[0].args).toMatchObject({
			query: "intent",
			vectorWeight: 0.7,
			textWeight: 0.3,
			limit: 20,
		});
	});

	it("refuses a namespace the bearer may not read, before any door", async () => {
		const h = harness({ "search:hybridSearch": () => hy }, CLIENT_CTX);
		const res = await h.tools.get("hybrid_search")!.handler({
			query: "intent",
			namespace: "team/other-org",
		});
		expectRefused(res, /Forbidden|namespace/i);
		expect(h.calls).toHaveLength(0);
	});
});

describe("search_episodes_by_keyword", () => {
	it("restricts the BM25 search to type 'episode'", async () => {
		const h = harness({ "search:textSearch": () => kw });
		const res = await h.tools.get("search_episodes_by_keyword")!.handler({
			query: "convex deploy schema",
			namespace: "project/ops",
		});
		const out = expectServed(h.tools, "search_episodes_by_keyword", res);
		expect(out.items).toEqual(kw);
		expect(h.calls[0].fn).toBe("search:textSearch");
		expect(h.calls[0].args.type).toBe("episode");
	});

	it("refuses a namespace the bearer may not read, before any door", async () => {
		const h = harness({ "search:textSearch": () => kw }, CLIENT_CTX);
		const res = await h.tools.get("search_episodes_by_keyword")!.handler({
			query: "x",
			namespace: "orchestrator/sigma",
		});
		expectRefused(res, /Forbidden|namespace/i);
		expect(h.calls).toHaveLength(0);
	});
});

describe("search_episodes_by_semantic", () => {
	const sem = [
		{ memoryId: "m3", score: 0.91, namespace: "project/ops", type: "episode", content: "hook false positive" },
	];

	it("restricts the semantic search to type 'episode' through search:recall", async () => {
		const h = harness({ "search:recall": () => sem });
		const res = await h.tools.get("search_episodes_by_semantic")!.handler({
			query: "hook false positive blocked publish",
			namespace: "project/ops",
			limit: 3,
		});
		const out = expectServed(h.tools, "search_episodes_by_semantic", res);
		expect(out.items).toEqual(sem);
		expect(h.calls[0].fn).toBe("search:recall");
		expect(h.calls[0].args).toMatchObject({ type: "episode", limit: 3 });
	});

	it("refuses a namespace the bearer may not read, before any door", async () => {
		const h = harness({ "search:recall": () => sem }, CLIENT_CTX);
		const res = await h.tools.get("search_episodes_by_semantic")!.handler({
			query: "x",
			namespace: "orchestrator/sigma",
		});
		expectRefused(res, /Forbidden|namespace/i);
		expect(h.calls).toHaveLength(0);
	});
});

describe("get_episode", () => {
	const EPISODE_ID = "j57dy3049btafda9m2f5d2ggk987ph3f";
	const row = (type: string) => ({
		_id: EPISODE_ID,
		_creationTime: 1_700_000_000_000,
		namespace: "project/ops",
		type,
		content: "context goal action outcome insight",
		createdBy: "beta",
	});

	it("serves the episode row as text and structuredContent", async () => {
		const h = harness({ "memories:getMemory": () => row("episode") });
		const res = await h.tools.get("get_episode")!.handler({ episodeId: EPISODE_ID });
		const out = expectServed(h.tools, "get_episode", res);
		expect(out).toEqual(row("episode"));
		expect(JSON.parse(res.content[0].text)).toEqual(row("episode"));
		expect(h.calls[0].args.memoryId).toBe(EPISODE_ID);
	});

	it("answers 'Episode not found' for a memory that is not an episode", async () => {
		const h = harness({ "memories:getMemory": () => row("project") });
		const res = await h.tools.get("get_episode")!.handler({ episodeId: EPISODE_ID });
		expectRefused(res, /Episode not found/);
	});

	it("answers 'Episode not found' when the door returns no row", async () => {
		const h = harness({ "memories:getMemory": () => null });
		const res = await h.tools.get("get_episode")!.handler({ episodeId: EPISODE_ID });
		expectRefused(res, /Episode not found/);
	});
});
