/// <reference types="vite/client" />
/**
 * One namespace-ownership rule for the memories table (module M10a/M14).
 *
 * storeMemory, storeMemoryScoped and the OKF export/import gate
 * (requireTenantNamespace) each judged "may this member use this namespace?"
 * by its own copy of the rule, so one write (`team/<orgClerkId>`) was admitted
 * by storeMemory and refused by the other two. They now share ONE predicate,
 * isTeamNamespaceAllowed (convex/lib/teamNamespace.ts). This suite pins that
 * the three doors agree, for every namespace shape, both poles.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import { isNamespaceAllowedForScope, requireTenantNamespace } from "../lib/auth";
import {
	isTeamNamespaceAllowed,
	teamNamespaceOf,
	teamNamespaceOrgRef,
} from "../lib/teamNamespace";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const ORG_ID = testClerkOrgId("org-a");
const OTHER_ID = testClerkOrgId("org-b");

const SHAPES: { namespace: string; admitted: boolean }[] = [
	{ namespace: teamNamespaceOf(ORG_ID), admitted: true },
	{ namespace: `${teamNamespaceOf(ORG_ID)}/notes`, admitted: true },
	{ namespace: "team/org-a", admitted: true }, // legacy slug alias of the same org
	{ namespace: "team/org-a/notes", admitted: true },
	{ namespace: `${teamNamespaceOf(ORG_ID)}x`, admitted: false },
	{ namespace: teamNamespaceOf(OTHER_ID), admitted: false },
	{ namespace: "team/org-ab", admitted: false },
	{ namespace: "team/other", admitted: false },
	{ namespace: "global", admitted: false },
	{ namespace: "team", admitted: false },
];

const member = {
	isMaster: false,
	orgSlug: "org-a" as string | null,
	orgClerkId: ORG_ID as string | undefined,
	anonymous: false,
	refused: false,
};

describe("teamNamespace — the shape helpers", () => {
	test("teamNamespaceOf builds team/<id> and teamNamespaceOrgRef reads the id segment back", () => {
		expect(teamNamespaceOf("org_x")).toBe("team/org_x");
		expect(teamNamespaceOrgRef("team/org_x")).toEqual({ id: "org_x" });
		expect(teamNamespaceOrgRef("team/org_x/a/b")).toEqual({ id: "org_x" });
		expect(teamNamespaceOrgRef("team")).toBeNull();
		expect(teamNamespaceOrgRef("team/")).toBeNull();
		expect(teamNamespaceOrgRef("global/org_x")).toBeNull();
	});
});

describe("one namespace rule — the pure predicate and the OKF gate agree", () => {
	for (const { namespace, admitted } of SHAPES) {
		test(`${namespace} is ${admitted ? "admitted" : "refused"} by isTeamNamespaceAllowed, isNamespaceAllowedForScope and requireTenantNamespace`, () => {
			expect(isTeamNamespaceAllowed(member, namespace)).toBe(admitted);
			expect(isNamespaceAllowedForScope(member, namespace)).toBe(admitted);
			const gate = () => requireTenantNamespace(member, namespace, "okf:export");
			if (admitted) expect(gate).not.toThrow();
			else expect(gate).toThrow(/RBAC_DENIED/);
		});
	}

	test("a member whose organisation has no permanent id owns no namespace, in all three", () => {
		const idless = { ...member, orgClerkId: undefined };
		expect(isTeamNamespaceAllowed(idless, "team/org-a")).toBe(false);
		expect(isNamespaceAllowedForScope(idless, "team/org-a")).toBe(false);
		expect(() =>
			requireTenantNamespace(idless, "team/org-a", "okf:export"),
		).toThrow(/RBAC_DENIED/);
	});

	test("the master is admitted everywhere", () => {
		const master = { ...member, isMaster: true, orgSlug: null, orgClerkId: undefined };
		for (const { namespace } of SHAPES) {
			expect(isTeamNamespaceAllowed(master, namespace)).toBe(true);
			expect(isNamespaceAllowedForScope(master, namespace)).toBe(true);
		}
	});
});

describe("one namespace rule — storeMemory and storeMemoryScoped admit and refuse the same namespaces", () => {
	async function seed() {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-a",
				clerkOrgId: ORG_ID,
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: "org-a",
				isActive: true,
				createdAt: 1,
			});
		});
		return t;
	}
	const asMember = (t: Awaited<ReturnType<typeof seed>>) =>
		t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
			org_id: ORG_ID,
		} as Parameters<typeof t.withIdentity>[0]);

	for (const { namespace, admitted } of SHAPES) {
		test(`${namespace}: both write doors ${admitted ? "admit" : "refuse"} it`, async () => {
			const t = await seed();
			const tA = asMember(t);
			const viaStore = tA
				.mutation(api.memories.storeMemory, {
					namespace,
					type: "project",
					content: "c",
				})
				.then(
					() => true,
					() => false,
				);
			const viaScoped = tA
				.mutation(api.memoriesScoped.storeMemoryScoped, {
					namespace,
					type: "project",
					content: "c",
				})
				.then(
					() => true,
					() => false,
				);
			expect(await viaStore).toBe(admitted);
			expect(await viaScoped).toBe(admitted);
		});
	}
});
