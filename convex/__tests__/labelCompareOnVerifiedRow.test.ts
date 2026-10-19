/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * Deletion series slice 2a (task k1778c2hvae8e8vz9f5bbbbbb98g62hw): an asserted
 * label is compared with the label of the row ALREADY resolved by ID. No table
 * read by name takes part, and the label never selects anybody.
 *
 * SITES (each with three poles; the label compare is `normalizeOrchestratorId`
 * on both sides, exactly the rule `findAgentByName` applied to the stored name):
 *   1. requireVerifiedActorMatch   (convex/lib/auth.ts, verifiedActor proof)
 *   2. requireAgentCredentialMatch (convex/lib/auth.ts, secret presented)
 *   3. agentReader                 (convex/lib/inboxReader.ts, recipient beside a verifiedActor)
 *   4. messages:sendMessage        (a proven sender is not re-screened by name)
 *
 * POLES
 *   OWN      the resolved agent's own label passes
 *   OTHER    another agent's label is refused with the unchanged code
 *   SPACING  a label differing only by case / padding behaves as before: passes
 *   NO-NAME  (sites 1, 2) no `agents` index keyed by a name is read
 *   DUPLICATE a legacy second row of the same label no longer turns the
 *            verified row's own label into a refusal
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { ownAgent } from "../../tests/lib/ownAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { requireAgentCredentialMatch } from "../lib/auth";
import schema from "../schema";

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

const NOW = 1_700_000_000_000;
const ORG_A = "org-a";
const ORG_B = "org-b";

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);
const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

type World = {
	t: T;
	alpha: Id<"agents">;
	bravo: Id<"agents">;
	zedFirst: Id<"agents">;
	zedSecond: Id<"agents">;
};

async function world(): Promise<World> {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		const mapping = (slug: string, names: string[]) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: names,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
			});
		await mapping(ORG_A, ["alpha", "peer"]);
		await mapping(ORG_B, ["bravo"]);
		await mapping("dup-org", ["zed"]);
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		for (const name of ["alpha", "peer"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: name,
				name,
				static: { role: name, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: NOW, sessionCount: 1 },
			});
		}
		const alpha = await agent(ORG_A, "alpha");
		await agent(ORG_A, "peer");
		const bravo = await agent(ORG_B, "bravo");
		// Legacy duplicate label in one org: two rows, one label. Inserted in this
		// order the by-name lookup returns the FIRST row.
		const zedFirst = await agent("dup-org", "zed");
		const zedSecond = await agent("dup-org", "zed");
		return { alpha, bravo, zedFirst, zedSecond };
	});
	return { t, ...ids };
}

