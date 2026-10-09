/// <reference types="vite/client" />
/**
 * `agentCredentials:resolveAgentCredential` refuses a wrong secret WITH A CODE.
 *
 * VantagePeers Cloud (multi-tenant). Rule: .claude/rules/refusal-is-distinguishable-from-absence.md
 *
 * Before: a wrong secret returned `null` — the same bytes as "no such credential".
 * Now, four outcomes that are textually pairwise different:
 *   RESOLVED          -> { orgSlug, agentName }
 *   ABSENT (nothing presented, empty secret) -> RAISES RBAC_DENIED reason "no-credential"
 *   WRONG (unknown / rotated-out)            -> RAISES RBAC_DENIED reason "credential-not-recognised"
 *   LEGITIMATE ABSENCE (agent has no credential, asked by its org-admin)
 *                     -> plain SUCCESS { hasActiveCredential: false }
 *
 * Identities: `admin-of-<org>` (org:admin) mints/asks; the credential holder
 * presents only a secret (no identity). None is master.
 *
 * DELETION PROBE (run manually, not committed): make `resolveAgentCredential`
 * return `null` instead of calling `refuseUnresolvedCredential` (the pre-fix
 * shape) and the WRONG and ABSENT poles go RED.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { agentIdOf, findAgentId } from "../../tests/lib/agentIdOf";

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

async function seedOrg(t: T, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["b"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

async function register(t: T, org: string, name: string) {
	// A label is registered once; a second call is refused AGENT_NAME_TAKEN.
	if ((await findAgentId(t, org, name)) !== null) return;
	await adminOf(t, org).mutation(api.agents.registerAgent, {
		orgSlug: org,
		name,
	});
}

async function mint(t: T, org: string, name: string): Promise<string> {
	await register(t, org, name);
	const minted = await adminOf(t, org).mutation(
		api.agentCredentials.mintAgentCredential,
		{ orgSlug: org, agentId: await agentIdOf(t, org, name) },
	);
	return minted.secret;
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

const DOOR = "agentCredentials:resolveAgentCredential";

describe("resolveAgentCredential — the refusal carries its code and names its door", () => {
	test("RESOLVED: a minted credential resolves; a second agent's resolves to a DIFFERENT pair", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const a = await mint(t, "org-a", "b");
		const b = await mint(t, "org-b", "b");
		const ra = await asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
			presentedSecret: a,
		});
		const rb = await asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
			presentedSecret: b,
		});
		expect(ra).toMatchObject({ orgSlug: "org-a", agentName: "b" });
		expect(rb).toMatchObject({ orgSlug: "org-b", agentName: "b" });
	});

	test("WRONG: an unknown secret RAISES RBAC_DENIED, naming the door and reason credential-not-recognised", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await mint(t, "org-a", "b");
		const refusal = await refusalOf(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: "f".repeat(64),
			}),
		);
		expect(refusal).toContain("RBAC_DENIED");
		expect(refusal).toContain(DOOR);
		expect(refusal).toMatch(/reason\\*":\\*"credential-not-recognised/);
	});

	test("WRONG: a rotated-out secret is refused the same way", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const old = await mint(t, "org-a", "b");
		await mint(t, "org-a", "b");
		const refusal = await refusalOf(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: old,
			}),
		);
		expect(refusal).toMatch(/reason\\*":\\*"credential-not-recognised/);
	});

	test("ABSENT: an empty secret RAISES with reason no-credential — textually different from WRONG", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await mint(t, "org-a", "b");
		const absent = await refusalOf(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: "   ",
			}),
		);
		const wrong = await refusalOf(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: "f".repeat(64),
			}),
		);
		expect(absent).toContain("RBAC_DENIED");
		expect(absent).toContain(DOOR);
		expect(absent).toMatch(/reason\\*":\\*"no-credential/);
		expect(absent).not.toEqual(wrong);
		expect(wrong).not.toContain("no-credential");
	});

	test("LEGITIMATE ABSENCE: an agent with no credential is a plain SUCCESS for its org-admin, not a refusal", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await register(t, "org-a", "no-cred");
		const status = await adminOf(t, "org-a").query(
			api.agentCredentials.getAgentCredentialStatus,
			{ orgSlug: "org-a", agentId: await agentIdOf(t, "org-a", "no-cred") },
		);
		expect(status).toEqual({
			orgSlug: "org-a",
			agentId: await agentIdOf(t, "org-a", "no-cred"),
			agentName: "no-cred",
			hasActiveCredential: false,
			activeRows: 0,
		});
		// Same agent after a mint: the absence was real, not a broken door.
		await mint(t, "org-a", "no-cred");
		const after = await adminOf(t, "org-a").query(
			api.agentCredentials.getAgentCredentialStatus,
			{ orgSlug: "org-a", agentId: await agentIdOf(t, "org-a", "no-cred") },
		);
		expect(after.hasActiveCredential).toBe(true);
		expect(after.activeRows).toBe(1);
	});

	test("the absence door itself refuses another org's admin (scoped, not open)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await register(t, "org-a", "b");
		await expect(
			adminOf(t, "org-b").query(api.agentCredentials.getAgentCredentialStatus, {
				orgSlug: "org-a",
				agentId: await agentIdOf(t, "org-a", "b"),
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});


/**
 * `resolveAgentCredential` is closed to everyone but the fleet's service
 * account (the MCP server's identity). Every call in this file is the MCP
 * login path, so it is made as that account; the DENY poles that matter for
 * the door itself live in closeDoorsCreds.test.ts.
 */
function asServiceAccount<X extends { withIdentity: (i: never) => unknown }>(
	t: X,
): ReturnType<X["withIdentity"]> {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as never) as ReturnType<X["withIdentity"]>;
}
