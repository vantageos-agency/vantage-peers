// allow-missing-refs: new file
/**
 * seat-org-by-id.test.ts - batch C, module M3 residue. VantagePeers Cloud.
 *
 * Operator ruling 2026-10-13: "identify by id, not by name".
 *
 * `seatAgentOf` believes a seat token's agent stamp only when the stamp's
 * organisation is the token's OWN organisation. That is decided by the
 * permanent org ID (@vantageos/cloud-identity `sameOrg`), never by the slug:
 *
 *   PRESENT  same org ID, and a RENAMED slug (the label moved, the org did not)
 *            still believes the stamp
 *   DENY     the same slug in another organisation (a freed slug that a new org
 *            took) is NOT believed: the IDs differ
 *   DENY     an absent agent, an empty ID, a token with no organisation
 *   ABSENT   a provider that states no org ID (a Convex that predates the field)
 *            is the one that vouched: the stamp is believed as the provider sent it
 */
import { describe, expect, it } from "vitest";
import { type OAuthContext, seatAgentOf } from "../src/auth.js";

const base = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "c",
	userId: "u",
	scopes: ["mcp:full"],
	scopeProfile: "clio-org-a",
	fromAllowList: ["clio"],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: Date.now() + 1000,
	isMaster: false,
	accessTokenHash: "h",
	clerkOrgSlug: "org-a",
	clerkOrgId: "org_A1",
	seatAgent: {
		agentId: "agent-clio",
		orgId: "org-a",
		agentName: "clio",
		orgClerkId: "org_A1",
	},
	...over,
});

describe("seatAgentOf decides the organisation by permanent ID", () => {
	it("PRESENT: the same org ID believes the stamp", () => {
		expect(seatAgentOf(base())?.agentId).toBe("agent-clio");
	});

	it("PRESENT: a renamed slug does not break the seat (the label moved, the organisation did not)", () => {
		const renamed = base({
			clerkOrgSlug: "org-a-renamed",
			seatAgent: {
				agentId: "agent-clio",
				orgId: "org-a",
				agentName: "clio",
				orgClerkId: "org_A1",
			},
		});
		expect(seatAgentOf(renamed)?.agentId).toBe("agent-clio");
	});

	it("DENY: the same slug in ANOTHER organisation is not believed (different org ID)", () => {
		const reused = base({
			seatAgent: {
				agentId: "agent-clio-b",
				orgId: "org-a",
				agentName: "clio",
				orgClerkId: "org_B1",
			},
		});
		expect(seatAgentOf(reused)).toBeUndefined();
	});

	it("DENY: no stamp, an empty agent ID, an empty name, and a token with no organisation", () => {
		expect(seatAgentOf(base({ seatAgent: null }))).toBeUndefined();
		expect(seatAgentOf(base({ seatAgent: undefined }))).toBeUndefined();
		expect(
			seatAgentOf(
				base({ seatAgent: { agentId: "", orgId: "org-a", agentName: "clio" } }),
			),
		).toBeUndefined();
		expect(
			seatAgentOf(
				base({ seatAgent: { agentId: "a", orgId: "org-a", agentName: "" } }),
			),
		).toBeUndefined();
		expect(seatAgentOf(base({ clerkOrgSlug: undefined }))).toBeUndefined();
	});

	it("ABSENT: a provider that states no org ID vouched for the stamp; it is believed as sent", () => {
		const old = base({
			clerkOrgId: undefined,
			seatAgent: { agentId: "agent-clio", orgId: "org-a", agentName: "clio" },
		});
		expect(seatAgentOf(old)?.agentId).toBe("agent-clio");
	});

	it("the source of seatAgentOf compares no slug", async () => {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(
			new URL("../src/auth.ts", import.meta.url),
			"utf8",
		);
		const body = source.indexOf("const seat = ctx.seatAgent;");
		const fn = source.slice(body, source.indexOf("\n}\n", body));
		expect(fn).not.toMatch(/clerkOrgSlug\s*(!==|===)\s*(?!undefined)\S/);
		expect(fn).not.toMatch(/orgId\s*(!==|===)/);
	});
});
