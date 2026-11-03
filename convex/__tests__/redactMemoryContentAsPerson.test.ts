/// <reference types="vite/client" />
//
// memories:redactMemoryContentAsPerson — the MCP person-bearer form of the
// erase. The fleet service account is the transport; the person is rebuilt from
// its token row by the bearer hash (convex/lib/personPrincipal.ts).
//
// POLES (all below the MCP layer)
//   AUTHOR  a same-org member, not admin, erases the row whose stored author is its own subject
//   ADMIN   a same-org admin, not the author, erases any row of its org
//   NOT AUTHOR  a same-org member on someone else's row   -> RBAC_DENIED, row unchanged
//   OTHER ORG   an admin of org-b on org-a's row          -> RBAC_DENIED, row unchanged
//   NOT TRANSPORT  an org member / anonymous presenting a hash -> refused, row unchanged

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const AUTHOR = "1".repeat(64);
const ADMIN_A = "2".repeat(64);
const OTHER_A = "3".repeat(64);
const ADMIN_B = "4".repeat(64);
const SECRET = "fake-cred-marker-person-door";

let t: T;
const service = () => t.withIdentity({ subject: SERVICE });
const redactions = [{ find: SECRET, replaceWith: "[REDACTED]" }];
const acting = (org: string) => ({ __actingOrg: testClerkOrgId(org) });

async function expectDenied(p: Promise<unknown>): Promise<void> {
	let caught: unknown;
	try {
		await p;
	} catch (err) {
		caught = err;
	}
	expect(caught, "expected a refusal").toBeDefined();
	const data = (caught as { data?: unknown }).data;
	const text = `${(caught as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	expect(text).toMatch(/RBAC_DENIED|ORG_MISMATCH/);
}

const rowOf = (id: Id<"memories">) => t.run((ctx) => ctx.db.get(id));

async function memory(createdBy: string): Promise<Id<"memories">> {
	return await t.run((ctx) =>
		ctx.db.insert("memories", {
			namespace: "team/org-a",
			clerkOrgId: testClerkOrgId("org-a"),
			type: "reference",
			content: `${SECRET} here`,
			contentHash: "original-hash",
			createdBy,
			relations: [],
			isLatest: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
}

beforeEach(async () => {
	vi.useFakeTimers();
	t = createT();
	const now = Date.now();
	await t.run(async (ctx) => {
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["agent"],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		}
		const base = {
			clientId: "c",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "person",
			fromAllowList: ["agent"],
			namespaceReadPrefixes: ["team/org-a"],
			namespaceWritePrefixes: ["team/org-a"],
			expiresAt: now + 3_600_000,
			createdAt: now,
			principal: "person" as const,
		};
		const tokens: [string, string, string, string][] = [
			[AUTHOR, "user_author", "org:member", "org-a"],
			[ADMIN_A, "user_admin_a", "org:admin", "org-a"],
			[OTHER_A, "user_other_a", "org:member", "org-a"],
			[ADMIN_B, "user_admin_b", "org:admin", "org-b"],
		];
		for (const [tokenHash, userId, orgRole, org] of tokens) {
			await ctx.db.insert("oauth_access_tokens", {
				...base,
				tokenHash,
				userId,
				orgRole,
				clerkOrgSlug: org,
			});
		}
	});
});
afterEach(() => {
	vi.useRealTimers();
});

describe("redactMemoryContentAsPerson", () => {
	test("AUTHOR: a member, not admin, erases the row it authored (body gone, hash recomputed, re-index scheduled)", async () => {
		const id = await memory("user:user_author");
		const result = await service().mutation(api.memories.redactMemoryContentAsPerson, {
			memoryId: id,
			redactions,
			...acting("org-a"),
			verifiedPerson: { accessTokenHash: AUTHOR },
		});
		expect(result.replacements).toBe(1);
		const row = await rowOf(id);
		expect(row?.content).not.toContain(SECRET);
		expect(row?.contentHash).not.toBe("original-hash");
		const jobs = (
			await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
		).filter((j) => j.name.includes("replaceRagEntryContent"));
		expect(jobs).toHaveLength(1);
	});

	test("ADMIN: a same-org admin who is not the author erases any row of its org", async () => {
		const id = await memory("user:user_author");
		await service().mutation(api.memories.redactMemoryContentAsPerson, {
			memoryId: id,
			redactions,
			...acting("org-a"),
			verifiedPerson: { accessTokenHash: ADMIN_A },
		});
		expect((await rowOf(id))?.content).not.toContain(SECRET);
	});

	test("NOT AUTHOR: a same-org member on someone else's row is refused; the row is unchanged", async () => {
		const id = await memory("user:user_author");
		await expectDenied(
			service().mutation(api.memories.redactMemoryContentAsPerson, {
				memoryId: id,
				redactions,
				...acting("org-a"),
				verifiedPerson: { accessTokenHash: OTHER_A },
			}),
		);
		expect((await rowOf(id))?.content).toContain(SECRET);
	});

	test("OTHER ORG: an admin of org-b on org-a's row is refused; the row is unchanged", async () => {
		const id = await memory("user:user_author");
		await expectDenied(
			service().mutation(api.memories.redactMemoryContentAsPerson, {
				memoryId: id,
				redactions,
				...acting("org-b"),
				verifiedPerson: { accessTokenHash: ADMIN_B },
			}),
		);
		expect((await rowOf(id))?.content).toContain(SECRET);
	});

	test("NOT TRANSPORT: an org member and an anonymous caller presenting a hash are refused; the row is unchanged", async () => {
		const id = await memory("user:user_author");
		const member = t.withIdentity({
			subject: "member-x",
			org_slug: "org-a",
			org_id: testClerkOrgId("org-a"),
			org_role: "org:admin",
		} as Parameters<typeof t.withIdentity>[0]);
		const args = {
			memoryId: id,
			redactions,
			...acting("org-a"),
			verifiedPerson: { accessTokenHash: ADMIN_A },
		};
		await expectDenied(member.mutation(api.memories.redactMemoryContentAsPerson, args));
		await expectDenied(t.mutation(api.memories.redactMemoryContentAsPerson, args));
		expect((await rowOf(id))?.content).toContain(SECRET);
	});
});
