/**
 * CLERK_DOMAIN has no default (task k172bj3j3yts4n76qwcr8waawd8k0r3c).
 *
 * A caller holding a LIVE secret key and no CLERK_DOMAIN used to mint a
 * sign-in ticket on the live Clerk instance and redeem it on a hardcoded DEV
 * instance, failing with `ticket_invalid_code`, which reads as an outage.
 * Now the call refuses BEFORE any Clerk or network call, naming CLERK_DOMAIN.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	_loadConfigForTest,
	_resetServiceAccountCacheForTest,
	_setServiceAccountDepsForTest,
	getScopedUserToken,
	getServiceAccountToken,
} from "../serviceAccountAuth.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	process.env.CLERK_SECRET_KEY = "sk_live_fake_00000000000000000000";
	process.env.CLERK_SERVICE_ACCOUNT_USER_ID = "user_fake_service_account";
	delete process.env.CLERK_DOMAIN;
	_setServiceAccountDepsForTest(null);
	_resetServiceAccountCacheForTest();
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	_setServiceAccountDepsForTest(null);
	_resetServiceAccountCacheForTest();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe.each([
	{
		label: "unset",
		apply: () => {
			delete process.env.CLERK_DOMAIN;
		},
	},
	{
		label: "empty",
		apply: () => {
			process.env.CLERK_DOMAIN = "";
		},
	},
])("CLERK_DOMAIN $label", ({ apply }) => {
	test("getServiceAccountToken rejects naming CLERK_DOMAIN and makes no fetch", async () => {
		apply();
		const fetchStub = vi.fn();
		vi.stubGlobal("fetch", fetchStub);

		await expect(getServiceAccountToken()).rejects.toThrow(
			/CLERK_DOMAIN.*Frontend API origin.*CLERK_SECRET_KEY/s,
		);
		expect(fetchStub).toHaveBeenCalledTimes(0);
	});

	test("getScopedUserToken rejects naming CLERK_DOMAIN and makes no fetch", async () => {
		apply();
		const fetchStub = vi.fn();
		vi.stubGlobal("fetch", fetchStub);

		await expect(getScopedUserToken("user_x")).rejects.toThrow(
			/CLERK_DOMAIN.*Frontend API origin.*CLERK_SECRET_KEY/s,
		);
		expect(fetchStub).toHaveBeenCalledTimes(0);
	});

	test("loadConfig refuses instead of defaulting to a dev instance", () => {
		apply();
		expect(() => _loadConfigForTest()).toThrow(/CLERK_DOMAIN/);
	});
});

describe("CLERK_DOMAIN set", () => {
	test("is used verbatim, never replaced by a default", () => {
		process.env.CLERK_DOMAIN = "https://clerk.example.test";
		expect(_loadConfigForTest()?.domain).toBe("https://clerk.example.test");
	});

	test("secret key absent still returns null (no credential configured), not a CLERK_DOMAIN refusal", async () => {
		delete process.env.CLERK_SECRET_KEY;
		expect(await getServiceAccountToken()).toBeNull();
		expect(await getScopedUserToken("user_x")).toBeNull();
	});
});
