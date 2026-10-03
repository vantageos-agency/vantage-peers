/// <reference types="vite/client" />
/**
 * Operator onboards a NEW client org from the dashboard with his own verified
 * Clerk session (task k17fbbq8z7rs1bgd06gmb88x8s8fkpm3, Pi ruling (b)).
 *
 * Before: a brand-new org could only be created with the master bearer,
 * because requireOrgAdmin needs an existing mapping.
 *
 * Rule: no callerToken + no mapping for args.clerkOrgSlug -> allowed iff the
 * caller is org:admin of an ACTIVE mapping whose orgKind === "operator"
 * (resolved from the verified org claim). The created mapping is orgKind
 * "client". An existing slug keeps the requireOrgAdmin path (admin of THAT org).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Ident = Parameters<T["withIdentity"]>[0];

async function seedOrg(
	t: T,
	slug: string,
	orgKind: "operator" | "client" | undefined,
	names: string[] = ["seed-seat"],
	isActive = true,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: names,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive,
			createdAt: Date.now(),
			...(orgKind ? { orgKind } : {}),
		});
	});
}

const as = (t: T, org: string, role: string, sub = `${role}-of-${org}`) =>
	t.withIdentity({
		subject: sub,
		organizationSlug: org,
		orgRole: role,
	} as Ident);

const args = (slug: string, names = ["acme-lead", "acme-dev"]) => ({
	clerkOrgSlug: slug,
	displayName: `Org ${slug}`,
	orchestrators: names.map((name) => ({ name })),
});

const countMappings = (t: T, slug: string) =>
	t.run(
		async (ctx) =>
			(
				await ctx.db
					.query("client_org_mapping")
					.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
					.collect()
			).length,
	);

async function denied(p: Promise<unknown>, reason: string) {
	await expect(p).rejects.toThrow(/RBAC_DENIED/);
	await expect(p).rejects.toThrow(new RegExp(`"reason":"${reason}"`));
}

describe("operator org:admin creates a NEW client org", () => {
	test("SERVED: creates mapping orgKind client, roster = names, seats' secrets returned, audit row names the admin", async () => {
		const t = createT();
		await seedOrg(t, "operator-org", "operator", ["op-seat"]);
		const r = await as(t, "operator-org", "org:admin", "user_op_1").mutation(
			api.oauth.provisionOrganization,
			args("client-acme"),
		);
		expect(r.replay).toBe(false);
		expect(r.orchestrators.map((o) => o.name)).toEqual([
			"acme-lead",
			"acme-dev",
		]);
		for (const o of r.orchestrators) {
			expect(o.clientSecret).toMatch(/^[0-9a-f]{64}$/);
			expect(o.accessToken).toMatch(/^[0-9a-f]{64}$/);
			expect(o.refreshToken).toMatch(/^[0-9a-f]{64}$/);
		}
		const m = await t.run(async (ctx) => ctx.db.get(r.mappingId));
		expect(m?.orgKind).toBe("client");
		expect(m?.clerkOrgSlug).toBe("client-acme");
		expect(m?.allowedOrchestrators).toEqual(["acme-lead", "acme-dev"]);
		expect(m?.isActive).toBe(true);
		const audit = await t.run(async (ctx) =>
			ctx.db
				.query("orgMembership")
				.withIndex("by_org_user", (q) =>
					q.eq("clerkOrgSlug", "client-acme").eq("clerkUserId", "user_op_1"),
				)
				.unique(),
		);
		expect(audit?.role).toBe("admin");
		// the operator mapping itself is untouched
		expect(await countMappings(t, "operator-org")).toBe(1);
	});

	test("REFUSED: operator org:editor / member (not admin)", async () => {
		const t = createT();
		await seedOrg(t, "operator-org", "operator");
		await denied(
			as(t, "operator-org", "org:member").mutation(
				api.oauth.provisionOrganization,
				args("client-acme"),
			),
			"operator-member-not-admin",
		);
		await denied(
			as(t, "operator-org", "org:editor").mutation(
				api.oauth.provisionOrganization,
				args("client-acme"),
			),
			"operator-member-not-admin",
		);
		expect(await countMappings(t, "client-acme")).toBe(0);
	});

	test("REFUSED: admin of a CLIENT org creating a new org", async () => {
		const t = createT();
		await seedOrg(t, "operator-org", "operator");
		await seedOrg(t, "client-a", "client");
		await denied(
			as(t, "client-a", "org:admin").mutation(
				api.oauth.provisionOrganization,
				args("client-new"),
			),
			"caller-org-not-operator",
		);
		// legacy mapping without orgKind is not operator either
		await seedOrg(t, "legacy-org", undefined);
		await denied(
			as(t, "legacy-org", "org:admin").mutation(
				api.oauth.provisionOrganization,
				args("client-new"),
			),
			"caller-org-not-operator",
		);
		expect(await countMappings(t, "client-new")).toBe(0);
	});

	test("REFUSED: anonymous", async () => {
		const t = createT();
		await seedOrg(t, "operator-org", "operator");
		await denied(
			t.mutation(api.oauth.provisionOrganization, args("client-acme")),
			"anonymous",
		);
		expect(await countMappings(t, "client-acme")).toBe(0);
	});

	test("REFUSED: operator admin targeting an EXISTING other org's slug (no hijack, no re-provision)", async () => {
		const t = createT();
		await seedOrg(t, "operator-org", "operator");
		await seedOrg(t, "client-a", "client", ["acme-lead", "acme-dev"]);
		const before = await t.run(async (ctx) =>
			ctx.db.query("oauth_clients").collect(),
		);
		await expect(
			as(t, "operator-org", "org:admin").mutation(
				api.oauth.provisionOrganization,
				args("client-a"),
			),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await countMappings(t, "client-a")).toBe(1);
		const after = await t.run(async (ctx) =>
			ctx.db.query("oauth_clients").collect(),
		);
		expect(after.length).toBe(before.length);
		// inactive existing slug is also an existing slug
		await seedOrg(t, "client-dead", "client", ["x"], false);
		await expect(
			as(t, "operator-org", "org:admin").mutation(
				api.oauth.provisionOrganization,
				args("client-dead"),
			),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("REFUSED: slug equal to the operator org's own slug creates nothing and never flips orgKind", async () => {
		const t = createT();
		await seedOrg(t, "operator-org", "operator", ["op-seat"]);
		// different name set -> refused (existing replay rule), same -> replay w/ null secrets
		await expect(
			as(t, "operator-org", "org:admin").mutation(
				api.oauth.provisionOrganization,
				args("operator-org"),
			),
		).rejects.toThrow();
		const r = await as(t, "operator-org", "org:admin").mutation(
			api.oauth.provisionOrganization,
			args("operator-org", ["op-seat"]),
		);
		expect(r.replay).toBe(true);
		expect(r.orchestrators[0].clientSecret).toBeNull();
		expect(await countMappings(t, "operator-org")).toBe(1);
		const m = await t.run(async (ctx) => ctx.db.get(r.mappingId));
		expect(m?.orgKind).toBe("operator");
	});

	test("REFUSED: inactive operator mapping cannot create", async () => {
		const t = createT();
		await seedOrg(t, "operator-org", "operator", ["op-seat"], false);
		await denied(
			as(t, "operator-org", "org:admin").mutation(
				api.oauth.provisionOrganization,
				args("client-acme"),
			),
			"caller-org-not-operator",
		);
	});

	test("orgKind operator is impossible for a created org: no argument can set it, result is always client", async () => {
		const t = createT();
		await seedOrg(t, "operator-org", "operator");
		await expect(
			as(t, "operator-org", "org:admin").mutation(
				api.oauth.provisionOrganization,
				// biome-ignore lint/suspicious/noExplicitAny: probing an undeclared arg
				{ ...args("client-x"), orgKind: "operator" } as any,
			),
		).rejects.toThrow();
		const r = await as(t, "operator-org", "org:admin").mutation(
			api.oauth.provisionOrganization,
			args("client-y"),
		);
		const m = await t.run(async (ctx) => ctx.db.get(r.mappingId));
		expect(m?.orgKind).toBe("client");
		const operators = await t.run(async (ctx) =>
			(await ctx.db.query("client_org_mapping").collect()).filter(
				(x) => x.orgKind === "operator",
			),
		);
		expect(operators.map((x) => x.clerkOrgSlug)).toEqual(["operator-org"]);
	});
});

describe("pre-existing paths unchanged", () => {
	test("master bearer still creates a new org (orgKind left unset, as before)", async () => {
		const prev = process.env.BEARER_SECRET_MASTER;
		process.env.BEARER_SECRET_MASTER = "operator-create-master";
		try {
			const t = createT();
			const r = await t.mutation(api.oauth.provisionOrganization, {
				callerToken: "operator-create-master",
				...args("client-master"),
			});
			expect(r.replay).toBe(false);
			const m = await t.run(async (ctx) => ctx.db.get(r.mappingId));
			expect(m?.orgKind).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.BEARER_SECRET_MASTER;
			else process.env.BEARER_SECRET_MASTER = prev;
		}
	});

	test("admin of THIS existing org replays (null secrets); member of it is refused", async () => {
		const t = createT();
		await seedOrg(t, "client-a", "client", ["acme-lead"]);
		const r = await as(t, "client-a", "org:admin").mutation(
			api.oauth.provisionOrganization,
			args("client-a", ["acme-lead"]),
		);
		expect(r.replay).toBe(true);
		expect(r.orchestrators[0].clientSecret).toBeNull();
		await expect(
			as(t, "client-a", "org:member").mutation(
				api.oauth.provisionOrganization,
				args("client-a", ["acme-lead"]),
			),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("oauth:canCreateOrganization -- same predicate as the mutation", () => {
	const setup = async () => {
		const t = createT();
		await seedOrg(t, "operator-org", "operator");
		await seedOrg(t, "client-a", "client");
		return t;
	};
	const callers: Array<
		[string, (t: T) => ReturnType<T["withIdentity"]>, boolean]
	> = [
		["operator admin", (t) => as(t, "operator-org", "org:admin"), true],
		["operator editor", (t) => as(t, "operator-org", "org:editor"), false],
		["client admin", (t) => as(t, "client-a", "org:admin"), false],
		["no org", (t) => t.withIdentity({ subject: "u-no-org" } as Ident), false],
	];

	test.each(
		callers,
	)("%s -> allowed matches expectation", async (_n, mk, want) => {
		const t = await setup();
		const r = await mk(t).query(api.oauth.canCreateOrganization, {});
		expect(r).toEqual({ allowed: want });
	});

	test("anonymous RAISES RBAC_DENIED (never an empty/false success)", async () => {
		const t = await setup();
		await expect(t.query(api.oauth.canCreateOrganization, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});

	test.each(
		callers,
	)("consistency: %s query answer == mutation accepts a fresh slug", async (_n, mk, _want) => {
		const t = await setup();
		const asked = await mk(t).query(api.oauth.canCreateOrganization, {});
		let accepted = true;
		try {
			await mk(t).mutation(api.oauth.provisionOrganization, args("fresh-slug"));
		} catch {
			accepted = false;
		}
		expect(asked.allowed).toBe(accepted);
	});
});
