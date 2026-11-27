/**
 * S-35 -- mayReadMasterOnlyDoor(oauthCtx): who may reach a fleet-master-only door.
 *
 * These tests exist because the wrapper's { kind: "master" } on get_issue and issue_stats makes the
 * in-handler check unreachable through registerTools: the wrapper refuses a non-master caller
 * first, so a test through the registered tool cannot turn the in-handler check red.
 */

import { describe, expect, it } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { mayReadMasterOnlyDoor } from "../src/tools.js";

const base = {
	scopes: ["mcp:full"],
	namespaceReadPrefixes: ["team/org-fixture-alpha"],
	namespaceWritePrefixes: ["team/org-fixture-alpha"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};

const MASTER_BEARER: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
	viaMasterBearer: true,
};
// A signed-in org member (Clerk session) and a seat bearer carrying a verified org.
const MEMBER: OAuthContext = {
	...base,
	clientId: "clerk-member",
	userId: "user-fixture-alpha",
	scopeProfile: "team-member",
	fromAllowList: ["alpha"],
	orgClerkId: "org_fixtureAlpha",
};
const SEAT: OAuthContext = {
	...base,
	clientId: "seat-bearer",
	userId: "user-fixture-seat",
	scopeProfile: "tenant",
	fromAllowList: ["alpha"],
	orgClerkId: "org_fixtureAlpha",
};
// An OAuth client (a registered application's token).
const CLIENT: OAuthContext = {
	...base,
	clientId: "client-fixture-alpha",
	userId: "user-fixture-alpha",
	scopeProfile: "tenant",
	fromAllowList: ["alpha"],
};

describe("S-35 -- mayReadMasterOnlyDoor", () => {
	it("master bearer: true", () => {
		expect(mayReadMasterOnlyDoor(MASTER_BEARER)).toBe(true);
	});
	it("local stdio trust (master): true", () => {
		expect(mayReadMasterOnlyDoor(LOCAL_STDIO_TRUST_CTX)).toBe(true);
	});
	it("org member: false", () => {
		expect(mayReadMasterOnlyDoor(MEMBER)).toBe(false);
	});
	it("seat bearer: false", () => {
		expect(mayReadMasterOnlyDoor(SEAT)).toBe(false);
	});
	it("client: false", () => {
		expect(mayReadMasterOnlyDoor(CLIENT)).toBe(false);
	});
	it("no context: false, absence is never master", () => {
		expect(mayReadMasterOnlyDoor(undefined)).toBe(false);
	});
});
