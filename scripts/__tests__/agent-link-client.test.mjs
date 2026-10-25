import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRANT_FN, REVOKE_FN, agentLinkArgs, agentLinkCall } from "../lib/agent-link-client.mjs";

// The consumer of agentLinks:grant / agentLinks:revoke (no MCP tool: a person's session).
// It must send exactly the args the doors declare, never grantedBy, and must name doors
// that exist in the generated API.

const ROOT = join(import.meta.dirname, "..", "..");

function recordingClient(answer) {
	const calls = [];
	return { calls, mutation: async (name, args) => (calls.push({ name, args }), answer) };
}

describe("agentLinks consumer — contract with the doors", () => {
	it("the doors it calls exist: convex/agentLinks.ts exports grant and revoke, api.d.ts imports the module", () => {
		const src = readFileSync(join(ROOT, "convex/agentLinks.ts"), "utf-8");
		expect(src).toMatch(/export const grant = mutation\(/);
		expect(src).toMatch(/export const revoke = mutation\(/);
		const api = readFileSync(join(ROOT, "convex/_generated/api.d.ts"), "utf-8");
		expect(api).toContain('agentLinks: typeof agentLinks;');
		expect(GRANT_FN).toBe("agentLinks:grant");
		expect(REVOKE_FN).toBe("agentLinks:revoke");
	});

	it("the args it sends are exactly the doors' validators", () => {
		const src = readFileSync(join(ROOT, "convex/agentLinks.ts"), "utf-8");
		const grantArgs = /export const grant = mutation\(\{\s*args: \{([^}]*)\}/.exec(src)[1];
		const revokeArgs = /export const revoke = mutation\(\{\s*args: \{([^}]*)\}/.exec(src)[1];
		const keys = (s) => [...s.matchAll(/(\w+):/g)].map((m) => m[1]).sort();
		expect(keys(grantArgs)).toEqual(Object.keys(agentLinkArgs("grant", { fromAgentId: "a", toAgentId: "b", reason: "0123456789" })).sort());
		expect(keys(revokeArgs)).toEqual(Object.keys(agentLinkArgs("revoke", { fromAgentId: "a", toAgentId: "b" })).sort());
	});
});

describe("agentLinkCall", () => {
	it("grant calls agentLinks:grant with fromAgentId, toAgentId, reason and returns the row id", async () => {
		const c = recordingClient("link123");
		const r = await agentLinkCall(c, "grant", { fromAgentId: "pi1", toAgentId: "victor1", reason: "HR onboarding coordination" });
		expect(r).toBe("link123");
		expect(c.calls).toEqual([{ name: "agentLinks:grant", args: { fromAgentId: "pi1", toAgentId: "victor1", reason: "HR onboarding coordination" } }]);
	});

	it("revoke calls agentLinks:revoke with the pair only", async () => {
		const c = recordingClient(null);
		await agentLinkCall(c, "revoke", { fromAgentId: "pi1", toAgentId: "victor1" });
		expect(c.calls).toEqual([{ name: "agentLinks:revoke", args: { fromAgentId: "pi1", toAgentId: "victor1" } }]);
	});

	it.each([
		["grantedBy is never sent", "grant", { fromAgentId: "a", toAgentId: "b", reason: "0123456789", grantedBy: "user_x" }, /takes no grantedBy/],
		["a short reason", "grant", { fromAgentId: "a", toAgentId: "b", reason: "short" }, /reason is required/],
		["a missing target", "grant", { fromAgentId: "a", reason: "0123456789" }, /toAgentId is required/],
		["the same agent twice", "grant", { fromAgentId: "a", toAgentId: "a", reason: "0123456789" }, /same agent/],
		["a reason on revoke", "revoke", { fromAgentId: "a", toAgentId: "b", reason: "0123456789" }, /takes no reason/],
		["an unknown action", "delete", { fromAgentId: "a", toAgentId: "b" }, /unknown action/],
	])("REFUSED before any call: %s", async (_label, action, input, why) => {
		const c = recordingClient("x");
		await expect(agentLinkCall(c, action, input)).rejects.toThrow(why);
		expect(c.calls).toEqual([]);
	});
});
