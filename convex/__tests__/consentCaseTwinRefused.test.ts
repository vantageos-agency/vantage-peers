/// <reference types="vite/client" />
// VantagePeers Cloud, task k1726h1v7hqdbk818bn8s1rgdx8hy0ts. The roster compare is
// on the normalised name, so two agents of one org that differ only by case would
// read each other's rows. Agent creation refuses such a twin
// (assertAgentNameFree); this pins it on the consent create path, with the
// other org's identical label still allowed.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
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

const SERVICE = "test-service-account-user-id";
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedOrg(t: T, slug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const create = (t: T, slug: string, name: string, tag: string) =>
	t.withIdentity({ subject: SERVICE }).mutation(api.oauth.putPersonCode, {
		record: {
			codeHash: createHash("sha256").update(tag).digest("hex"),
			clerkUserId: "user_x",
			orgId: testClerkOrgId(slug),
			orgSlug: slug,
			orgRole: "org:admin",
			clientId: "client-x",
			redirectUri: "https://claude.ai/cb",
			codeChallenge: "c",
			resource: "https://mcp.example/mcp",
			scope: "mcp:full",
			expiresAt: Date.now() + 600_000,
		},
		choice: { kind: "create", name },
	});

const codeOf = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const d = (e as { data?: unknown }).data;
		const m = /([A-Z][A-Z_]{3,}):/.exec(typeof d === "string" ? d : String(e));
		return m ? m[1] : "OTHER";
	}
};

describe("case-twin agent labels in one org", () => {
	test("REFUSED: 'Ada' then 'ada' in the same org is AGENT_NAME_TAKEN, one agent row", async () => {
		const t = createT();
		await seedOrg(t, "twin-org");
		expect(await codeOf(create(t, "twin-org", "Ada", "c1"))).toBe("SERVED");
		expect(await codeOf(create(t, "twin-org", "ada", "c2"))).toBe(
			"AGENT_NAME_TAKEN",
		);
		const rows = await t.run((ctx) => ctx.db.query("agents").collect());
		expect(rows.filter((r) => r.orgSlug === "twin-org")).toHaveLength(1);
	});
	test("ALLOWED: the same label in ANOTHER org is a different agent", async () => {
		const t = createT();
		await seedOrg(t, "twin-org");
		await seedOrg(t, "other-org");
		expect(await codeOf(create(t, "twin-org", "Ada", "c1"))).toBe("SERVED");
		expect(await codeOf(create(t, "other-org", "ada", "c2"))).toBe("SERVED");
	});
});
