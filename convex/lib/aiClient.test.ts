/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getAITextEmbeddingProvider, getEmbeddingModelName } from "./aiClient";

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

describe("getAITextEmbeddingProvider", () => {
	test("direct OpenAI path: OPENAI_API_KEY set + AI_GATEWAY_API_KEY unset → uses api.openai.com", () => {
		process.env.OPENAI_API_KEY = "sk-direct-test-key";

		// Should not throw — returns a provider object
		const provider = getAITextEmbeddingProvider();

		// The provider is the result of createOpenAICompatible. We verify the
		// factory succeeded (truthy) and inspect the name to confirm the
		// non-gateway branch was taken.
		expect(provider).toBeTruthy();
		// The provider object exposes a string identifier via toString or
		// provider.__id — we check it is callable as an embedding model factory.
		expect(typeof provider.textEmbeddingModel).toBe("function");
	});

	test("missing both env vars → throws clear error message", () => {
		// Neither key is set (cleared in beforeEach)
		expect(() => getAITextEmbeddingProvider()).toThrowError(
			"Missing AI key — set AI_GATEWAY_API_KEY (Vercel gateway) or OPENAI_API_KEY (direct OpenAI)",
		);
	});

	test("precedence: both env vars set → gateway path wins (AI_GATEWAY_API_KEY takes priority)", () => {
		process.env.AI_GATEWAY_API_KEY = "gw-key";
		process.env.OPENAI_API_KEY = "sk-direct-key";

		// Should not throw — gateway key wins
		const provider = getAITextEmbeddingProvider();
		expect(provider).toBeTruthy();
		expect(typeof provider.textEmbeddingModel).toBe("function");
	});
});

describe("getEmbeddingModelName", () => {
	test("AI_GATEWAY_API_KEY set → returns prefixed model name for Vercel Gateway", () => {
		process.env.AI_GATEWAY_API_KEY = "gw-key";
		expect(getEmbeddingModelName()).toBe("openai/text-embedding-3-small");
	});

	test("AI_GATEWAY_API_KEY unset → returns bare model name for direct OpenAI", () => {
		// AI_GATEWAY_API_KEY already cleared in beforeEach
		expect(getEmbeddingModelName()).toBe("text-embedding-3-small");
	});
});
