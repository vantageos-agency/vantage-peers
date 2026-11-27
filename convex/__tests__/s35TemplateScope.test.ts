/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k177e1a9wfz01c1f0h4y4bgz3s8k11m6 (mcp-server-standard
// S-35: the scope is applied INSIDE the read, never after).
//
// `missionTemplates:getByName` was marked "fleet-master-only, nothing to scope",
// but a member reads its own templates today: the MCP calls the door as the fleet
// service account and narrows afterwards in get_mission_template with
// `scopeFilterGet`. The visibility rule of that filter, for a template row (which
// carries `createdBy` and no `namespace`), is: the row passes when its `createdBy`
// is on the caller's roster (`fromAllowList`, compared on the normalised label).
// The door now takes `verifiedOrg` and applies the same rule against the verified
// organisation's roster inside the read.
//
// Poles:
//   PRESENT   verifiedOrg A reads a template created by an orchestrator on A's roster
//   REFUSED   verifiedOrg A gets null (the door's existing "not found") for a template
//             created by an orchestrator that is not on A's roster
//   CLAIMLESS (expand only) the service account with no verifiedOrg reads as before
//   MEMBER    an ordinary member without verifiedOrg is refused as before (masterOnly)
//   PARITY    the door's verdict equals the MCP filter's verdict on the same rows

import { passesScopeFilter } from "@vantageos/cloud-identity";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const NOW = 1_700_000_000_000;
const A_ID = "org_S35TA1";
const B_ID = "org_S35TB1";
const A_SLUG = "s35t-a";
const B_SLUG = "s35t-b";
const A_SEAT = "seat-a";
const B_SEAT = "seat-b";
const OWN = "tpl-own";
const FOREIGN = "tpl-foreign";

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMemberOfA = (t: T) =>
	t.withIdentity({
		subject: "user-s35t-a",
		organizationSlug: A_SLUG,
		org_id: A_ID,
		org_role: "org:editor",
	} as Identity);
const claimA = { orgSlug: A_SLUG, orgId: A_ID };

async function world() {
	const t = createT();
	await t.run(async (ctx) => {
		const mapping = (slug: string, id: string, seat: string) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: [seat],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
			});
		await mapping(A_SLUG, A_ID, A_SEAT);
		await mapping(B_SLUG, B_ID, B_SEAT);
		const template = (name: string, createdBy: string) =>
			ctx.db.insert("missionTemplates", {
				name,
				steps: [{ title: "s", description: "d" }],
				isDefault: false,
				createdBy,
				createdAt: NOW,
				updatedAt: NOW,
			});
		await template(OWN, A_SEAT);
		await template(FOREIGN, B_SEAT);
	});
	return t;
}

describe("missionTemplates:getByName applies the verified org inside the read", () => {
	test("PRESENT: verifiedOrg A reads a template created by a seat on A's roster", async () => {
		const t = await world();
		const r = await asService(t).query(api.missionTemplates.getByName, {
			name: OWN,
			verifiedOrg: claimA,
		});
		expect(r?.name).toBe(OWN);
	});
	test("REFUSED: verifiedOrg A gets null for a template created by a seat outside A's roster", async () => {
		const t = await world();
		const r = await asService(t).query(api.missionTemplates.getByName, {
			name: FOREIGN,
			verifiedOrg: claimA,
		});
		expect(r).toBeNull();
	});
	test("CLAIMLESS (expand): the service account with no verifiedOrg reads any template as before", async () => {
		const t = await world();
		const own = await asService(t).query(api.missionTemplates.getByName, { name: OWN });
		const foreign = await asService(t).query(api.missionTemplates.getByName, {
			name: FOREIGN,
		});
		expect(own?.name).toBe(OWN);
		expect(foreign?.name).toBe(FOREIGN);
	});
	test("MEMBER: an ordinary member without verifiedOrg is refused as before", async () => {
		const t = await world();
		await expect(
			asMemberOfA(t).query(api.missionTemplates.getByName, { name: OWN }),
		).rejects.toThrow();
	});
	test("PARITY: the door's verdict equals the MCP scopeFilterGet verdict on an admitted and a refused row", async () => {
		const t = await world();
		const mcpCtx = {
			scope: "team-member",
			fromAllowList: [A_SEAT],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
		};
		for (const [name, createdBy] of [
			[OWN, A_SEAT],
			[FOREIGN, B_SEAT],
		] as const) {
			const mcpAdmits = passesScopeFilter(mcpCtx, { createdBy });
			const door = await asService(t).query(api.missionTemplates.getByName, {
				name,
				verifiedOrg: claimA,
			});
			expect(door !== null).toBe(mcpAdmits);
		}
	});
});
