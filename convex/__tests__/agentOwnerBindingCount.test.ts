/// <reference types="vite/client" />
//
// migrations/agentOwnerBinding:count -- NUMBERS-ONLY, read-only count of the owner binding of the
// agents of ONE organisation. Task k176v7x1xr5shra8j3d8v4rp718hs4n2.
//
// Why. The MCP refuses an agent credential (AGENT_CREDENTIAL_INVALID) when the agent has no live
// member owner. This door says, for one org, how many agents are in each state so an operator
// can tell WHICH refusal applies without reading a single row. It names no id, no label, no
// email, no secret: every field of the answer is a number or a boolean.

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const A = "owner-count-org-a";
const B = "owner-count-org-b";
const EMPTY = "owner-count-org-empty";

type Seed = {
	name: string;
	isActive?: boolean;
	owner?: string;
	stamped?: boolean;
	member?: "live" | "tombstoned" | "none";
	credentials?: boolean[]; // one entry per credential row: its isActive
};

async function seedOrg(t: T, slug: string, rows: Seed[]) {
	await t.run(async (ctx) => {
		const orgId = testClerkOrgId(slug);
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: orgId,
			allowedOrchestrators: [],
			scopes: ["vantage:read", "vantage:write"],
			displayName: slug,
			isActive: true,
			createdAt: 1,
		});
		for (const r of rows) {
			const agentId: Id<"agents"> = await ctx.db.insert("agents", {
				orgSlug: slug,
				...(r.stamped === false ? {} : { clerkOrgId: orgId }),
				name: r.name,
				...(r.owner === undefined ? {} : { ownerPersonId: r.owner }),
				isActive: r.isActive ?? true,
				createdAt: 1,
			});
			if (r.owner !== undefined && (r.member ?? "none") !== "none") {
				await ctx.db.insert("orgMembership", {
					clerkOrgSlug: slug,
					clerkOrgId: orgId,
					clerkUserId: r.owner,
					role: "member",
					createdAt: 1,
					updatedAt: 1,
					...(r.member === "tombstoned" ? { deletedAt: 2 } : {}),
				});
			}
			for (const [i, active] of (r.credentials ?? []).entries()) {
				await ctx.db.insert("agent_credentials", {
					orgSlug: slug,
					clerkOrgId: orgId,
					agentId,
					agentName: r.name,
					secretHash: `hash-${slug}-${r.name}-${i}`,
					isActive: active,
					createdAt: 1,
				});
			}
		}
	});
}

const count = (t: T, orgSlug: string) =>
	t.query(internal.migrations.agentOwnerBinding.count, { orgSlug });

async function seedAll(): Promise<T> {
	const t = createT();
	await seedOrg(t, A, [
		// live member owner, one active and one rotated-out credential
		{ name: "live", owner: "user_live", member: "live", credentials: [true, false] },
		// no owner at all
		{ name: "no-owner", credentials: [true] },
		// owner but the agent row carries no permanent org id
		{ name: "unstamped", owner: "user_unstamped", member: "live", stamped: false },
		// retired agent whose owner is a live member
		{ name: "retired", owner: "user_retired", member: "live", isActive: false, credentials: [true] },
		// owner who is not a member of the org at all
		{ name: "stranger", owner: "user_stranger", member: "none" },
		// owner whose membership was tombstoned
		{ name: "left", owner: "user_left", member: "tombstoned" },
	]);
	// another org, fully bound: never counted for A
	await seedOrg(t, B, [
		{ name: "b-live", owner: "user_b", member: "live", credentials: [true, true] },
	]);
	return t;
}

describe("migrations/agentOwnerBinding:count", () => {
	test("exact numbers for an org with an agent in every state", async () => {
		const t = await seedAll();
		expect(await count(t, A)).toEqual({
			agents: 6,
			activeAgents: 5,
			withOwnerPersonId: 5,
			withClerkOrgId: 5,
			ownerIsLiveMember: 1,
			activeCredentials: 3,
			truncated: false,
		});
	});

	test("another org's agents are never counted, in either direction", async () => {
		const t = await seedAll();
		expect(await count(t, B)).toEqual({
			agents: 1,
			activeAgents: 1,
			withOwnerPersonId: 1,
			withClerkOrgId: 1,
			ownerIsLiveMember: 1,
			activeCredentials: 2,
			truncated: false,
		});
	});

	test("an org with no agent is zeros, a real answer", async () => {
		const t = await seedAll();
		expect(await count(t, EMPTY)).toEqual({
			agents: 0,
			activeAgents: 0,
			withOwnerPersonId: 0,
			withClerkOrgId: 0,
			ownerIsLiveMember: 0,
			activeCredentials: 0,
			truncated: false,
		});
	});

	test("the answer holds numbers and booleans only: no id, label, email or secret", async () => {
		const t = await seedAll();
		const out = (await count(t, A)) as Record<string, unknown>;
		for (const [key, value] of Object.entries(out)) {
			expect(
				["number", "boolean"].includes(typeof value) || value === null,
				`field ${key}`,
			).toBe(true);
		}
		const text = JSON.stringify(out);
		for (const secret of ["user_live", "no-owner", "hash-", "org_", A]) {
			expect(text).not.toContain(secret);
		}
	});

	test("an empty org slug is refused, not answered as an empty org", async () => {
		const t = await seedAll();
		await expect(count(t, "   ")).rejects.toThrow();
	});
});
