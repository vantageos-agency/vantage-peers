/**
 * Task k178ty5ndzkyy8y4vd7c3jh0p58hxg2z: improvisation_digest shows an
 * orchestrator under its real name.
 *
 * Convex cannot return a field name that is not ASCII, so scanWindow keys its
 * `countsByOrch` record by the percent-encoded name and carries the real names
 * in `byOrchestrator`. The tool reads the array and falls back to the decoded
 * record (a backend that predates the array).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const master: OAuthContext = {
	clientId: "c",
	userId: "u",
	scopes: ["vantage:read"],
	scopeProfile: "fleet-master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: Date.now() + 3_600_000,
	isMaster: true,
	accessTokenHash: "h",
	clerkOrgSlug: "vantage",
};

async function callDigest(backend: unknown) {
	const handlers = new Map<string, ToolHandler>();
	const capture = (...a: unknown[]): unknown => {
		handlers.set(a[0] as string, a[a.length - 1] as ToolHandler);
		return {};
	};
	const server = { tool: capture, registerTool: capture } as unknown as McpServer;
	const query = vi.fn(async () => backend);
	registerTools(
		server,
		{ query, mutation: vi.fn(), action: vi.fn() } as unknown as ConvexHttpClient,
		master,
	);
	const result = (await handlers.get("improvisation_digest")?.({
		windowDays: 7,
	})) as { structuredContent: { countsByOrch: Record<string, number> } };
	return result;
}

const cats = { complete_task: 3, send_message: 0, store_memory: 0 };

describe("improvisation_digest real orchestrator names", () => {
	it("reads the array: the accented name is a key of countsByOrch, the encoded one is not", async () => {
		const r = await callDigest({
			countsByOrch: { "h%C3%A9lios": 2, sigma: 1 },
			byOrchestrator: [
				{ orchestrator: "hélios", count: 2 },
				{ orchestrator: "sigma", count: 1 },
			],
			countsByCategory: cats,
			samples: [],
		});
		expect(r.structuredContent.countsByOrch).toEqual({ "hélios": 2, sigma: 1 });
	});

	it("falls back to the decoded record when the backend predates the array", async () => {
		const r = await callDigest({
			countsByOrch: { "h%C3%A9lios": 2, sigma: 1 },
			countsByCategory: cats,
			samples: [],
		});
		expect(r.structuredContent.countsByOrch).toEqual({ "hélios": 2, sigma: 1 });
	});
});

describe("the running MCP survives the expanded shape", () => {
	it("the previous output schema (looseObject) accepts the backend's raw answer, extra array included", async () => {
		const { improvisationDigestServedOutputSchema } = await import(
			"../src/outputSchemas.js"
		);
		const raw = {
			countsByOrch: { "h%C3%A9lios": 2, sigma: 1 },
			byOrchestrator: [
				{ orchestrator: "hélios", count: 2 },
				{ orchestrator: "sigma", count: 1 },
			],
			countsByCategory: cats,
			samples: [],
		};
		expect(improvisationDigestServedOutputSchema.safeParse(raw).success).toBe(true);
	});
});
