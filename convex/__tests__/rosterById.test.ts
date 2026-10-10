/// <reference types="vite/client" />
//
// VantagePeers Cloud, module M1: client rosters are stored as AGENT IDs.
// Identity is the `agents` row `_id`, never a name; every roster decision goes
// through @vantageos/cloud-identity `assertPrincipalListed`.
//
// Every pole below runs under a SCOPED org identity (a Clerk member or admin of
// one client organisation), never as the master / service account, except the
// operator agent that READS the coordinator mail and the migration, which is an
// internal mutation.
//
// Poles:
//   ADMITTED     a listed agent ID is admitted.
//   REFUSED      a same-name agent of another org; an agent listed by NAME but
//                not by ID; an org with no ID roster at all; an unlisted
//                coordinator.
//   DIRECTORY    the coordinator ID comes from the STORED roster (the client
//                roster holds no "pi" name at all); a rename keeps every grant.
//   COORDINATOR  a client sender reaches a listed operator agent by ID and that
//                agent reads the mail.
//   BACKFILL     dry run lists ambiguous and unknown names by row id and writes
//                nothing; the write run is idempotent.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const OP = "fleet-op";
const C = "client-c";
const D = "client-d";
const E = "client-e";
const M = "client-m";
const NOW = 1_700_000_000_000;

const asMember = (t: T, org: string, role = "org:member") =>
	t.withIdentity({
		subject: `user-${org}-${role}`,
		organizationSlug: org,
		org_role: role,
	} as Identity);
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

type Ids = Record<string, Id<"agents">>;

async function world() {
	const t = createT();
	const ids: Ids = {};
	await t.run(async (ctx) => {
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		ids.opPi = await agent(OP, "pi");
		ids.opSigma = await agent(OP, "sigma");
		ids.cEve = await agent(C, "eve");
		ids.cAda = await agent(C, "ada");
		ids.dAda = await agent(D, "ada");
		ids.eEve = await agent(E, "eve");
		ids.eAda = await agent(E, "ada");
		ids.mEve = await agent(M, "eve");
		ids.mAda = await agent(M, "ada");
		const mapping = (
			clerkOrgSlug: string,
			allowedOrchestrators: string[],
			extra: Partial<Doc<"client_org_mapping">>,
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug,
				allowedOrchestrators,
				scopes: ["view-own-tasks"],
				displayName: clerkOrgSlug,
				isActive: true,
				createdAt: NOW,
				...extra,
			});
		await mapping(OP, ["pi", "sigma"], {
			orgKind: "operator",
			fleetWide: true,
			allowedAgentIds: [ids.opPi, ids.opSigma],
		});
		// "zed" is a roster NAME with no agents row: the scoped member sends as a
		// label that needs no per-agent credential. C: roster by ID; the legacy name list does NOT carry "pi" at all, so a
		// directory that finds the coordinator can only have read the stored ID.
		await mapping(C, ["eve", "ada", "zed"], {
			allowedAgentIds: [ids.cEve, ids.cAda],
			addressableFleetCoordinatorIds: [ids.opPi],
		});
		await mapping(D, ["ada"], { allowedAgentIds: [ids.dAda] });
		// E: "ada" is on the NAME roster but its ID is not on the ID roster.
		await mapping(E, ["eve", "ada", "zed"], { allowedAgentIds: [ids.eEve] });
		// M: names only, no ID roster stored at all.
		await mapping(M, ["eve", "ada", "zed"], {});
	});
	return { t, ids };
}

async function errorOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		if (typeof data === "string") return data;
		if (data !== undefined) return JSON.stringify(data);
		return String(e);
	}
	throw new Error("expected a refusal, the call succeeded");
}

const send = (t: T, org: string, from: string, ids: Id<"agents">[]) =>
	asMember(t, org).mutation(api.messages.sendMessage, {
		from,
		content: "hello",
		recipientAgentIds: ids,
	});

const receiptsOf = (t: T, messageId: Id<"messages">) =>
	t.run((ctx) =>
		ctx.db
			.query("messageReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", messageId))
			.collect(),
	);

describe("ADMITTED / REFUSED — a recipient is judged by the ID roster", () => {
	test("a listed agent ID is admitted (scoped member of client-c)", async () => {
		const { t, ids } = await world();
		const messageId = await send(t, C, "zed", [ids.cAda]);
		const receipts = await receiptsOf(t, messageId);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].recipientId).toBe(ids.cAda);
		expect(receipts[0].tenantId).toBe(C);
	});

	test("a same-name agent of another org is refused (client-d's ada from client-c)", async () => {
		const { t, ids } = await world();
		const refusal = await errorOf(send(t, C, "zed", [ids.dAda]));
		expect(refusal).toContain("recipient-agent-not-addressable");
	});

	test("an agent listed by NAME but not by ID is refused (client-e)", async () => {
		const { t, ids } = await world();
		const refusal = await errorOf(send(t, E, "zed", [ids.eAda]));
		expect(refusal).toContain("recipient-agent-not-addressable");
		// positive control: the ID that IS listed is admitted on the same door.
		const ok = await send(t, E, "zed", [ids.eEve]);
		expect((await receiptsOf(t, ok))[0].recipientId).toBe(ids.eEve);
	});

	test("an org with no ID roster at all refuses every recipient (client-m)", async () => {
		const { t, ids } = await world();
		const refusal = await errorOf(send(t, M, "zed", [ids.mAda]));
		expect(refusal).toContain("recipient-agent-not-addressable");
	});
});

