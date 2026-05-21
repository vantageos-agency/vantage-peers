/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	getAITextEmbeddingProvider,
	getEmbeddingModelName,
	isDirectOpenAIKey,
	resolveEmbeddingPath,
} from "./aiClient";

// Save original env before each test and restore after
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	// Remove both keys so each test starts from a clean slate
	delete process.env.AI_GATEWAY_API_KEY;
	delete process.env.OPENAI_API_KEY;
	delete process.env.AI_GATEWAY_BASE_URL;
});

afterEach(() => {
	// Restore original environment
	process.env.AI_GATEWAY_API_KEY = ORIGINAL_ENV.AI_GATEWAY_API_KEY;
	process.env.OPENAI_API_KEY = ORIGINAL_ENV.OPENAI_API_KEY;
	process.env.AI_GATEWAY_BASE_URL = ORIGINAL_ENV.AI_GATEWAY_BASE_URL;
	if (ORIGINAL_ENV.AI_GATEWAY_API_KEY === undefined)
		delete process.env.AI_GATEWAY_API_KEY;
	if (ORIGINAL_ENV.OPENAI_API_KEY === undefined)
		delete process.env.OPENAI_API_KEY;
	if (ORIGINAL_ENV.AI_GATEWAY_BASE_URL === undefined)
		delete process.env.AI_GATEWAY_BASE_URL;
});

// ─────────────────────────────────────────────────────────────────────────────
// isDirectOpenAIKey
// ─────────────────────────────────────────────────────────────────────────────

