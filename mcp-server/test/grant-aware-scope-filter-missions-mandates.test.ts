/**
 * cloud-identity 0.5.0 consumer upgrade — grant-aware scope filter applied to
 * the two carriers Pi verified as structurally blind to per-row grants:
 *
 *   - missions (get_mission)   — grant fields: `pilot` (string), `agents` (string[])
 *   - mandates (list/get)      — grant fields: `requestedBy`, `fulfilledBy` (both string)
 *
 * Task k174y9ra7pp8zed3bcczk6xaed8cpynp — closes "a right REFUSED by
 * absence": a named agent/pilot/fulfiller is a real per-row grant, but
 * scopeFilterList/scopeFilterGet used to consult only createdBy/namespace,
 * neither of which these rows carry — so the grantee was denied even though
 * the grant was present on the row.
 *
 * Every authorization test below runs under a SCOPED identity that is NOT
 * the row's creator (missions/mandates have no `createdBy` field at all) —
 * the fixture rows only ever carry the grant fields under test, so a
 * passing assertion is only possible if the grant path itself fires.
 *
 * Litmus test: could each "grantee reads" assertion still pass if the
 * grant-consulting code were deleted? No — with grantFields unconsulted,
 * scopeFilterList/scopeFilterGet fall back to createdBy/namespace-only
 * matching, and these fixtures carry neither, so every non-master read
 * would return empty/null. The tests are not worthless.
 */

import { describe, expect, it } from "vitest";
import {
	scopeFilterGet,
	scopeFilterList,
	type OAuthCtx,
} from "@vantageos/cloud-identity";

// SCOPED identity under test: "alice". Never the creator (no createdBy field
// exists on these fixtures at all) — every assertion below is decided purely
// by the grant-field path.
function aliceCtx(): OAuthCtx {
	return {
		scope: "tenant",
		fromAllowList: ["alice"],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// missions — get_mission slice. Rows mirror convex/missions.ts (pilot:
// string, agents: string[]). No createdBy/namespace field on this table.
// ─────────────────────────────────────────────────────────────────────────────

type MissionRow = {
	_id: string;
	pilot: string;
	agents: string[];
	name: string;
};

describe("MISSION — get_mission grant-aware read (pilot, agents)", () => {
	it("scoped grantee named as pilot reads the mission — identity: alice", () => {
		const row: MissionRow = {
			_id: "mis_pilot",
			pilot: "alice",
			agents: ["bob"],
			name: "Alice-piloted mission",
		};
		expect(scopeFilterGet(aliceCtx(), row, ["pilot", "agents"])).toEqual(row);
	});

	it("scoped grantee named inside agents (not pilot) reads the mission — identity: alice", () => {
		const row: MissionRow = {
			_id: "mis_agent",
			pilot: "bob",
			agents: ["carol", "alice"],
			name: "Bob-piloted, Alice as agent",
		};
		expect(scopeFilterGet(aliceCtx(), row, ["pilot", "agents"])).toEqual(row);
	});

	it("scoped non-grantee (named nowhere) does NOT read the mission — identity: alice", () => {
		const row: MissionRow = {
			_id: "mis_other",
			pilot: "bob",
			agents: ["carol", "dave"],
			name: "No alice anywhere",
		};
		expect(scopeFilterGet(aliceCtx(), row, ["pilot", "agents"])).toBeNull();
	});

	it("regression: NOT declaring grantFields refuses even the named pilot — byte-identical to 0.4.0", () => {
		const row: MissionRow = {
			_id: "mis_pilot",
			pilot: "alice",
			agents: ["bob"],
			name: "Alice-piloted mission",
		};
		// pilot="alice" would pass if declared; omitting grantFields must
		// reproduce the pre-0.5.0 createdBy/namespace-only predicate exactly —
		// missions carry neither, so the pre-0.5.0 result is a hard refusal.
		expect(scopeFilterGet(aliceCtx(), row)).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// mandates — list_mandates / get_mandate slice. Rows mirror
// convex/mandates.ts (requestedBy: string, fulfilledBy: string). No
// createdBy/namespace field on this table either.
// ─────────────────────────────────────────────────────────────────────────────

type MandateRow = {
	_id: string;
	requestedBy: string;
	fulfilledBy: string;
	service: string;
};

const MANDATE_FIXTURE: MandateRow[] = [
	{ _id: "man_req", requestedBy: "alice", fulfilledBy: "bob", service: "seo" },
	{ _id: "man_ful", requestedBy: "bob", fulfilledBy: "alice", service: "dev" },
	{ _id: "man_none", requestedBy: "bob", fulfilledBy: "carol", service: "ads" },
];

describe("MANDATE — list_mandates/get_mandate grant-aware read (requestedBy, fulfilledBy)", () => {
	it("scoped grantee named as requestedBy reads the mandate — identity: alice", () => {
		expect(
			scopeFilterGet(aliceCtx(), MANDATE_FIXTURE[0], [
				"requestedBy",
				"fulfilledBy",
			]),
		).toEqual(MANDATE_FIXTURE[0]);
	});

	it("scoped grantee named as fulfilledBy (not requestedBy) reads the mandate — identity: alice", () => {
		expect(
			scopeFilterGet(aliceCtx(), MANDATE_FIXTURE[1], [
				"requestedBy",
				"fulfilledBy",
			]),
		).toEqual(MANDATE_FIXTURE[1]);
	});

	it("scoped non-grantee (named on neither side) does NOT read the mandate — identity: alice", () => {
		expect(
			scopeFilterGet(aliceCtx(), MANDATE_FIXTURE[2], [
				"requestedBy",
				"fulfilledBy",
			]),
		).toBeNull();
	});

	it("list_mandates: single grantFields-declared pass yields both grantee rows, drops the non-grantee — identity: alice", () => {
		const out = scopeFilterList(aliceCtx(), MANDATE_FIXTURE, [
			"requestedBy",
			"fulfilledBy",
		]);
		expect(out.map((r) => r._id).sort()).toEqual(["man_ful", "man_req"]);
	});

	it("regression: NOT declaring grantFields refuses every mandate row — byte-identical to 0.4.0", () => {
		const out = scopeFilterList(aliceCtx(), MANDATE_FIXTURE);
		expect(out).toEqual([]);
	});

	it("master scope still wildcards regardless of grantFields — identity: master", () => {
		const masterCtx: OAuthCtx = {
			scope: "master",
			fromAllowList: ["*"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
		};
		const out = scopeFilterList(masterCtx, MANDATE_FIXTURE, [
			"requestedBy",
			"fulfilledBy",
		]);
		expect(out).toHaveLength(MANDATE_FIXTURE.length);
	});
});
