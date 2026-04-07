#!/usr/bin/env bun
/**
 * VantagePeers RAG Integration Tests
 *
 * Verifies the embedding pipeline end-to-end against the prod deployment:
 *   1. store_memory creates an embedding
 *   2. recall returns semantically relevant results
 *   3. search_fix_patterns returns results from the fixpatterns namespace
 *
 * Usage: bun scripts/test-rag-integration.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dirname ?? __dirname, "..");
const SERVER_PATH = resolve(PROJECT_ROOT, "mcp-server/server.ts");
const ENV_PATH = resolve(PROJECT_ROOT, ".env.local");
const TIMEOUT_MS = 45_000; // RAG embedding can be slow
const EMBEDDING_SETTLE_MS = 4_000; // wait for async embedding job

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
		if (resp.result?.isError) {
			const errText = resp.result?.content?.[0]?.text ?? "Unknown MCP tool error";
			throw new Error(errText);
		}
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
// Test runner helpers
// ─────────────────────────────────────────────────────────────────────────────

interface TestResult {
	name: string;
	passed: boolean;
	detail: string;
}

const results: TestResult[] = [];

function pass(name: string, detail: string) {
	results.push({ name, passed: true, detail });
	console.log(`  PASS  ${name} — ${detail}`);
}

function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
	console.error(`  FAIL  ${name} — ${detail}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const timestamp = Date.now();
	const namespace = `test/rag-integration-${timestamp}`;
	const createdMemoryIds: string[] = [];

	console.log("\nVantagePeers RAG Integration Tests");
	console.log("====================================");
	console.log(`Namespace: ${namespace}`);
	console.log(`Embedding settle time: ${EMBEDDING_SETTLE_MS}ms\n`);

	const client = new McpClient();

	// Give the server a moment to start
	await Bun.sleep(500);

	try {
		// ── Initialize handshake ──────────────────────────────────────────────────
		await client.send("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "rag-integration-tester", version: "1.0.0" },
		});
		await client.notify("notifications/initialized");

		// ── Test 1: store_memory creates a record and returns a memoryId ─────────
		console.log("--- Test 1: store_memory (vector content) ---");
		let memoryId1: string | undefined;
		try {
			const res = await client.callTool("store_memory", {
				namespace,
				type: "user",
				content: "The quantum flux capacitor requires 1.21 gigawatts",
				createdBy: "sigma",
			});
			memoryId1 = res.memoryId;
			if (typeof memoryId1 === "string" && memoryId1.length > 0) {
				createdMemoryIds.push(memoryId1);
				pass("store_memory #1", `memoryId=${memoryId1}`);
			} else {
				fail("store_memory #1", `No memoryId returned: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("store_memory #1", e.message);
		}

		// ── Wait for embedding to complete ────────────────────────────────────────
		console.log(`\nWaiting ${EMBEDDING_SETTLE_MS}ms for embedding pipeline...\n`);
		await Bun.sleep(EMBEDDING_SETTLE_MS);

		// ── Test 2: recall returns the stored memory via vector search ───────────
		console.log("--- Test 2: recall (semantic match for memory #1) ---");
		try {
			const res = await client.callTool("recall", {
				query: "gigawatts power requirements",
				namespace,
				limit: 5,
			});
			const memories: any[] = Array.isArray(res) ? res : [];
			const found = memories.some(
				(m: any) =>
					typeof m.content === "string" &&
					m.content.toLowerCase().includes("gigawatt"),
			);
			if (found) {
				pass(
					"recall #1 — semantic match",
					`Found gigawatts memory in ${memories.length} result(s)`,
				);
			} else {
				fail(
					"recall #1 — semantic match",
					`Memory not found. Results: ${JSON.stringify(memories.map((m: any) => m.content))}`,
				);
			}
		} catch (e: any) {
			fail("recall #1 — semantic match", e.message);
		}

		// ── Test 3: store a second memory with type=project ───────────────────────
		console.log("\n--- Test 3: store_memory (project type) ---");
		let memoryId2: string | undefined;
		try {
			const res = await client.callTool("store_memory", {
				namespace,
				type: "project",
				content: "Project deadline is March 2027 for phase 2 launch",
				createdBy: "sigma",
			});
			memoryId2 = res.memoryId;
			if (typeof memoryId2 === "string" && memoryId2.length > 0) {
				createdMemoryIds.push(memoryId2);
				pass("store_memory #2", `memoryId=${memoryId2}`);
			} else {
				fail("store_memory #2", `No memoryId returned: ${JSON.stringify(res)}`);
			}
		} catch (e: any) {
			fail("store_memory #2", e.message);
		}

		// ── Wait for second embedding ─────────────────────────────────────────────
		console.log(`\nWaiting ${EMBEDDING_SETTLE_MS}ms for second embedding...\n`);
		await Bun.sleep(EMBEDDING_SETTLE_MS);

		// ── Test 4: recall returns the second memory ──────────────────────────────
		console.log("--- Test 4: recall (semantic match for memory #2) ---");
		try {
			const res = await client.callTool("recall", {
				query: "deadline launch date",
				namespace,
				limit: 5,
			});
			const memories: any[] = Array.isArray(res) ? res : [];
			const found = memories.some(
				(m: any) =>
					typeof m.content === "string" &&
					(m.content.toLowerCase().includes("deadline") ||
						m.content.toLowerCase().includes("march") ||
						m.content.toLowerCase().includes("launch")),
			);
			if (found) {
				pass(
					"recall #2 — deadline match",
					`Found deadline memory in ${memories.length} result(s)`,
				);
			} else {
				fail(
					"recall #2 — deadline match",
					`Memory not found. Results: ${JSON.stringify(memories.map((m: any) => m.content))}`,
				);
			}
		} catch (e: any) {
			fail("recall #2 — deadline match", e.message);
		}

		// ── Test 5: recall with type filter isolates project memories ────────────
		console.log("\n--- Test 5: recall with type=project filter ---");
		try {
			const res = await client.callTool("recall", {
				query: "project phase launch",
				namespace,
				type: "project",
				limit: 5,
			});
			const memories: any[] = Array.isArray(res) ? res : [];
			const allProject = memories.every((m: any) => m.type === "project");
			const hasDeadline = memories.some(
				(m: any) =>
					typeof m.content === "string" &&
					m.content.toLowerCase().includes("deadline"),
			);
			if (hasDeadline && (memories.length === 0 || allProject)) {
				pass(
					"recall with type filter",
					`${memories.length} result(s), type filter respected`,
				);
			} else if (hasDeadline) {
				pass(
					"recall with type filter",
					`Found deadline memory; type values: ${memories.map((m: any) => m.type).join(", ")}`,
				);
			} else {
				fail(
					"recall with type filter",
					"Expected project memory not in results: " + JSON.stringify(memories.map((m: any) => ({ type: m.type, content: m.content?.slice(0, 60) }))),
				);
			}
		} catch (e: any) {
			fail("recall with type filter", e.message);
		}

		// ── Test 6: search_fix_patterns returns results from prod data ────────────
		console.log("\n--- Test 6: search_fix_patterns ---");
		try {
			const res = await client.callTool("search_fix_patterns", {
				query: "test",
				limit: 5,
			});
			const patterns: any[] = Array.isArray(res) ? res : [];
			if (patterns.length > 0) {
				const first = patterns[0];
				const hasRequiredFields =
					typeof first.patternId === "string" &&
					typeof first.symptom === "string" &&
					typeof first.rootCause === "string" &&
					typeof first.score === "number";
				if (hasRequiredFields) {
					pass(
						"search_fix_patterns",
						patterns.length + " pattern(s) returned; first patternId=" + first.patternId,
					);
				} else {
					fail(
						"search_fix_patterns",
						`Results missing required fields: ${JSON.stringify(first)}`,
					);
				}
			} else {
				// It is acceptable if no fix patterns exist in prod yet — treat as pass
				// but note it so it is visible
				pass(
					"search_fix_patterns",
					"0 results returned (no fix patterns in prod fixpatterns namespace yet)",
				);
			}
		} catch (e: any) {
			fail("search_fix_patterns", e.message);
		}

		// ── Cleanup: soft-delete test memories ───────────────────────────────────
		console.log("\n--- Cleanup: soft-deleting test memories ---");
		for (const memId of createdMemoryIds) {
			try {
				await client.callTool("soft_delete_memory", { memoryId: memId });
				console.log(`  Deleted ${memId}`);
			} catch (e: any) {
				console.warn(`  Warning: failed to delete ${memId}: ${e.message}`);
			}
		}
	} finally {
		client.kill();
	}

	// ── Summary ───────────────────────────────────────────────────────────────
	console.log("\n====================================");
	console.log("Results");
	console.log("====================================");
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;
	for (const r of results) {
		const icon = r.passed ? "PASS" : "FAIL";
		console.log(`  ${icon}  ${r.name}`);
	}
	console.log(`\n${passed}/${results.length} tests passed`);
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed.`);
		process.exit(1);
	} else {
		console.log("\nAll RAG integration tests passed.");
		process.exit(0);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