describe("isDirectOpenAIKey", () => {
	test("legacy sk- key → true", () => {
		expect(isDirectOpenAIKey("sk-abc123xyz")).toBe(true);
	});

	test("project key sk-proj- → true", () => {
		expect(isDirectOpenAIKey("sk-proj-foobar")).toBe(true);
	});

	test("Vercel gateway token (not sk-) → false", () => {
		expect(isDirectOpenAIKey("vgw_someGatewayToken")).toBe(false);
	});

	test("empty string → false", () => {
		expect(isDirectOpenAIKey("")).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveEmbeddingPath — the core routing logic
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveEmbeddingPath", () => {
	test("OPENAI_API_KEY only → openai-direct path", () => {
		process.env.OPENAI_API_KEY = "sk-direct-test-key";
		const resolved = resolveEmbeddingPath();
		expect(resolved.path).toBe("openai-direct");
		if (resolved.path === "openai-direct") {
			expect(resolved.apiKey).toBe("sk-direct-test-key");
		}
	});

	test("AI_GATEWAY_API_KEY with sk- key (Cédric bug) → openai-direct path", () => {
		// This is the root cause: user put a direct OpenAI key into AI_GATEWAY_API_KEY.
		// Previously this routed to ai-gateway.vercel.sh → 401 → recall() returned [].
		process.env.AI_GATEWAY_API_KEY = "sk-proj-cedricDirectKey123";
		const resolved = resolveEmbeddingPath();
		expect(resolved.path).toBe("openai-direct");
		if (resolved.path === "openai-direct") {
			expect(resolved.apiKey).toBe("sk-proj-cedricDirectKey123");
		}
	});

	test("AI_GATEWAY_API_KEY with real gateway key → gateway path with default base URL", () => {
		process.env.AI_GATEWAY_API_KEY = "vgw_realGatewayToken";
		const resolved = resolveEmbeddingPath();
		expect(resolved.path).toBe("gateway");
		if (resolved.path === "gateway") {
			expect(resolved.apiKey).toBe("vgw_realGatewayToken");
			expect(resolved.baseURL).toBe("https://ai-gateway.vercel.sh/v1");
		}
	});

	test("AI_GATEWAY_API_KEY + AI_GATEWAY_BASE_URL → gateway path with custom base URL", () => {
		process.env.AI_GATEWAY_API_KEY = "vgw_realGatewayToken";
		process.env.AI_GATEWAY_BASE_URL = "https://custom.gateway.example.com/v1";
		const resolved = resolveEmbeddingPath();
		expect(resolved.path).toBe("gateway");
		if (resolved.path === "gateway") {
			expect(resolved.baseURL).toBe("https://custom.gateway.example.com/v1");
		}
	});

	test("OPENAI_API_KEY wins over AI_GATEWAY_API_KEY (precedence)", () => {
		process.env.OPENAI_API_KEY = "sk-canonical-direct";
		process.env.AI_GATEWAY_API_KEY = "vgw_gatewayToken";
		const resolved = resolveEmbeddingPath();
		expect(resolved.path).toBe("openai-direct");
		if (resolved.path === "openai-direct") {
			expect(resolved.apiKey).toBe("sk-canonical-direct");
		}
	});

	test("neither key set → missing", () => {
		const resolved = resolveEmbeddingPath();
		expect(resolved.path).toBe("missing");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// getAITextEmbeddingProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("getAITextEmbeddingProvider", () => {
	test("direct OpenAI path: OPENAI_API_KEY set → returns callable provider", () => {
		process.env.OPENAI_API_KEY = "sk-direct-test-key";
		const provider = getAITextEmbeddingProvider();
		expect(provider).toBeTruthy();
		expect(typeof provider.textEmbeddingModel).toBe("function");
	});

	test("Cédric bug path: sk-* in AI_GATEWAY_API_KEY → returns callable provider (not throwing)", () => {
		// This is the regression test for the fix.
		// Before the fix, this key would be sent to ai-gateway.vercel.sh → 401.
		// After the fix, it routes to api.openai.com/v1.
		process.env.AI_GATEWAY_API_KEY = "sk-proj-cedricDirectKey123";
		const provider = getAITextEmbeddingProvider();
		expect(provider).toBeTruthy();
		expect(typeof provider.textEmbeddingModel).toBe("function");
	});

	test("missing both env vars → throws clear error message", () => {
		expect(() => getAITextEmbeddingProvider()).toThrowError(
			"Missing AI key — set AI_GATEWAY_API_KEY (Vercel gateway) or OPENAI_API_KEY (direct OpenAI)",
		);
	});

	test("gateway path: real gateway key → returns callable provider", () => {
		process.env.AI_GATEWAY_API_KEY = "vgw_gatewayToken";
		const provider = getAITextEmbeddingProvider();
		expect(provider).toBeTruthy();
		expect(typeof provider.textEmbeddingModel).toBe("function");
	});

	test("precedence: OPENAI_API_KEY wins over gateway key", () => {
		process.env.AI_GATEWAY_API_KEY = "vgw_gatewayToken";
		process.env.OPENAI_API_KEY = "sk-direct-key";
		const provider = getAITextEmbeddingProvider();
		expect(provider).toBeTruthy();
		expect(typeof provider.textEmbeddingModel).toBe("function");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// getEmbeddingModelName
// ─────────────────────────────────────────────────────────────────────────────

describe("getEmbeddingModelName", () => {
	test("gateway path → returns prefixed model name for Vercel Gateway", () => {
		process.env.AI_GATEWAY_API_KEY = "vgw_gatewayToken";
		expect(getEmbeddingModelName()).toBe("openai/text-embedding-3-small");
	});

	test("direct path via OPENAI_API_KEY → returns bare model name", () => {
		process.env.OPENAI_API_KEY = "sk-direct";
		expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
	});

	test("Cédric bug path: sk-* in AI_GATEWAY_API_KEY → bare model name (direct path)", () => {
		// After fix: sk-* key in AI_GATEWAY_API_KEY → direct path → bare model name.
		// Before fix: gateway path was taken → "openai/" prefix → wrong model name
		// sent to api.openai.com/v1 (which rejects the prefix) → 400 error.
		process.env.AI_GATEWAY_API_KEY = "sk-proj-cedricDirectKey123";
		expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
	});

	test("missing key → bare model name (no crash in getEmbeddingModelName)", () => {
		// getEmbeddingModelName doesn't throw — only getAITextEmbeddingProvider does
		expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
	});
});
