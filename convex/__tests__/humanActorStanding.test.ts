/// <reference types="vite/client" />
/**
 * resolveHumanActor — the STANDING decision (@vantageos/cloud-identity's
 * resolveCallerStanding) is not the same as the local `orgSlug === null` check.
 *
 * `withOrgScope` already refuses a session whose org ID resolves no active
 * mapping, so a scope reaching resolveHumanActor from a plain member session
 * always carries an active, ID-stamped org. The package standing is what decides
 * for a scope assembled any other way (an acting-for scope, a recipient scope,
 * a mapping deactivated or unstamped between the scope read and the decision):
 * it carries an org SLUG, so the local check passes, and only the standing
 * refuses. These poles call the function on exactly such scopes.
 *
 * POLES
 *   INACTIVE   slug set, orgClerkId names an INACTIVE mapping  -> refused
 *   NO ID      slug set, no orgClerkId (mapping row unstamped)  -> refused
 *   UNKNOWN ID slug set, orgClerkId names no mapping            -> refused
 *   SERVED     the same member, active ID-stamped mapping       -> acts as user:<sub>
 *
 * Backfill precondition (NO ID): migrations/backfill_org_clerk_id leaves a
 * mapping without clerkOrgId listed as `mappingHasNoClerkId` and never guesses;
 * withOrgScope already refuses such a mapping on every request path (the org is
 * selected by ID only), so refusing it here removes no grant a member holds.
 */

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { beforeEach, describe, expect, test } from "vitest";
import schema from "../schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { resolveHumanActor } from "../lib/humanActor";
import type { OrgScope } from "../lib/auth";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
let t: ReturnType<typeof createT>;

const SUB = "member-sub-1";

function scopeOf(
	over: Partial<OrgScope> & { orgSlug: string | null },
): OrgScope {
	return {
		userId: SUB,
		allowedOrchestrators: [],
		allowedAgentIds: [],
		fleetWide: false,
		scopes: ["vantage:read", "vantage:write"],
		isMaster: false,
		orgRole: "org:editor",
		...over,
	};
}

async function seedMapping(
	slug: string,
	opts: { isActive: boolean; withId: boolean },
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			...(opts.withId ? { clerkOrgId: testClerkOrgId(slug) } : {}),
			allowedOrchestrators: [],
			scopes: ["vantage:read", "vantage:write"],
			displayName: slug,
			isActive: opts.isActive,
			createdAt: Date.now(),
		});
	});
}

function resolve(scope: OrgScope): Promise<string> {
	return t.run((ctx) =>
		resolveHumanActor(ctx, scope, { door: "test:standing" }),
	);
}

async function refusal(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (err) {
		const data = (err as { data?: unknown }).data;
		return `${(err as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	}
	throw new Error("expected a refusal, the call was served");
}

beforeEach(async () => {
	t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
	});
});

describe("resolveHumanActor standing", () => {
	test("INACTIVE: a mapping that is not active refuses the member", async () => {
		await seedMapping("org-off", { isActive: false, withId: true });
		const text = await refusal(
			resolve(
				scopeOf({ orgSlug: "org-off", orgClerkId: testClerkOrgId("org-off") }),
			),
		);
		expect(text).toContain("RBAC_DENIED");
		expect(text).toContain("callerOrchestrator is required");
	});

	test("NO ID: a scope with a slug and no org ID refuses the member", async () => {
		await seedMapping("org-noid", { isActive: true, withId: false });
		const text = await refusal(resolve(scopeOf({ orgSlug: "org-noid" })));
		expect(text).toContain("RBAC_DENIED");
		expect(text).toContain("callerOrchestrator is required");
	});

	test("UNKNOWN ID: an org ID that no mapping holds refuses the member", async () => {
		const text = await refusal(
			resolve(
				scopeOf({
					orgSlug: "org-ghost",
					orgClerkId: testClerkOrgId("org-ghost"),
				}),
			),
		);
		expect(text).toContain("RBAC_DENIED");
		expect(text).toContain("callerOrchestrator is required");
	});

	test("SERVED: the same member with an active, ID-stamped mapping acts", async () => {
		await seedMapping("org-on", { isActive: true, withId: true });
		const actor = await resolve(
			scopeOf({ orgSlug: "org-on", orgClerkId: testClerkOrgId("org-on") }),
		);
		expect(actor).toBe(`user:${SUB}`);
	});
});
