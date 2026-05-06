"use node";
// ─────────────────────────────────────────────────────────────────────────────
// getAITextEmbeddingProvider — returns a createOpenAICompatible provider
// configured to use either the Vercel AI Gateway (when AI_GATEWAY_API_KEY is
// set) or the OpenAI API directly (when OPENAI_API_KEY is set).
//
// Priority:
//   1. AI_GATEWAY_API_KEY present → Vercel AI Gateway (existing prod path)
//   2. OPENAI_API_KEY present      → api.openai.com direct (BYOK self-host)
//   3. Neither set                 → throws a clear error
//
// Custom gateway base URL:
//   Set AI_GATEWAY_BASE_URL to override the default Vercel gateway endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export function getAITextEmbeddingProvider(): ReturnType<
	typeof createOpenAICompatible
> {
	const useGateway = !!process.env.AI_GATEWAY_API_KEY;
	const baseURL = useGateway
		? (process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1")
		: "https://api.openai.com/v1";
	const apiKey = useGateway
		? process.env.AI_GATEWAY_API_KEY
		: process.env.OPENAI_API_KEY;

	if (!apiKey) {
		throw new Error(
			"Missing AI key — set AI_GATEWAY_API_KEY (Vercel gateway) or OPENAI_API_KEY (direct OpenAI)",
		);
	}

	return createOpenAICompatible({
		name: useGateway ? "ai-gateway" : "openai-direct",
		baseURL,
		apiKey,
	});
}