// Records every index an `agents` query is opened with.
function spyOnIndexes<C extends { db: unknown }>(
	ctx: C,
	used: string[],
): C {
	// biome-ignore lint/suspicious/noExplicitAny: a test spy over the db reader
	const db = ctx.db as any;
	const wrapQuery = (q: any): any =>
		new Proxy(q, {
			get(target, prop) {
				if (prop === "withIndex") {
					return (name: string, ...rest: unknown[]) => {
						used.push(name);
						return wrapQuery(target.withIndex(name, ...rest));
					};
				}
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	const spyDb = new Proxy(db, {
		get(target, prop) {
			if (prop === "query") {
				return (table: string) => wrapQuery(target.query(table));
			}
			const value = Reflect.get(target, prop);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { ...ctx, db: spyDb };
}

const NAME_INDEXES = ["by_org_normalized_name", "by_org_name"];

async function outcome(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "NO_ERROR";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		return (text.replace(/^"/, "").split(":")[0]) ?? text;
	}
}

const serviceAccountProof = (agentId: Id<"agents">, orgSlug: string) => ({
	scope: { isMaster: true, masterSource: "service-account" as const },
	verifiedActor: { agentId, orgSlug },
});

describe("site 1: requireVerifiedActorMatch compares against the loaded row", () => {
	test("OWN: the verified agent's own label passes", async () => {
		const { t, alpha } = await world();
		const got = await t.run((ctx) =>
			outcome(
				requireAgentCredentialMatch(ctx, undefined, "alpha", null, serviceAccountProof(alpha, ORG_A)),
			),
		);
		expect(got).toBe("NO_ERROR");
	});
	test("OTHER: another agent's label is refused AGENT_IDENTITY_MISMATCH", async () => {
		const { t, alpha } = await world();
		const got = await t.run((ctx) =>
			outcome(
				requireAgentCredentialMatch(ctx, undefined, "bravo", null, serviceAccountProof(alpha, ORG_A)),
			),
		);
		expect(got).toBe("AGENT_IDENTITY_MISMATCH");
	});
	test("SPACING: case and padding pass, as before (NFC, lowercase, trim)", async () => {
		const { t, alpha } = await world();
		const got = await t.run((ctx) =>
			outcome(
				requireAgentCredentialMatch(ctx, undefined, "  ALPHA ", null, serviceAccountProof(alpha, ORG_A)),
			),
		);
		expect(got).toBe("NO_ERROR");
	});
	test("NO-NAME: no name-keyed agents index is read", async () => {
		const { t, alpha } = await world();
		const used: string[] = [];
		await t.run((ctx) =>
			outcome(
				requireAgentCredentialMatch(spyOnIndexes(ctx, used), undefined, "alpha", null, serviceAccountProof(alpha, ORG_A)),
			),
		);
		expect(used.filter((i) => NAME_INDEXES.includes(i))).toEqual([]);
	});
	test("DUPLICATE: the second row of a duplicated label passes under its own label", async () => {
		const { t, zedSecond } = await world();
		const got = await t.run((ctx) =>
			outcome(
				requireAgentCredentialMatch(ctx, undefined, "zed", null, serviceAccountProof(zedSecond, "dup-org")),
			),
		);
		expect(got).toBe("NO_ERROR");
	});
});

describe("site 2: requireAgentCredentialMatch (secret) compares against the resolved row", () => {
	async function withSecret() {
		const w = await world();
		await adminOf(w.t, ORG_A).mutation(api.agents.registerAgent, {
			orgSlug: ORG_A,
			name: "clio",
		});
		const minted = await adminOf(w.t, ORG_A).mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: ORG_A, agentId: await agentIdOf(w.t, ORG_A, "clio") },
		);
		await ownAgent(w.t, ORG_A, "clio");
		return { ...w, secret: minted.secret };
	}
	const none = { scope: { isMaster: false }, verifiedActor: undefined };

	test("OWN: the credential holder under its own label passes", async () => {
		const { t, secret } = await withSecret();
		expect(
			await t.run((ctx) => outcome(requireAgentCredentialMatch(ctx, secret, "clio", ORG_A, none))),
		).toBe("NO_ERROR");
	});
	test("OTHER: the holder under another agent's label is refused AGENT_IDENTITY_MISMATCH", async () => {
		const { t, secret } = await withSecret();
		expect(
			await t.run((ctx) => outcome(requireAgentCredentialMatch(ctx, secret, "alpha", ORG_A, none))),
		).toBe("AGENT_IDENTITY_MISMATCH");
	});
	test("SPACING: case and padding pass, as before", async () => {
		const { t, secret } = await withSecret();
		expect(
			await t.run((ctx) => outcome(requireAgentCredentialMatch(ctx, secret, " CLIO", ORG_A, none))),
		).toBe("NO_ERROR");
	});
	test("NO-NAME: no name-keyed agents index is read once a secret is presented", async () => {
		const { t, secret } = await withSecret();
		const used: string[] = [];
		await t.run((ctx) =>
			outcome(requireAgentCredentialMatch(spyOnIndexes(ctx, used), secret, "clio", ORG_A, none)),
		);
		expect(used.filter((i) => NAME_INDEXES.includes(i))).toEqual([]);
	});
});

describe("site 3: agentReader compares a recipient label against the verified reader", () => {
	const read = async (t: T, agentId: Id<"agents">, orgSlug: string, recipient: string) =>
		await outcome(
			asServiceAccount(t).query(api.messages.checkNewMessages, {
				recipient,
				verifiedActor: { agentId, orgSlug },
			} as never),
		);

	test("OWN: the reader's own label passes", async () => {
		const { t, alpha } = await world();
		expect(await read(t, alpha, ORG_A, "alpha")).toBe("NO_ERROR");
	});
	test("OTHER: another agent's label is refused RBAC_DENIED recipient-not-the-reader", async () => {
		const { t, alpha } = await world();
		await expect(
			asServiceAccount(t).query(api.messages.checkNewMessages, {
				recipient: "bravo",
				verifiedActor: { agentId: alpha, orgSlug: ORG_A },
			} as never),
		).rejects.toThrow(/RBAC_DENIED.*recipient-not-the-reader/);
	});
	test("SPACING: case and padding pass, as before", async () => {
		const { t, alpha } = await world();
		expect(await read(t, alpha, ORG_A, " Alpha ")).toBe("NO_ERROR");
	});
	test("DUPLICATE: the second row of a duplicated label reads under its own label", async () => {
		const { t, zedSecond } = await world();
		expect(await read(t, zedSecond, "dup-org", "zed")).toBe("NO_ERROR");
	});
});

describe("site 4: sendMessage does not re-screen a proven sender by name", () => {
	const sendAs = async (from: string) => {
		const { t, alpha } = await world();
		return await outcome(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from,
				channel: "peer",
				content: "x",
				seatOrgSlug: ORG_A,
				verifiedActor: { agentId: alpha, orgSlug: ORG_A },
			}),
		);
	};

	test("OWN: the verified sender under its own label is delivered", async () => {
		expect(await sendAs("alpha")).toBe("NO_ERROR");
	});
	test("OTHER: another org's identity is refused by the proof compare (AGENT_IDENTITY_MISMATCH)", async () => {
		expect(await sendAs("bravo")).toBe("AGENT_IDENTITY_MISMATCH");
	});
	test("SPACING: case and padding pass, as before", async () => {
		expect(await sendAs(" ALPHA")).toBe("NO_ERROR");
	});
	test("UNPROVEN: with no proof, the seat screening still refuses a foreign identity", async () => {
		const { t } = await world();
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "bravo",
				channel: "peer",
				content: "x",
				seatOrgSlug: ORG_A,
			}),
		).rejects.toThrow(/seat-sender-foreign-identity/);
	});
});
