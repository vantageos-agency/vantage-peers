/// <reference types="vite/client" />
/**
 * The two remaining doors that resolve a presented agent secret apply the same
 * OWNER check as `agentCredentials:resolveAgentCredential` (PR #1547).
 *
 * VantagePeers Cloud (multi-tenant). Task k1778c2hvae8e8vz9f5bbbbbb98g62hw, item 4b
 * follow-up demanded by Eta's #1547 verdict.
 *
 * Doors:
 *   1. lib/auth.ts `requireAgentCredentialMatch`  (reached via tasks:create, the
 *      public mutation that calls it). Refusal shape unchanged: ConvexError
 *      AGENT_IDENTITY_MISMATCH, with the reason now in the JSON payload.
 *   2. lib/taskActors.ts `callerActorOf`           (its only caller,
 *      tasks.ts requireTaskCaller, runs the lock of door 1 first, so the secret
 *      branch is not separately reachable through a public mutation: it is
 *      driven directly with a real ctx). Refusal shape unchanged: undefined.
 *
 * POLES, per door:
 *   PRESENT          owner set + live orgMembership          -> accepted
 *   REFUSED owner    agent without ownerPersonId             -> refused (owner-missing)
 *   REFUSED member   owner set, no membership row            -> refused (agent-owner-not-member)
 *   REFUSED tombstone membership row with deletedAt          -> refused (agent-owner-not-member)
 */
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { ownAgent, ownerOf, tombstoneOwnerMembership } from "../../tests/lib/ownAgent";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { callerActorOf } from "../lib/taskActors";
import type { OrgScope } from "../lib/auth";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const ORG = "org-o";

async function seedOrg(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			allowedOrchestrators: ["b"],
			scopes: ["view-own-tasks"],
			displayName: ORG,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const adminOf = (t: T) =>
	t.withIdentity({
		subject: `admin-of-${ORG}`,
		org_slug: ORG,
		org_id: testClerkOrgId(ORG),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

/** An org with agent "b" and its minted secret; NO owner yet. */
async function mintUnowned(t: T): Promise<string> {
	await seedFleetAgents(t, ["b"]);
	await seedOrg(t);
	await adminOf(t).mutation(api.agents.registerAgent, { orgSlug: ORG, name: "b" });
	const minted = await adminOf(t).mutation(
		api.agentCredentials.mintAgentCredential,
		{ orgSlug: ORG, agentId: await agentIdOf(t, ORG, "b") },
	);
	return minted.secret;
}

async function setOwnerWithoutMembership(t: T) {
	const id = await agentIdOf(t, ORG, "b");
	await t.run(async (ctx) => {
		await ctx.db.patch(id, { ownerPersonId: ownerOf(ORG) });
	});
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data : String(e);
	}
	throw new Error("expected a refusal, got a success");
}

function expectLockRefused(text: string, reason: string) {
	expect(text).toContain("AGENT_IDENTITY_MISMATCH");
	expect(text).toMatch(new RegExp(`reason\\\\*":\\\\*"${reason}`));
}

const createAsB = (t: T, secret: string) =>
	asServiceAccount(t).mutation(api.tasks.create, {
		title: "created by b",
		assignedTo: "b",
		priority: "medium",
		status: "todo",
		createdBy: "b",
		agentCredentialSecret: secret,
	});

const actorOf = (t: T, secret: string) =>
	t.run((ctx) =>
		callerActorOf(ctx, {} as unknown as OrgScope, "b", {
			agentCredentialSecret: secret,
		}),
	);

describe("requireAgentCredentialMatch (via tasks:create) — owner check", () => {
	test("PRESENT: owned agent with a live membership is accepted", async () => {
		const t = createT();
		const secret = await mintUnowned(t);
		await ownAgent(t, ORG, "b");
		expect(await createAsB(t, secret)).toBeTruthy();
	});

	test("REFUSED owner missing", async () => {
		const t = createT();
		const secret = await mintUnowned(t);
		expectLockRefused(await refusalOf(createAsB(t, secret)), "owner-missing");
	});

	test("REFUSED owner not a member", async () => {
		const t = createT();
		const secret = await mintUnowned(t);
		await setOwnerWithoutMembership(t);
		expectLockRefused(
			await refusalOf(createAsB(t, secret)),
			"agent-owner-not-member",
		);
	});

	test("REFUSED tombstoned membership", async () => {
		const t = createT();
		const secret = await mintUnowned(t);
		await ownAgent(t, ORG, "b");
		expect(await createAsB(t, secret)).toBeTruthy();
		await tombstoneOwnerMembership(t, ORG, 5);
		expectLockRefused(
			await refusalOf(createAsB(t, secret)),
			"agent-owner-not-member",
		);
	});

	test("UNCHANGED: an unrecognised secret keeps AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await mintUnowned(t);
		await expect(createAsB(t, "not-a-secret")).rejects.toThrow(
			/AGENT_IDENTITY_MISMATCH/,
		);
	});
});

describe("callerActorOf — owner check", () => {
	test("PRESENT: owned agent with a live membership resolves to its actor", async () => {
		const t = createT();
		const secret = await mintUnowned(t);
		await ownAgent(t, ORG, "b");
		expect(await actorOf(t, secret)).toEqual({
			id: await agentIdOf(t, ORG, "b"),
			orgSlug: ORG,
		});
	});

	test("REFUSED owner missing: undefined", async () => {
		const t = createT();
		const secret = await mintUnowned(t);
		expect(await actorOf(t, secret)).toBeUndefined();
	});

	test("REFUSED owner not a member: undefined", async () => {
		const t = createT();
		const secret = await mintUnowned(t);
		await setOwnerWithoutMembership(t);
		expect(await actorOf(t, secret)).toBeUndefined();
	});

	test("REFUSED tombstoned membership: undefined", async () => {
		const t = createT();
		const secret = await mintUnowned(t);
		await ownAgent(t, ORG, "b");
		expect(await actorOf(t, secret)).toBeDefined();
		await tombstoneOwnerMembership(t, ORG, 5);
		expect(await actorOf(t, secret)).toBeUndefined();
	});
});
