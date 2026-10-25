/// <reference types="vite/client" />
/**
 * identityOrphans — the last identity decisions that lived in these files
 * (task k177jrz8k2dr7naqe7yzmp0px18g77n5, module M19):
 *
 *   convex/lib/rosterIds.ts          listedAgentsOfOrg
 *   convex/lib/personPrincipal.ts    resolveVerifiedPerson
 *   convex/lib/actingPrincipal.ts    requireVerifiedActorPrincipal
 *   convex/memberWriterRoles.ts      assertPersonMayWrite
 *   convex/errorMonitorFilters.ts    listFilterRules
 *
 * Every pole runs under a SCOPED identity (an ordinary org member, the fleet
 * service account only where the door is the service account's by purpose),
 * never as a master standing in for the caller under test.
 *
 * POLES
 *   OWN ORG       the caller's own organisation is served
 *   OTHER ORG     another organisation is refused, and so is a same-NAME
 *                 principal or a same-LABEL organisation of another tenant
 *   CLAIMLESS     the service account carrying no verified claim is refused
 *   NO GRANT LOST the grants that existed still hold
 *
 * Where a file already decided by ID and only carried a redundant local
 * comparison (rosterIds), the poles are GREEN before and after: they pin that
 * deleting the comparison withheld nothing and admitted nothing.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireVerifiedActorPrincipal } from "../lib/actingPrincipal";
import { type OrgScope, withOrgScope } from "../lib/auth";
import { resolveVerifiedPerson } from "../lib/personPrincipal";
import { listedAgentsOfOrg } from "../lib/rosterIds";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;

const EDITOR_A = "a".repeat(64);
const VIEWER_A = "b".repeat(64);
const VIEWER_B = "c".repeat(64);
const SEAT_A = "d".repeat(64);
const STALE_LABEL = "e".repeat(64);
const OWN_RENAMED = "f".repeat(64);

let t: T;
const service = () => t.withIdentity({ subject: SERVICE });
const memberIdentity = (org: string, role = "org:admin") => ({
	subject: `member-of-${org}`,
	org_slug: org,
	org_id: testClerkOrgId(org),
	org_role: role,
});
const memberOf = (org: string, role = "org:admin") =>
	t.withIdentity(
		memberIdentity(org, role) as Parameters<typeof t.withIdentity>[0],
	);
const preOrg = () =>
	t.withIdentity({ subject: "signed-in-no-org" } as Parameters<
		typeof t.withIdentity
	>[0]);

async function refusalText(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (err) {
		const data = (err as { data?: unknown }).data;
		return `${(err as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	}
	return "";
}

async function expectRefused(p: Promise<unknown>, ...codes: string[]) {
	const text = await refusalText(p);
	expect(text, "expected a refusal, the call was served").not.toBe("");
	for (const c of codes) expect(text).toContain(c);
}

async function seedOrg(
	slug: string,
	opts: { id?: string; allowedAgentIds?: string[] } = {},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: opts.id ?? testClerkOrgId(slug),
			allowedOrchestrators: [],
			...(opts.allowedAgentIds !== undefined
				? { allowedAgentIds: opts.allowedAgentIds as Id<"agents">[] }
				: {}),
			scopes: ["vantage:read", "vantage:write"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedAgent(
	orgSlug: string,
	name: string,
	isActive = true,
): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			clerkOrgId: testClerkOrgId(orgSlug),
			name,
			normalizedName: name,
			isActive,
			createdAt: Date.now(),
		}),
	);
}

async function seedToken(
	tokenHash: string,
	row: {
		userId: string;
		clerkOrgSlug: string;
		clerkOrgId?: string;
		orgRole?: string;
		person?: boolean;
	},
) {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash,
			clientId: "c",
			userId: row.userId,
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "person",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: now + 3_600_000,
			createdAt: now,
			clerkOrgSlug: row.clerkOrgSlug,
			...(row.clerkOrgId !== undefined ? { clerkOrgId: row.clerkOrgId } : {}),
			...(row.orgRole !== undefined ? { orgRole: row.orgRole } : {}),
			...(row.person === false ? {} : { principal: "person" as const }),
		});
	});
}

beforeEach(async () => {
	t = createT();
	await seedOrg("org-a");
	await seedOrg("org-b");
});

// ─────────────────────────────────────────────────────────────────────────────
// memberWriterRoles.assertPersonMayWrite — R-54 + the claimless service account
// ─────────────────────────────────────────────────────────────────────────────

describe("memberWriterRoles:assertPersonMayWrite — the role and the org come from the verified token, never from arguments", () => {
	beforeEach(async () => {
		const now = Date.now();
		await t.run(async (ctx) => {
			// Fleet default: admin and editor write. Org-b's own list: admin and viewer write.
			await ctx.db.insert("memberWriterRoles", {
				roles: ["org:admin", "org:editor"],
				updatedAt: now,
			});
			await ctx.db.insert("memberWriterRoles", {
				orgSlug: "org-b",
				clerkOrgId: testClerkOrgId("org-b"),
				roles: ["org:admin", "org:viewer"],
				updatedAt: now,
			});
		});
		await seedToken(EDITOR_A, {
			userId: "user_editor_a",
			clerkOrgSlug: "org-a",
			orgRole: "org:editor",
		});
		await seedToken(VIEWER_A, {
			userId: "user_viewer_a",
			clerkOrgSlug: "org-a",
			orgRole: "org:viewer",
		});
		await seedToken(VIEWER_B, {
			userId: "user_viewer_b",
			clerkOrgSlug: "org-b",
			orgRole: "org:viewer",
		});
		await seedToken(SEAT_A, {
			userId: "seat",
			clerkOrgSlug: "org-a",
			person: false,
		});
	});

	const gate = (hash: string) => ({
		verifiedPerson: { accessTokenHash: hash },
		door: "mcp:test",
	});

	test("OWN ORG — an editor of org-a on the fleet-default list is allowed", async () => {
		expect(
			await service().query(
				api.memberWriterRoles.assertPersonMayWrite,
				gate(EDITOR_A),
			),
		).toEqual({ allowed: true });
	});

	test("OWN ORG — a viewer of org-b is allowed by ORG-B's own list", async () => {
		expect(
			await service().query(
				api.memberWriterRoles.assertPersonMayWrite,
				gate(VIEWER_B),
			),
		).toEqual({ allowed: true });
	});

	test("OTHER ORG — a viewer of org-a does not borrow org-b's list (role-not-writer)", async () => {
		await expectRefused(
			service().query(
				api.memberWriterRoles.assertPersonMayWrite,
				gate(VIEWER_A),
			),
			"role-not-writer",
		);
	});

	test("NOT A PERSON — a seat token's hash is refused", async () => {
		await expectRefused(
			service().query(api.memberWriterRoles.assertPersonMayWrite, gate(SEAT_A)),
			"not-a-person-token",
		);
	});

	test("NOT LIVE — an unknown hash is refused", async () => {
		await expectRefused(
			service().query(
				api.memberWriterRoles.assertPersonMayWrite,
				gate("0".repeat(64)),
			),
			"person-token-not-live",
		);
	});

	test("UNTRUSTED — an org member and an anonymous caller are refused", async () => {
		await expectRefused(
			memberOf("org-a").query(
				api.memberWriterRoles.assertPersonMayWrite,
				gate(EDITOR_A),
			),
			"RBAC_DENIED",
		);
		await expectRefused(
			t.query(api.memberWriterRoles.assertPersonMayWrite, gate(EDITOR_A)),
			"RBAC_DENIED",
		);
	});

	test("CLAIMLESS — the service account naming an org and a role by ARGUMENT, with no verified token, is refused", async () => {
		// The pre-fix door took `orgSlug` and `role` as plain arguments, so the
		// service account (or anyone holding its identity) could assert ANY org and
		// ANY writer role and be told `allowed: true`.
		const claimless = {
			orgSlug: "org-b",
			role: "org:admin",
			door: "mcp:test",
		};
		await expectRefused(
			service().query(
				api.memberWriterRoles.assertPersonMayWrite,
				claimless as never,
			),
		);
		await expectRefused(
			service().query(api.memberWriterRoles.assertPersonMayWrite, {
				door: "mcp:test",
			} as never),
		);
	});

	test("NO ORG ARG — a verifiedPerson carrying an org or a role beside the hash is rejected", async () => {
		await expectRefused(
			service().query(api.memberWriterRoles.assertPersonMayWrite, {
				verifiedPerson: {
					accessTokenHash: VIEWER_A,
					orgSlug: "org-b",
					role: "org:admin",
				},
				door: "mcp:test",
			} as never),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// personPrincipal.resolveVerifiedPerson — a renamed org's label must not select
// another tenant
// ─────────────────────────────────────────────────────────────────────────────

describe("personPrincipal:resolveVerifiedPerson — the organisation is the token's, by ID", () => {
	const ACME_OLD_ID = "org_ACMEOLD";
	const ACME_NEW_ID = "org_ACMENEW";

	beforeEach(async () => {
		// Organisation "acme" was renamed "acme-old"; a DIFFERENT organisation
		// then took the label "acme". A token minted before the rename still
		// carries the label it was minted under.
		await seedOrg("acme-old", { id: ACME_OLD_ID });
		await seedOrg("acme", { id: ACME_NEW_ID });
		await seedToken(STALE_LABEL, {
			userId: "user_old_acme",
			clerkOrgSlug: "acme",
			clerkOrgId: ACME_OLD_ID,
			orgRole: "org:editor",
		});
		await seedToken(OWN_RENAMED, {
			userId: "user_old_acme",
			clerkOrgSlug: "acme-old",
			clerkOrgId: ACME_OLD_ID,
			orgRole: "org:editor",
		});
		await seedToken(EDITOR_A, {
			userId: "user_editor_a",
			clerkOrgSlug: "org-a",
			orgRole: "org:editor",
		});
	});

	const resolveAs = (
		identity: Record<string, unknown> | null,
		hash: string,
		scopeOverride?: Partial<OrgScope>,
	) =>
		(identity === null
			? t
			: t.withIdentity(identity as Parameters<typeof t.withIdentity>[0])
		).run(async (ctx) => {
			const scope = {
				...(await withOrgScope(ctx)),
				...scopeOverride,
			} as OrgScope;
			return await resolveVerifiedPerson(
				ctx,
				scope,
				{ accessTokenHash: hash },
				{ door: "identityOrphans" },
			);
		});

	test("OWN ORG — a token whose label and ID name one org resolves to that org's scope", async () => {
		const scope = await resolveAs({ subject: SERVICE }, OWN_RENAMED);
		expect(scope.orgSlug).toBe("acme-old");
		expect(scope.orgClerkId).toBe(ACME_OLD_ID);
		expect(scope.isMaster).toBe(false);
	});

	test("OWN ORG — a legacy token with no ID (expand phase) keeps resolving by its label", async () => {
		const scope = await resolveAs({ subject: SERVICE }, EDITOR_A);
		expect(scope.orgSlug).toBe("org-a");
	});

	test("OTHER ORG — a token whose LABEL now names another org is refused, not served that org's scope", async () => {
		await expectRefused(
			resolveAs({ subject: SERVICE }, STALE_LABEL),
			"ORG_MISMATCH",
		);
	});

	test("UNTRUSTED — an org member presenting a verifiedPerson is refused", async () => {
		await expectRefused(
			resolveAs(memberIdentity("org-a"), EDITOR_A),
			"verified-person-not-trusted",
		);
	});

	test("STANDING — a scope claiming service-account without being fleet-wide is refused (the package reads all three fields)", async () => {
		await expectRefused(
			resolveAs({ subject: SERVICE }, EDITOR_A, { fleetWide: false }),
			"verified-person-not-trusted",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// actingPrincipal.requireVerifiedActorPrincipal
// ─────────────────────────────────────────────────────────────────────────────

describe("actingPrincipal:requireVerifiedActorPrincipal — the actor is an agents-row ID of the verified org", () => {
	let etaA: Id<"agents">;
	let etaB: Id<"agents">;

	beforeEach(async () => {
		// Two agents with the SAME NAME in two organisations.
		etaA = await seedAgent("org-a", "eta");
		etaB = await seedAgent("org-b", "eta");
	});

	const actAs = (
		identity: Record<string, unknown> | null,
		verifiedActor: { agentId: Id<"agents">; orgSlug: string },
		scopeOverride?: Partial<OrgScope>,
	) =>
		(identity === null
			? t
			: t.withIdentity(identity as Parameters<typeof t.withIdentity>[0])
		).run(async (ctx) => {
			const scope = {
				...(await withOrgScope(ctx)),
				...scopeOverride,
			} as OrgScope;
			return await requireVerifiedActorPrincipal(
				ctx,
				scope,
				verifiedActor,
				"identityOrphans",
			);
		});

	test("OWN ORG — the service account carrying org-a's eta is resolved to that agent", async () => {
		const principal = await actAs(
			{ subject: SERVICE },
			{ agentId: etaA, orgSlug: "org-a" },
		);
		expect(principal.principalId).toBe(etaA);
		expect(principal.kind).toBe("agent");
	});

	test("OTHER ORG — org-b's same-named eta, presented as an agent of org-a, is refused", async () => {
		await expectRefused(
			actAs({ subject: SERVICE }, { agentId: etaB, orgSlug: "org-a" }),
			"ORG_MISMATCH",
		);
	});

	test("UNTRUSTED — an org member presenting a verifiedActor is refused", async () => {
		await expectRefused(
			actAs(memberIdentity("org-a"), { agentId: etaA, orgSlug: "org-a" }),
			"verified-actor-not-trusted",
		);
	});

	test("STANDING — a scope claiming service-account without being fleet-wide is refused (the package reads all three fields)", async () => {
		await expectRefused(
			actAs(
				{ subject: SERVICE },
				{ agentId: etaA, orgSlug: "org-a" },
				{ fleetWide: false },
			),
			"verified-actor-not-trusted",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// rosterIds.listedAgentsOfOrg — GREEN before and after: the package already
// decided; the local label comparison in front of it was redundant.
// ─────────────────────────────────────────────────────────────────────────────

describe("rosterIds:listedAgentsOfOrg — the roster lists IDs of its own org, judged by the package", () => {
	test("OWN ORG / OTHER ORG / SAME NAME / INACTIVE — only the listed, active agent of the org is returned", async () => {
		const etaA = await seedAgent("org-a", "eta");
		const etaB = await seedAgent("org-b", "eta"); // same NAME, other org
		const inactiveA = await seedAgent("org-a", "retired", false);
		const unlistedA = await seedAgent("org-a", "unlisted");

		const got = await t.run(async (ctx) =>
			listedAgentsOfOrg(
				ctx,
				"org-a",
				[etaA, etaB, inactiveA, "not-an-id"],
				"identityOrphans",
			),
		);
		expect(got.map((a) => a._id)).toEqual([etaA]);
		expect(got.map((a) => a._id)).not.toContain(etaB);
		expect(got.map((a) => a._id)).not.toContain(unlistedA);
	});

	test("NO GRANT LOST — every listed active agent of the org is returned", async () => {
		const a1 = await seedAgent("org-a", "one");
		const a2 = await seedAgent("org-a", "two");
		const got = await t.run(async (ctx) =>
			listedAgentsOfOrg(ctx, "org-a", [a1, a2], "identityOrphans"),
		);
		expect(got.map((a) => a._id).sort()).toEqual([a1, a2].sort());
	});

	test("ABSENT — an empty roster is an empty success", async () => {
		const got = await t.run(async (ctx) =>
			listedAgentsOfOrg(ctx, "org-a", [], "identityOrphans"),
		);
		expect(got).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorFilters:listFilterRules — no membership gate left in the handler
// ─────────────────────────────────────────────────────────────────────────────

describe("errorMonitorFilters:listFilterRules — a fleet-master read; every other caller is refused, none is served an absence", () => {
	beforeEach(async () => {
		await t.run(async (ctx) => {
			await ctx.db.insert("errorMonitorFilterRules", {
				functionName: "tasks:complete",
				errorMessageRegex: "x",
				reason: "noise",
				severity: "skip",
				active: true,
				createdAt: Date.now(),
			});
		});
	});

	test("NO GRANT LOST — the fleet service account reads the row", async () => {
		const rows = await service().query(
			api.errorMonitorFilters.listFilterRules,
			{},
		);
		expect(rows).toHaveLength(1);
	});

	test("ABSENT — the service account reading an empty table gets an empty success", async () => {
		await t.run(async (ctx) => {
			for (const r of await ctx.db.query("errorMonitorFilterRules").collect()) {
				await ctx.db.delete(r._id);
			}
		});
		expect(
			await service().query(api.errorMonitorFilters.listFilterRules, {}),
		).toEqual([]);
	});

	test("OTHER ORG — an ordinary member of an active org is refused, not handed [] (an empty array is the bytes of an absence)", async () => {
		await expectRefused(
			memberOf("org-a", "org:editor").query(
				api.errorMonitorFilters.listFilterRules,
				{},
			),
			"RBAC_DENIED",
			"errorMonitorFilters:listFilterRules",
		);
	});

	test("CLAIMLESS — an anonymous caller and a signed-in caller with no organisation are refused", async () => {
		await expectRefused(
			t.query(api.errorMonitorFilters.listFilterRules, {}),
			"RBAC_DENIED",
		);
		await expectRefused(
			preOrg().query(api.errorMonitorFilters.listFilterRules, {}),
			"RBAC_DENIED",
		);
	});
});
