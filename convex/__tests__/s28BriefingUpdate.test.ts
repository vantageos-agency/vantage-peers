/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17esvscdrzgmx6ef40n3nyj4s8k009s (mcp-server-standard
// S-28 / S-35: the door decides inside the write).
//
// briefingNotes:update ran a seat's service-account call as master and left the
// MCP to check the note's organisation first. It now takes `verifiedOrg`
// (believed from the fleet service account only) and answers the claim as a
// member of that organisation is answered: the note is reachable only when it
// belongs to the verified org.
//
// Poles:
//   OWN        service account + verifiedOrg of the note's org + its author -> updated
//   FOREIGN    verifiedOrg of another active org -> RBAC_DENIED, note unchanged
//   UNCHANGED  service account, no claim -> as before (expand only)
//   REFUSED    a non-service caller presenting verifiedOrg -> RBAC_DENIED
//   INACTIVE   a claim naming an inactive org -> RBAC_DENIED

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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
const A_SLUG = "s28-a";
const B_SLUG = "s28-b";
const D_SLUG = "s28-dead";
const A_ID = testClerkOrgId(A_SLUG);
const B_ID = testClerkOrgId(B_SLUG);
const D_ID = testClerkOrgId(D_SLUG);
const claimA = { orgSlug: A_SLUG, orgId: A_ID };
const claimB = { orgSlug: B_SLUG, orgId: B_ID };
const claimDead = { orgSlug: D_SLUG, orgId: D_ID };

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const memberOf = (t: T, slug: string) =>
	t.withIdentity({
		subject: `member-of-${slug}`,
		org_slug: slug,
		org_id: testClerkOrgId(slug),
		org_role: "org:admin",
	} as Identity);

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return `${(e as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	}
	return "NO-REFUSAL";
}

async function world() {
	const t = createT();
	const ids: Record<string, Id<"agents">> = {};
	let noteA = "" as Id<"briefingNotes">;
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
		ids.ada = await agent(A_SLUG, A_ID, "ada");
		ids.bob = await agent(B_SLUG, B_ID, "bob");
		const org = (
			slug: string,
			id: string,
			roster: string[],
			agentIds: Id<"agents">[],
			isActive: boolean,
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: roster,
				allowedAgentIds: agentIds,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive,
				createdAt: NOW,
			});
		await org(A_SLUG, A_ID, ["ada"], [ids.ada], true);
		await org(B_SLUG, B_ID, ["bob"], [ids.bob], true);
		await org(D_SLUG, D_ID, ["dan"], [], false);
		noteA = await ctx.db.insert("briefingNotes", {
			title: "note of A",
			topic: "handoff",
			participants: ["ada"],
			content: "a secret of A",
			createdBy: "ada",
			createdById: ids.ada,
			participantIds: [ids.ada],
			createdAt: 1,
			orgId: A_SLUG,
			clerkOrgId: A_ID,
		});
	});
	return { t, ids, noteA };
}

const titleOf = (t: T, id: Id<"briefingNotes">) =>
	t.run(async (ctx) => (await ctx.db.get(id))?.title);

describe("briefingNotes:update applies the verified org inside the write", () => {
	test("OWN: verifiedOrg A and the author update A's note", async () => {
		const { t, ids, noteA } = await world();
		await asService(t).mutation(api.briefingNotes.update, {
			noteId: noteA,
			callerOrchestrator: "ada",
			verifiedActor: { agentId: ids.ada, orgSlug: A_SLUG },
			verifiedOrg: claimA,
			title: "renamed by ada",
		});
		expect(await titleOf(t, noteA)).toBe("renamed by ada");
	});

	test("FOREIGN: verifiedOrg B cannot update A's note (RBAC_DENIED, note unchanged)", async () => {
		const { t, ids, noteA } = await world();
		const out = await codeOf(
			asService(t).mutation(api.briefingNotes.update, {
				noteId: noteA,
				callerOrchestrator: "bob",
				verifiedActor: { agentId: ids.bob, orgSlug: B_SLUG },
				verifiedOrg: claimB,
				title: "hijacked",
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(await titleOf(t, noteA)).toBe("note of A");
	});

	test("FOREIGN: verifiedOrg B beside the author's proof of A is refused too", async () => {
		const { t, ids, noteA } = await world();
		const out = await codeOf(
			asService(t).mutation(api.briefingNotes.update, {
				noteId: noteA,
				callerOrchestrator: "ada",
				verifiedActor: { agentId: ids.ada, orgSlug: A_SLUG },
				verifiedOrg: claimB,
				title: "hijacked",
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(await titleOf(t, noteA)).toBe("note of A");
	});

	test("UNCHANGED: the service account with no claim updates as before", async () => {
		const { t, ids, noteA } = await world();
		await asService(t).mutation(api.briefingNotes.update, {
			noteId: noteA,
			callerOrchestrator: "ada",
			verifiedActor: { agentId: ids.ada, orgSlug: A_SLUG },
			title: "renamed unclaimed",
		});
		expect(await titleOf(t, noteA)).toBe("renamed unclaimed");
	});

	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t, noteA } = await world();
		const out = await codeOf(
			memberOf(t, A_SLUG).mutation(api.briefingNotes.update, {
				noteId: noteA,
				verifiedOrg: claimA,
				title: "forged claim",
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
		expect(await titleOf(t, noteA)).toBe("note of A");
	});

	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t, ids, noteA } = await world();
		const out = await codeOf(
			asService(t).mutation(api.briefingNotes.update, {
				noteId: noteA,
				callerOrchestrator: "ada",
				verifiedActor: { agentId: ids.ada, orgSlug: A_SLUG },
				verifiedOrg: claimDead,
				title: "dead org",
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
		expect(await titleOf(t, noteA)).toBe("note of A");
	});
});
