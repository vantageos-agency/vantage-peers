/// <reference types="vite/client" />
/**
 * Agent identity is the `agents` ROW (`_id`), never the name string.
 *
 * Operator ruling (binding): (1) an agent is NOT distinguished by its name;
 * (2) one organisation cannot have two agents with the same name; (3) every
 * agent has a unique ID. The name is a label, unique within its org under
 * `normalizeOrchestratorId`; `agent_credentials.agentId` is the identity.
 *
 * POLES
 *   RENAME      a credential minted for an agent keeps resolving after the
 *               agent is renamed, and the write-surface lock accepts the NEW
 *               name and refuses the OLD one.
 *   ORG         org-a's credential never resolves to / acts for org-b's
 *               same-named agent.
 *   REVOKED     a rotated-out (isActive=false) credential still refuses after
 *               a rename.
 *   UNIQUENESS  `Clio` then `clio` in one org: second REFUSED (AGENT_NAME_TAKEN);
 *               `clio` + `victor` register; `clio` in two orgs registers.
 *   BACKFILL    dryRun writes nothing; real run sets agentId; a credential whose
 *               agent row is missing is COUNTED, never patched.
 *
 * MUTANT (run by hand, recorded in the dispatch report): make the uniqueness
 * check in `assertAgentNameFree` (convex/lib/agentIdentity.ts) global instead of
 * per-org; the "same name in two orgs" pole goes red.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { requireAgentCredentialMatch } from "../lib/auth";
import { sha256Hex } from "@vantageos/cloud-identity";
import { agentIdOf } from "../../tests/lib/agentIdOf";

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

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seedOrg(t: T, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["seat"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedProfile(t: T, orchestratorId: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			name: orchestratorId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

async function register(t: T, org: string, name: string): Promise<Id<"agents">> {
	return await adminOf(t, org).mutation(api.agents.registerAgent, {
		orgSlug: org,
		name,
	});
}

async function mint(t: T, org: string, agentName: string): Promise<string> {
	const minted = await adminOf(t, org).mutation(
		api.agentCredentials.mintAgentCredential,
		{ orgSlug: org, agentId: await agentIdOf(t, org, agentName) },
	);
	return minted.secret;
}

// A raw rename: what ANY future rename path (dashboard, migration, operator
// patch) does to the row. Deliberately NOT through renameAgent, so the RED run
// against the unmodified head measures the credential, not the new door.
async function rawRename(t: T, id: Id<"agents">, name: string) {
	await t.run(async (ctx) => {
		await ctx.db.patch(id, { name });
	});
}

// Neither proof carrier but a secret: today's direct-caller shape.
const NO_VERIFIED_ACTOR = {
	scope: { isMaster: false },
	verifiedActor: undefined,
} as const;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (e instanceof ConvexError) return String(e.data).replace(/^"/, "");
		return `NON_CONVEX_ERROR: ${String(e)}`;
	}
	return "NO_ERROR";
}

describe("RENAME — the credential follows the row", () => {
	test("a credential minted for an agent still resolves after the agent is renamed", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const id = await register(t, "org-a", "clio");
		const secret = await mint(t, "org-a", "clio");

		await rawRename(t, id, "calliope");

		const resolved = await asServiceAccount(t).query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: secret },
		);
		expect(resolved).toMatchObject({ orgSlug: "org-a", agentName: "calliope" });
	});

	test("the write-surface lock accepts the NEW name and refuses the OLD one after a rename", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "calliope");
		await seedProfile(t, "clio");
		await seedProfile(t, "recipient-role");
		const id = await register(t, "org-a", "clio");
		const secret = await mint(t, "org-a", "clio");
		await rawRename(t, id, "calliope");

		const ok = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "calliope",
			channel: "recipient-role",
			content: "as the renamed agent",
			agentCredentialSecret: secret,
		});
		expect(ok).toBeTruthy();

		const stale = await codeOf(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "clio",
				channel: "recipient-role",
				content: "as the OLD name",
				agentCredentialSecret: secret,
			}),
		);
		expect(stale).toMatch(/^AGENT_IDENTITY_MISMATCH/);
	});

	test("the credential row carries the agent's _id", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const id = await register(t, "org-a", "clio");
		await mint(t, "org-a", "clio");
		const rows = await t.run(async (ctx) => ctx.db.query("agent_credentials").collect());
		expect(rows).toHaveLength(1);
		expect(rows[0].agentId).toBe(id);
	});

	test("renameAgent (the door) keeps the credential working and refuses a taken name", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await register(t, "org-a", "clio");
		await register(t, "org-a", "victor");
		const secret = await mint(t, "org-a", "clio");

		const taken = await codeOf(
			adminOf(t, "org-a").mutation(api.agents.renameAgent, {
				orgSlug: "org-a",
				agentId: await agentIdOf(t, "org-a", "clio"),
				newName: "Victor",
			}),
		);
		expect(taken).toMatch(/^AGENT_NAME_TAKEN/);

		await adminOf(t, "org-a").mutation(api.agents.renameAgent, {
			orgSlug: "org-a",
			agentId: await agentIdOf(t, "org-a", "clio"),
			newName: "calliope",
		});
		const resolved = await asServiceAccount(t).query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: secret },
		);
		expect(resolved).toMatchObject({ orgSlug: "org-a", agentName: "calliope" });
	});
});

describe("ORG — one org's credential never acts for another org's same-named agent", () => {
	test("org-a's credential resolves to org-a's row, not org-b's same-named agent", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const idA = await register(t, "org-a", "clio");
		const idB = await register(t, "org-b", "clio");
		expect(idA).not.toBe(idB);
		const secretA = await mint(t, "org-a", "clio");

		const resolved = await asServiceAccount(t).query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: secretA },
		);
		expect(resolved).toMatchObject({ orgSlug: "org-a", agentName: "clio" });
		const rows = await t.run(async (ctx) => ctx.db.query("agent_credentials").collect());
		expect(rows).toHaveLength(1);
		expect(rows[0].agentId).toBe(idA);
	});

	test("the lock refuses org-a's credential at a call targeting org-b (same name), ORG_MISMATCH", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await register(t, "org-a", "clio");
		await register(t, "org-b", "clio");
		const secretA = await mint(t, "org-a", "clio");

		const code = await t.run(async (ctx) =>
			codeOf(requireAgentCredentialMatch(ctx, secretA, "clio", "org-b", NO_VERIFIED_ACTOR)),
		);
		expect(code).toMatch(/^ORG_MISMATCH/);
		const allowed = await t.run(async (ctx) =>
			codeOf(requireAgentCredentialMatch(ctx, secretA, "clio", "org-a", NO_VERIFIED_ACTOR)),
		);
		expect(allowed).toBe("NO_ERROR");
	});
});

describe("REVOKED — a rotated-out credential stays dead through a rename", () => {
	test("old secret refuses after rotation AND rename; the new secret works", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const id = await register(t, "org-a", "clio");
		const oldSecret = await mint(t, "org-a", "clio");
		const newSecret = await mint(t, "org-a", "clio"); // rotation
		await rawRename(t, id, "calliope");

		const svc = asServiceAccount(t);
		const dead = await codeOf(
			svc.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: oldSecret,
			}),
		);
		expect(dead).toMatch(/RBAC_DENIED/);
		const live = await svc.query(api.agentCredentials.resolveAgentCredential, {
			presentedSecret: newSecret,
		});
		expect(live.agentName).toBe("calliope");
	});

	test("revokeAgentCredential finds the agent's credentials by id after a rename", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const id = await register(t, "org-a", "clio");
		const secret = await mint(t, "org-a", "clio");
		await rawRename(t, id, "calliope");

		const res = await adminOf(t, "org-a").mutation(
			api.agentCredentials.revokeAgentCredential,
			{ orgSlug: "org-a", agentId: await agentIdOf(t, "org-a", "calliope") },
		);
		expect(res).toEqual({ revoked: 1 });
		const dead = await codeOf(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secret,
			}),
		);
		expect(dead).toMatch(/RBAC_DENIED/);
	});
});

describe("UNIQUENESS — a name is unique within its org, per normalizeOrchestratorId", () => {
	test("Clio then clio in one org: the second is REFUSED with AGENT_NAME_TAKEN", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await register(t, "org-a", "Clio");
		const code = await codeOf(register(t, "org-a", "clio"));
		expect(code).toMatch(/^AGENT_NAME_TAKEN/);
		const rows = await t.run(async (ctx) => ctx.db.query("agents").collect());
		expect(rows).toHaveLength(1);
	});

	test("registering the exact same name again is REFUSED naming the holder by id; the name never selects a row", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const first = await register(t, "org-a", "clio");
		const code = await codeOf(register(t, "org-a", "clio"));
		expect(code).toMatch(/^AGENT_NAME_TAKEN/);
		expect(code).toContain(first);
		const rows = await t.run(async (ctx) => ctx.db.query("agents").collect());
		expect(rows).toHaveLength(1);
	});

	test("clio and victor in one org both register", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const a = await register(t, "org-a", "clio");
		const b = await register(t, "org-a", "victor");
		expect(a).not.toBe(b);
	});

	test("clio in org-a and clio in org-b both register", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const a = await register(t, "org-a", "clio");
		const b = await register(t, "org-b", "Clio");
		expect(a).not.toBe(b);
	});

	test("a LEGACY row with no normalizedName still blocks a case variant", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await t.run(async (ctx) => {
			await ctx.db.insert("agents", {
				orgSlug: "org-a",
				name: "Clio",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		const code = await codeOf(register(t, "org-a", "clio"));
		expect(code).toMatch(/^AGENT_NAME_TAKEN/);
	});
});

describe("BACKFILL — agentId from (orgSlug, agentName), refusing never guessing", () => {
	async function legacyCredential(t: T, orgSlug: string, agentName: string) {
		return await t.run(async (ctx) =>
			ctx.db.insert("agent_credentials", {
				orgSlug,
				agentName,
				secretHash: `hash-${orgSlug}-${agentName}`,
				isActive: true,
				createdAt: Date.now(),
			}),
		);
	}

	test("dryRun reports and writes nothing; the real run sets agentId", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const id = await register(t, "org-a", "clio");
		const credId = await legacyCredential(t, "org-a", "clio");

		const dry = await t.mutation(
			internal.migrations.agentIdentityRows.backfillCredentialAgentIds,
			{ dryRun: true, cursor: null },
		);
		expect(dry).toMatchObject({ dryRun: true, scanned: 1, updated: 1, missingAgent: 0, ambiguous: 0 });
		expect((await t.run(async (ctx) => ctx.db.get(credId)))?.agentId).toBeUndefined();

		const real = await t.mutation(
			internal.migrations.agentIdentityRows.backfillCredentialAgentIds,
			{ dryRun: false, cursor: null },
		);
		expect(real).toMatchObject({ dryRun: false, updated: 1, missingAgent: 0 });
		expect((await t.run(async (ctx) => ctx.db.get(credId)))?.agentId).toBe(id);

		const again = await t.mutation(
			internal.migrations.agentIdentityRows.backfillCredentialAgentIds,
			{ dryRun: false, cursor: null },
		);
		expect(again).toMatchObject({ updated: 0, alreadySet: 1 });
	});

	test("a credential whose agent row is missing is counted, not patched", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const credId = await legacyCredential(t, "org-a", "ghost");
		const res = await t.mutation(
			internal.migrations.agentIdentityRows.backfillCredentialAgentIds,
			{ dryRun: false, cursor: null },
		);
		expect(res).toMatchObject({ updated: 0, missingAgent: 1, ambiguous: 0 });
		expect((await t.run(async (ctx) => ctx.db.get(credId)))?.agentId).toBeUndefined();
	});

	test("an ambiguous (orgSlug, agentName) is counted, not patched", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await t.run(async (ctx) => {
			for (let i = 0; i < 2; i++) {
				await ctx.db.insert("agents", {
					orgSlug: "org-a",
					name: "clio",
					isActive: true,
					createdAt: Date.now(),
				});
			}
		});
		const credId = await legacyCredential(t, "org-a", "clio");
		const res = await t.mutation(
			internal.migrations.agentIdentityRows.backfillCredentialAgentIds,
			{ dryRun: false, cursor: null },
		);
		expect(res).toMatchObject({ updated: 0, ambiguous: 1 });
		expect((await t.run(async (ctx) => ctx.db.get(credId)))?.agentId).toBeUndefined();
	});

	test("a legacy credential (no agentId) is REFUSED until the backfill binds it to its agent by id", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await register(t, "org-a", "clio");
		const secret = await mint(t, "org-a", "clio");
		await t.run(async (ctx) => {
			const row = (await ctx.db.query("agent_credentials").collect())[0];
			await ctx.db.patch(row._id, { agentId: undefined });
		});
		await expect(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secret,
			}),
		).rejects.toThrow(/credential-not-recognised/);
		await t.mutation(
			internal.migrations.agentIdentityRows.backfillCredentialAgentIds,
			{ dryRun: false, cursor: null },
		);
		const resolved = await asServiceAccount(t).query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: secret },
		);
		expect(resolved).toMatchObject({ orgSlug: "org-a", agentName: "clio" });
	});

	test("agent normalizedName backfill: sets it, and refuses a colliding pair", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const ids = await t.run(async (ctx) => {
			const solo = await ctx.db.insert("agents", {
				orgSlug: "org-a", name: "Victor", isActive: true, createdAt: 1,
			});
			const c1 = await ctx.db.insert("agents", {
				orgSlug: "org-b", name: "Clio", isActive: true, createdAt: 1,
			});
			const c2 = await ctx.db.insert("agents", {
				orgSlug: "org-b", name: "clio", isActive: true, createdAt: 2,
			});
			return { solo, c1, c2 };
		});
		const res = await t.mutation(
			internal.migrations.agentIdentityRows.backfillAgentNormalizedNames,
			{ dryRun: false, cursor: null },
		);
		expect(res).toMatchObject({ scanned: 3, updated: 1, collisions: 2 });
		const solo = await t.run(async (ctx) => ctx.db.get(ids.solo));
		expect(solo?.normalizedName).toBe("victor");
		const c1 = await t.run(async (ctx) => ctx.db.get(ids.c1));
		expect(c1?.normalizedName).toBeUndefined();
	});
});

describe("LEGACY credential (agentId undefined) is inert: a label never selects an agent", () => {
	// Pre-backfill prod shape: minted, then agentId stripped.
	async function legacyMint(t: T, org: string, name: string) {
		const secret = await mint(t, org, name);
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query("agent_credentials").collect()) {
				await ctx.db.patch(row._id, { agentId: undefined });
			}
		});
		return secret;
	}

	const resolveRefused = (t: T, secret: string) =>
		expect(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secret,
			}),
		).rejects.toThrow(/credential-not-recognised/);

	test("P1a: a legacy credential is refused before and after a rename, and the lock refuses it under either label", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "calliope");
		await seedProfile(t, "clio");
		await seedProfile(t, "recipient-role");
		await register(t, "org-a", "clio");
		const secret = await legacyMint(t, "org-a", "clio");
		await resolveRefused(t, secret);

		await adminOf(t, "org-a").mutation(api.agents.renameAgent, {
			orgSlug: "org-a",
			agentId: await agentIdOf(t, "org-a", "clio"),
			newName: "calliope",
		});
		await resolveRefused(t, secret);

		for (const from of ["calliope", "clio"]) {
			const code = await codeOf(
				asServiceAccount(t).mutation(api.messages.sendMessage, {
					from,
					channel: "recipient-role",
					content: "legacy cred",
					agentCredentialSecret: secret,
				}),
			);
			expect(code).toMatch(/^AGENT_IDENTITY_MISMATCH/);
		}
	});

	test("P1b: re-registering the old label makes a NEW row that does not inherit the legacy credential", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const oldId = await register(t, "org-a", "clio");
		const secret = await legacyMint(t, "org-a", "clio");
		await adminOf(t, "org-a").mutation(api.agents.renameAgent, {
			orgSlug: "org-a",
			agentId: oldId,
			newName: "calliope",
		});
		const newId = await register(t, "org-a", "clio");
		expect(newId).not.toBe(oldId);

		await resolveRefused(t, secret);
		const status = await adminOf(t, "org-a").query(
			api.agentCredentials.getAgentCredentialStatus,
			{ orgSlug: "org-a", agentId: newId },
		);
		expect(status.hasActiveCredential).toBe(false);
	});

	test("ORPHAN: a legacy credential whose agent row is gone does not block registering that label, and never resolves to the new agent", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const secret = "f0".repeat(32);
		await t.run(async (ctx) => {
			await ctx.db.insert("agent_credentials", {
				orgSlug: "org-a",
				agentName: "Clio",
				secretHash: await sha256Hex(secret),
				isActive: true,
				createdAt: Date.now(),
			});
		});
		const id = await register(t, "org-a", "clio");
		await resolveRefused(t, secret);
		const status = await adminOf(t, "org-a").query(
			api.agentCredentials.getAgentCredentialStatus,
			{ orgSlug: "org-a", agentId: id },
		);
		expect(status.hasActiveCredential).toBe(false);
	});
});
