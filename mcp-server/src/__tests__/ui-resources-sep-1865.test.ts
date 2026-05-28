/**
 * Tests for SEP-1865 ui:// resources M1 — VantagePeers Generative UI primitives backend.
 *
 * Mission : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
 * Template VR : gui-iframe-embed-v1 v1.0.0 (jx7bzk0x1086tgwgj2zrssk2pn87k1ga).
 */

import { describe, expect, it } from "vitest";
import {
	listUiResources,
	PRIMITIVES,
	parseUiUri,
	readUiResource,
} from "../ui-resources/index.js";

describe("parseUiUri (M1 SEP-1865)", () => {
	it("parses ui://vp/v1/tasks-table without query", () => {
		const p = parseUiUri("ui://vp/v1/tasks-table");
		expect(p).not.toBeNull();
		expect(p?.primitive).toBe("tasks-table");
		expect(Array.from(p?.query.entries())).toEqual([]);
	});

	it("parses ui://vp/v1/tasks-table?status=todo&limit=10", () => {
		const p = parseUiUri("ui://vp/v1/tasks-table?status=todo&limit=10");
		expect(p).not.toBeNull();
		expect(p?.primitive).toBe("tasks-table");
		expect(p?.query.get("status")).toBe("todo");
		expect(p?.query.get("limit")).toBe("10");
	});

	it("rejects non-ui:// scheme", () => {
		expect(parseUiUri("https://vp/v1/tasks-table")).toBeNull();
		expect(parseUiUri("file://vp/v1/tasks-table")).toBeNull();
	});

	it("rejects wrong host segment", () => {
		expect(parseUiUri("ui://crm/v1/tasks-table")).toBeNull();
	});

	it("rejects wrong version segment", () => {
		expect(parseUiUri("ui://vp/v2/tasks-table")).toBeNull();
	});
});

describe("listUiResources (M1 SEP-1865)", () => {
	it("returns ≥1 resource (M1 ships tasks-table)", () => {
		const resources = listUiResources();
		expect(resources.length).toBeGreaterThanOrEqual(1);
		expect(resources[0].uri).toBe("ui://vp/v1/tasks-table");
		expect(resources[0].mimeType).toBe("text/html");
	});

	it("each resource has uri + name + description + mimeType", () => {
		for (const r of listUiResources()) {
			expect(r.uri).toMatch(/^ui:\/\/vp\/v1\/[a-z][a-z0-9-]*$/);
			expect(r.name).toBeTypeOf("string");
			expect(r.description).toBeTypeOf("string");
			expect(r.mimeType).toBe("text/html");
		}
	});
});

describe("readUiResource (M1 tasks-table)", () => {
	it("renders empty table when backend returns no tasks", async () => {
		const fetchConvex = async (
			_fn: string,
			_args: Record<string, unknown>,
		) => [];
		const r = await readUiResource(
			"ui://vp/v1/tasks-table?limit=10",
			fetchConvex,
		);
		expect(r.uri).toBe("ui://vp/v1/tasks-table?limit=10");
		expect(r.mimeType).toBe("text/html");
		expect(r.text).toContain("vp-tasks-table");
		expect(r.text).toContain("0 task");
	});

	it("renders tasks rows with status badge classes", async () => {
		const fetchConvex = async () => [
			{ _id: "k1", title: "Test task 1", status: "todo", priority: "high" },
			{ _id: "k2", title: "Test task 2", status: "review", priority: "medium" },
		];
		const r = await readUiResource(
			"ui://vp/v1/tasks-table?limit=5",
			fetchConvex,
		);
		expect(r.text).toContain("Test task 1");
		expect(r.text).toContain("Test task 2");
		expect(r.text).toContain("vp-status-todo");
		expect(r.text).toContain("vp-status-review");
		expect(r.text).toContain("2 tasks");
	});

	it("renders French labels when lang=fr", async () => {
		const fetchConvex = async () => [
			{ _id: "k1", title: "Tâche test", status: "todo" },
		];
		const r = await readUiResource(
			"ui://vp/v1/tasks-table?lang=fr",
			fetchConvex,
		);
		expect(r.text).toContain("Titre");
		expect(r.text).toContain("Statut");
		expect(r.text).toContain("1 tâche");
	});

	it("forwards status array (comma-separated) to backend args", async () => {
		let receivedArgs: Record<string, unknown> = {};
		const fetchConvex = async (_fn: string, args: Record<string, unknown>) => {
			receivedArgs = args;
			return [];
		};
		await readUiResource(
			"ui://vp/v1/tasks-table?status=todo,in_progress",
			fetchConvex,
		);
		expect(receivedArgs.status).toEqual(["todo", "in_progress"]);
	});

	it("forwards createdBy + assignedTo to backend args", async () => {
		let receivedArgs: Record<string, unknown> = {};
		const fetchConvex = async (_fn: string, args: Record<string, unknown>) => {
			receivedArgs = args;
			return [];
		};
		await readUiResource(
			"ui://vp/v1/tasks-table?createdBy=pi&assignedTo=sigma",
			fetchConvex,
		);
		expect(receivedArgs.createdBy).toBe("pi");
		expect(receivedArgs.assignedTo).toBe("sigma");
	});

	it("escapes HTML in task title (XSS prevention)", async () => {
		const fetchConvex = async () => [
			{
				_id: "k1",
				title: "<script>alert('xss')</script>",
				status: "todo",
			},
		];
		const r = await readUiResource("ui://vp/v1/tasks-table", fetchConvex);
		expect(r.text).not.toContain("<script>alert");
		expect(r.text).toContain("&lt;script&gt;");
	});

	it("returns error div when backend throws", async () => {
		const fetchConvex = async () => {
			throw new Error("Backend unavailable");
		};
		const r = await readUiResource("ui://vp/v1/tasks-table", fetchConvex);
		expect(r.text).toContain("vp-tasks-table-error");
		expect(r.text).toContain("Backend unavailable");
	});

	it("rejects unknown primitive with throw", async () => {
		const fetchConvex = async () => [];
		await expect(
			readUiResource("ui://vp/v1/unknown-primitive", fetchConvex),
		).rejects.toThrow("Unknown primitive");
	});

	it("clamps limit to 1-200 range", async () => {
		let receivedArgs: Record<string, unknown> = {};
		const fetchConvex = async (_fn: string, args: Record<string, unknown>) => {
			receivedArgs = args;
			return [];
		};
		await readUiResource("ui://vp/v1/tasks-table?limit=500", fetchConvex);
		expect(receivedArgs.limit).toBe(200);
		await readUiResource("ui://vp/v1/tasks-table?limit=0", fetchConvex);
		expect(receivedArgs.limit).toBe(1);
	});
});

describe("PRIMITIVES registry (M1)", () => {
	it("exposes tasks-table as initial M1 primitive", () => {
		expect(PRIMITIVES).toContain("tasks-table");
	});
});
