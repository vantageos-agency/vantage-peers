/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorDeployWindow.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Bug 1 (issue #1088) — non-forgeable deploy-window signal. See
// convex/errorMonitorDeployWindow.ts header for the full rationale and the
// explicit statement of what this signal does and does NOT protect against.
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	DEPLOY_WINDOW_ENV_VAR,
	isDeployWindowActive,
} from "../errorMonitorDeployWindow";

const originalEnv = process.env[DEPLOY_WINDOW_ENV_VAR];

beforeEach(() => {
	delete process.env[DEPLOY_WINDOW_ENV_VAR];
});
afterEach(() => {
	if (originalEnv === undefined) {
		delete process.env[DEPLOY_WINDOW_ENV_VAR];
	} else {
		process.env[DEPLOY_WINDOW_ENV_VAR] = originalEnv;
	}
});

describe("isDeployWindowActive", () => {
	test("unset env var → inactive (fail-open, never silently blinds the monitor)", () => {
		expect(isDeployWindowActive(Date.now())).toBe(false);
	});

	test("set to a future timestamp → active", () => {
		process.env[DEPLOY_WINDOW_ENV_VAR] = String(Date.now() + 5 * 60_000);
		expect(isDeployWindowActive(Date.now())).toBe(true);
	});

	test("set to a past timestamp (window elapsed) → inactive", () => {
		process.env[DEPLOY_WINDOW_ENV_VAR] = String(Date.now() - 60_000);
		expect(isDeployWindowActive(Date.now())).toBe(false);
	});

	test("non-numeric value → inactive, does not throw", () => {
		process.env[DEPLOY_WINDOW_ENV_VAR] = "not-a-number";
		expect(() => isDeployWindowActive(Date.now())).not.toThrow();
		expect(isDeployWindowActive(Date.now())).toBe(false);
	});

	test("empty string → inactive", () => {
		process.env[DEPLOY_WINDOW_ENV_VAR] = "";
		expect(isDeployWindowActive(Date.now())).toBe(false);
	});

	test("cannot be forged by a caller-supplied value — only process.env is consulted", () => {
		// This is the core anti-forgery property: isDeployWindowActive has NO
		// parameter through which a request/caller can influence the result
		// other than `now` (server clock). There is no `claimedSmokeTest`-style
		// argument anywhere in its signature.
		expect(isDeployWindowActive.length).toBe(1);
	});
});
