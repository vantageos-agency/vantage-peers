/// <reference types="vite/client" />
//
// Pi ruling on #1652 (task k1701vj2gxbacdjqr1avpxx7en8hdw2q): a seat is admitted to
// `orchestrator/<its verified agent ID>` only, so its scope profile must LIST that
// prefix or the MCP ceiling (checkNamespaceRead/Write) refuses the call before it
// reaches Convex.
//
// (1) migrations/seat_profile_agent_namespace:run appends `orchestrator/<agentId>`
//     to the read + write prefixes of each client-bound seat profile whose single
//     fromAllowList name resolves to EXACTLY ONE agent of that profile's org; dry run
//     by default, idempotent, per-org counts + sample profile ids.
// (2) THROUGH the MCP profile check: a seat whose profile carries orchestrator/<own
//     id> writes + reads it -> the MCP admits it and Convex serves it; orchestrator/
//     <other id> -> the MCP refuses it, and Convex refuses it too if it were reached.
// Hermetic: no deployment is touched.

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import {
	checkNamespaceRead,
	checkNamespaceWrite,
	type OAuthContext,
} from "../../mcp-server/src/auth.js";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("search") && !path.includes("backfill"),
	),
);
const mig = internal.migrations.seat_profile_agent_namespace;
const NOW = 1_700_000_000_000;
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

const A = "sp-org-a";
const B = "sp-org-b";

type World = { aliceA: Id<"agents">; aliceB: Id<"agents">; carolA: Id<"agents"> };

async function seed(t: T): Promise<World> {
	return await t.run(async (ctx) => {
		const mapping = (slug: string, operator: boolean, roster: string[]) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: roster,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(operator ? { orgKind: "operator" as const } : {}),
			});
		await mapping("sp-fleet", true, ["sigma"]);
		await mapping(A, false, ["alice", "carol"]);
		await mapping(B, false, ["alice"]);
		const agent = (name: string, orgSlug: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: name.toLowerCase(),
				isActive: true,
				createdAt: NOW,
			});
		await agent("sigma", "sp-fleet");
		const world = {
			aliceA: await agent("alice", A),
			carolA: await agent("carol", A),
			aliceB: await agent("alice", B),
		};
		const profile = (
			profileId: string,
			clerkOrgSlug: string | undefined,
			fromAllowList: string[],
		) =>
			ctx.db.insert("oauth_scope_profiles", {
				profileId,
				description: profileId,
				fromAllowList,
				namespaceReadPrefixes: [`orchestrator/${fromAllowList[0]}`, `project/${clerkOrgSlug}`],
				namespaceWritePrefixes: [`orchestrator/${fromAllowList[0]}`, `project/${clerkOrgSlug}`],
				createdAt: NOW,
				updatedAt: NOW,
				...(clerkOrgSlug === undefined ? {} : { clerkOrgSlug }),
			});
		await profile(`alice-${A}`, A, ["alice"]);
		await profile(`alice-${B}`, B, ["alice"]);
		await profile(`multi-${A}`, A, ["alice", "carol"]);
		await profile(`ghost-${A}`, A, ["ghost"]);
		await profile(`wild-${A}`, A, ["*"]);
		await profile("sigma-fleet", "sp-fleet", ["sigma"]);
		await profile("unbound", undefined, ["alice"]);
		return world;
	});
}

const profileRow = (t: T, profileId: string) =>
	t.run(async (ctx) =>
		ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique(),
	);

