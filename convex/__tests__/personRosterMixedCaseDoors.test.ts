/// <reference types="vite/client" />
/**
 * VantagePeers Cloud, task k1726h1v7hqdbk818bn8s1rgdx8hy0ts, the class beyond tasks.
 *
 * Every orchestrator label a door WRITES is normalised (lowercase, NFC), while an
 * org roster holds the agent's exact stored name ("Ada"). Any door that decides
 * with an exact `allowedOrchestrators.includes(label)` locks a mixed-case consent
 * agent out of its own org. Door families here: messages (listByChannel, the
 * channel roster) and profiles (getProfile, the requested orchestrator).
 * Caller as the MCP builds it: the service account acting for the org.
 *
 * Poles: OWN (served) / FOREIGN (a name on no roster of this org still refused,
 * another org's mixed-case name is not admitted by the normalised match).
 */

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
			!path.includes("backfill"),
	),
);

const SERVICE = "test-service-account-user-id";
const A = "vp-directory-review";
const B = "other-client-org";
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seed(t: T) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const agents: Record<string, Id<"agents">> = {};
		for (const [slug, names] of [
			[A, ["Ada", "Bram"]],
			[B, ["Cleo"]],
		] as const) {
			const ids: Id<"agents">[] = [];
			for (const name of names) {
				const id = await ctx.db.insert("agents", {
					orgSlug: slug,
					clerkOrgId: testClerkOrgId(slug),
					name,
					normalizedName: name.toLowerCase(),
					isActive: true,
					createdAt: now,
				});
				ids.push(id);
				agents[name] = id;
			}
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [...names],
				allowedAgentIds: ids,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				orgKind: "client",
				createdAt: now,
			});
		}
		await ctx.db.insert("messages", {
			from: "bram",
			channel: "bram",
			content: "to bram",
			createdAt: now,
			tenantId: A,
			tenantOrgId: testClerkOrgId(A),
		} as never);
		await ctx.db.insert("profiles", {
			orchestratorId: "ada",
			agentId: agents.Ada,
			instanceId: "ada-main",
			name: "Ada profile",
			static: { role: "r", workspace: "w", capabilities: [] },
			dynamic: { lastSeen: 1, sessionCount: 1 },
		});
		return agents;
	});
}

const acting = (_t: T, slug: string) => (args: Record<string, unknown>) => ({
	...args,
	__actingOrg: testClerkOrgId(slug),
});

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const d = (e as { data?: unknown }).data;
		const text = typeof d === "string" ? d : String(e);
		const m = /([A-Z][A-Z_]{3,}):/.exec(text);
		return m ? m[1] : `OTHER(${text.slice(0, 120)})`;
	}
}

describe("messages:listByChannel, channel roster", () => {
	test("OWN: the org reads the channel named by a normalised roster name", async () => {
		const t = createT();
		await seed(t);
		const withA = acting(t, A);
		const rows = (await t
			.withIdentity({ subject: SERVICE })
			.query(
				api.messages.listByChannel,
				withA({ channel: "bram" }) as never,
			)) as unknown[];
		expect(rows).toHaveLength(1);
	});
	test("FOREIGN: the other org reads nothing from that channel", async () => {
		const t = createT();
		await seed(t);
		const rows = (await t
			.withIdentity({ subject: SERVICE })
			.query(
				api.messages.listByChannel,
				acting(t, B)({ channel: "bram" }) as never,
			)) as unknown[];
		expect(rows).toEqual([]);
	});
});

describe("profiles:getProfile, requested orchestrator on the roster", () => {
	test("OWN: the consent agent reads its profile by the normalised name", async () => {
		const t = createT();
		const ag = await seed(t);
		const got = await t.withIdentity({ subject: SERVICE }).query(
			api.profiles.getProfile,
			acting(
				t,
				A,
			)({
				orchestratorId: "ada",
				verifiedActor: { agentId: ag.Ada, orgSlug: A },
			}) as never,
		);
		expect(got).not.toBeNull();
	});
	test("FOREIGN: a name on no roster of the org is still refused", async () => {
		const t = createT();
		const ag = await seed(t);
		expect(
			await code(
				t.withIdentity({ subject: SERVICE }).query(
					api.profiles.getProfile,
					acting(
						t,
						A,
					)({
						orchestratorId: "cleo",
						verifiedActor: { agentId: ag.Ada, orgSlug: A },
					}) as never,
				),
			),
		).toBe("RBAC_DENIED");
	});
});
