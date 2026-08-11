/// <reference types="vite/client" />
/**
 * De-hardcode Clerk issuer domain — convex/auth.config.ts must read
 * process.env.CLERK_JWT_ISSUER_DOMAIN, never a literal Clerk domain.
 *
 * Closes VP task k1730kpyw3nwtds5ewhtd68nah8c123r ("[HARDCODE CATÉGORIQUE]"),
 * violation of no-hardcoded-business-knowledge.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_CONFIG_PATH = path.join(__dirname, "..", "auth.config.ts");

describe("auth.config.ts — no hardcoded Clerk domain", () => {
	test("source contains no hardcoded Clerk domain literal and references process.env.CLERK_JWT_ISSUER_DOMAIN", () => {
		const source = readFileSync(AUTH_CONFIG_PATH, "utf-8");

		expect(source).not.toMatch(
			/sharp-sponge-67|clerk\.accounts\.dev|clerk\.[a-z0-9.-]+\.(dev|com)/,
		);
		// No literal https:// URL sitting in the domain position.
		expect(source).not.toMatch(/domain:\s*"https:\/\//);
		expect(source).toMatch(/process\.env\.CLERK_JWT_ISSUER_DOMAIN/);
	});

	describe("behavior parity with env var", () => {
		const ORIGINAL_ENV = process.env.CLERK_JWT_ISSUER_DOMAIN;

		beforeEach(() => {
			process.env.CLERK_JWT_ISSUER_DOMAIN = "https://test-issuer.example";
		});

		afterEach(() => {
			if (ORIGINAL_ENV === undefined) {
				process.env.CLERK_JWT_ISSUER_DOMAIN = undefined;
			} else {
				process.env.CLERK_JWT_ISSUER_DOMAIN = ORIGINAL_ENV;
			}
		});

		test("providers[0].domain flows from env, applicationID stays convex", async () => {
			vi.resetModules();
			const mod = await import("../auth.config");
			const config = mod.default;

			expect(config.providers[0].domain).toBe("https://test-issuer.example");
			expect(config.providers[0].applicationID).toBe("convex");
		});
	});
});
