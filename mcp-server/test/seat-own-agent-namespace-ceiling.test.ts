/**
 * Task k171ysvpwb4wzjkkjr2kqpwsx98hedaw. A seat token's namespace prefixes are a
 * SNAPSHOT taken at mint time. A seat minted before its profile gained
 * `orchestrator/<agentId>` carries `orchestrator/<name>` only, so the MCP refused
 * the one agent namespace Convex admits (convex/lib/seatNamespace.ts). The ceiling
 * now admits `orchestrator/<the token's own verified agent ID>` in both
 * directions, segment-bounded, derived only from the verified token row
 * (`seatAgentOf`: the stamp is believed only for the token's own org), never from
 * a name or an argument, exactly like the `team/<orgClerkId>` carve-out.
 *
 * Poles: own ID allowed (read + write) with a stale snapshot; refused: another
 * agent's ID, `orchestrator/<id>x`, `orchestrator/<name>` for a seat whose
 * snapshot names another agent, a bare `orchestrator`, a seat with no verified
 * agent, a stamp for another org; master unchanged.
 */
import { describe, expect, it } from "vitest";
import {
	checkNamespaceRead,
	checkNamespaceWrite,
	type OAuthContext,
} from "../src/auth.js";

const OWN = "r57b8p6jp2na6p6pdz7z0g0sk58fczj9";
const OTHER = "r57zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

const seat = (extra: Partial<OAuthContext> = {}): OAuthContext =>
	({
		clientId: "seat-victor",
		userId: "u",
		scopes: ["mcp:full"],
		scopeProfile: "victor-iris-rh",
		fromAllowList: ["victor"],
		// the stale mint-time snapshot: the NAME, not the ID
		namespaceReadPrefixes: ["orchestrator/victor", "project/iris-rh"],
		namespaceWritePrefixes: ["orchestrator/victor", "project/iris-rh"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		clerkOrgSlug: "iris-rh",
		accessTokenHash: "h",
		seatAgent: { agentId: OWN, orgId: "iris-rh", agentName: "victor" },
		...extra,
	}) as OAuthContext;

const FORBIDDEN = /^Forbidden: namespace=/;

describe("a stale-snapshot seat reaches its own orchestrator/<agent ID>", () => {
	it("ALLOW: write and read orchestrator/<own ID> and a sub-namespace", () => {
		const ctx = seat();
		for (const ns of [`orchestrator/${OWN}`, `orchestrator/${OWN}/notes`]) {
			expect(checkNamespaceWrite(ctx, ns), ns).toBeNull();
			expect(checkNamespaceRead(ctx, ns), ns).toBeNull();
		}
	});

	it("REFUSED: another agent's ID, a no-boundary prefix, a bare root", () => {
		const ctx = seat();
		for (const ns of [
			`orchestrator/${OTHER}`,
			`orchestrator/${OWN}x`,
			`orchestrator/${OWN.slice(0, -1)}`,
			"orchestrator",
			"orchestrator/",
			"orchestrator/*",
		]) {
			expect(checkNamespaceWrite(ctx, ns), ns).toMatch(FORBIDDEN);
			expect(checkNamespaceRead(ctx, ns), ns).toMatch(FORBIDDEN);
		}
	});

	it("REFUSED: a name-only snapshot never opens another agent's ID or a different name", () => {
		const ctx = seat({
			seatAgent: { agentId: OTHER, orgId: "iris-rh", agentName: "marie" },
		});
		expect(checkNamespaceWrite(ctx, `orchestrator/${OWN}`)).toMatch(FORBIDDEN);
		expect(checkNamespaceWrite(ctx, "orchestrator/marie")).toMatch(FORBIDDEN);
		expect(checkNamespaceWrite(ctx, `orchestrator/${OTHER}`)).toBeNull();
	});

	it("REFUSED: no verified agent (org-level seat, null, absent) or a stamp for another org", () => {
		for (const extra of [
			{ seatAgent: null },
			{ seatAgent: undefined },
			{ seatAgent: { agentId: OWN, orgId: "other-co", agentName: "victor" } },
			{ seatAgent: { agentId: "", orgId: "iris-rh", agentName: "victor" } },
		] as Partial<OAuthContext>[]) {
			const ctx = seat(extra);
			expect(checkNamespaceWrite(ctx, `orchestrator/${OWN}`)).toMatch(FORBIDDEN);
			expect(checkNamespaceRead(ctx, `orchestrator/${OWN}`)).toMatch(FORBIDDEN);
		}
	});

	it("REFUSED: the name-derived namespace still follows the snapshot only (project/<other slug> stays refused)", () => {
		const ctx = seat();
		expect(checkNamespaceWrite(ctx, "project/marie")).toMatch(FORBIDDEN);
		expect(checkNamespaceWrite(ctx, "audit/friction")).toMatch(FORBIDDEN);
		expect(checkNamespaceWrite(ctx, "orchestrator/victor")).toBeNull();
	});

	it("MASTER unchanged", () => {
		const master = seat({ isMaster: true, scopeProfile: "master" });
		expect(checkNamespaceWrite(master, `orchestrator/${OTHER}`)).toBeNull();
		expect(checkNamespaceRead(master, "audit/friction")).toBeNull();
	});
});
