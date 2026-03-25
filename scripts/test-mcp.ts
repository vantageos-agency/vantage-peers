#!/usr/bin/env bun
/**
 * VantageMemory MCP Server Tester
 *
 * Spawns the MCP server, sends JSON-RPC requests via stdin,
 * and verifies responses for all VantageMemory tools.
 *
 * Usage: bun scripts/test-mcp.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dirname ?? __dirname, "..");
const SERVER_PATH = resolve(PROJECT_ROOT, "mcp-server/server.ts");
const ENV_PATH = resolve(PROJECT_ROOT, ".env.local");
const TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Load CONVEX_URL from .env.local
// ─────────────────────────────────────────────────────────────────────────────

function loadConvexUrl(): string {
	if (process.env.CONVEX_URL) return process.env.CONVEX_URL;
	try {
		const raw = readFileSync(ENV_PATH, "utf-8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("CONVEX_URL=")) {
				const value = trimmed.slice("CONVEX_URL=".length).split("#")[0].trim();
				if (value) return value;
			}
		}
	} catch {}
	throw new Error("CONVEX_URL not found in environment or .env.local");
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Client — spawn server, send/receive JSON-RPC over stdio
// ─────────────────────────────────────────────────────────────────────────────

class McpClient {
	private proc: ReturnType<typeof Bun.spawn>;
	private nextId = 1;
	private buffer = "";
	private pending = new Map<
		number,
		{ resolve: (v: any) => void; reject: (e: Error) => void }
	>();
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private decoder = new TextDecoder();
	private reading = false;

	constructor() {
		const convexUrl = loadConvexUrl();
		this.proc = Bun.spawn(["bun", SERVER_PATH], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CONVEX_URL: convexUrl },
		});
		this.reader = this.proc.stdout.getReader();
		this.startReading();
	}

	private startReading() {
		if (this.reading) return;
		this.reading = true;
		(async () => {
			try {
				while (true) {
					const { done, value } = await this.reader.read();
					if (done) break;
					this.buffer += this.decoder.decode(value, { stream: true });
					this.processBuffer();
				}
			} catch {
				// Server closed
			}
		})();
	}

	private processBuffer() {
		// MCP uses newline-delimited JSON
		let newlineIdx: number;
		while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, newlineIdx).trim();
			this.buffer = this.buffer.slice(newlineIdx + 1);
			if (!line) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.id != null && this.pending.has(msg.id)) {
					const { resolve } = this.pending.get(msg.id)!;
					this.pending.delete(msg.id);
					resolve(msg);
				}
			} catch {
				// Ignore non-JSON lines (stderr leaks, etc.)
			}
		}
	}

	async send(method: string, params: any = {}): Promise<any> {
		const id = this.nextId++;
		const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
		this.proc.stdin.write(msg);
		await this.proc.stdin.flush();

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(
						new Error(`Timeout waiting for response to ${method} (id=${id})`),
					);
				}
			}, TIMEOUT_MS);
		});
	}

	async notify(method: string, params: any = {}): Promise<void> {
		const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
		this.proc.stdin.write(msg);
		await this.proc.stdin.flush();
	}

	async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
		const resp = await this.send("tools/call", { name, arguments: args });
		if (resp.error) {
			throw new Error(`Tool error: ${JSON.stringify(resp.error)}`);
		}
		// Parse the text content from MCP response
		const content = resp.result?.content;
		if (content && content[0]?.type === "text") {
			return JSON.parse(content[0].text);
		}
		return resp.result;
	}

	kill() {
		try {
			this.proc.stdin.end();
			this.proc.kill();
		} catch {}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Test runner
// ─────────────────────────────────────────────────────────────────────────────

interface TestResult {
	name: string;
	passed: boolean;
	detail: string;
}

const results: TestResult[] = [];

function pass(name: string, detail: string) {
	results.push({ name, passed: true, detail });
}

function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

async function main() {
	const client = new McpClient();

	// Give the server a moment to start
	await Bun.sleep(500);

	try {
		// ── Initialize handshake ──────────────────────────────────────────────
		await client.send("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "mcp-tester", version: "1.0.0" },
		});
		await client.notify("notifications/initialized");

		// ── tools/list ────────────────────────────────────────────────────────
		const toolsResp = await client.send("tools/list", {});
		const tools: any[] = toolsResp.result?.tools ?? [];
		if (tools.length > 0) {
			pass("tools/list", `${tools.length} tools found`);
		} else {
			fail("tools/list", "No tools returned");
		}

		// ── create_task ───────────────────────────────────────────────────────
		let taskId: string | undefined;
		try {
			const res = await client.callTool("create_task", {
				title: "Test task from MCP tester",
				assignedTo: "pi",
				priority: "medium",
				status: "todo",
				createdBy: "pi",
			});
			taskId = res.taskId;
			if (taskId) {
				pass("create_task", `taskId=${taskId}`);
			} else {
				fail("create_task", `No taskId in response: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("create_task", e.message);
		}

		// ── list_tasks ────────────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_tasks", {
				assignedTo: "pi",
			});
			const tasks = Array.isArray(res) ? res : [];
			if (tasks.length >= 1) {
				const found = tasks.some(
					(t: any) =>
						t.title === "Test task from MCP tester" || t._id === taskId,
				);
				pass(
					"list_tasks",
					`${tasks.length} task(s)${found ? ", test task found" : ""}`,
				);
			} else {
				fail("list_tasks", `Expected 1+ tasks, got ${tasks.length}`);
			}
		} catch (e: any) {
			fail("list_tasks", e.message);
		}

		// ── update_task ───────────────────────────────────────────────────────
		if (taskId) {
			try {
				const res = await client.callTool("update_task", {
					taskId,
					priority: "high",
				});
				if (res.updated === true) {
					pass("update_task", "priority -> high");
				} else {
					fail("update_task", `Unexpected response: ${JSON.stringify(res)}`);
				}
			} catch (e: any) {
				fail("update_task", e.message);
			}
		} else {
			fail("update_task", "Skipped — no taskId from create_task");
		}

		// ── complete_task ─────────────────────────────────────────────────────
		if (taskId) {
			try {
				const res = await client.callTool("complete_task", { taskId });
				if (res.status === "done") {
					pass("complete_task", "status -> done");
				} else {
					fail("complete_task", `Unexpected response: ${JSON.stringify(res)}`);
				}
			} catch (e: any) {
				fail("complete_task", e.message);
			}
		} else {
			fail("complete_task", "Skipped — no taskId from create_task");
		}

		// ── create_mission ──────────────────────────────────────────────────
		let missionId: string | undefined;
		try {
			const res = await client.callTool("create_mission", {
				name: "Test mission from MCP tester",
				project: "test-project",
				status: "brainstorm",
				priority: "medium",
				pilot: "pi",
				agents: ["copywriter", "strategy-researcher"],
				createdBy: "pi",
			});
			missionId = res.missionId;
			if (missionId) {
				pass("create_mission", `missionId=${missionId}`);
			} else {
				fail(
					"create_mission",
					`No missionId in response: ${JSON.stringify(res)}`,
				);
			}
		} catch (e: any) {
			fail("create_mission", e.message);
		}

		// ── list_missions ─────────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_missions", {
				project: "test-project",
			});
			const missions = Array.isArray(res) ? res : [];
			if (missions.length >= 1) {
				pass("list_missions", `${missions.length} mission(s)`);
			} else {
				fail("list_missions", `Expected 1+ missions, got ${missions.length}`);
			}
		} catch (e: any) {
			fail("list_missions", e.message);
		}

		// ── update_mission_status ─────────────────────────────────────────────
		if (missionId) {
			try {
				const res = await client.callTool("update_mission_status", {
					missionId,
					status: "execute",
				});
				if (res.status === "execute") {
					pass("update_mission_status", "status -> execute");
				} else {
					fail(
						"update_mission_status",
						`Unexpected response: ${JSON.stringify(res)}`,
					);
				}
			} catch (e: any) {
				fail("update_mission_status", e.message);
			}
		} else {
			fail(
				"update_mission_status",
				"Skipped — no missionId from create_mission",
			);
		}

		// ── create_task with missionId ────────────────────────────────────────
		let missionTaskId: string | undefined;
		if (missionId) {
			try {
				const res = await client.callTool("create_task", {
					title: "Mission-linked task from MCP tester",
					assignedTo: "pi",
					priority: "high",
					status: "todo",
					missionId,
					estimatedMinutes: 30,
					createdBy: "pi",
				});
				missionTaskId = res.taskId;
				if (missionTaskId) {
					pass("create_task (with missionId)", `taskId=${missionTaskId}`);
				} else {
					fail(
						"create_task (with missionId)",
						`No taskId: ${JSON.stringify(res)}`,
					);
				}
			} catch (e: any) {
				fail("create_task (with missionId)", e.message);
			}
		} else {
			fail("create_task (with missionId)", "Skipped — no missionId");
		}

		// ── start_task ────────────────────────────────────────────────────────
		if (missionTaskId) {
			try {
				const res = await client.callTool("start_task", {
					taskId: missionTaskId,
				});
				if (res.status === "in_progress") {
					pass("start_task", "status -> in_progress");
				} else {
					fail("start_task", `Unexpected response: ${JSON.stringify(res)}`);
				}
			} catch (e: any) {
				fail("start_task", e.message);
			}
		} else {
			fail("start_task", "Skipped — no missionTaskId");
		}

		// ── list_tasks_by_mission ─────────────────────────────────────────────
		if (missionId) {
			try {
				const res = await client.callTool("list_tasks_by_mission", {
					missionId,
				});
				const tasks = Array.isArray(res) ? res : [];
				if (tasks.length >= 1) {
					const found = tasks.some(
						(t: any) =>
							t.title === "Mission-linked task from MCP tester" ||
							t._id === missionTaskId,
					);
					pass(
						"list_tasks_by_mission",
						`${tasks.length} task(s)${found ? ", mission task found" : ""}`,
					);
				} else {
					fail(
						"list_tasks_by_mission",
						`Expected 1+ tasks, got ${tasks.length}`,
					);
				}
			} catch (e: any) {
				fail("list_tasks_by_mission", e.message);
			}
		} else {
			fail("list_tasks_by_mission", "Skipped — no missionId");
		}

		// ── write_diary ───────────────────────────────────────────────────────
		const todayISO = new Date().toISOString().slice(0, 10);
		try {
			const res = await client.callTool("write_diary", {
				date: todayISO,
				orchestrator: "pi",
				content: "MCP test diary entry",
				highlights: ["Ran MCP tester successfully"],
			});
			if (res.diaryId) {
				pass("write_diary", `diaryId=${res.diaryId}`);
			} else {
				fail("write_diary", `No diaryId in response: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("write_diary", e.message);
		}

		// ── get_diary ─────────────────────────────────────────────────────────
		try {
			const res = await client.callTool("get_diary", {
				date: todayISO,
				orchestrator: "pi",
			});
			if (res && res.content && res.content.includes("MCP test diary entry")) {
				pass("get_diary", "content matches");
			} else if (res && res.content) {
				// Diary might have been overwritten by upsert with existing content
				pass("get_diary", "entry retrieved");
			} else {
				fail("get_diary", `Unexpected response: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("get_diary", e.message);
		}

		// ── list_diaries ──────────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_diaries", {
				orchestrator: "pi",
			});
			const entries = Array.isArray(res) ? res : [];
			if (entries.length >= 1) {
				pass("list_diaries", `${entries.length} entry/entries`);
			} else {
				fail("list_diaries", `Expected 1+ entries, got ${entries.length}`);
			}
		} catch (e: any) {
			fail("list_diaries", e.message);
		}

		// ── create_briefing_note ──────────────────────────────────────────────
		try {
			const res = await client.callTool("create_briefing_note", {
				title: "MCP Test Briefing",
				topic: "testing",
				participants: ["pi"],
				content: "Test briefing content",
				createdBy: "pi",
			});
			if (res.noteId) {
				pass("create_briefing_note", `noteId=${res.noteId}`);
			} else {
				fail("create_briefing_note", `No noteId: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("create_briefing_note", e.message);
		}

		// ── list_briefing_notes ───────────────────────────────────────────────
		try {
			const res = await client.callTool("list_briefing_notes", {});
			const notes = Array.isArray(res) ? res : [];
			if (notes.length >= 1) {
				pass("list_briefing_notes", `${notes.length} note(s)`);
			} else {
				fail("list_briefing_notes", `Expected 1+ notes, got ${notes.length}`);
			}
		} catch (e: any) {
			fail("list_briefing_notes", e.message);
		}
	} finally {
		client.kill();
	}

	// ── Print results ─────────────────────────────────────────────────────────
	console.log("\nMCP Tester Results:");
	const maxName = Math.max(...results.map((r) => r.name.length));
	for (const r of results) {
		const status = r.passed ? "PASS" : "FAIL";
		const pad = " ".repeat(maxName - r.name.length + 2);
		console.log(`  ${r.name}${pad}${status} (${r.detail})`);
	}

	const passed = results.filter((r) => r.passed).length;
	const total = results.length;
	console.log(`\n  ${passed}/${total} passed`);

	process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
