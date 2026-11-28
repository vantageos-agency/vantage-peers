/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17bcj237901qqfghbzsnj13258k0adb (mcp-server-standard
// S-28 expand: okfBundleNode:validateOkfBundle, okfBundleNode:importOkfBundle).
//
// Each door below takes `verifiedOrg` (believed from the fleet service account
// only) and answers the claim as a member of that organisation is answered.
// Doors: okfBundleNode:validateOkfBundle, okfBundleNode:importOkfBundle
//
// Poles per door:
//   OWN        the claim names the row's organisation -> served / write applied
//   FOREIGN    the claim names another active organisation -> the member's answer
//   UNCHANGED  the service account with no claim -> as before (expand only)
//   REFUSED    a non-service caller presenting the claim -> RBAC_DENIED
//   INACTIVE   a claim naming an inactive organisation -> RBAC_DENIED
// The storage ownership gate is the observable decision: a blob bound to A is served to a
// claim of A and refused (AUTH_STORAGE_NOT_OWNED) to a claim of B. importOkfBundle runs in
// dry-run mode, so nothing is written.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api, internal } from "../_generated/api";
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
const claimB = { orgSlug: B, orgId: B_ID };
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

import { packTarball } from "../okfBundleNode";
import { serializeMemory } from "../okfSerializer";

// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (see okfBundleImport.test.ts)
const VALIDATE_REF = "okfBundleNode:validateOkfBundle" as any;
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (see okfBundleImport.test.ts)
const IMPORT_REF = "okfBundleNode:importOkfBundle" as any;

const act = <R>(c: Client, ref: unknown, args: Record<string, unknown>) =>
	c.action(ref as never, args as never) as Promise<R>;

// A bundle stored in the shared `_storage` and bound to org A the way the
// upload/store path binds it (validate and import only ASSERT the binding).
async function world() {
	const t = createT();
	await seedOrgs(t);
	const mem = serializeMemory({
		_id: "k28mem001" as never,
		_creationTime: NOW,
		type: "reference",
		namespace: `team/${A}`,
		content: "Org A private memory body.",
		createdBy: "alice",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const buf = await packTarball([
		{
			path: "index.md",
			content: '---\nokf_version: "0.1"\ntype: index\n---\n# Bundle\n',
		},
		{ path: mem.filePath, content: mem.content },
	]);
	const storageId = await t.run(async (ctx) =>
		ctx.storage.store(new Blob([new Uint8Array(buf)])),
	);
	await t.mutation(internal.kbMutations.bindOrAssertStorageOwnership, {
		storageId,
		orgId: A,
	});
	return { t, storageId };
}

const memoryCount = (t: T) =>
	t.run(async (ctx) => (await ctx.db.query("memories").collect()).length);

describe("okfBundleNode:validateOkfBundle applies the verified org inside the read", () => {
	test("OWN: verifiedOrg A validates A's blob", async () => {
		const { t, storageId } = await world();
		const r = await act<{ valid: boolean }>(asService(t), VALIDATE_REF, {
			storageId,
			verifiedOrg: claimA,
		});
		expect(typeof r.valid).toBe("boolean");
	});
	test("FOREIGN: verifiedOrg B is refused A's blob (AUTH_STORAGE_NOT_OWNED)", async () => {
		const { t, storageId } = await world();
		const out = await codeOf(
			act(asService(t), VALIDATE_REF, { storageId, verifiedOrg: claimB }),
		);
		expect(out).toContain("AUTH_STORAGE_NOT_OWNED");
	});
	test("UNCHANGED: the service account with no claim validates A's blob", async () => {
		const { t, storageId } = await world();
		const r = await act<{ valid: boolean }>(asService(t), VALIDATE_REF, {
			storageId,
		});
		expect(typeof r.valid).toBe("boolean");
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t, storageId } = await world();
		const out = await codeOf(
			act(memberOf(t, A), VALIDATE_REF, { storageId, verifiedOrg: claimA }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t, storageId } = await world();
		const out = await codeOf(
			act(asService(t), VALIDATE_REF, { storageId, verifiedOrg: claimDead }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});

describe("okfBundleNode:importOkfBundle applies the verified org inside the write", () => {
	const dry = (storageId: Id<"_storage">, ns: string) => ({
		storageId,
		targetNamespace: ns,
		mode: "dry-run" as const,
	});
	test("OWN: verifiedOrg A dry-runs A's blob into A's namespace", async () => {
		const { t, storageId } = await world();
		const r = await act<{ imported: { memories: number } }>(
			asService(t),
			IMPORT_REF,
			{ ...dry(storageId, `team/${A_ID}`), verifiedOrg: claimA },
		);
		expect(r.imported).toBeDefined();
		expect(await memoryCount(t)).toBe(0);
	});
	test("FOREIGN: verifiedOrg B is refused A's blob in B's own namespace (AUTH_STORAGE_NOT_OWNED)", async () => {
		const { t, storageId } = await world();
		const out = await codeOf(
			act(asService(t), IMPORT_REF, {
				...dry(storageId, `team/${B_ID}`),
				verifiedOrg: claimB,
			}),
		);
		expect(out).toContain("AUTH_STORAGE_NOT_OWNED");
	});
	test("FOREIGN: verifiedOrg B is refused A's namespace", async () => {
		const { t, storageId } = await world();
		const out = await codeOf(
			act(asService(t), IMPORT_REF, {
				...dry(storageId, `team/${A_ID}`),
				verifiedOrg: claimB,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
	});
	test("UNCHANGED: the service account with no claim dry-runs A's blob", async () => {
		const { t, storageId } = await world();
		const r = await act<{ imported: { memories: number } }>(
			asService(t),
			IMPORT_REF,
			dry(storageId, `team/${A_ID}`),
		);
		expect(r.imported).toBeDefined();
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t, storageId } = await world();
		const out = await codeOf(
			act(memberOf(t, A), IMPORT_REF, {
				...dry(storageId, `team/${A_ID}`),
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t, storageId } = await world();
		const out = await codeOf(
			act(asService(t), IMPORT_REF, {
				...dry(storageId, `team/${A_ID}`),
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});
