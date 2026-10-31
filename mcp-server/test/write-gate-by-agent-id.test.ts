/**
 * Task k17cn591av7f4t070vj4hgymhx8hbab1 (VantagePeers Cloud). A person token that
 * acts as an agent chosen at consent is admitted at the `from` gate by that agent's
 * ID being on the organisation's roster by ID, READ LIVE by Convex
 * (oauth:getAccessTokenByHash -> personalAgent.onRoster). The label snapshot minted
 * onto the token (fromAllowList) never decides it, and neither does its spelling.
 *
 * Poles: ADMIT (snapshot lacks the label / differs by case), REFUSE (agent ID not on
 * the roster, onRoster false), REFUSE (asserted name is another agent's), LEGACY
 * (no onRoster: today's label compare, both poles, byte-identical).
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { fromGate } from "./lib/fromGate.js";

const ORG = "client-org";

function personCtx(over: {
	snapshot: string[];
	agentName: string;
	onRoster?: boolean;
	personalAgentId?: string;
	actorAgentId?: string;
}): OAuthContext {
	const agentId = over.actorAgentId ?? "agent-aria";
	return {
		clientId: "chatgpt",
		userId: "user_person",
		scopes: ["mcp:full"],
		scopeProfile: "team-member",
		fromAllowList: over.snapshot,
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		principal: "person",
		clerkOrgSlug: ORG,
		accessTokenHash: "hash",
		actor: { orgSlug: ORG, agentName: over.agentName, agentId },
		personalAgent: {
			agentId: over.personalAgentId ?? "agent-aria",
			orgId: ORG,
			agentName: over.agentName,
			...(over.onRoster === undefined ? {} : { onRoster: over.onRoster }),
		},
	};
}

describe("write gate by agent ID (person token)", () => {
	it("ADMIT: the snapshot lacks the stamped agent's label, its ID is on the live roster", async () => {
		const ctx = personCtx({
			snapshot: ["bo", "cy"],
			agentName: "Aria",
			onRoster: true,
		});
		expect(await fromGate(ctx, "Aria")).toBeNull();
		expect(await fromGate(ctx, undefined)).toBeNull();
	});

	it("ADMIT: the roster label differs from the stored name only by case", async () => {
		const ctx = personCtx({
			snapshot: ["bo", "aria"],
			agentName: "Aria",
			onRoster: true,
		});
		expect(await fromGate(ctx, "Aria")).toBeNull();
	});

	it("REFUSE: the agent ID is not on the live roster even when its label is in the snapshot", async () => {
		const ctx = personCtx({
			snapshot: ["Aria", "bo"],
			agentName: "Aria",
			onRoster: false,
		});
		expect(await fromGate(ctx, "Aria")).toMatch(
			/^Forbidden: from='Aria' is not in this client's allowlist/,
		);
	});

	it("REFUSE: an asserted name that is another agent's is not admitted by the live flag", async () => {
		const ctx = personCtx({
			snapshot: ["bo"],
			agentName: "Aria",
			onRoster: true,
		});
		expect(await fromGate(ctx, "Bo")).not.toBeNull();
	});

	it("REFUSE: the flag belongs to the resolved agent only (credential actor is another agent)", async () => {
		const ctx = personCtx({
			snapshot: ["bo"],
			agentName: "Dee",
			onRoster: true,
			actorAgentId: "agent-dee",
			personalAgentId: "agent-aria",
		});
		expect(await fromGate(ctx, "Dee")).toMatch(
			/not in this client's allowlist/,
		);
	});

	it("LEGACY: no live flag (older provider / roster not backfilled) keeps the label compare", async () => {
		const listed = personCtx({ snapshot: ["Aria"], agentName: "Aria" });
		expect(await fromGate(listed, "Aria")).toBeNull();
		const unlisted = personCtx({ snapshot: ["bo"], agentName: "Aria" });
		expect(await fromGate(unlisted, "Aria")).toMatch(
			/not in this client's allowlist/,
		);
	});
});
