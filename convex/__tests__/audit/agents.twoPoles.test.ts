/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { testClerkOrgId } from "../../../tests/fixtures/testClerkOrgId";
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const NOW = 1_700_000_000_000;
const asService = (t: T) =>
	t.withIdentity({ subject: process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string });
const asMember = (t: T, org: string, role = "org:member") =>
	t.withIdentity({
		subject: `user-${org}-${role}`,
		organizationSlug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Parameters<T["withIdentity"]>[0]);
const mapping = (
	t: T,
	slug: string,
	names: string[],
	scopes: string[],
	allowedAgentIds?: Id<"agents">[],
) =>
	t.run((ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: names,
			// M1: the roster is stored by agent ID (rosters by ID); the names stay beside it.
			...(allowedAgentIds !== undefined ? { allowedAgentIds } : {}),
			scopes,
			displayName: slug,
			isActive: true,
			createdAt: NOW,
		}),
	);

import { normalizeOrchestratorId } from "../../_helpers/normalizeOrchestratorId";
// RED reproduction, group R5 — agents:renameAgent. Origin: inboxByAgentId.test.ts world, orgRoster.getMyAgentDirectory.
describe("agents:renameAgent", () => {
	test("agents:renameAgent — after an admin renames a rostered agent, the agent stays addressable (directory still gives its agent ID) (identity: Clerk org:admin of client-c)", async () => {
		const t = createT();
		const ada = await t.run((ctx) =>
			ctx.db.insert("agents", { orgSlug: "client-c", name: "ada", normalizedName: normalizeOrchestratorId("ada"), isActive: true, createdAt: NOW }),
		);
		await mapping(t, "client-c", ["ada"], ["view-own-tasks"], [ada]);
		const before = await asMember(t, "client-c", "org:admin").query(api.orgRoster.getMyAgentDirectory, {});
		expect(before.find((e) => e.agentId === ada), "positive control: addressable before rename").toBeDefined();
		await asMember(t, "client-c", "org:admin").mutation(api.agents.renameAgent, { orgSlug: "client-c", agentId: ada, newName: "ada2" });
		const after = await asMember(t, "client-c", "org:admin").query(api.orgRoster.getMyAgentDirectory, {});
		expect(after.find((e) => e.agentId === ada), "renamed agent dropped out of the directory (roster not updated)").toBeDefined();
	});
});
