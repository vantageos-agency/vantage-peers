// ─────────────────────────────────────────────────────────────────────────────
// improvisation_digest.tool.test.ts — PR-I TDD-RED phase
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the MCP tool registration + Zod args schema contract for
// `improvisation_digest`.
//
// Mission: k571gcctka8mq5jbkgpj0a0b2n892ctg (VP-MCP top level Bloc A)
// Branch: feat/vpmcp-i-improvisation-digest-weekly
//
// Pi-approved Option C (msg jn779tfjpg68v01db67b4ht20c189c8yw-class):
//   V1 data source = VP tasks + messages aggregation (transcript replay V2).
//   MODE = ADVISORY only — never blocks any action.
//
// T-GREEN must export from mcp-server/src/tools.ts:
//   - IMPROVISATION_DIGEST_TOOL_NAME: string — exactly "improvisation_digest"
//   - improvisationDigestArgsSchema: z.ZodObject — must enforce:
//       windowDays    : z.number().default(7)
//       orchestrators : z.array(z.string()).optional()
//
// Both imports will throw "does not provide an export named …" until T-GREEN
// ships them — that is the RED contract.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";

// Expected exports from T-GREEN — these do NOT exist in tools.ts yet → RED
// @ts-expect-error — RED: exports do not exist yet, will exist post-T-GREEN
import { IMPROVISATION_DIGEST_TOOL_NAME, improvisationDigestArgsSchema } from "../tools.js";

describe("improvisation_digest MCP tool registration + args schema (PR-I RED)", () => {

	// ── Tool registration ────────────────────────────────────────────────────
	it("tool name is 'improvisation_digest' and is registered in the MCP tool list", () => {
		// Will fail until IMPROVISATION_DIGEST_TOOL_NAME is exported from tools.ts
		expect(typeof IMPROVISATION_DIGEST_TOOL_NAME).toBe("string");
		expect(IMPROVISATION_DIGEST_TOOL_NAME).toBe("improvisation_digest");
	});

	// ── Zod args schema ──────────────────────────────────────────────────────
	it("args schema: windowDays defaults to 7, orchestrators optional array of strings", () => {
		// Will fail until improvisationDigestArgsSchema is exported from tools.ts

		// Valid — empty input: windowDays must default to 7
		const minimal = improvisationDigestArgsSchema.parse({});
		expect(minimal.windowDays).toBe(7);
		expect(minimal.orchestrators).toBeUndefined();

		// Valid — explicit windowDays
		const withDays = improvisationDigestArgsSchema.parse({ windowDays: 14 });
		expect(withDays.windowDays).toBe(14);

		// Valid — orchestrators present as array of strings
		const withOrch = improvisationDigestArgsSchema.parse({
			orchestrators: ["sigma", "pi"],
		});
		expect(withOrch.orchestrators).toEqual(["sigma", "pi"]);

		// Valid — both fields provided
		const full = improvisationDigestArgsSchema.parse({
			windowDays: 30,
			orchestrators: ["eta"],
		});
		expect(full.windowDays).toBe(30);
		expect(full.orchestrators).toEqual(["eta"]);

		// Invalid — windowDays is a string, not a number
		expect(() =>
			improvisationDigestArgsSchema.parse({ windowDays: "seven" }),
		).toThrow();

		// Invalid — orchestrators must be array, not a string
		expect(() =>
			improvisationDigestArgsSchema.parse({ orchestrators: "sigma" }),
		).toThrow();

		// Invalid — orchestrators array must contain strings, not numbers
		expect(() =>
			improvisationDigestArgsSchema.parse({ orchestrators: [1, 2] }),
		).toThrow();
	});
});
