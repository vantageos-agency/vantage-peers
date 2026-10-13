/// <reference types="vite/client" />
/**
 * Batch G, the identity foundation in convex/lib (identity-by-id plan, FINAL
 * k17bqmh6a4b6nw0rzab50tf98x8fyepa; M1 k173a1jxyvgtsenh5y1j0sjehd8fzk6c).
 *
 * The shared primitives that every other module's doors call decide identity
 * through @vantageos/cloud-identity and nothing else. Each block below pins one
 * primitive on its three poles (REFUSED / ABSENT / PRESENT) plus a cross-org
 * deny pole:
 *
 *   memberScopeOfMapping      the ONE builder of an organisation's member scope
 *   scopeRosterIds            the roster leg of a row read, by agent ID
 *   verifiedOrg (Ref)         a verified org compared with a row BY ORG ID
 *   resolvePrincipalOfPresentedSecret   the secret's agent AND its principal
 *   fleetStanding             standing is the package's reading of the scope
 *   requireResolvedCaller     a self-contradicting scope is not master
 *   requireOrgAdmin           an absent session is refused by the package
 *   requireAgentCredentialMatch / verifiedActor   judged by the package, by ID
 *   listedAgentsOfOrg         a foreign agent on a roster is dropped
 */

import {
	hasFleetRead,
	scopeStanding,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolvePrincipalOfPresentedSecret } from "../lib/agentIdentity";
import {
	memberScopeOfMapping,
	requireAgentCredentialMatch,
	requireOrgAdmin,
	requireResolvedCaller,
	withOrgScope,
} from "../lib/auth";
import { fleetStandingOf, requireFleetDoor, scopeWithFleetStanding } from "../lib/fleetStanding";
import { listedAgentsOfOrg } from "../lib/rosterIds";
import {
	filterByOrgScopeById,
	isRowVisibleToScopeById,
} from "../lib/scopeRosterIds";
import {
	assertRowInVerifiedOrgRef,
	resolveVerifiedOrgRef,
} from "../lib/verifiedOrg";
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
type Identity = Parameters<T["withIdentity"]>[0];

const SERVICE_SUBJECT = "test-service-account-user-id";

