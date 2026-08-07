import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	resolveLocalCredName,
	resolvePreflight,
} from "../deploy-preflight.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
	readFileSync(resolve(__dirname, "../../deploy/env-manifest.json"), "utf8"),
);
const PROJECT = "vantage-peers";

describe("resolvePreflight", () => {
	it("Test A — reports the EXACT divergent name as MISSING (convex-prod missing CLERK_JWT_ISSUER_DOMAIN)", () => {
		const presentNames = [
			"CLERK_SERVICE_ACCOUNT_USER_ID",
			"CLERK_SECRET_KEY",
			"BEARER_SECRET_MASTER",
			"AI_GATEWAY_API_KEY",
			// CLERK_JWT_ISSUER_DOMAIN deliberately absent
		];
		const r = resolvePreflight({
			manifest,
			project: PROJECT,
			target: "convex-prod",
			presentNames,
		});
		expect(r.ok).toBe(false);
		expect(r.missing).toContain("CLERK_JWT_ISSUER_DOMAIN");
	});

	it("Test B — a present var is NOT reported missing (all required exact names present)", () => {
		const presentNames = [
			"CLERK_JWT_ISSUER_DOMAIN",
			"CLERK_SERVICE_ACCOUNT_USER_ID",
			"CLERK_SECRET_KEY",
			"BEARER_SECRET_MASTER",
			"AI_GATEWAY_API_KEY",
			"UNRELATED_EXTRA_VAR",
		];
		const r = resolvePreflight({
			manifest,
			project: PROJECT,
			target: "convex-prod",
			presentNames,
		});
		expect(r.ok).toBe(true);
		expect(r.missing).toEqual([]);
		expect(r.required.every((x) => x.status === "PRESENT")).toBe(true);
	});

	it("Test C — divergence absorbed: convex-prod-deploy-key maps to the BARE name, not a guessed suffix", () => {
		const name = resolveLocalCredName(
			manifest,
			PROJECT,
			"convex-prod-deploy-key",
		);
		expect(name).toBe("CONVEX_DEPLOY_KEY");
		expect(name).not.toBe("CONVEX_DEPLOY_KEY_VANTAGE_PEERS");
		// sibling dev key keeps its suffixed name
		expect(
			resolveLocalCredName(manifest, PROJECT, "convex-dev-deploy-key"),
		).toBe("CONVEX_DEPLOY_KEY_DEV_VP");
	});
});