describe("migrations/seat_profile_agent_namespace:run", () => {
	test("DRY RUN is the default: it counts and writes nothing", async () => {
		const t = createT();
		await seed(t);
		const r = await t.mutation(mig.run, {});
		expect(r.dryRun).toBe(true);
		expect(r.toUpdate).toBe(2);
		expect(r.updated).toBe(0);
		expect((await profileRow(t, `alice-${A}`))?.namespaceReadPrefixes).toEqual([
			"orchestrator/alice",
			`project/${A}`,
		]);
	});

	test("appends orchestrator/<that org's agent id> to read + write; skips the rest and counts them", async () => {
		const t = createT();
		const w = await seed(t);
		const r = await t.mutation(mig.run, { dryRun: false });
		expect(r.updated).toBe(2);
		const a = await profileRow(t, `alice-${A}`);
		const b = await profileRow(t, `alice-${B}`);
		expect(a?.namespaceReadPrefixes).toContain(`orchestrator/${w.aliceA}`);
		expect(a?.namespaceWritePrefixes).toContain(`orchestrator/${w.aliceA}`);
		expect(a?.namespaceReadPrefixes).not.toContain(`orchestrator/${w.aliceB}`);
		expect(b?.namespaceWritePrefixes).toContain(`orchestrator/${w.aliceB}`);
		for (const id of [`multi-${A}`, `ghost-${A}`, `wild-${A}`, "sigma-fleet", "unbound"]) {
			expect((await profileRow(t, id))?.namespaceReadPrefixes.length, id).toBe(2);
		}
		expect(r.skipped.notExactlyOneSeat).toBe(2); // multi, wild
		expect(r.skipped.noAgentInOrg).toBe(1); // ghost
		expect(r.skipped.operatorOrg).toBe(1);
		expect(r.skipped.notClientBound).toBe(1);
		const orgA = r.orgs.find((o) => o.slug === A);
		expect(orgA?.updated).toBe(1);
		expect(orgA?.sampleProfileIds).toEqual([`alice-${A}`]);
	});

	test("idempotent: a second run updates 0", async () => {
		const t = createT();
		await seed(t);
		await t.mutation(mig.run, { dryRun: false });
		const again = await t.mutation(mig.run, { dryRun: false });
		expect(again.toUpdate).toBe(0);
		expect(again.updated).toBe(0);
		expect(again.alreadyDone).toBe(2);
	});

	test("a profile with two agents of the same label in its org is skipped (no guess)", async () => {
		const t = createT();
		await seed(t);
		await t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: A,
				clerkOrgId: testClerkOrgId(A),
				name: "Alice",
				normalizedName: "alice",
				isActive: true,
				createdAt: NOW,
			}),
		);
		const r = await t.mutation(mig.run, { dryRun: false });
		expect(r.skipped.ambiguousAgent).toBe(1);
		expect((await profileRow(t, `alice-${A}`))?.namespaceReadPrefixes.length).toBe(2);
		expect(r.updated).toBe(1);
	});
});

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		const m = /([A-Z][A-Z_]{3,}):/.exec(text);
		return m ? m[1] : `OTHER(${text.slice(0, 100)})`;
	}
}

// What the MCP builds from the profile row (auth.ts OAuthContext), reduced to the
// fields the namespace ceiling reads.
const ctxOf = (
	row: NonNullable<Awaited<ReturnType<typeof profileRow>>>,
): OAuthContext =>
	({
		clientId: "seat",
		userId: "u",
		scopes: ["mcp:full"],
		scopeProfile: row.profileId,
		fromAllowList: row.fromAllowList,
		namespaceReadPrefixes: row.namespaceReadPrefixes,
		namespaceWritePrefixes: row.namespaceWritePrefixes,
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		clerkOrgSlug: A,
		accessTokenHash: "h",
	}) as OAuthContext;

describe("THROUGH the MCP profile check, then Convex", () => {
	const seatCall = (t: T, w: World, namespace: string) => ({
		run: () =>
			service(t).mutation(api.memories.storeMemory, {
				namespace,
				type: "project",
				content: "x",
				createdBy: "alice",
				__actingOrg: testClerkOrgId(A),
				verifiedActor: { agentId: w.aliceA, orgSlug: A },
			} as never),
	});

	test("before the profile update the MCP itself refuses orchestrator/<id>", async () => {
		const t = createT();
		const w = await seed(t);
		const ctx = ctxOf((await profileRow(t, `alice-${A}`))!);
		expect(checkNamespaceWrite(ctx, `orchestrator/${w.aliceA}`)).toMatch(/^Forbidden/);
	});

	test("after the update: own ID is admitted by the MCP and served by Convex; another ID is refused by both", async () => {
		const t = createT();
		const w = await seed(t);
		await t.mutation(mig.run, { dryRun: false });
		const ctx = ctxOf((await profileRow(t, `alice-${A}`))!);
		const own = `orchestrator/${w.aliceA}`;
		expect(checkNamespaceWrite(ctx, own)).toBeNull();
		expect(checkNamespaceRead(ctx, own)).toBeNull();
		expect(await code(seatCall(t, w, own).run())).toBe("SERVED");
		// another agent of the same org, and another org's same-named agent
		for (const other of [w.carolA, w.aliceB]) {
			const ns = `orchestrator/${other}`;
			expect(checkNamespaceWrite(ctx, ns), ns).toMatch(/^Forbidden/);
			expect(checkNamespaceRead(ctx, ns), ns).toMatch(/^Forbidden/);
			expect(await code(seatCall(t, w, ns).run()), ns).toBe("RBAC_DENIED");
		}
	});

	test("the name prefix still passes the MCP, and Convex refuses it", async () => {
		const t = createT();
		const w = await seed(t);
		await t.mutation(mig.run, { dryRun: false });
		const ctx = ctxOf((await profileRow(t, `alice-${A}`))!);
		expect(checkNamespaceWrite(ctx, "orchestrator/alice")).toBeNull();
		expect(await code(seatCall(t, w, "orchestrator/alice").run())).toBe("RBAC_DENIED");
	});
});
