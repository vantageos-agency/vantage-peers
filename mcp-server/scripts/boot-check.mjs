#!/usr/bin/env node
/**
 * boot-check.mjs — Day-159 incident gate (RULE #19 BUILD-PASS GATE).
 *
 * Builds nothing itself (the caller must have run `npm run build` first —
 * see the `pretest`/`prepublishOnly` wiring in package.json), but STARTS the
 * real built server (`dist/server.js`) as a child process and talks to it
 * over its REAL stdio transport — the same transport `npx vantage-peers-mcp`
 * uses in prod. This is the check that would have caught the Day-159
 * incident: PR #1189 passed a full source-level vitest suite (2847 tests)
 * while the DEPLOYED server 500'd on every request, because the defect was
 * at MCP SDK REGISTRATION time (`server.tool(strictZodObjectSchema, ...)`
 * crashes at boot — see registerTool.ts `defineTool` doc comment) — a floor
 * below anything a source-only test can observe. A server that cannot boot
 * is indistinguishable from one that works when you only test source.
 *
 * Four calls, in order, over stdio JSON-RPC:
 *   (a) initialize        → MUST succeed
 *   (b) tools/list        → MUST succeed, returns a non-empty tool set
 *   (c) whoami (no args)  → MUST succeed (MUST_PASS pole — ordinary call)
 *   (d) whoami (bogus arg)→ MUST come back as a NAMED protocol-level refusal
 *                            (MUST_BLOCK pole) — never a 500 / crash / a
 *                            silently-stripped success.
 *
 * Exit code 0 = all four calls behaved as specified. Exit code 1 = any call
 * failed its pole (with a diagnostic on stderr naming which call and why).
 *
 * CONVEX_URL is not required to be a live deployment for this check: none
 * of the four calls above touch Convex (`whoami` is read-only against the
 * bearer's own already-resolved scope context, never the DB — see the
 * "whoami never calls Convex" comment in mcp-server/test/whoami-day92.test.ts).
 * A syntactically valid https URL is enough to satisfy the SDK's client
 * constructor.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, "..", "dist", "server.js");
const BOOT_TIMEOUT_MS = 15_000;

function send(child, message) {
	child.stdin.write(`${JSON.stringify(message)}\n`);
}

/**
 * Reads newline-delimited JSON-RPC messages from the child's stdout and
 * resolves the next one whose `id` matches, or rejects on timeout / early
 * exit.
 */
function nextResponse(child, id, timeoutMs = BOOT_TIMEOUT_MS) {
	return new Promise((resolvePromise, reject) => {
		let buffer = "";
		let settled = false;

		const onData = (chunk) => {
			buffer += chunk.toString("utf-8");
			let newlineIdx;
			// eslint-disable-next-line no-cond-assign
			while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newlineIdx).trim();
				buffer = buffer.slice(newlineIdx + 1);
				if (!line) continue;
				let parsed;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue; // not JSON — likely stray log noise, skip
				}
				if (parsed && parsed.id === id && !settled) {
					settled = true;
					cleanup();
					resolvePromise(parsed);
				}
			}
		};

		const onExit = (code, signal) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				new Error(
					`server process exited before responding to id=${id} (code=${code}, signal=${signal})`,
				),
			);
		};

		const onError = (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(`timed out waiting for response to id=${id}`));
		}, timeoutMs);

		function cleanup() {
			clearTimeout(timer);
			child.stdout.off("data", onData);
			child.off("exit", onExit);
			child.off("error", onError);
		}

		child.stdout.on("data", onData);
		child.on("exit", onExit);
		child.on("error", onError);
	});
}

