/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17bcj237901qqfghbzsnj13258k0adb (mcp-server-standard
// S-28 expand: memories:softDeleteMemory, memories:redactMemoryContent).
//
// Each door below takes `verifiedOrg` (believed from the fleet service account
// only) and answers the claim as a member of that organisation is answered.
// Doors: memories:softDeleteMemory, memories:redactMemoryContent
//
// Poles per door:
//   OWN        the claim names the row's organisation -> served / write applied
//   FOREIGN    the claim names another active organisation -> the member's answer
//   UNCHANGED  the service account with no claim -> as before (expand only)
//   REFUSED    a non-service caller presenting the claim -> RBAC_DENIED
//   INACTIVE   a claim naming an inactive organisation -> RBAC_DENIED
// memories:redactMemoryContent is the SESSION form of an erase: it needs a verified
// person or agent. A service account with a claim is a member scope with neither,
// so OWN and FOREIGN are both the member's refusal and the row stays unredacted;
// the pole that shows the door still serves is a same-org admin session, claimless.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
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

// Writes schedule RAG-sync functions; fake timers keep the scheduler under the
// test's control (same pattern as s28DoorDecisions.test.ts).
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
type Client = ReturnType<T["withIdentity"]>;

const OP = "s28x-op";
const A = "s28x-a";
const B = "s28x-b";
const D = "s28x-dead";
const OP_ID = testClerkOrgId(OP);
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);
const D_ID = testClerkOrgId(D);
const claimA = { orgSlug: A, orgId: A_ID };
const claimDead = { orgSlug: D, orgId: D_ID };
const NOW = 1_780_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const memberOf = (t: T, slug: string) =>
	t.withIdentity({
		subject: `member-of-${slug}`,
		org_slug: slug,
		org_id: testClerkOrgId(slug),
		org_role: "org:admin",
	} as Identity);

const m = <R>(c: Client, ref: unknown, args: Record<string, unknown>) =>
	c.mutation(ref as never, args as never) as Promise<R>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return `${(e as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	}
	return "NO-REFUSAL";
}

// One operator organisation, two client organisations and one inactive one, each
// active org with its roster agent (by ID).
async function seedOrgs(t: T): Promise<Record<string, Id<"agents">>> {
	await t.run(async (ctx) => {
		const org = (
			slug: string,
			id: string,
			roster: string,
			isActive: boolean,
			orgKind: "operator" | "client",
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: [roster],
				scopes: [
					"view-own-tasks",
					"view-own-missions",
					"view-stats-aggregated",
				],
				displayName: slug,
				isActive,
				orgKind,
				createdAt: 1,
			});
		await org(OP, OP_ID, "opa", true, "operator");
		await org(A, A_ID, "alice", true, "client");
		await org(B, B_ID, "bob", true, "client");
		await org(D, D_ID, "dan", false, "client");
	});
	return await seedRosterAgents(t);
}

const SECRET = "s28-secret-marker";

async function world() {
	const t = createT();
	await seedOrgs(t);
	const ids = await t.run(async (ctx) => {
		const out: Record<string, Id<"memories">> = {};
		for (const [slug, id] of [
			[A, A_ID],
			[B, B_ID],
		] as const) {
			out[slug] = await ctx.db.insert("memories", {
				namespace: `team/${id}`,
				clerkOrgId: id,
				type: "reference",
				content: `${SECRET} of ${slug}`,
				contentHash: `hash-${slug}`,
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
		return out;
	});
	return { t, ids };
}

const latestOf = (t: T, id: Id<"memories">) =>
	t.run(async (ctx) => (await ctx.db.get(id))?.isLatest);
const contentOf = (t: T, id: Id<"memories">) =>
	t.run(async (ctx) => (await ctx.db.get(id))?.content);

describe("memories:softDeleteMemory applies the verified org inside the write", () => {
	test("OWN: verifiedOrg A deletes A's memory", async () => {
		const { t, ids } = await world();
		await m(asService(t), api.memories.softDeleteMemory, {
			memoryId: ids[A],
			verifiedOrg: claimA,
		});
		expect(await latestOf(t, ids[A])).toBe(false);
	});
	test("FOREIGN: verifiedOrg A cannot delete B's memory (RBAC_DENIED, row unchanged)", async () => {
		const { t, ids } = await world();
		const out = await codeOf(
			m(asService(t), api.memories.softDeleteMemory, {
				memoryId: ids[B],
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("memory-not-in-caller-org");
		expect(await latestOf(t, ids[B])).toBe(true);
	});
	test("UNCHANGED: the service account with no claim deletes B's memory", async () => {
		const { t, ids } = await world();
		await m(asService(t), api.memories.softDeleteMemory, { memoryId: ids[B] });
		expect(await latestOf(t, ids[B])).toBe(false);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t, ids } = await world();
		const out = await codeOf(
			m(memberOf(t, A), api.memories.softDeleteMemory, {
				memoryId: ids[A],
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
		expect(await latestOf(t, ids[A])).toBe(true);
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t, ids } = await world();
		const out = await codeOf(
			m(asService(t), api.memories.softDeleteMemory, {
				memoryId: ids[A],
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
		expect(await latestOf(t, ids[A])).toBe(true);
	});
});

describe("memories:redactMemoryContent applies the verified org inside the write", () => {
	const redactions = [{ find: SECRET, replaceWith: "[REDACTED]" }];
	test("OWN: verifiedOrg A on A's memory is the member's refusal (no person), row unredacted", async () => {
		const { t, ids } = await world();
		const out = await codeOf(
			m(asService(t), api.memories.redactMemoryContent, {
				memoryId: ids[A],
				redactions,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(await contentOf(t, ids[A])).toContain(SECRET);
	});
	test("FOREIGN: verifiedOrg A on B's memory is refused, row unredacted", async () => {
		const { t, ids } = await world();
		const out = await codeOf(
			m(asService(t), api.memories.redactMemoryContent, {
				memoryId: ids[B],
				redactions,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(await contentOf(t, ids[B])).toContain(SECRET);
	});
	test("UNCHANGED: a same-org admin session with no claim still erases", async () => {
		const { t, ids } = await world();
		const r = await m<{ replacements: number }>(
			memberOf(t, A),
			api.memories.redactMemoryContent,
			{ memoryId: ids[A], redactions },
		);
		expect(r.replacements).toBe(1);
		expect(await contentOf(t, ids[A])).not.toContain(SECRET);
	});
	test("UNCHANGED: the service account with no claim is still refused", async () => {
		const { t, ids } = await world();
		const out = await codeOf(
			m(asService(t), api.memories.redactMemoryContent, {
				memoryId: ids[A],
				redactions,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(await contentOf(t, ids[A])).toContain(SECRET);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t, ids } = await world();
		const out = await codeOf(
			m(memberOf(t, A), api.memories.redactMemoryContent, {
				memoryId: ids[A],
				redactions,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
		expect(await contentOf(t, ids[A])).toContain(SECRET);
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t, ids } = await world();
		const out = await codeOf(
			m(asService(t), api.memories.redactMemoryContent, {
				memoryId: ids[A],
				redactions,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});
