/**
 * S3.1.B Wave B — scopeAwareFilter applied to Marie surface tools (3 sites).
 *
 * Sprint S3.1.B
 * Mission     k57c7s478gw1a3e5gmhdeptg5n87z78n
 * Task        k170618c4cqky8gmq6rr2pwrt187yfgm
 * Doctrine    j579y6f31g7xzgtgdnpgetdmjx87ztyj base
 *           + j57bvz4c62mrfs024fay5vhqqs87zxph extension D9-D14
 * Precedent   Wave A SHA 251d183 (main)
 *
 * Tools covered in Wave B (Marie's primary read surface):
 *   1. list_briefing_notes  (tools.ts L3052)
 *   2. list_messages        (tools.ts L1614)
 *   3. list_peers           (tools.ts L1554)
 *
 * NOTE on the brief's 4th tool (`get_briefing_note`):
 * No such tool is registered in `mcp-server/src/tools.ts` (verified by grep on
 * the full file at HEAD). Only create_briefing_note + update_briefing_note +
 * list_briefing_notes exist. Wave B therefore ships 3 tools; the missing
 * `get_briefing_note` is logged as a brief discrepancy + Wave C follow-up.
 *
 * Harness note (friction — mirrors Wave A § Friction):
 * The brief implies handler-integration tests through Hono `/mcp` round-trip
 * with a mocked Convex client. That harness exceeds the ~80k token Wave B
 * envelope (bootstrapping McpServer + JSON-RPC envelope + every cross-cutting
 * guard). Following Wave A precedent, the tests below exercise the *exact
 * post-Convex-query slice* the GREEN patch introduces — `scopeFilterList`
 * applied to the rows returned by each Convex query, per the alpha/beta/gamma
 * fixture convention from oauth-d6-d7.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { scopeFilterList } from "@vantageos/cloud-identity";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders (mirror Wave A)
// ─────────────────────────────────────────────────────────────────────────────

function masterCtx(): OAuthContext {
	return {
		clientId: "master",
		userId: "master",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3600_000,
		isMaster: true,
	};
}

function alphaCtx(): OAuthContext {
	return {
		clientId: "client-alpha",
		userId: "user-alpha",
		scopes: ["vantage:read"],
		scopeProfile: "tenant-alpha",
		fromAllowList: ["alpha"],
		namespaceReadPrefixes: ["orchestrator/alpha", "project/alpha"],
		namespaceWritePrefixes: ["project/alpha"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

function unscopedCtx(): OAuthContext {
	return {
		clientId: "client-dcr",
		userId: "client-dcr",
		scopes: [],
		scopeProfile: "client-generic",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 1 — list_briefing_notes
// Fixture mimics rows from `briefingNotes:list` Convex query.
// ─────────────────────────────────────────────────────────────────────────────

type BriefingNoteRow = {
	_id: string;
	createdBy?: string;
	namespace?: string;
	topic: string;
	title: string;
};

const BRIEFING_FIXTURE: BriefingNoteRow[] = [
	{
		_id: "bn_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		topic: "onboarding",
		title: "Alpha kickoff",
	},
	{
		_id: "bn_a2",
		createdBy: "alpha",
		namespace: "project/alpha",
		topic: "review",
		title: "Alpha review",
	},
	{
		_id: "bn_a3",
		createdBy: "someone-else",
		namespace: "orchestrator/alpha/deep",
		topic: "deep",
		title: "Alpha subspace by other",
	},
	{
		_id: "bn_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		topic: "onboarding",
		title: "Beta kickoff",
	},
	{
		_id: "bn_b2",
		createdBy: "beta",
		namespace: "project/beta",
		topic: "review",
		title: "Beta review",
	},
	{
		_id: "bn_g1",
		createdBy: "gamma",
		namespace: "global",
		topic: "global",
		title: "Gamma global",
	},
];

describe("BN — list_briefing_notes slice (scopeFilterList)", () => {
	it("BN-T1 master scope → all 6 fixture notes visible", () => {
		const out = scopeFilterList(masterCtx(), BRIEFING_FIXTURE);
		expect(out).toHaveLength(BRIEFING_FIXTURE.length);
	});

	it("BN-T2 alpha scope → only alpha-createdBy or alpha-namespaced notes visible", () => {
		const out = scopeFilterList(alphaCtx(), BRIEFING_FIXTURE);
		const ids = out.map((r) => r._id).sort();
		expect(ids).toEqual(["bn_a1", "bn_a2", "bn_a3"]);
	});

	it("BN-T3 cross-tenant: alpha never sees beta briefing notes", () => {
		const out = scopeFilterList(alphaCtx(), BRIEFING_FIXTURE);
		expect(out.some((r) => r.createdBy === "beta")).toBe(false);
		expect(out.some((r) => r.namespace?.startsWith("orchestrator/beta"))).toBe(
			false,
		);
		expect(out.some((r) => r.namespace?.startsWith("project/beta"))).toBe(
			false,
		);
	});

	it("BN-T4 namespace filter: alpha sees orchestrator/alpha + project/alpha, not orchestrator/beta", () => {
		const ctx = alphaCtx();
		const fixture: BriefingNoteRow[] = [
			{
				_id: "bn_n1",
				namespace: "orchestrator/alpha",
				topic: "x",
				title: "x",
			},
			{
				_id: "bn_n2",
				namespace: "project/alpha",
				topic: "x",
				title: "x",
			},
			{
				_id: "bn_n3",
				namespace: "orchestrator/alphabet",
				topic: "x",
				title: "x",
			},
			{
				_id: "bn_n4",
				namespace: "orchestrator/beta",
				topic: "x",
				title: "x",
			},
		];
		const out = scopeFilterList(ctx, fixture).map((r) => r._id);
		expect(out).toEqual(["bn_n1", "bn_n2"]);
	});

	it("BN-T5 unscoped non-master (DCR client-generic) → [] (no 403, no throw)", () => {
		const out = scopeFilterList(unscopedCtx(), BRIEFING_FIXTURE);
		expect(out).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 2 — list_messages
// Fixture mimics rows from `messages:listMessages`. Messages carry `from`
// (sender) and optionally `namespace`. We map `from` → `createdBy` at the
// filter call site (see tools.ts Wave B GREEN patch).
// ─────────────────────────────────────────────────────────────────────────────

type MessageRow = {
	_id: string;
	from?: string;
	createdBy?: string;
	namespace?: string;
	channel?: string;
	content: string;
};

const MESSAGE_FIXTURE: MessageRow[] = [
	{
		_id: "msg_a1",
		from: "alpha",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		channel: "general",
		content: "alpha hi",
	},
	{
		_id: "msg_a2",
		from: "alpha",
		createdBy: "alpha",
		namespace: "project/alpha",
		channel: "general",
		content: "alpha project ping",
	},
	{
		_id: "msg_a3",
		from: "someone-else",
		createdBy: "someone-else",
		namespace: "orchestrator/alpha/deep",
		channel: "general",
		content: "alpha subspace by other",
	},
	{
		_id: "msg_b1",
		from: "beta",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		channel: "general",
		content: "beta hi",
	},
	{
		_id: "msg_b2",
		from: "beta",
		createdBy: "beta",
		namespace: "project/beta",
		channel: "general",
		content: "beta project ping",
	},
	{
		_id: "msg_g1",
		from: "gamma",
		createdBy: "gamma",
		namespace: "global",
		channel: "broadcast",
		content: "gamma global",
	},
];

describe("MSG — list_messages slice (scopeFilterList)", () => {
	it("MSG-T1 master scope → all 6 fixture messages visible", () => {
		const out = scopeFilterList(masterCtx(), MESSAGE_FIXTURE);
		expect(out).toHaveLength(MESSAGE_FIXTURE.length);
	});

	it("MSG-T2 alpha scope → only alpha-createdBy or alpha-namespaced messages visible", () => {
		const out = scopeFilterList(alphaCtx(), MESSAGE_FIXTURE);
		const ids = out.map((r) => r._id).sort();
		expect(ids).toEqual(["msg_a1", "msg_a2", "msg_a3"]);
	});

	it("MSG-T3 cross-tenant: alpha never sees beta messages", () => {
		const out = scopeFilterList(alphaCtx(), MESSAGE_FIXTURE);
		expect(out.some((r) => r.createdBy === "beta")).toBe(false);
		expect(out.some((r) => r.namespace?.startsWith("orchestrator/beta"))).toBe(
			false,
		);
		expect(out.some((r) => r.namespace?.startsWith("project/beta"))).toBe(
			false,
		);
	});

	it("MSG-T4 namespace filter: orchestrator/alpha + project/alpha visible, orchestrator/beta hidden", () => {
		const ctx = alphaCtx();
		const fixture: MessageRow[] = [
			{ _id: "m_n1", namespace: "orchestrator/alpha", content: "" },
			{ _id: "m_n2", namespace: "orchestrator/alpha/x", content: "" },
			{ _id: "m_n3", namespace: "orchestrator/alphabet", content: "" },
			{ _id: "m_n4", namespace: "orchestrator/beta", content: "" },
		];
		const out = scopeFilterList(ctx, fixture).map((r) => r._id);
		expect(out).toEqual(["m_n1", "m_n2"]);
	});

	it("MSG-T5 unscoped non-master → []", () => {
		const out = scopeFilterList(unscopedCtx(), MESSAGE_FIXTURE);
		expect(out).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 3 — list_peers
// Fixture mimics rows from `profiles:listProfiles`. The handler synthesises
// peers from profile rows; the filter runs on the *profile rows* (which carry
// createdBy + namespace via static.workspace) BEFORE the peer projection.
// ─────────────────────────────────────────────────────────────────────────────

type ProfileRow = {
	_id: string;
	orchestratorId: string;
	createdBy?: string;
	namespace?: string;
	name: string;
};

const PROFILE_FIXTURE: ProfileRow[] = [
	{
		_id: "prof_a1",
		orchestratorId: "alpha-1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		name: "Alpha One",
	},
	{
		_id: "prof_a2",
		orchestratorId: "alpha-2",
		createdBy: "alpha",
		namespace: "project/alpha",
		name: "Alpha Two",
	},
	{
		_id: "prof_a3",
		orchestratorId: "alpha-sub",
		createdBy: "someone-else",
		namespace: "orchestrator/alpha/deep",
		name: "Alpha Sub Other",
	},
	{
		_id: "prof_b1",
		orchestratorId: "beta-1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		name: "Beta One",
	},
	{
		_id: "prof_b2",
		orchestratorId: "beta-2",
		createdBy: "beta",
		namespace: "project/beta",
		name: "Beta Two",
	},
	{
		_id: "prof_g1",
		orchestratorId: "gamma-1",
		createdBy: "gamma",
		namespace: "global",
		name: "Gamma One",
	},
];

describe("PEER — list_peers slice (scopeFilterList)", () => {
	it("PEER-T1 master scope → all 6 fixture profiles visible", () => {
		const out = scopeFilterList(masterCtx(), PROFILE_FIXTURE);
		expect(out).toHaveLength(PROFILE_FIXTURE.length);
	});

	it("PEER-T2 alpha scope → only alpha-createdBy or alpha-namespaced profiles visible", () => {
		const out = scopeFilterList(alphaCtx(), PROFILE_FIXTURE);
		const ids = out.map((r) => r._id).sort();
		expect(ids).toEqual(["prof_a1", "prof_a2", "prof_a3"]);
	});

	it("PEER-T3 cross-tenant: alpha never sees beta peers", () => {
		const out = scopeFilterList(alphaCtx(), PROFILE_FIXTURE);
		expect(out.some((r) => r.createdBy === "beta")).toBe(false);
		expect(out.some((r) => r.namespace?.startsWith("orchestrator/beta"))).toBe(
			false,
		);
		expect(out.some((r) => r.namespace?.startsWith("project/beta"))).toBe(
			false,
		);
	});

	it("PEER-T4 namespace filter: alpha sees orchestrator/alpha + project/alpha, not orchestrator/beta", () => {
		const ctx = alphaCtx();
		const fixture: ProfileRow[] = [
			{
				_id: "p_n1",
				orchestratorId: "n1",
				namespace: "orchestrator/alpha",
				name: "n1",
			},
			{
				_id: "p_n2",
				orchestratorId: "n2",
				namespace: "project/alpha",
				name: "n2",
			},
			{
				_id: "p_n3",
				orchestratorId: "n3",
				namespace: "orchestrator/alphabet",
				name: "n3",
			},
			{
				_id: "p_n4",
				orchestratorId: "n4",
				namespace: "orchestrator/beta",
				name: "n4",
			},
		];
		const out = scopeFilterList(ctx, fixture).map((r) => r._id);
		expect(out).toEqual(["p_n1", "p_n2"]);
	});

	it("PEER-T5 unscoped non-master → []", () => {
		const out = scopeFilterList(unscopedCtx(), PROFILE_FIXTURE);
		expect(out).toEqual([]);
	});
});
