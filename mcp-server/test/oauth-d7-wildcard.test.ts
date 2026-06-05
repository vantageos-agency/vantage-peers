/**
 * S3.5 D7 wildcard tests — RFC 6749 §3.1.2 with single-`*` glob expansion.
 *
 * Day 92 (2026-06-04): ChatGPT's MCP custom-connector flow rotates its
 * callback under a stable prefix with a dynamic trailing segment, e.g.
 *   https://chatgpt.com/connector/oauth/<per-connector-id>
 * Pure exact-match redirect_uri policy blocked every flow after the first
 * registration. The `redirectUriMatches` helper now accepts a registered
 * URI that embeds one `*` token, expanded to `[a-zA-Z0-9_-]+` and anchored.
 *
 * This file is a pure unit test of the matcher — no Hono / no Convex /
 * no fixtures — because the semantic only matters at the helper level.
 * The full /authorize + /token integration is covered by the prior
 * D6+D7 tests; this file pins the wildcard semantics with both
 * accept-paths and lookalike-rejection cases.
 */

import { describe, expect, it } from "vitest";
import { redirectUriMatches } from "../server-http.js";

describe("D7 redirect_uri wildcard matcher (S3.5)", () => {
	describe("backwards-compatible exact-match (no `*` present)", () => {
		it("accepts the byte-identical URI", () => {
			expect(
				redirectUriMatches(
					"https://claude.ai/api/mcp/auth_callback",
					"https://claude.ai/api/mcp/auth_callback",
				),
			).toBe(true);
		});

		it("rejects a different URI even by one character", () => {
			expect(
				redirectUriMatches(
					"https://claude.ai/api/mcp/auth_callback",
					"https://claude.ai/api/mcp/auth_callbacK",
				),
			).toBe(false);
		});

		it("rejects a trailing-slash variant", () => {
			expect(
				redirectUriMatches(
					"https://claude.ai/api/mcp/auth_callback",
					"https://claude.ai/api/mcp/auth_callback/",
				),
			).toBe(false);
		});

		it("rejects a scheme change", () => {
			expect(
				redirectUriMatches(
					"https://claude.ai/api/mcp/auth_callback",
					"http://claude.ai/api/mcp/auth_callback",
				),
			).toBe(false);
		});
	});

	describe("ChatGPT connector callback pattern", () => {
		const REGISTERED = "https://chatgpt.com/connector/oauth/*";

		it("accepts a typical connector id", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chatgpt.com/connector/oauth/conn_01HX9P3VANTAGE",
				),
			).toBe(true);
		});

		it("accepts an alphanumeric + underscore + hyphen id", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chatgpt.com/connector/oauth/abc-DEF_123",
				),
			).toBe(true);
		});

		it("rejects an empty dynamic segment (trailing slash only)", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chatgpt.com/connector/oauth/",
				),
			).toBe(false);
		});

		it("rejects an id that contains a path separator", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chatgpt.com/connector/oauth/abc/extra",
				),
			).toBe(false);
		});

		it("rejects an id that contains a dot (would let lookalike domains in if loosened)", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chatgpt.com/connector/oauth/abc.evil",
				),
			).toBe(false);
		});

		it("rejects a path-traversal attempt", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chatgpt.com/connector/oauth/..%2Fadmin",
				),
			).toBe(false);
		});
	});

	describe("lookalike-host attacks must NOT match", () => {
		const REGISTERED = "https://chatgpt.com/connector/oauth/*";

		it("rejects a subdomain-pretend host", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chatgpt.com.evil.io/connector/oauth/abc",
				),
			).toBe(false);
		});

		it("rejects a homoglyph-style host", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chаtgpt.com/connector/oauth/abc",
				),
			).toBe(false);
		});

		it("rejects an HTTP downgrade", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"http://chatgpt.com/connector/oauth/abc",
				),
			).toBe(false);
		});

		it("rejects an unrelated path on the same host", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chatgpt.com/admin/oauth/abc",
				),
			).toBe(false);
		});

		it("rejects an attacker-controlled host containing the registered path", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://evil.io/chatgpt.com/connector/oauth/abc",
				),
			).toBe(false);
		});
	});

	describe("anchor-bypass attacks must NOT match", () => {
		const REGISTERED = "https://chatgpt.com/connector/oauth/*";

		it("rejects a URI with a fragment appended after a valid id", () => {
			// `#` is not in [a-zA-Z0-9_-], so the dynamic segment fails to match the full string.
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chatgpt.com/connector/oauth/abc#evil=1",
				),
			).toBe(false);
		});

		it("rejects a URI with a query string appended after a valid id", () => {
			expect(
				redirectUriMatches(
					REGISTERED,
					"https://chatgpt.com/connector/oauth/abc?next=//evil",
				),
			).toBe(false);
		});

		it("rejects a newline-injection attempt", () => {
			expect(
				redirectUriMatches(REGISTERED, "https://chatgpt.com/connector/oauth/abc\nattack"),
			).toBe(false);
		});
	});

	describe("multiple registered URIs (matcher used via array)", () => {
		it("a client may register both an exact Claude URI and a wildcard ChatGPT URI; both must match their own path", () => {
			const registered = [
				"https://claude.ai/api/mcp/auth_callback",
				"https://chatgpt.com/connector/oauth/*",
			];
			expect(
				registered.some((u) =>
					redirectUriMatches(u, "https://claude.ai/api/mcp/auth_callback"),
				),
			).toBe(true);
			expect(
				registered.some((u) =>
					redirectUriMatches(
						u,
						"https://chatgpt.com/connector/oauth/conn_abc",
					),
				),
			).toBe(true);
			expect(
				registered.some((u) =>
					redirectUriMatches(u, "https://attacker.example/cb"),
				),
			).toBe(false);
		});
	});
});
