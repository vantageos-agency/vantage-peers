/**
 * MCP-layer mirror of convex requireSenderInstanceOfSender: an OAuth
 * access-token caller reaches Convex as the service account (master), so its
 * `fromInstanceId` is judged here. Non-master ctx; master poles kept.
 */
import { describe, expect, it } from "vitest";
import { checkInstanceOfSender, type OAuthContext } from "../src/auth.js";

const ctxOf = (fromAllowList: string[], isMaster = false): OAuthContext => ({
	clientId: "c",
	userId: "u",
	scopes: ["vantage:write"],
	scopeProfile: "team-member",
	fromAllowList,
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: Number.MAX_SAFE_INTEGER,
	isMaster,
});

describe("checkInstanceOfSender", () => {
	const ctx = ctxOf(["pi", "pi-x", "bob"]);
	it("REFUSES a foreign or sibling instance", () => {
		for (const [from, inst] of [
			["bob", "eta-vps"],
			["bob", "bobby-vps"],
			["pi", "pi-x"],
			["pi", "pi-x-vps"],
			["bob", "bob-"],
			["bob", "bob-​"],
			["bob", "bob--x"],
		]) {
			expect(checkInstanceOfSender(ctx, from, inst).error).toMatch(/Forbidden/);
		}
	});
	it("SERVES own instances and returns the normalised form", () => {
		expect(checkInstanceOfSender(ctx, "bob", "  BOB-VPS ")).toEqual({
			error: null,
			instance: "bob-vps",
		});
		expect(checkInstanceOfSender(ctx, "pi", "pi-vps").error).toBeNull();
		expect(checkInstanceOfSender(ctx, "pi-x", "pi-x-vps").error).toBeNull();
		expect(checkInstanceOfSender(ctx, "bob", undefined)).toEqual({
			error: null,
			instance: undefined,
		});
	});
	it("MASTER is not decided here; no ctx refuses", () => {
		expect(checkInstanceOfSender(ctxOf([], true), "bob", "eta-vps")).toEqual({
			error: null,
			instance: "eta-vps",
		});
		expect(checkInstanceOfSender(undefined, "bob", "bob-vps").error).not.toBeNull();
	});
});