describe("DIRECTORY / RENAME — the stored ID is the answer", () => {
	test("the coordinator ID is returned from the stored roster, with no name lookup", async () => {
		const { t, ids } = await world();
		const dir = await asMember(t, C).query(
			api.orgRoster.getMyAgentDirectory,
			{},
		);
		expect(dir.find((e) => e.name === "ada")?.agentId).toBe(ids.cAda);
		expect(dir.find((e) => e.name === "eve")?.agentId).toBe(ids.cEve);
		expect(dir.find((e) => e.name === "pi")?.agentId).toBe(ids.opPi);
		// an operator agent NOT stored as a coordinator is not in the directory.
		expect(dir.find((e) => e.agentId === ids.opSigma)).toBeUndefined();
	});

	test("a rename keeps every grant: the ID stays listed, addressable and in the directory", async () => {
		const { t, ids } = await world();
		await asMember(t, C, "org:admin").mutation(api.agents.renameAgent, {
			orgSlug: C,
			agentId: ids.cAda,
			newName: "ada2",
		});
		const mapping = await t.run(async (ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", C))
				.first(),
		);
		expect(mapping?.allowedAgentIds).toEqual([ids.cEve, ids.cAda]);
		const dir = await asMember(t, C).query(
			api.orgRoster.getMyAgentDirectory,
			{},
		);
		expect(dir.find((e) => e.agentId === ids.cAda)?.name).toBe("ada2");
		const messageId = await send(t, C, "zed", [ids.cAda]);
		expect((await receiptsOf(t, messageId))[0].recipientId).toBe(ids.cAda);
	});
});

describe("COORDINATOR — a listed operator agent is reached and reads by ID", () => {
	test("client-c reaches operator pi by ID; pi reads it; an unlisted operator agent is refused", async () => {
		const { t, ids } = await world();
		const messageId = await send(t, C, "zed", [ids.opPi]);
		const receipts = await receiptsOf(t, messageId);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].recipientId).toBe(ids.opPi);
		expect(receipts[0].tenantId).toBe(C);
		const inbox = await asService(t).query(
			api.messages.checkNewMessagesEnvelope,
			{
				verifiedActor: { agentId: ids.opPi, orgSlug: OP },
			},
		);
		expect(inbox.messages.map((m) => m.messageId)).toEqual([messageId]);
		const refusal = await errorOf(send(t, C, "zed", [ids.opSigma]));
		expect(refusal).toContain("recipient-agent-not-addressable");
	});
});

