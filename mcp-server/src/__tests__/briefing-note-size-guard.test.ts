/**
 * Pre-flight content-size guard tests (S-BN-T2 / L2 fix).
 *
 * Convex has a 1 MiB HTTP body limit. The MCP tools
 * (`create_briefing_note`, `store_memory`, `send_message`, `write_diary`,
 * `register_component`, `update_component`) forward their `content` arg to
 * Convex mutations. Without a client-side guard, oversized payloads surface
 * as an opaque "Server Error" from Convex.
 *
 * These tests pin the boundary conditions of `assertContentSize`:
 *   - 1,000 bytes           → pass (baseline)
 *   - 899,999 bytes         → pass (edge, one below the ceiling)
 *   - 900,000 bytes         → pass (edge, exactly at the ceiling — inclusive)
 *   - 900,001 bytes         → fail with specific InvalidParams McpError
 *   - 1,500,000 bytes       → fail with specific InvalidParams McpError
 *
 * We also verify the error message shape (byte count + remediation hint +
 * InvalidParams error code) because the MCP client relies on it for triage.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { assertContentSize, MAX_CONTENT_BYTES } from "../tools.js";

describe("MAX_CONTENT_BYTES constant", () => {
	it("is exactly 900,000 bytes (148,576-byte headroom under Convex 1 MiB limit)", () => {
		expect(MAX_CONTENT_BYTES).toBe(900_000);
	});
});

describe("assertContentSize — accept path", () => {
	it("accepts a 1,000-char baseline payload", () => {
		const content = "x".repeat(1000);
		expect(() =>
			assertContentSize(content, "create_briefing_note"),
		).not.toThrow();
		expect(assertContentSize(content, "create_briefing_note")).toBe(1000);
	});

	it("accepts an empty string", () => {
		expect(() => assertContentSize("", "create_briefing_note")).not.toThrow();
		expect(assertContentSize("", "create_briefing_note")).toBe(0);
	});

	it("accepts 899,999 bytes (one below the ceiling)", () => {
		const content = "a".repeat(899_999);
		expect(() =>
			assertContentSize(content, "create_briefing_note"),
		).not.toThrow();
		expect(assertContentSize(content, "create_briefing_note")).toBe(899_999);
	});

	it("accepts exactly 900,000 bytes (inclusive ceiling)", () => {
		const content = "a".repeat(900_000);
		expect(() =>
			assertContentSize(content, "create_briefing_note"),
		).not.toThrow();
		expect(assertContentSize(content, "create_briefing_note")).toBe(900_000);
	});

	it("counts UTF-8 byte length, not character length, for multibyte content", () => {
		// "é" is 2 bytes in UTF-8. 449,999 "é" → 899,998 bytes, still under 900 KB.
		const content = "é".repeat(449_999);
		expect(() =>
			assertContentSize(content, "create_briefing_note"),
		).not.toThrow();
		expect(assertContentSize(content, "create_briefing_note")).toBe(899_998);
	});
});

describe("assertContentSize — reject path", () => {
	it("rejects 900,001 bytes with InvalidParams McpError", () => {
		const content = "a".repeat(900_001);
		expect(() => assertContentSize(content, "create_briefing_note")).toThrow(
			McpError,
		);
		try {
			assertContentSize(content, "create_briefing_note");
		} catch (error) {
			expect(error).toBeInstanceOf(McpError);
			const mcpErr = error as McpError;
			expect(mcpErr.code).toBe(ErrorCode.InvalidParams);
			expect(mcpErr.message).toContain("900001 bytes");
			expect(mcpErr.message).toContain("max 900000 bytes");
			expect(mcpErr.message).toContain("create_briefing_note");
			expect(mcpErr.message).toContain("deliverable");
		}
	});

	it("rejects 1,500,000 bytes (extreme oversize) with InvalidParams McpError", () => {
		const content = "a".repeat(1_500_000);
		expect(() => assertContentSize(content, "create_briefing_note")).toThrow(
			McpError,
		);
		try {
			assertContentSize(content, "create_briefing_note");
		} catch (error) {
			expect(error).toBeInstanceOf(McpError);
			const mcpErr = error as McpError;
			expect(mcpErr.code).toBe(ErrorCode.InvalidParams);
			expect(mcpErr.message).toContain("1500000 bytes");
		}
	});

	it("rejects oversized UTF-8 content based on byte count, not char count", () => {
		// 450_001 × "é" = 900_002 bytes, just over the ceiling.
		const content = "é".repeat(450_001);
		expect(() => assertContentSize(content, "write_diary")).toThrow(McpError);
		try {
			assertContentSize(content, "write_diary");
		} catch (error) {
			const mcpErr = error as McpError;
			expect(mcpErr.code).toBe(ErrorCode.InvalidParams);
			expect(mcpErr.message).toContain("900002 bytes");
			expect(mcpErr.message).toContain("write_diary");
		}
	});

	it("includes the tool name in the error message for each caller", () => {
		const content = "a".repeat(900_001);
		for (const tool of [
			"store_memory",
			"send_message",
			"write_diary",
			"create_briefing_note",
			"register_component",
			"update_component",
		]) {
			try {
				assertContentSize(content, tool);
				throw new Error("expected assertContentSize to throw");
			} catch (error) {
				expect(error).toBeInstanceOf(McpError);
				expect((error as McpError).message).toContain(tool);
			}
		}
	});
});
