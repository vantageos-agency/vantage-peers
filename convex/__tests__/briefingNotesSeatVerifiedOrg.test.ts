/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud: a briefing note written through a one-agent SEAT token is
// stamped with the seat's VERIFIED organisation, so the seat reads its own note.
//
// Defect (prod, 2026-10-13): a seat reaches Convex as the fleet service account,
// so `withOrgScope` resolves master with no organisation and `create` stored the
// note fleet-owned (no orgId, no clerkOrgId). The seat's own get/list then ran
// under its member scope and could not see it. The transport's `verifiedOrg` is
// now an input of the write (believed from the service account only).
//
// REFUSED  another org's seat never reads the note; a member naming a
//          verifiedOrg by argument is refused; an inactive org is refused.
// PRESENT  the seat reads its note back (get, list); the row carries the org ID.
// ABSENT   the fleet master (no verifiedOrg) keeps writing fleet-owned notes.

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const NOW = 1_700_000_000_000;
const A_ID = "org_SEATA1";
const B_ID = "org_SEATB1";
const OFF_ID = "org_OFF1";

const asMaster = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, slug: string, orgId: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationSlug: slug,
		org_id: orgId,
		org_role: "org:admin",
	} as Identity);

async function world() {
	const t = createT();
	const ids: Record<string, Id<"agents">> = {};
	await t.run(async (ctx) => {
		const agent = (orgSlug: string, clerkOrgId: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		ids.aSeat = await agent("org-a", A_ID, "seat-a");
		ids.bSeat = await agent("org-b", B_ID, "seat-b");
		const mapping = (
			clerkOrgSlug: string,
			clerkOrgId: string,
			allowedOrchestrators: string[],
			allowedAgentIds: Id<"agents">[],
			isActive = true,
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug,
				clerkOrgId,
				allowedOrchestrators,
				allowedAgentIds,
				scopes: ["view-own-tasks"],
				displayName: clerkOrgSlug,
				isActive,
				createdAt: NOW,
			});
		await mapping("org-a", A_ID, ["seat-a"], [ids.aSeat]);
		await mapping("org-b", B_ID, ["seat-b"], [ids.bSeat]);
		await mapping("org-off", OFF_ID, [], [], false);
	});
	return { t, ids };
}

const seatWrite = (
	ids: Record<string, Id<"agents">>,
	which: "aSeat" | "bSeat",
	orgSlug: string,
) => ({
	title: `note of ${orgSlug}`,
	topic: "handoff",
	participants: [which === "aSeat" ? "seat-a" : "seat-b"],
	content: `content of ${orgSlug}`,
	createdBy: which === "aSeat" ? "seat-a" : "seat-b",
	verifiedActor: { agentId: ids[which], orgSlug },
	verifiedOrg: { orgSlug },
});

describe("briefingNotes.create carries the seat's verified org", () => {
	test("PRESENT: the seat reads its own note back (get and list); the row is org-stamped", async () => {
		const { t, ids } = await world();
		const m = asMaster(t);
		const id = await m.mutation(
			api.briefingNotes.create,
			seatWrite(ids, "aSeat", "org-a"),
		);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.orgId).toBe("org-a");
		expect(row?.clerkOrgId).toBe(A_ID);
		expect(row?.createdById).toBe(ids.aSeat);

		const verifiedOrg = { orgSlug: "org-a" };
		const got = await m.query(api.briefingNotes.get, {
			noteId: id,
			master: false,
			callerIdentities: ["seat-a"],
			verifiedOrg,
		});
		expect(got?._id).toBe(id);
		const listed = await m.query(api.briefingNotes.list, {
			limit: 50,
			verifiedOrg,
		});
		const items = Array.isArray(listed) ? listed : listed.items;
		expect(items.map((n) => n._id)).toEqual([id]);
	});

	test("REFUSED: another org's seat cannot read the note", async () => {
		const { t, ids } = await world();
		const m = asMaster(t);
		const id = await m.mutation(
			api.briefingNotes.create,
			seatWrite(ids, "aSeat", "org-a"),
		);
		const verifiedOrg = { orgSlug: "org-b" };
		expect(
			await m.query(api.briefingNotes.get, {
				noteId: id,
				master: false,
				callerIdentities: ["seat-b"],
				verifiedOrg,
			}),
		).toBeNull();
		const listed = await m.query(api.briefingNotes.list, {
			limit: 50,
			verifiedOrg,
		});
		const items = Array.isArray(listed) ? listed : listed.items;
		expect(items).toEqual([]);
	});

	test("REFUSED: a member cannot name a verifiedOrg by argument", async () => {
		const { t, ids } = await world();
		await expect(
			asMember(t, "org-a", A_ID).mutation(
				api.briefingNotes.create,
				seatWrite(ids, "aSeat", "org-a"),
			),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("REFUSED: a verifiedOrg that names an inactive organisation", async () => {
		const { t, ids } = await world();
		await expect(
			asMaster(t).mutation(api.briefingNotes.create, {
				...seatWrite(ids, "aSeat", "org-a"),
				verifiedOrg: { orgSlug: "org-off" },
			}),
		).rejects.toThrow(/RBAC_DENIED.*org-not-active/s);
	});

	test("ABSENT: the fleet master without verifiedOrg still writes a fleet-owned note", async () => {
		const { t } = await world();
		const m = asMaster(t);
		const id = await m.mutation(api.briefingNotes.create, {
			title: "fleet note",
			topic: "handoff",
			participants: ["pi"],
			content: "fleet content",
			createdBy: "pi",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.orgId).toBeUndefined();
		expect(row?.clerkOrgId).toBeUndefined();
		const got = await m.query(api.briefingNotes.get, { noteId: id });
		expect(got?._id).toBe(id);
	});
});