async function main() {
	const child = spawn(process.execPath, [SERVER_ENTRY], {
		env: {
			...process.env,
			// Syntactically valid — never dialed by any of the 4 calls below.
			CONVEX_URL: process.env.CONVEX_URL ?? "https://boot-check-placeholder.convex.cloud",
			// `whoami` is not in the prod CORE tool-exposure list (it stays
			// registered but `.disable()`d — see tools.ts `registerTools`
			// masking). Point at a boot-check-only exposure file that keeps it
			// enabled, so this check can call a real, Convex-free tool without
			// touching the prod tool-exposure.json.
			VP_TOOL_EXPOSURE_PATH: resolve(__dirname, "boot-check-tool-exposure.json"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stderrBuf = "";
	child.stderr.on("data", (c) => {
		stderrBuf += c.toString("utf-8");
	});

	const results = {};
	let exitCode = 0;

	try {
		// ── (a) initialize ──────────────────────────────────────────────────
		send(child, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "boot-check", version: "0.0.0" },
			},
		});
		const initResp = await nextResponse(child, 1);
		results.initialize = initResp;
		if (initResp.error) {
			throw new Error(
				`(a) initialize FAILED: ${JSON.stringify(initResp.error)}`,
			);
		}
		console.log("(a) initialize -> OK:", JSON.stringify(initResp.result?.serverInfo ?? initResp.result));

		// SDK requires the "initialized" notification before further calls.
		send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });

		// ── (b) tools/list ───────────────────────────────────────────────────
		send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		const listResp = await nextResponse(child, 2);
		results.toolsList = listResp;
		if (listResp.error) {
			throw new Error(`(b) tools/list FAILED: ${JSON.stringify(listResp.error)}`);
		}
		const toolCount = listResp.result?.tools?.length ?? 0;
		if (toolCount === 0) {
			throw new Error("(b) tools/list returned an EMPTY tool set");
		}
		console.log(`(b) tools/list -> OK: ${toolCount} tools`);

		// ── (c) whoami — well-formed call (MUST_PASS pole) ──────────────────
		send(child, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "whoami", arguments: {} },
		});
		const wellFormedResp = await nextResponse(child, 3);
		results.wellFormedCall = wellFormedResp;
		if (wellFormedResp.error) {
			throw new Error(
				`(c) whoami (well-formed) FAILED: ${JSON.stringify(wellFormedResp.error)}`,
			);
		}
		if (wellFormedResp.result?.isError) {
			throw new Error(
				`(c) whoami (well-formed) returned isError=true: ${JSON.stringify(wellFormedResp.result)}`,
			);
		}
		console.log("(c) whoami (well-formed, no args) -> OK:", JSON.stringify(wellFormedResp.result?.content));

		// ── (d) whoami — undeclared param (MUST_BLOCK pole) ─────────────────
		send(child, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "whoami",
				arguments: { bogusUndeclaredParam: "should-be-refused-by-name" },
			},
		});
		const amputatedResp = await nextResponse(child, 4);
		results.amputatedCall = amputatedResp;

		// A refusal can surface either as a JSON-RPC protocol error (McpError
		// thrown by the SDK's own validateToolInput, before our handler runs)
		// or as a CallToolResult with isError=true carrying the same message
		// (the McpServer's outer try/catch converts an uncaught McpError into
		// createToolError — see server/mcp.js). Either is an acceptable NAMED
		// refusal; a plain 200 with the key silently dropped is NOT.
		const refusalText = amputatedResp.error
			? JSON.stringify(amputatedResp.error)
			: amputatedResp.result?.isError
				? JSON.stringify(amputatedResp.result)
				: null;

		if (refusalText === null) {
			throw new Error(
				`(d) whoami (amputated, bogusUndeclaredParam) SUCCEEDED silently instead of being refused: ${JSON.stringify(amputatedResp)}`,
			);
		}
		if (!refusalText.includes("bogusUndeclaredParam")) {
			throw new Error(
				`(d) whoami (amputated) was refused but did NOT name the offending key 'bogusUndeclaredParam'. Refusal was: ${refusalText}`,
			);
		}
		console.log("(d) whoami (amputated, bogusUndeclaredParam) -> REFUSED, names the key:", refusalText);

		console.log("\nBOOT CHECK: PASS — all 4 calls behaved as specified.");
	} catch (err) {
		exitCode = 1;
		console.error("\nBOOT CHECK: FAIL —", err instanceof Error ? err.message : String(err));
		if (stderrBuf.trim()) {
			console.error("\n--- server stderr ---\n" + stderrBuf.trim());
		}
	} finally {
		child.kill();
	}

	process.exit(exitCode);
}

main();
