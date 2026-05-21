"use node";
// ─────────────────────────────────────────────────────────────────────────────
// getAITextEmbeddingProvider — returns a createOpenAICompatible provider
// configured to use either the Vercel AI Gateway (when AI_GATEWAY_API_KEY is
// set and looks like a gateway key) or the OpenAI API directly.
//
// Priority:
//   1. OPENAI_API_KEY present                → api.openai.com direct (canonical BYOK path)
//   2. AI_GATEWAY_API_KEY present + sk-* key → api.openai.com direct (migration guard:
//                                               user put a direct OpenAI key into the
//                                               wrong env var — route correctly anyway)
//   3. AI_GATEWAY_API_KEY present + other    → Vercel AI Gateway (existing prod path)
//   4. Neither set                           → throws a clear error
//
// The "sk-* key in AI_GATEWAY_API_KEY" case is the Cédric Delport bug:
//   On 2026-05-06 Cédric replaced his Vercel gateway key with a direct OpenAI
//   key in AI_GATEWAY_API_KEY. The previous code sent that key to
//   ai-gateway.vercel.sh which returned 401/empty vectors → recall() → [].
//   Fix: detect the sk- prefix and fall through to the direct OpenAI path.
//
// Custom gateway base URL:
//   Set AI_GATEWAY_BASE_URL to override the default Vercel gateway endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Direct OpenAI key pattern: starts with "sk-" (project keys: sk-proj-*, legacy: sk-*)
const DIRECT_OPENAI_KEY_RE = /^sk-/;

/**
 * Returns true when the given key looks like a direct OpenAI API key rather
 * than a Vercel AI Gateway token. Used to guard against the common self-host
 * misconfiguration where a direct key is placed into AI_GATEWAY_API_KEY.
 */
export function isDirectOpenAIKey(key: string): boolean {
	return DIRECT_OPENAI_KEY_RE.test(key);
}

/**
 * Resolve the active embedding path based on env vars.
 *
 * Returns one of three discriminated values:
 *   { path: "openai-direct"; apiKey: string }
 *   { path: "gateway";       apiKey: string; baseURL: string }
 *   { path: "missing" }
 */
export function resolveEmbeddingPath():
	| { path: "openai-direct"; apiKey: string }
	| { path: "gateway"; apiKey: string; baseURL: string }
	| { path: "missing" } {
	// 1. OPENAI_API_KEY — canonical direct path
	if (process.env.OPENAI_API_KEY) {
		return { path: "openai-direct", apiKey: process.env.OPENAI_API_KEY };
	}

	// 2. AI_GATEWAY_API_KEY present
	const gwKey = process.env.AI_GATEWAY_API_KEY;
	if (gwKey) {
		// Guard: direct OpenAI key in the wrong env var → redirect to direct path
		if (isDirectOpenAIKey(gwKey)) {
			return { path: "openai-direct", apiKey: gwKey };
		}
		// Genuine gateway key
		const baseURL =
			process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
		return { path: "gateway", apiKey: gwKey, baseURL };
	}

	return { path: "missing" };
}

// Returns the correct embedding model name for the active path:
//   gateway path → "openai/text-embedding-3-small" (Vercel Gateway prefix required)
//   direct path  → "text-embedding-3-small" (bare OpenAI model name)
export function getEmbeddingModelName(): string {
	const resolved = resolveEmbeddingPath();
	return resolved.path === "gateway"
		? "openai/text-embedding-3-small"
		: "text-embedding-3-small";
}

export function getAITextEmbeddingProvider(): ReturnType<
	typeof createOpenAICompatible
> {
	const resolved = resolveEmbeddingPath();

	if (resolved.path === "missing") {
		throw new Error(
			"Missing AI key — set AI_GATEWAY_API_KEY (Vercel gateway) or OPENAI_API_KEY (direct OpenAI)",
		);
	}

	if (resolved.path === "openai-direct") {
		return createOpenAICompatible({
			name: "openai-direct",
			baseURL: "https://api.openai.com/v1",
			apiKey: resolved.apiKey,
		});
	}

	// gateway path
	return createOpenAICompatible({
		name: "ai-gateway",
		baseURL: resolved.baseURL,
		apiKey: resolved.apiKey,
	});
}
