/// <reference types="vite/client" />
/**
 * VantagePeers Cloud — task k177e8dyrnykk3c56yf2b0pgfs8hhz06.
 *
 * An AGENT-LESS person family stays agent-less forever if nothing re-runs consent:
 * a refresh never shows the consent page. A family minted before the consent fixes
 * (the agent picker did not list the person's own agent, so the connection fell to
 * "connect as myself") therefore never reaches its agent.
 *
 * The rule: a refresh of an agent-less person family is refused (OAuth
 * `invalid_grant` at /token, `refused / agent-choice-pending` here, the family
 * revoked) when the person NOW has a choice the consent page would offer — an agent
 * of its own ("mine": designated to the person, active, in the same organisation)
 * or the right to create one (an organisation admin) — and the family's consent
 * did not already decline such an offer. The client then re-runs authorization and
 * the person meets the consent page.
 *
 * Poles:
 *   REFUSE  legacy agent-less family, the person has its own agent
 *   REFUSE  legacy agent-less family, the person is an organisation admin
 *   ADMIT   legacy agent-less family, nothing to choose (a plain member, no agent)
 *   ADMIT   a consent that DECLINED an offered agent ("connect as myself" posted
 *           while the picker listed one): stamped at putPersonCode, carried by
 *           every rotation, so an explicit choice is never re-asked
 *   ADMIT   a family bound to an agent refreshes unchanged
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

const SERVICE_ACCOUNT_ID = "test-service-account-user-id";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

const SLUG = "org-pac";
const ORG_ID = testClerkOrgId(SLUG) as string;
const PERSON = "user_pac";
const DAY = 86_400_000;

async function world(t: T, opts: { ownAgent: boolean }) {
	return await t.run(async (ctx) => {
		const agent = opts.ownAgent
			? await ctx.db.insert("agents", {
					orgSlug: SLUG,
					clerkOrgId: ORG_ID,
					name: "ulysse",
					normalizedName: "ulysse",
					personalAgentOf: PERSON,
					isActive: true,
					createdAt: Date.now(),
				})
			: null;
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_ID,
			allowedOrchestrators: ["ulysse"],
			...(agent !== null ? { allowedAgentIds: [agent] } : {}),
			scopes: ["view-own-tasks"],
			displayName: SLUG,
			isActive: true,
			createdAt: Date.now(),
		});
		await ctx.db.insert("orgMembership", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_ID,
			clerkUserId: PERSON,
			role: "member",
			createdAt: 1,
			updatedAt: 1,
			lastEventAt: 1,
		});
		return agent;
	});
}

let n = 0;
const record = (role: string) => {
	n += 1;
	return {
		codeHash: sha(`pac-code-${n}`),
		clerkUserId: PERSON,
		orgId: ORG_ID,
		orgSlug: SLUG,
		orgRole: role,
		clientId: "dcr-client",
		redirectUri: "https://client.example/cb",
		codeChallenge: "c",
		resource: "r",
		scope: "mcp:full",
		expiresAt: Date.now() + 60_000,
	};
};

/**
 * Mint a person family. `legacy`: the code row is written the way a family minted
 * before the consent fixes carries it (connectedAs, nothing else). Otherwise the
 * real consent door (`putPersonCode`) writes it, with `agentId` as the choice.
 */
async function issue(
	t: T,
	opts: { role?: string; legacy?: boolean; agentId?: Id<"agents"> | null },
) {
	const role = opts.role ?? "org:member";
	const rec = record(role);
	if (opts.legacy === true) {
		await t.run((ctx) =>
			ctx.db.insert("oauth_person_codes", {
				...rec,
				connectedAs: "person" as const,
			}),
		);
	} else {
		await asService(t).mutation(api.oauth.putPersonCode, {
			record: rec,
			...(opts.agentId
				? { choice: { kind: "existing" as const, agentId: opts.agentId } }
				: {}),
		});
	}
	const refresh = `pac-refresh-${n}`;
	await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash: sha(`pac-access-${n}`),
		clientId: "dcr-client",
		userId: PERSON,
		scopes: ["view-own-tasks", "mcp:full"],
		scopeProfile: "team-member",
		fromAllowList: ["ulysse"],
		namespaceReadPrefixes: [`team/${SLUG}`],
		namespaceWritePrefixes: [`team/${SLUG}`],
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug: SLUG,
		orgRole: role,
		principal: "person",
		codeHash: rec.codeHash,
		refreshTokenHash: sha(refresh),
		personRefresh: {
			expiresAt: Date.now() + 30 * DAY,
			requestedScopes: ["mcp:full"],
		},
	});
	return refresh;
}

const rotate = (t: T, raw: string) =>
	asService(t).mutation(api.oauth.rotateRefreshToken, {
		presentedHash: sha(raw),
		clientId: "dcr-client",
		accessExpiresAt: Date.now() + 3_600_000,
		refreshExpiresAt: Date.now() + 30 * DAY,
	});

describe("an agent-less person family meets the consent page again when it has a choice", () => {
	test("REFUSE: legacy agent-less family, the person now has its own agent", async () => {
		const t = createT();
		await world(t, { ownAgent: true });
		const refresh = await issue(t, { legacy: true });
		const out = await rotate(t, refresh);
		expect(out).toEqual({ status: "refused", reason: "agent-choice-pending" });
		// The family is revoked: the same token is now a replay, never a second chance.
		expect((await rotate(t, refresh)).status).not.toBe("ok");
	});

	test("REFUSE: legacy agent-less family, the person is an organisation admin (may create one)", async () => {
		const t = createT();
		await world(t, { ownAgent: false });
		const refresh = await issue(t, { legacy: true, role: "org:admin" });
		expect(await rotate(t, refresh)).toEqual({
			status: "refused",
			reason: "agent-choice-pending",
		});
	});

	test("ADMIT: legacy agent-less family with nothing to choose (plain member, no agent)", async () => {
		const t = createT();
		await world(t, { ownAgent: false });
		const refresh = await issue(t, { legacy: true });
		expect((await rotate(t, refresh)).status).toBe("ok");
	});

	test("ADMIT: a consent that declined an offered agent is never re-asked, across rotations", async () => {
		const t = createT();
		await world(t, { ownAgent: true });
		const refresh = await issue(t, { agentId: null });
		const first = await rotate(t, refresh);
		expect(first.status).toBe("ok");
		if (first.status !== "ok") return;
		expect((await rotate(t, first.issued.refresh)).status).toBe("ok");
	});

	test("ADMIT: a family bound to an agent refreshes unchanged", async () => {
		const t = createT();
		const agent = await world(t, { ownAgent: true });
		const refresh = await issue(t, { agentId: agent });
		expect((await rotate(t, refresh)).status).toBe("ok");
	});
});