const session = (org: string, role: "org:admin" | "org:member", who = "u") =>
	({
		subject: `${who}-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	}) as Identity;

async function seedOrg(
	t: T,
	slug: string,
	opts: {
		orgKind?: "operator" | "client";
		isActive?: boolean;
		allowedAgentIds?: Id<"agents">[];
		scopes?: string[];
	} = {},
): Promise<Id<"client_org_mapping">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: ["legacy-name"],
			...(opts.allowedAgentIds !== undefined
				? { allowedAgentIds: opts.allowedAgentIds }
				: {}),
			scopes: opts.scopes ?? ["view-own-tasks"],
			displayName: slug,
			isActive: opts.isActive ?? true,
			createdAt: 1_700_000_000_000,
			...(opts.orgKind !== undefined ? { orgKind: opts.orgKind } : {}),
		}),
	);
}

async function seedAgent(
	t: T,
	org: string,
	name: string,
	opts: { isActive?: boolean } = {},
): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			name,
			normalizedName: name.toLowerCase(),
			isActive: opts.isActive ?? true,
			createdAt: 1,
		}),
	);
}

// The text of a refusal, whether the runner kept the ConvexError's data as the
// string or wrapped it in JSON on the way out.
function refusalText(data: unknown): string {
	let text = String(data);
	while (text.startsWith('"')) {
		try {
			text = String(JSON.parse(text));
		} catch {
			break;
		}
	}
	return text;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (e instanceof ConvexError) return refusalText(e.data);
		return `NON_CONVEX_ERROR: ${String(e)}`;
	}
	return "NO_ERROR";
}

// ─────────────────────────────────────────────────────────────────────────────
describe("memberScopeOfMapping — the ONE builder of an organisation's member scope", () => {
	test("PRESENT: slug, permanent ID, both rosters and scopes come from the mapping row; never master", async () => {
		const t = createT();
		const agent = await seedAgent(t, "org-a", "ada");
		const id = await seedOrg(t, "org-a", {
			allowedAgentIds: [agent],
			scopes: ["view-own-tasks", "view-own-missions"],
		});
		const scope = await t.run(async (ctx) => {
			const mapping = await ctx.db.get(id);
			if (mapping === null) throw new Error("mapping missing");
			return memberScopeOfMapping(mapping, {
				userId: "user-1",
				orgRole: "org:admin",
			});
		});
		expect(scope).toEqual({
			userId: "user-1",
			orgSlug: "org-a",
			orgClerkId: testClerkOrgId("org-a"),
			allowedOrchestrators: ["legacy-name"],
			allowedAgentIds: [agent],
			fleetWide: false,
			scopes: ["view-own-tasks", "view-own-missions"],
			isMaster: false,
			orgRole: "org:admin",
		});
		expect(scopeStanding(scope)).toBe("member");
		expect(hasFleetRead(scope)).toBe(false);
	});

	test("ABSENT: a mapping with no ID roster yields an empty one; no role claim leaves no orgRole key", async () => {
		const t = createT();
		const id = await seedOrg(t, "org-b");
		const scope = await t.run(async (ctx) => {
			const mapping = await ctx.db.get(id);
			if (mapping === null) throw new Error("mapping missing");
			return memberScopeOfMapping(mapping, { userId: "user-2", orgRole: null });
		});
		expect(scope.allowedAgentIds).toEqual([]);
		expect("orgRole" in scope).toBe(false);
	});

	test("PRESENT through the resolver: withOrgScope returns exactly this scope for a member, with the verified role", async () => {
		const t = createT();
		const agent = await seedAgent(t, "org-c", "cleo");
		await seedOrg(t, "org-c", { allowedAgentIds: [agent] });
		const scope = await t
			.withIdentity(session("org-c", "org:member"))
			.run((ctx) => withOrgScope(ctx));
		expect(scope).toMatchObject({
			orgSlug: "org-c",
			orgClerkId: testClerkOrgId("org-c"),
			allowedAgentIds: [agent],
			isMaster: false,
			fleetWide: false,
			orgRole: "org:member",
		});
	});

	test("CROSS-ORG: a member of org-d never receives org-c's roster", async () => {
		const t = createT();
		const agentC = await seedAgent(t, "org-c", "cleo");
		await seedOrg(t, "org-c", { allowedAgentIds: [agentC] });
		await seedOrg(t, "org-d");
		const scope = await t
			.withIdentity(session("org-d", "org:member"))
			.run((ctx) => withOrgScope(ctx));
		expect(scope.orgSlug).toBe("org-d");
		expect(scope.allowedAgentIds).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("scopeRosterIds — the roster leg of a row read, by agent ID", () => {
	async function world() {
		const t = createT();
		const ada = await seedAgent(t, "org-a", "ada");
		const bea = await seedAgent(t, "org-a", "bea"); // in org-a, NOT on the roster
		const vic = await seedAgent(t, "org-b", "vic");
		await seedOrg(t, "org-a", { allowedAgentIds: [ada] });
		await seedOrg(t, "org-b", { allowedAgentIds: [vic] });
		const row = (org: string, pilotId?: string, extra: object = {}) => ({
			orgId: org,
			clerkOrgId: testClerkOrgId(org),
			...(pilotId !== undefined ? { pilotId } : {}),
			...extra,
		});
		const memberA = <R>(fn: (ctx: MutationCtx) => Promise<R>): Promise<R> =>
			t.withIdentity(session("org-a", "org:member")).run(fn);
		return { t, ada, bea, vic, row, memberA };
	}

	test("PRESENT: a row of the caller's org naming a listed agent is visible", async () => {
		const { ada, row, memberA } = await world();
		const out = await memberA(async (ctx) => {
			const scope = await withOrgScope(ctx);
			return {
				one: await isRowVisibleToScopeById(ctx, scope, row("org-a", ada), "test"),
				many: await filterByOrgScopeById(ctx, [row("org-a", ada)], scope, "test"),
			};
		});
		expect(out.one).toBe(true);
		expect(out.many).toHaveLength(1);
	});

	test("REFUSED: a row naming an agent of the org that is NOT on the roster is hidden", async () => {
		const { bea, row, memberA } = await world();
		const out = await memberA(async (ctx) => {
			const scope = await withOrgScope(ctx);
			return {
				one: await isRowVisibleToScopeById(ctx, scope, row("org-a", bea), "test"),
				many: await filterByOrgScopeById(ctx, [row("org-a", bea)], scope, "test"),
			};
		});
		expect(out.one).toBe(false);
		expect(out.many).toEqual([]);
	});

	test("ABSENT: no rows is an empty success; a row naming no agent is hidden from a member", async () => {
		const { row, memberA } = await world();
		const out = await memberA(async (ctx) => {
			const scope = await withOrgScope(ctx);
			return {
				none: await filterByOrgScopeById(ctx, [], scope, "test"),
				unnamed: await isRowVisibleToScopeById(ctx, scope, row("org-a"), "test"),
			};
		});
		expect(out.none).toEqual([]);
		expect(out.unnamed).toBe(false);
	});

	test("CROSS-ORG: another org's row is hidden even when it names an agent ID the caller's roster lists", async () => {
		const { vic, row, memberA, t } = await world();
		// org-a's stored roster is (wrongly) made to list org-b's agent: the
		// package refuses an agent stamped with another organisation.
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-a"))
				.first();
			if (m !== null) await ctx.db.patch(m._id, { allowedAgentIds: [vic as Id<"agents">] });
		});
		const out = await memberA(async (ctx) => {
			const scope = await withOrgScope(ctx);
			return {
				foreignRow: await isRowVisibleToScopeById(ctx, scope, row("org-b", vic), "test"),
				ownRowForeignAgent: await isRowVisibleToScopeById(ctx, scope, row("org-a", vic), "test"),
			};
		});
		expect(out.foreignRow).toBe(false);
		expect(out.ownRowForeignAgent).toBe(false);
	});

	test("CROSS-ORG: a row stamped with the same SLUG but another org ID is hidden (a label never matches)", async () => {
		const { ada, memberA } = await world();
		const out = await memberA(async (ctx) => {
			const scope = await withOrgScope(ctx);
			return await isRowVisibleToScopeById(
				ctx,
				scope,
				{ orgId: "org-a", clerkOrgId: "org_SomeOtherOrgWithTheSameSlug", pilotId: ada },
				"test",
			);
		});
		expect(out).toBe(false);
	});

	test("REFUSED: an anonymous scope sees nothing; the fleet service account sees every row", async () => {
		const { ada, row, t } = await world();
		const anon = await t.run(async (ctx) => {
			const scope = await withOrgScope(ctx);
			return await filterByOrgScopeById(ctx, [row("org-a", ada)], scope, "test");
		});
		expect(anon).toEqual([]);
		const fleet = await t
			.withIdentity({ subject: SERVICE_SUBJECT } as Identity)
			.run(async (ctx) => {
				const scope = await withOrgScope(ctx);
				return await filterByOrgScopeById(
					ctx,
					[row("org-a", ada), row("org-b", "x")],
					scope,
					"test",
				);
			});
		expect(fleet).toHaveLength(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("verifiedOrg (Ref) — a verified organisation compared with a row BY ORG ID", () => {
	test("PRESENT: the service account's proof resolves to the org's ID and label; a row with that ID passes", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const out = await t
			.withIdentity({ subject: SERVICE_SUBJECT } as Identity)
			.run(async (ctx) => {
				const transport = await withOrgScope(ctx);
				const ref = await resolveVerifiedOrgRef(ctx, transport, { orgSlug: "org-a" }, "test");
				assertRowInVerifiedOrgRef(
					{ orgId: "org-a", clerkOrgId: testClerkOrgId("org-a") },
					ref,
					"row-1",
					"test",
				);
				return ref;
			});
		expect(out).toEqual({ id: testClerkOrgId("org-a"), label: "org-a" });
	});

	test("ABSENT: no proof carried is no verified org; the assertion is a no-op", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const out = await t
			.withIdentity({ subject: SERVICE_SUBJECT } as Identity)
			.run(async (ctx) => {
				const transport = await withOrgScope(ctx);
				assertRowInVerifiedOrgRef({ orgId: "anything" }, undefined, "row-1", "test");
				const ref = await resolveVerifiedOrgRef(ctx, transport, undefined, "test");
				return ref === undefined ? "no verified org" : "a verified org";
			});
		expect(out).toBe("no verified org");
	});

	test("REFUSED: a member cannot name a verified org; an unknown or inactive org is refused", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-off", { isActive: false });
		const asMember = await codeOf(
			t.withIdentity(session("org-a", "org:member")).run(async (ctx) => {
				const transport = await withOrgScope(ctx);
				return await resolveVerifiedOrgRef(ctx, transport, { orgSlug: "org-a" }, "test");
			}),
		);
		expect(asMember).toMatch(/verified-org-not-trusted/);
		for (const slug of ["org-ghost", "org-off"]) {
			const refused = await codeOf(
				t.withIdentity({ subject: SERVICE_SUBJECT } as Identity).run(async (ctx) => {
					const transport = await withOrgScope(ctx);
					return await resolveVerifiedOrgRef(ctx, transport, { orgSlug: slug }, "test");
				}),
			);
			expect(refused).toMatch(/org-not-active/);
		}
	});

	test("CROSS-ORG: another org's row, an unstamped row, and a same-slug row with another ID are refused", () => {
		const verified = { id: testClerkOrgId("org-a"), label: "org-a" };
		const refuse = (row: { orgId?: string; clerkOrgId?: string }) => {
			try {
				assertRowInVerifiedOrgRef(row, verified, "row-1", "test");
			} catch (e) {
				return e instanceof ConvexError ? refusalText(e.data) : "OTHER";
			}
			return "NO_ERROR";
		};
		expect(refuse({ orgId: "org-b", clerkOrgId: testClerkOrgId("org-b") })).toMatch(
			/row-outside-verified-org/,
		);
		expect(refuse({})).toMatch(/row-outside-verified-org/);
		expect(refuse({ orgId: "org-a" })).toMatch(/row-outside-verified-org/);
		expect(refuse({ orgId: "org-a", clerkOrgId: "org_Impostor" })).toMatch(
			/row-outside-verified-org/,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("resolvePrincipalOfPresentedSecret — the secret's agent AND its principal", () => {
	async function world() {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const admin = t.withIdentity(session("org-a", "org:admin"));
		const agentId = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "clio",
		});
		const minted = await admin.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-a",
			agentId,
		});
		return { t, agentId, secret: minted.secret, admin };
	}

	test("PRESENT: a live secret resolves to the agents row and a principal stamped with its org", async () => {
		const { t, agentId, secret } = await world();
		const out = await t.run((ctx) =>
			resolvePrincipalOfPresentedSecret(ctx, secret, "test"),
		);
		expect(out?.agent._id).toBe(agentId);
		expect(out?.principal).toMatchObject({
			kind: "agent",
			principalId: agentId,
			orgId: "org-a",
		});
	});

	test("REFUSED: an unknown secret resolves to nothing", async () => {
		const { t } = await world();
		const out = await t.run((ctx) =>
			resolvePrincipalOfPresentedSecret(ctx, "vp_agent_not-a-real-secret", "test"),
		);
		expect(out).toBeNull();
	});

	test("REFUSED: a secret whose agent was deactivated resolves to nothing", async () => {
		const { t, agentId, secret } = await world();
		await t.run((ctx) => ctx.db.patch(agentId, { isActive: false }));
		const out = await t.run((ctx) =>
			resolvePrincipalOfPresentedSecret(ctx, secret, "test"),
		);
		expect(out).toBeNull();
	});

	test("CROSS-ORG: the lock refuses org-a's credential at a call targeting org-b (ORG_MISMATCH), and accepts it at org-a", async () => {
		const { t, secret } = await world();
		const none = { scope: { isMaster: false }, verifiedActor: undefined } as const;
		const wrong = await codeOf(
			t.run((ctx) => requireAgentCredentialMatch(ctx, secret, "clio", "org-b", none)),
		);
		expect(wrong).toMatch(/^ORG_MISMATCH/);
		const right = await codeOf(
			t.run((ctx) => requireAgentCredentialMatch(ctx, secret, "clio", "org-a", none)),
		);
		expect(right).toBe("NO_ERROR");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("verifiedActor — judged by the package, by ID", () => {
	const proof = (agentId: Id<"agents">, orgSlug: string) => ({
		scope: { isMaster: true, fleetWide: true, masterSource: "service-account" as const },
		verifiedActor: { agentId, orgSlug },
	});

	test("PRESENT: an active agent of an active org, targeted at its own org, is accepted", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		const out = await codeOf(
			t.run((ctx) =>
				requireAgentCredentialMatch(ctx, undefined, "clio", "org-a", proof(clio, "org-a")),
			),
		);
		expect(out).toBe("NO_ERROR");
	});

	test("REFUSED: an agent of an INACTIVE organisation is refused even though the row is active", async () => {
		const t = createT();
		await seedOrg(t, "org-off", { isActive: false });
		const clio = await seedAgent(t, "org-off", "clio");
		const out = await codeOf(
			t.run((ctx) =>
				requireAgentCredentialMatch(ctx, undefined, "clio", null, proof(clio, "org-off")),
			),
		);
		expect(out).toMatch(/^RBAC_DENIED/);
	});

	test("REFUSED: a scope that is not the service account is not believed (a contradicting scope included)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		for (const scope of [
			{ isMaster: true, fleetWide: false, masterSource: "service-account" as const },
			{ isMaster: true, fleetWide: true, masterSource: "internal" as const },
			{ isMaster: false, fleetWide: false },
		]) {
			const out = await codeOf(
				t.run((ctx) =>
					requireAgentCredentialMatch(ctx, undefined, "clio", null, {
						scope,
						verifiedActor: { agentId: clio, orgSlug: "org-a" },
					}),
				),
			);
			expect(out).toMatch(/verified-actor-not-trusted/);
		}
	});

	test("CROSS-ORG: the proof's org against another org's target is ORG_MISMATCH", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const clio = await seedAgent(t, "org-a", "clio");
		const out = await codeOf(
			t.run((ctx) =>
				requireAgentCredentialMatch(ctx, undefined, "clio", "org-b", proof(clio, "org-a")),
			),
		);
		expect(out).toMatch(/^ORG_MISMATCH/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("fleetStanding — the standing is the package's reading", () => {
	async function world() {
		const t = createT();
		await seedOrg(t, "op-org", { orgKind: "operator" });
		await seedOrg(t, "client-org", { orgKind: "client" });
		return t;
	}
	const service = { subject: SERVICE_SUBJECT } as Identity;

	test("PRESENT: the service account is fleet; the operator admin is fleet-read on a read only", async () => {
		const t = await world();
		expect(
			await t.withIdentity(service).run((ctx) => fleetStandingOf(ctx, "test")),
		).toBe("fleet");
		const admin = t.withIdentity(session("op-org", "org:admin"));
		expect(await admin.run((ctx) => fleetStandingOf(ctx, "test"))).toBeNull();
		expect(
			await admin.run((ctx) =>
				fleetStandingOf(ctx, "test", { operatorHumanMayRead: true }),
			),
		).toBe("operator-admin");
	});

	test("REFUSED: a client-org admin, a member, and an anonymous caller are not fleet (the option widens nothing)", async () => {
		const t = await world();
		for (const identity of [
			session("client-org", "org:admin"),
			session("op-org", "org:member"),
		]) {
			expect(
				await t.withIdentity(identity).run((ctx) =>
					fleetStandingOf(ctx, "test", { operatorHumanMayRead: true }),
				),
			).toBeNull();
		}
		expect(
			await t.run((ctx) => fleetStandingOf(ctx, "test", { operatorHumanMayRead: true })),
		).toBeNull();
	});

	test("PRESENT/REFUSED: the scope it hands the refusal helper reads as fleet only for the fleet", async () => {
		const t = await world();
		const standingOf = async (identity: Identity | null) => {
			const run = (fn: Parameters<T["run"]>[0]) =>
				identity === null ? t.run(fn) : t.withIdentity(identity).run(fn);
			return await run(async (ctx) => {
				const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
				return scopeStanding(await scopeWithFleetStanding(ctx, scope, "test"));
			});
		};
		expect(await standingOf(service)).toBe("fleet");
		expect(await standingOf(session("client-org", "org:member"))).toBe("member");
		expect(await standingOf(session("op-org", "org:admin"))).not.toBe("fleet");
	});

	test("REFUSED: a fleet-only measurement door raises for an ordinary member and returns true for the fleet", async () => {
		const t = await world();
		const member = await codeOf(
			t.withIdentity(session("client-org", "org:member")).run(async (ctx) => {
				const scope = await withOrgScope(ctx);
				return await requireFleetDoor(ctx, scope, "test:door", { masterOnly: true });
			}),
		);
		expect(member).toMatch(/not-fleet-master/);
		const fleet = await t.withIdentity(service).run(async (ctx) => {
			const scope = await withOrgScope(ctx);
			return await requireFleetDoor(ctx, scope, "test:door", { masterOnly: true });
		});
		expect(fleet).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("requireResolvedCaller — a self-contradicting scope is not master", () => {
	const base = {
		orgSlug: null,
		anonymous: undefined,
		refused: undefined,
	};
	const refusal = (scope: Parameters<typeof requireResolvedCaller>[0]) => {
		try {
			requireResolvedCaller(scope, "test:door", { masterOnly: true });
		} catch (e) {
			return e instanceof ConvexError ? refusalText(e.data) : "OTHER";
		}
		return "NO_ERROR";
	};

	test("PRESENT: the fleet and the operator human pass", () => {
		expect(
			refusal({ ...base, isMaster: true, fleetWide: true, masterSource: "service-account" }),
		).toBe("NO_ERROR");
		expect(
			refusal({ ...base, isMaster: true, fleetWide: true, masterSource: "operator-admin" }),
		).toBe("NO_ERROR");
	});

	test("REFUSED: a scope claiming master without agreeing fleetWide / masterSource does not pass a master-only door", () => {
		expect(
			refusal({ ...base, isMaster: true, fleetWide: false, masterSource: "service-account" }),
		).toMatch(/not-fleet-master/);
		expect(refusal({ ...base, isMaster: true, fleetWide: true })).toMatch(
			/not-fleet-master/,
		);
	});

	test("ABSENT: an anonymous caller is refused by raising", () => {
		expect(refusal({ ...base, isMaster: false, fleetWide: false, anonymous: true })).toMatch(
			/no-credential/,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("requireOrgAdmin — the session goes to the package, an absent one is refused there", () => {
	test("REFUSED: an anonymous caller is refused with the door named in the payload", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const out = await codeOf(t.run((ctx) => requireOrgAdmin(ctx, "org-a")));
		expect(out).toMatch(/^RBAC_DENIED/);
		expect(out).toContain("lib/auth:requireOrgAdmin");
	});

	test("PRESENT: the admin of the org passes; a member and the admin of another org are refused", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		expect(
			await codeOf(
				t.withIdentity(session("org-a", "org:admin")).run((ctx) => requireOrgAdmin(ctx, "org-a")),
			),
		).toBe("NO_ERROR");
		expect(
			await codeOf(
				t.withIdentity(session("org-a", "org:member")).run((ctx) => requireOrgAdmin(ctx, "org-a")),
			),
		).toMatch(/^RBAC_DENIED/);
		expect(
			await codeOf(
				t.withIdentity(session("org-b", "org:admin")).run((ctx) => requireOrgAdmin(ctx, "org-a")),
			),
		).toMatch(/^RBAC_DENIED/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("listedAgentsOfOrg — the roster lists agents of its own organisation only", () => {
	test("PRESENT/REFUSED: the listed active agent is returned; an inactive, an unlisted and a foreign one are dropped", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const listed = await seedAgent(t, "org-a", "listed");
		const retired = await seedAgent(t, "org-a", "retired", { isActive: false });
		const foreign = await seedAgent(t, "org-b", "foreign");
		const out = await t.run((ctx) =>
			listedAgentsOfOrg(ctx, "org-a", [listed, retired, foreign], "test"),
		);
		expect(out.map((a) => a._id)).toEqual([listed]);
	});

	test("ABSENT: an empty roster lists nobody", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		expect(await t.run((ctx) => listedAgentsOfOrg(ctx, "org-a", [], "test"))).toEqual([]);
	});
});
