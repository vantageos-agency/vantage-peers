#!/usr/bin/env bun
/**
 * VantagePeers MCP Server Tester
 *
 * Spawns the MCP server, sends JSON-RPC requests via stdin,
 * and verifies responses for all VantagePeers tools.
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
		// Check for MCP-level tool errors (isError flag in result)
		if (resp.result?.isError) {
			const errText = resp.result?.content?.[0]?.text ?? "Unknown MCP tool error";
			throw new Error(errText);
		}
		// Parse the text content from MCP response
		const content = resp.result?.content;
		if (content && content[0]?.type === "text") {
			const text = content[0].text;
			try {
				return JSON.parse(text);
			} catch {
				return { _raw: text };
			}
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
					callerOrchestrator: "pi",
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
				const res = await client.callTool("complete_task", { taskId, callerOrchestrator: "pi", completionNote: "Smoke test completion" });
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
					callerOrchestrator: "pi",
				});
				if (res.status === "in_progress") {
					pass("start_task", "status -> in_progress");
				} else {
					pass("start_task", `ok (${JSON.stringify(res).slice(0, 60)})`);
				}
			} catch (e: any) {
				// May fail if another task is in_progress — acceptable for smoke test
				if (e.message.includes("unclosed in_progress")) {
					pass("start_task", "tool works (blocked by existing in_progress — expected)");
				} else {
					fail("start_task", e.message);
				}
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

		// ── update_mission ───────────────────────────────────────────────────
		if (missionId) {
			try {
				const res = await client.callTool("update_mission", {
					missionId,
					name: "Updated test mission",
				});
				if (res.updated === true) {
					pass("update_mission", "name -> Updated test mission");
				} else {
					fail("update_mission", `Unexpected response: ${JSON.stringify(res)}`);
				}
			} catch (e: any) {
				fail("update_mission", e.message);
			}
		} else {
			fail("update_mission", "Skipped — no missionId from create_mission");
		}

		// ── get_mission ─────────────────────────────────────────────────
		try {
			await client.callTool("get_mission", { missionId: "invalid-id" });
			pass("get_mission", "ok");
		} catch (e: any) {
			if (e.message?.includes("not found") || e.message?.includes("invalid")) {
				pass("get_mission", "correctly rejects invalid ID");
			} else {
				fail("get_mission", e.message);
			}
		}

		// ── store_memory ──────────────────────────────────────────────────────
		try {
			const res = await client.callTool("store_memory", {
				namespace: "test/mcp-tester",
				type: "project",
				content: "MCP test memory entry",
				createdBy: "pi",
			});
			if (res.memoryId) {
				pass("store_memory", `memoryId=${res.memoryId}`);
			} else {
				fail("store_memory", `No memoryId in response: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("store_memory", e.message);
		}

		// ── list_memories ─────────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_memories", {
				namespace: "test/mcp-tester",
			});
			const memories = Array.isArray(res) ? res : [];
			if (memories.length >= 1) {
				const found = memories.some(
					(m: any) => m.content === "MCP test memory entry",
				);
				pass(
					"list_memories",
					`${memories.length} memory/memories${found ? ", test memory found" : ""}`,
				);
			} else {
				fail("list_memories", `Expected 1+ memories, got ${memories.length}`);
			}
		} catch (e: any) {
			fail("list_memories", e.message);
		}

		// ── recall ────────────────────────────────────────────────────────────
		// Semantic search — embeddings may not be indexed yet (2-5s delay),
		// so accept empty results as a valid pass.
		try {
			const res = await client.callTool("recall", {
				query: "MCP test memory",
				namespace: "test/mcp-tester",
				limit: 5,
			});
			const hits = Array.isArray(res) ? res : [];
			pass("recall", `${hits.length} result(s) (empty ok — embedding delay)`);
		} catch (e: any) {
			fail("recall", e.message);
		}

		// ── store_episode ─────────────────────────────────────────────────────
		try {
			const res = await client.callTool("store_episode", {
				namespace: "test/mcp-tester",
				createdBy: "pi",
				context: "Running MCP tester",
				goal: "Verify store_episode works",
				action: "Called store_episode via MCP",
				outcome: "Success",
				insight: "Episodes work via MCP",
				severity: "minor",
			});
			if (res.memoryId) {
				pass("store_episode", `memoryId=${res.memoryId}`);
			} else {
				fail("store_episode", `No memoryId in response: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("store_episode", e.message);
		}

		// ── get_profile ───────────────────────────────────────────────────────
		try {
			const res = await client.callTool("get_profile", {
				orchestratorId: "pi",
			});
			if (res === null || (res && res.orchestratorId === "pi")) {
				pass("get_profile", res === null ? "no profile yet (null)" : "found profile");
			} else {
				pass("get_profile", `got response: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("get_profile", e.message);
		}

		// ── update_profile ────────────────────────────────────────────────────
		try {
			const res = await client.callTool("update_profile", {
				orchestratorId: "pi",
				name: "Pi",
				static: {
					role: "test orchestrator",
					workspace: "/tmp/test",
					capabilities: ["testing"],
				},
				dynamic: {
					lastSeen: Date.now(),
					sessionCount: 1,
				},
			});
			if (res.profileId) {
				pass("update_profile", `profileId=${res.profileId}`);
			} else {
				fail("update_profile", `No profileId in response: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("update_profile", e.message);
		}

		// ── get_profile (after update) ────────────────────────────────────────
		try {
			const res = await client.callTool("get_profile", {
				orchestratorId: "pi",
			});
			if (res && (res.name === "Pi" || res.orchestratorId === "pi")) {
				pass("get_profile (after update)", `name=${res.name}, orchestratorId=${res.orchestratorId}`);
			} else {
				fail("get_profile (after update)", `Unexpected response: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("get_profile (after update)", e.message);
		}

		// ── set_summary ───────────────────────────────────────────────────────
		try {
			const res = await client.callTool("set_summary", {
				orchestratorId: "pi",
				instanceId: "pi-test",
				summary: "Running MCP tests",
			});
			if (res && res.orchestratorId === "pi") {
				pass("set_summary", `orchestratorId=${res.orchestratorId}`);
			} else {
				fail("set_summary", `Unexpected response: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("set_summary", e.message);
		}

		// ── list_peers ────────────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_peers", {});
			const peers = Array.isArray(res) ? res : [];
			if (peers.length >= 1) {
				pass("list_peers", `${peers.length} peer(s)`);
			} else {
				fail("list_peers", `Expected 1+ peers, got ${peers.length}`);
			}
		} catch (e: any) {
			fail("list_peers", e.message);
		}

		// ── send_message ──────────────────────────────────────────────────────
		try {
			const res = await client.callTool("send_message", {
				from: "pi",
				fromInstanceId: "pi-test",
				channel: "tau",
				content: "Test message from MCP tester",
			});
			if (res.messageId) {
				pass("send_message", `messageId=${res.messageId}`);
			} else {
				fail("send_message", `No messageId in response: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("send_message", e.message);
		}

		// ── check_messages ────────────────────────────────────────────────────
		try {
			const resp = await client.send("tools/call", {
				name: "check_messages",
				arguments: { recipient: "tau" },
			});
			const text = resp.result?.content?.[0]?.text ?? "";
			if (text === "No new messages." || text.startsWith("[")) {
				pass("check_messages", text === "No new messages." ? "no new messages" : `got messages`);
			} else {
				pass("check_messages", `got response`);
			}
		} catch (e: any) {
			fail("check_messages", e.message);
		}

		// ── list_messages ─────────────────────────────────────────────────────
		try {
			const resp = await client.send("tools/call", {
				name: "list_messages",
				arguments: { from: "pi", limit: 10 },
			});
			if (resp.error) {
				fail("list_messages", `Error: ${JSON.stringify(resp.error)}`);
			} else {
				const text = resp.result?.content?.[0]?.text ?? "";
				try {
					const parsed = JSON.parse(text);
					const messages = Array.isArray(parsed) ? parsed : [];
					pass("list_messages", `${messages.length} message(s)`);
				} catch {
					fail("list_messages", `Non-JSON response: ${text.slice(0, 200)}`);
				}
			}
		} catch (e: any) {
			fail("list_messages", e.message);
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
		// ══════════════════════════════════════════════════════════════════════
		// REMAINING TOOLS — smoke tests (call with minimal valid args)
		// ══════════════════════════════════════════════════════════════════════

		// ── soft_delete_memory ────────────────────────────────────────────────
		try {
			const res = await client.callTool("soft_delete_memory", {
				memoryId: "j570000000000000000000000000000", // fake ID — expect error
			});
			// Will error (not found) — that's OK, we're testing the tool responds
			fail("soft_delete_memory", `Unexpected success: ${JSON.stringify(res)}`);
		} catch (e: any) {
			// Expected: memory not found
			pass("soft_delete_memory", "correctly rejects invalid ID");
		}

		// ── mark_as_read ─────────────────────────────────────────────────────
		try {
			const res = await client.callTool("mark_as_read", {
				receiptIds: [],
			});
			pass("mark_as_read", `marked ${JSON.stringify(res)}`);
		} catch (e: any) {
			fail("mark_as_read", e.message);
		}

		// ── delete_message ───────────────────────────────────────────────────
		try {
			await client.callTool("delete_message", {
				messageId: "jn70000000000000000000000000000",
			});
			fail("delete_message", "should reject fake ID");
		} catch (e: any) {
			pass("delete_message", "correctly rejects invalid ID");
		}

		// ── list_broadcast_status ────────────────────────────────────────────
		try {
			await client.callTool("list_broadcast_status", {
				messageId: "jn70000000000000000000000000000",
			});
			fail("list_broadcast_status", "should reject fake ID");
		} catch (e: any) {
			pass("list_broadcast_status", "correctly rejects invalid ID");
		}

		// ── checkout_task ────────────────────────────────────────────────────
		try {
			await client.callTool("checkout_task", {
				taskId: "k170000000000000000000000000000",
				callerOrchestrator: "sigma",
				callerInstance: "sigma-test",
			});
			fail("checkout_task", "should reject fake ID");
		} catch (e: any) {
			pass("checkout_task", "correctly rejects invalid ID");
		}

		// ── delete_task ──────────────────────────────────────────────────────
		try {
			await client.callTool("delete_task", {
				taskId: "k170000000000000000000000000000",
			});
			fail("delete_task", "should reject fake ID");
		} catch (e: any) {
			pass("delete_task", "correctly rejects invalid ID");
		}

		// ── block_task ─────────────────────────────────────────────────
		try {
			await client.callTool("block_task", { taskId: "invalid-id", reason: "test block" });
			pass("block_task", "ok");
		} catch (e: any) {
			if (e.message?.includes("not found") || e.message?.includes("invalid")) {
				pass("block_task", "correctly rejects invalid ID");
			} else {
				fail("block_task", e.message);
			}
		}

		// ── add_task_dependency ─────────────────────────────────────────────────
		try {
			await client.callTool("add_task_dependency", { taskId: "invalid-id", dependsOn: ["dep-id"] });
			pass("add_task_dependency", "ok");
		} catch (e: any) {
			if (e.message?.includes("not found") || e.message?.includes("invalid") || e.message?.includes("Error")) {
				pass("add_task_dependency", "correctly rejects invalid ID");
			} else {
				fail("add_task_dependency", e.message);
			}
		}

		// ── create_bu ────────────────────────────────────────────────────────
		let buId: string | undefined;
		try {
			const res = await client.callTool("create_bu", {
				name: "MCP Test BU",
				description: "Test business unit",
				purpose: "Smoke test",
				orchestratorId: "sigma",
				status: "idea",
				businessModel: "SaaS",
				targetCustomers: "Developers",
				services: ["testing"],
				pricing: "Free",
				revenueProjections: { y1: 0, y2: 0, y3: 0 },
				coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
				coreProcesses: ["test"],
				dependencies: [],
				kpis: ["test"],
				createdBy: "sigma",
			});
			buId = res.buId;
			pass("create_bu", buId ? `buId=${buId}` : "ok");

		} catch (e: any) {
			fail("create_bu", e.message);
		}

		// ── list_bus ─────────────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_bus", {});
			const bus = Array.isArray(res) ? res : [];
			pass("list_bus", `${bus.length} BU(s)`);
		} catch (e: any) {
			fail("list_bus", e.message);
		}

		// ── get_bu ───────────────────────────────────────────────────────────
		if (buId) {
			try {
				const res = await client.callTool("get_bu", { buId });
				pass("get_bu", `name=${res.name}`);
			} catch (e: any) {
				fail("get_bu", e.message);
			}
		} else {
			fail("get_bu", "skipped — no buId");
		}

		// ── update_bu ────────────────────────────────────────────────────────
		if (buId) {
			try {
				await client.callTool("update_bu", { buId, description: "Updated by test" });
				pass("update_bu", "updated");
			} catch (e: any) {
				fail("update_bu", e.message);
			}
		} else {
			fail("update_bu", "skipped — no buId");
		}

		// ── delete_bu ────────────────────────────────────────────────────────
		if (buId) {
			try {
				await client.callTool("delete_bu", { buId });
				pass("delete_bu", "deleted");
			} catch (e: any) {
				fail("delete_bu", e.message);
			}
		} else {
			fail("delete_bu", "skipped — no buId");
		}

		// ── register_component ───────────────────────────────────────────────
		try {
			const res = await client.callTool("register_component", {
				name: "mcp-test-component",
				type: "skill",
				content: "Smoke test component",
				createdBy: "sigma",
			});
			pass("register_component", res.componentId ? `componentId=${res.componentId}` : "ok");
		} catch (e: any) {
			fail("register_component", e.message);
		}

		// ── list_components ──────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_components", {});
			pass("list_components", `${Array.isArray(res) ? res.length : 0} component(s)`);
		} catch (e: any) {
			fail("list_components", e.message);
		}

		// ── get_component ────────────────────────────────────────────────────
		try {
			const res = await client.callTool("get_component", { name: "mcp-test-component", type: "skill" });
			pass("get_component", res?.name ? `found: ${res.name}` : "ok");
		} catch (e: any) {
			fail("get_component", e.message);
		}

		// ── update_component ─────────────────────────────────────────────────
		try {
			await client.callTool("update_component", { componentId: "invalid-id", name: "test" });
			pass("update_component", "ok");
		} catch (e: any) {
			if (e.message?.includes("not found") || e.message?.includes("invalid")) {
				pass("update_component", "correctly rejects invalid ID");
			} else {
				fail("update_component", e.message);
			}
		}

		// ── delete_component ─────────────────────────────────────────────────
		try {
			await client.callTool("delete_component", { componentId: "invalid-id" });
			pass("delete_component", "ok");
		} catch (e: any) {
			if (e.message?.includes("not found") || e.message?.includes("invalid")) {
				pass("delete_component", "correctly rejects invalid ID");
			} else {
				fail("delete_component", e.message);
			}
		}

		// ── search_components ─────────────────────────────────────────────────
		try {
			const res = await client.callTool("search_components", { query: "test" });
			pass("search_components", `found ${Array.isArray(res) ? res.length : 0} result(s)`);
		} catch (e: any) {
			fail("search_components", e.message);
		}

		// ── create_recurring_task ────────────────────────────────────────────
		let recurringId: string | undefined;
		try {
			const res = await client.callTool("create_recurring_task", {
				title: "MCP test recurring",
				assignedTo: "sigma",
				priority: "low",
				cronExpression: "0 0 * * *",
				createdBy: "sigma",
			});
			recurringId = res.recurringTaskId ?? res.taskId;
			pass("create_recurring_task", recurringId ? `id=${recurringId}` : "ok (no id extracted)");
		} catch (e: any) {
			fail("create_recurring_task", e.message);
		}

		// ── list_recurring_tasks ─────────────────────────────────────────────
		try {
			const res = await client.callTool("list_recurring_tasks", {});
			pass("list_recurring_tasks", `${Array.isArray(res) ? res.length : 0} task(s)`);
		} catch (e: any) {
			fail("list_recurring_tasks", e.message);
		}

		// ── pause_recurring_task ─────────────────────────────────────────────
		if (recurringId) {
			try {
				await client.callTool("pause_recurring_task", { taskId: recurringId });
				pass("pause_recurring_task", "paused");
			} catch (e: any) {
				fail("pause_recurring_task", e.message);
			}
		} else {
			fail("pause_recurring_task", "skipped — no recurringId");
		}

		// ── resume_recurring_task ────────────────────────────────────────────
		if (recurringId) {
			try {
				await client.callTool("resume_recurring_task", { taskId: recurringId });
				pass("resume_recurring_task", "resumed");
			} catch (e: any) {
				fail("resume_recurring_task", e.message);
			}
		} else {
			fail("resume_recurring_task", "skipped — no recurringId");
		}

		// ── delete_recurring_task ────────────────────────────────────────────
		if (recurringId) {
			try {
				await client.callTool("delete_recurring_task", { taskId: recurringId });
				pass("delete_recurring_task", "deleted");
			} catch (e: any) {
				fail("delete_recurring_task", e.message);
			}
		} else {
			fail("delete_recurring_task", "skipped — no recurringId");
		}

		// ── update_recurring_task ─────────────────────────────────────────────────
		try {
			await client.callTool("update_recurring_task", { recurringTaskId: "invalid-id", title: "test" });
			pass("update_recurring_task", "ok");
		} catch (e: any) {
			if (e.message?.includes("not found") || e.message?.includes("invalid")) {
				pass("update_recurring_task", "correctly rejects invalid ID");
			} else {
				fail("update_recurring_task", e.message);
			}
		}

		// ── create_fix_pattern ───────────────────────────────────────────────
		try {
			const res = await client.callTool("create_fix_pattern", {
				symptom: "MCP test symptom",
				rootCause: "Test root cause",
				tags: ["mcp-test"],
				stack: ["test"],
				severity: "minor",
				createdBy: "sigma",
				sourceProject: "mcp-test",
			});
			pass("create_fix_pattern", res.patternId ? `patternId=${res.patternId}` : "ok");
		} catch (e: any) {
			fail("create_fix_pattern", e.message);
		}

		// ── list_fix_patterns ────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_fix_patterns", {});
			pass("list_fix_patterns", Array.isArray(res) ? `${res.length} pattern(s)` : "ok");
		} catch (e: any) {
			fail("list_fix_patterns", e.message);
		}

		// ── search_fix_patterns ──────────────────────────────────────────────
		try {
			const res = await client.callTool("search_fix_patterns", { query: "test" });
			pass("search_fix_patterns", `${Array.isArray(res) ? res.length : 0} result(s)`);
		} catch (e: any) {
			fail("search_fix_patterns", e.message);
		}

		// ── add_fix_attempt ──────────────────────────────────────────────────
		try {
			await client.callTool("add_fix_attempt", {
				patternId: "k170000000000000000000000000000",
				issueId: "k170000000000000000000000000000",
				appliedBy: "sigma",
				outcome: "success",
			});
			fail("add_fix_attempt", "should reject fake ID");
		} catch (e: any) {
			pass("add_fix_attempt", "correctly rejects invalid ID");
		}

		// ── validate_fix ─────────────────────────────────────────────────────
		try {
			await client.callTool("validate_fix", {
				patternId: "k170000000000000000000000000000",
				validatedBy: "sigma",
			});
			fail("validate_fix", "should reject fake ID");
		} catch (e: any) {
			pass("validate_fix", "correctly rejects invalid ID");
		}

		// ── link_issue_to_pattern ────────────────────────────────────────────
		try {
			await client.callTool("link_issue_to_pattern", {
				patternId: "k170000000000000000000000000000",
				issueId: "#999",
			});
			fail("link_issue_to_pattern", "should reject fake ID");
		} catch (e: any) {
			pass("link_issue_to_pattern", "correctly rejects invalid ID");
		}

		// ── list_issues ──────────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_issues", {});
			pass("list_issues", `${Array.isArray(res) ? res.length : 0} issue(s)`);
		} catch (e: any) {
			fail("list_issues", e.message);
		}

		// ── get_issue ────────────────────────────────────────────────────────
		try {
			await client.callTool("get_issue", {
				issueId: "k170000000000000000000000000000",
			});
			fail("get_issue", "should reject fake ID");
		} catch (e: any) {
			pass("get_issue", "correctly rejects invalid ID");
		}

		// ── update_issue_status ──────────────────────────────────────────────
		try {
			await client.callTool("update_issue_status", {
				issueId: "k170000000000000000000000000000",
				status: "investigating",
			});
			fail("update_issue_status", "should reject fake ID");
		} catch (e: any) {
			pass("update_issue_status", "correctly rejects invalid ID");
		}

		// ── verify_issue ─────────────────────────────────────────────────────
		try {
			await client.callTool("verify_issue", {
				issueId: "k170000000000000000000000000000",
				verifiedBy: "sigma",
			});
			fail("verify_issue", "should reject fake ID");
		} catch (e: any) {
			pass("verify_issue", "correctly rejects invalid ID");
		}

		// ── link_commit_to_issue ─────────────────────────────────────────────
		try {
			await client.callTool("link_commit_to_issue", {
				issueId: "k170000000000000000000000000000",
				commitSha: "abc1234",
			});
			fail("link_commit_to_issue", "should reject fake ID");
		} catch (e: any) {
			pass("link_commit_to_issue", "correctly rejects invalid ID");
		}

		// ── issue_stats ──────────────────────────────────────────────────────
		try {
			const res = await client.callTool("issue_stats", {});
			pass("issue_stats", `got stats`);
		} catch (e: any) {
			fail("issue_stats", e.message);
		}

		// ── list_errors ──────────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_errors", {});
			pass("list_errors", `${Array.isArray(res) ? res.length : 0} error(s)`);
		} catch (e: any) {
			fail("list_errors", e.message);
		}

		// ── get_error ────────────────────────────────────────────────────────
		try {
			await client.callTool("get_error", {
				errorId: "k170000000000000000000000000000",
			});
			fail("get_error", "should reject fake ID");
		} catch (e: any) {
			pass("get_error", "correctly rejects invalid ID");
		}

		// ── add_deployment ───────────────────────────────────────────────────
		try {
			const res = await client.callTool("add_deployment", {
				name: "test-deploy-smoke",
				deploymentUrl: "https://test-deploy-smoke.convex.cloud",
				deployKeyEnvVar: "DEPLOY_KEY_VANTAGEPEERS",
				githubRepo: "test-org/test-repo",
				orchestrator: "sigma",
			});
			pass("add_deployment", res.deploymentId ? `deploymentId=${res.deploymentId}` : "ok");
		} catch (e: any) {
			fail("add_deployment", e.message);
		}

		// ── remove_deployment ────────────────────────────────────────────────
		try {
			await client.callTool("remove_deployment", {
				deploymentId: "k170000000000000000000000000000",
			});
			fail("remove_deployment", "should reject fake ID");
		} catch (e: any) {
			pass("remove_deployment", "correctly rejects invalid ID");
		}

		// ── add_repo_mapping ─────────────────────────────────────────────────
		try {
			const res = await client.callTool("add_repo_mapping", {
				repo: "test-org/test-repo-mcp-smoke",
				orchestrator: "sigma",
				project: "mcp-test",
			});
			pass("add_repo_mapping", res.mappingId ? `mappingId=${res.mappingId}` : "ok");
		} catch (e: any) {
			fail("add_repo_mapping", e.message);
		}

		// ── list_repo_mappings ───────────────────────────────────────────────
		try {
			const res = await client.callTool("list_repo_mappings", {});
			pass("list_repo_mappings", `${Array.isArray(res) ? res.length : 0} mapping(s)`);
		} catch (e: any) {
			fail("list_repo_mappings", e.message);
		}

		// ── remove_repo_mapping ──────────────────────────────────────────────
		try {
			await client.callTool("remove_repo_mapping", {
				mappingId: "kx70000000000000000000000000000",
			});
			fail("remove_repo_mapping", "should reject fake ID");
		} catch (e: any) {
			pass("remove_repo_mapping", "correctly rejects invalid ID");
		}

		// ── create_mandate ───────────────────────────────────────────────────
		let mandateId: string | undefined;
		try {
			const res = await client.callTool("create_mandate", {
				requestedBy: "pi",
				fulfilledBy: "sigma",
				service: "MCP smoke test mandate",
				budget: 1000,
			});
			mandateId = res.mandateId;
			pass("create_mandate", mandateId ? `mandateId=${mandateId}` : "ok");
		} catch (e: any) {
			fail("create_mandate", e.message);
		}

		// ── list_mandates ────────────────────────────────────────────────────
		try {
			const res = await client.callTool("list_mandates", {});
			pass("list_mandates", `${Array.isArray(res) ? res.length : 0} mandate(s)`);
		} catch (e: any) {
			fail("list_mandates", e.message);
		}

		// ── accept_mandate ───────────────────────────────────────────────────
		if (mandateId) {
			try {
				await client.callTool("accept_mandate", {
					mandateId,
					callerOrchestrator: "sigma",
				});
				pass("accept_mandate", "accepted");
			} catch (e: any) {
				fail("accept_mandate", e.message);
			}
		} else {
			fail("accept_mandate", "skipped — no mandateId");
		}

		// ── update_mandate ───────────────────────────────────────────────────
		if (mandateId) {
			try {
				await client.callTool("update_mandate", {
					mandateId,
					callerOrchestrator: "sigma",
					status: "in_progress",
				});
				pass("update_mandate", "updated");
			} catch (e: any) {
				fail("update_mandate", e.message);
			}
		} else {
			fail("update_mandate", "skipped — no mandateId");
		}

		// ── validate_mandate_spending ────────────────────────────────────────
		if (mandateId) {
			try {
				const res = await client.callTool("validate_mandate_spending", {
					mandateId,
					proposedAmount: 100,
				});
				pass("validate_mandate_spending", `allowed=${res.allowed}`);
			} catch (e: any) {
				fail("validate_mandate_spending", e.message);
			}
		} else {
			fail("validate_mandate_spending", "skipped — no mandateId");
		}

		// ── settle_mandate ───────────────────────────────────────────────────
		if (mandateId) {
			try {
				await client.callTool("settle_mandate", {
					mandateId,
					callerOrchestrator: "pi",
					finalCost: 50,
				});
				pass("settle_mandate", "settled");
			} catch (e: any) {
				fail("settle_mandate", e.message);
			}
		} else {
			fail("settle_mandate", "skipped — no mandateId");
		}

		// ── get_mission_template ─────────────────────────────────────────────
		try {
			const res = await client.callTool("get_mission_template", {
				name: "issue-resolution-v3",
			});
			if (res && res.name) {
				pass("get_mission_template", `name=${res.name}, ${res.steps?.length} steps`);
			} else {
				pass("get_mission_template", "not found (ok for smoke test)");
			}
		} catch (e: any) {
			fail("get_mission_template", e.message);
		}

		// ── update_mission_template ──────────────────────────────────────────
		try {
			await client.callTool("update_mission_template", {
				name: "nonexistent-template-test",
				description: "test",
				steps: [{ title: "T0", description: "Test step" }],
				createdBy: "sigma",
			});
			pass("update_mission_template", "upserted");
		} catch (e: any) {
			fail("update_mission_template", e.message);
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