describe("BACKFILL — names become IDs inside one org, nothing is guessed", () => {
	async function backfillWorld() {
		const { t, ids } = await world();
		const extra: Ids = {};
		const rows: Record<string, Id<"client_org_mapping">> = {};
		await t.run(async (ctx) => {
			const agent = (orgSlug: string, name: string, normalized?: string) =>
				ctx.db.insert("agents", {
					orgSlug,
					name,
					normalizedName: normalized ?? normalizeOrchestratorId(name),
					isActive: true,
					createdAt: NOW,
				});
			const B = "client-b";
			extra.bEve = await agent(B, "eve");
			extra.bAda = await agent(B, "Ada");
			// a legacy duplicate: two rows whose labels normalise to "twin".
			extra.bTwin1 = await agent(B, "twin");
			extra.bTwin2 = await agent(B, "Twin");
			// "ghost" exists only in ANOTHER org: it must never be resolved for B.
			extra.cGhost = await agent(C, "ghost");
			rows.b = await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: B,
				allowedOrchestrators: ["eve", "ada", "ghost", "twin"],
				addressableFleetCoordinators: ["pi", "nobody"],
				scopes: ["view-own-tasks"],
				displayName: B,
				isActive: true,
				createdAt: NOW,
			});
			rows.star = await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "star-org",
				allowedOrchestrators: ["*"],
				scopes: ["view-own-tasks"],
				displayName: "star",
				isActive: true,
				createdAt: NOW,
			});
		});
		const snapshot = () =>
			t.run((ctx) => ctx.db.query("client_org_mapping").collect());
		return { t, ids, extra, rows, snapshot };
	}

	test("the dry run lists ambiguous and unknown names by row id and writes nothing", async () => {
		const { t, ids, extra, rows, snapshot } = await backfillWorld();
		const before = await snapshot();
		const report = await t.mutation(
			internal.migrations.backfillRosterAgentIds.backfillRosterAgentIds,
			{},
		);
		expect(report.dryRun).toBe(true);
		// ghost + nobody (client-b) and the sender label "zed" of C, E and M, which
		// no agents row carries.
		expect(report.unknown).toHaveLength(5);
		expect(report.unknown).toEqual(
			expect.arrayContaining([
				{
					rowId: rows.b,
					clerkOrgSlug: "client-b",
					field: "allowedOrchestrators",
					name: "ghost",
				},
				{
					rowId: rows.b,
					clerkOrgSlug: "client-b",
					field: "addressableFleetCoordinators",
					name: "nobody",
				},
			]),
		);
		expect(report.ambiguous).toEqual([
			{
				rowId: rows.b,
				clerkOrgSlug: "client-b",
				field: "allowedOrchestrators",
				name: "twin",
				candidates: 2,
			},
		]);
		expect(report.wouldPatch).toBeGreaterThan(0);
		expect(report.patched).toBe(0);
		expect(await snapshot()).toEqual(before);
		// not guessed: the ghost in client-c and the twins are in no stored list.
		expect(JSON.stringify(report)).not.toContain(extra.cGhost);
		expect(ids.opPi).toBeDefined();
	});

	test("the write run stores IDs, the coordinator ID and the fleet flag; a second run changes nothing", async () => {
		const { t, ids, extra, rows, snapshot } = await backfillWorld();
		const first = await t.mutation(
			internal.migrations.backfillRosterAgentIds.backfillRosterAgentIds,
			{ dryRun: false },
		);
		expect(first.dryRun).toBe(false);
		// client-b, star-org and client-m (the only rows with no stored ID roster).
		expect(first.patched).toBe(3);
		const m = await t.run(async (ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", M))
				.first(),
		);
		expect(m?.allowedAgentIds).toEqual([ids.mEve, ids.mAda]);
		const b = await t.run((ctx) => ctx.db.get(rows.b));
		expect(b?.allowedAgentIds).toEqual([extra.bEve, extra.bAda]);
		expect(b?.addressableFleetCoordinatorIds).toEqual([ids.opPi]);
		expect(b?.fleetWide).toBeUndefined();
		const star = await t.run((ctx) => ctx.db.get(rows.star));
		expect(star?.fleetWide).toBe(true);
		const afterFirst = await snapshot();
		const second = await t.mutation(
			internal.migrations.backfillRosterAgentIds.backfillRosterAgentIds,
			{ dryRun: false },
		);
		expect(second.patched).toBe(0);
		expect(await snapshot()).toEqual(afterFirst);
		// the unresolved names are still reported, never silently dropped.
		expect(second.unknown.length).toBeGreaterThan(0);
		expect(second.ambiguous).toHaveLength(1);
	});
});

describe("WRITERS — a new org's roster is written as agent IDs", () => {
	beforeEach(() => {
		vi.stubEnv("BEARER_SECRET_MASTER", "test-master-token");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("provisionOrganization stores the seats' agent IDs, in order, each stamped with the new org", async () => {
		const t = createT();
		await t.mutation(api.oauth.provisionOrganization, {
			callerToken: "test-master-token",
			clerkOrgSlug: "plan-org-ids",
			displayName: "Plan org ids",
			orchestrators: [{ name: "orch-a" }, { name: "orch-b" }],
		});
		const mapping = await t.run((ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "plan-org-ids"))
				.unique(),
		);
		const roster = mapping?.allowedAgentIds ?? [];
		expect(roster).toHaveLength(2);
		const rows = await Promise.all(
			roster.map((id) => t.run((ctx) => ctx.db.get(id))),
		);
		expect(rows.map((r) => [r?.name, r?.orgSlug, r?.isActive])).toEqual([
			["orch-a", "plan-org-ids", true],
			["orch-b", "plan-org-ids", true],
		]);
		// the legacy label roster is still written beside the IDs (expand phase).
		expect(mapping?.allowedOrchestrators).toEqual(["orch-a", "orch-b"]);
	});

	test("a seat registered ahead of provisioning is reused, never duplicated", async () => {
		const t = createT();
		const ahead = await t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: "plan-org-reuse",
				name: "orch-a",
				normalizedName: "orch-a",
				isActive: true,
				createdAt: NOW,
			}),
		);
		await t.mutation(api.oauth.provisionOrganization, {
			callerToken: "test-master-token",
			clerkOrgSlug: "plan-org-reuse",
			displayName: "Plan org reuse",
			orchestrators: [{ name: "orch-a" }, { name: "orch-b" }],
		});
		const mapping = await t.run((ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) =>
					q.eq("clerkOrgSlug", "plan-org-reuse"),
				)
				.unique(),
		);
		expect(mapping?.allowedAgentIds?.[0]).toBe(ahead);
		expect(mapping?.allowedAgentIds).toHaveLength(2);
		const all = await t.run((ctx) =>
			ctx.db
				.query("agents")
				.withIndex("by_org", (q) => q.eq("orgSlug", "plan-org-reuse"))
				.collect(),
		);
		expect(all).toHaveLength(2);
	});
});
