/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17edzy4wpq0ng4cbytgj8ev6n8k0hsd (mcp-server-standard
// S-35: the scope is applied INSIDE the read, never after).
//
// One MCP caller class still reaches `missionTemplates:getByName` with no
// `verifiedOrg`: a non-master bearer with no resolvable organisation but a
// non-empty roster. The MCP narrowed that read AFTER it, with `scopeFilterGet`
// on the caller's own roster. The door now takes that roster as `callerRoster`
// and decides inside the read, with the SAME predicate (`passesScopeFilter`).
//
// Poles:
//   PRESENT    callerRoster names the template's creator -> the row
//   REFUSED    callerRoster does not name it -> null
//   NORMALISED the roster compares on the package's normalised label
//   EMPTY      an empty roster names nobody -> null
//   IGNORED    a caller that is not the service account gets its unchanged answer
//   PRECEDENCE verifiedOrg decides when both are carried
//   UNCHANGED  no arguments -> the claimless service-account read as before
//   PARITY     the door's verdict equals the MCP filter's on the same rows

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
const A_ID = "org_S35RA1";
const A_SLUG = "s35r-a";
const A_SEAT = "seat-a";
const B_SEAT = "seat-b";
const OWN = "tpl-own";
const FOREIGN = "tpl-foreign";

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMemberOfA = (t: T) =>
	t.withIdentity({
		subject: "user-s35r-a",
		organizationSlug: A_SLUG,
		org_id: A_ID,
		org_role: "org:editor",
	} as Identity);
const claimA = { orgSlug: A_SLUG, orgId: A_ID };

async function world() {
	const t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: A_SLUG,
			clerkOrgId: A_ID,
			allowedOrchestrators: [A_SEAT],
			scopes: ["view-own-tasks"],
			displayName: A_SLUG,
			isActive: true,
			createdAt: NOW,
		});
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

describe("missionTemplates:getByName applies the caller's roster inside the read", () => {
	test("PRESENT: callerRoster naming the creator returns the row", async () => {
		const t = await world();
		const r = await asService(t).query(api.missionTemplates.getByName, {
			name: OWN,
			callerRoster: [A_SEAT],
		});
		expect(r?.name).toBe(OWN);
	});
	test("REFUSED: callerRoster not naming the creator returns null", async () => {
		const t = await world();
		const r = await asService(t).query(api.missionTemplates.getByName, {
			name: FOREIGN,
			callerRoster: [A_SEAT],
		});
		expect(r).toBeNull();
	});
	test("NORMALISED: the roster compares on the normalised label", async () => {
		const t = await world();
		const r = await asService(t).query(api.missionTemplates.getByName, {
			name: OWN,
			callerRoster: ["  Seat-A "],
		});
		expect(r?.name).toBe(OWN);
	});
	test("EMPTY: an empty roster names nobody", async () => {
		const t = await world();
		const r = await asService(t).query(api.missionTemplates.getByName, {
			name: OWN,
			callerRoster: [],
		});
		expect(r).toBeNull();
	});
	test("IGNORED: a caller that is not the service account is refused as before, roster or not", async () => {
		const t = await world();
		await expect(
			asMemberOfA(t).query(api.missionTemplates.getByName, {
				name: OWN,
				callerRoster: [B_SEAT],
			}),
		).rejects.toThrow();
		await expect(
			asMemberOfA(t).query(api.missionTemplates.getByName, { name: OWN }),
		).rejects.toThrow();
	});
	test("PRECEDENCE: verifiedOrg decides when both are carried", async () => {
		const t = await world();
		// the org's roster admits OWN; the presented roster would refuse it
		const own = await asService(t).query(api.missionTemplates.getByName, {
			name: OWN,
			verifiedOrg: claimA,
			callerRoster: [B_SEAT],
		});
		expect(own?.name).toBe(OWN);
		// the presented roster would admit FOREIGN; the org's roster refuses it
		const foreign = await asService(t).query(api.missionTemplates.getByName, {
			name: FOREIGN,
			verifiedOrg: claimA,
			callerRoster: [B_SEAT],
		});
		expect(foreign).toBeNull();
	});
	test("WILDCARD: a \"*\" entry passes, as in the MCP's scopeFilterGet (its deprecated master signal)", async () => {
		const t = await world();
		const r = await asService(t).query(api.missionTemplates.getByName, {
			name: OWN,
			callerRoster: ["*"],
		});
		expect(r?.name).toBe(OWN);
	});
	test("UNCHANGED: no arguments reads any template as before", async () => {
		const t = await world();
		const own = await asService(t).query(api.missionTemplates.getByName, { name: OWN });
		const foreign = await asService(t).query(api.missionTemplates.getByName, {
			name: FOREIGN,
		});
		expect(own?.name).toBe(OWN);
		expect(foreign?.name).toBe(FOREIGN);
	});
	test("PARITY: the door's verdict equals the MCP scopeFilterGet verdict", async () => {
		const t = await world();
		for (const roster of [[A_SEAT], [B_SEAT], [], ["Seat-A", "x"]]) {
			const mcpCtx = {
				scope: "team-member",
				fromAllowList: roster,
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
			};
			for (const [name, createdBy] of [
				[OWN, A_SEAT],
				[FOREIGN, B_SEAT],
			] as const) {
				const door = await asService(t).query(api.missionTemplates.getByName, {
					name,
					callerRoster: roster,
				});
				expect(door !== null).toBe(passesScopeFilter(mcpCtx, { createdBy }));
			}
		}
	});
});
