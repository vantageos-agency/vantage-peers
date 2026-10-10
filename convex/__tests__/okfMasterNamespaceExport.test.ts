/// <reference types="vite/client" />
/**
 * OKF master namespace — reserved to the fleet master, pinned at every door.
 *
 * DEFECT (pre-fix, origin/main 9e1413a): `assertCanExportNamespace`
 * (okfBundleNode.ts) and `assertCanExportNamespaceV8` (okfBundleDurable.ts)
 * returned early for the master namespace `project/elpi-corp` when the caller
 * had NO identity, and again when a signed-in caller carried no org slug. An
 * anonymous request could export (or import into) the fleet master namespace.
 *
 * FIX: the master namespace requires the fleet master (the service account the
 * MCP server authenticates as), resolved by `withOrgScope`. Everyone else is
 * refused by RAISING `RBAC_DENIED` naming the door
 * (`.claude/rules/refusal-is-distinguishable-from-absence.md`). The tenant
 * (non-master) namespace logic is UNCHANGED and pinned below.
 *
 * Doors: okfBundleNode:exportOkfBundle, okfBundleNode:importOkfBundle,
 * okfBundleDurable:startOkfBundleExportDurable,
 * okfBundleDurable:cancelOkfBundleExportDurable,
 * okfBundleDurable:getOkfBundleExportDurableStatus.
 *
 * Poles: REFUSED (anonymous, signed-in no org, org member, unmapped org member,
 * org literally named elpi-corp) / PRESENT (service account served; own-tenant
 * member unchanged) / and the writes a refusal must NOT have made.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { packTarball } from "../okfBundleNode";
import { type MemoryDoc, serializeMemory } from "../okfSerializer";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER_NS = "project/elpi-corp";

// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (cf. okfBundleImport.test.ts)
const EXPORT_REF = "okfBundleNode:exportOkfBundle" as any;
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (cf. okfBundleImport.test.ts)
const IMPORT_REF = "okfBundleNode:importOkfBundle" as any;

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedOrg(t: T, slug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asMaster(t: T) {
	// CLERK_SERVICE_ACCOUNT_USER_ID in vitest.config.ts
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asNoOrg(t: T) {
	return t.withIdentity({
		subject: "user-no-org",
		tokenIdentifier: "test|user-no-org",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asOrg(t: T, slug: string) {
	return t.withIdentity({
		subject: `user-${slug}`,
		tokenIdentifier: `test|user-${slug}`,
		organizationSlug: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<typeof t.withIdentity>[0]);
}

/** RBAC_DENIED naming the door, carrying the refusal reason in errorData. */
function refusedAt(door: string, reason: string) {
	return (err: unknown) => {
		const data = String((err as { data?: unknown }).data ?? err);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain(door);
		expect(data).toContain(reason);
	};
}

async function capture(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (err) {
		return err;
	}
	throw new Error("expected the call to be refused, but it resolved");
}

async function expectRefused(
	p: Promise<unknown>,
	door: string,
	reason: string,
) {
	refusedAt(door, reason)(await capture(p));
}

/** The call may fail downstream (storage / component harness), never on auth. */
async function expectPassesAuthGate(p: Promise<unknown>) {
	try {
		await p;
	} catch (err) {
		const text = String((err as { data?: unknown }).data ?? err);
		expect(text).not.toMatch(
			/RBAC_DENIED|AUTH_NO_IDENTITY|AUTH_NO_ORG|AUTH_NAMESPACE_DENIED/,
		);
	}
}

const EXPORT_DOOR = "okfBundleNode:exportOkfBundle";
const IMPORT_DOOR = "okfBundleNode:importOkfBundle";

// ─────────────────────────────────────────────────────────────────────────────
// exportOkfBundle
// ─────────────────────────────────────────────────────────────────────────────

describe("okfBundleNode:exportOkfBundle — master namespace", () => {
	const args = { namespace: MASTER_NS, format: "tarball" as const };

	test("REFUSED: anonymous caller (no credential) — the original leak", async () => {
		const t = createT();
		await expectRefused(
			t.action(EXPORT_REF, args),
			EXPORT_DOOR,
			"no-credential",
		);
	});

	test("REFUSED: signed-in caller with no organisation", async () => {
		const t = createT();
		await expectRefused(
			asNoOrg(t).action(EXPORT_REF, args),
			EXPORT_DOOR,
			"not-fleet-master",
		);
	});

	test("REFUSED: ordinary member of an active organisation", async () => {
		const t = createT();
		await seedOrg(t, "acme");
		await expectRefused(
			asOrg(t, "acme").action(EXPORT_REF, args),
			EXPORT_DOOR,
			"not-fleet-master",
		);
	});

	test("REFUSED: member of an org literally named elpi-corp (membership never mints master)", async () => {
		const t = createT();
		await seedOrg(t, "elpi-corp");
		await expectRefused(
			asOrg(t, "elpi-corp").action(EXPORT_REF, args),
			EXPORT_DOOR,
			"not-fleet-master",
		);
	});

	test("REFUSED: org member whose org has no mapping row is still refused (RBAC_DENIED)", async () => {
		const t = createT();
		const err = await capture(asOrg(t, "ghost").action(EXPORT_REF, args));
		expect(String((err as { data?: unknown }).data ?? err)).toContain(
			"RBAC_DENIED",
		);
	});

	test("PRESENT: the service account (fleet master) is served — it passes the auth gate and exports", async () => {
		const t = createT();
		const result = await asMaster(t).action(EXPORT_REF, args);
		expect(result).toMatchObject({ fileCount: expect.any(Number) });
	});

	test("PRESENT (unchanged): an org member exporting its OWN tenant namespace passes the auth gate", async () => {
		const t = createT();
		await seedOrg(t, "team-zen");
		await expectPassesAuthGate(
			asOrg(t, "team-zen").action(EXPORT_REF, {
				namespace: "team/team-zen",
				format: "tarball",
			}),
		);
	});

	test("cross-tenant export and anonymous tenant export are refused RBAC_DENIED", async () => {
		const t = createT();
		await seedOrg(t, "team-x");
		await expect(
			asOrg(t, "team-x").action(EXPORT_REF, {
				namespace: "team/team-y",
				format: "tarball",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			t.action(EXPORT_REF, { namespace: "team/team-y", format: "tarball" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// importOkfBundle — what changed: importing INTO the master namespace is now
// master-only too (it shares assertCanExportNamespace). Tenant import unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_MS = 1_700_000_000_000;

async function storeBundle(t: T, namespace: string): Promise<string> {
	const doc: MemoryDoc = {
		_id: "k179mem001" as never,
		_creationTime: FIXED_MS,
		type: "reference",
		namespace,
		content: "Imported memory body.",
		createdBy: "sigma",
		createdAt: FIXED_MS,
		updatedAt: FIXED_MS,
	};
	const mem = serializeMemory(doc);
	const buf = await packTarball([
		{
			path: "index.md",
			content: '---\nokf_version: "0.1"\ntype: index\n---\n# Bundle\n',
		},
		{ path: mem.filePath, content: mem.content },
	]);
	return await t.run(async (ctx) =>
		ctx.storage.store(new Blob([new Uint8Array(buf)])),
	);
}

async function memoryCount(t: T): Promise<number> {
	return await t.run(
		async (ctx) => (await ctx.db.query("memories").collect()).length,
	);
}

describe("okfBundleNode:importOkfBundle — master namespace", () => {
	test("REFUSED: anonymous import into the master namespace; nothing is written", async () => {
		const t = createT();
		const storageId = await storeBundle(t, MASTER_NS);
		await expectRefused(
			t.action(IMPORT_REF, {
				storageId,
				targetNamespace: MASTER_NS,
				mode: "merge",
				idempotencyKey: "anon-master",
			}),
			IMPORT_DOOR,
			"no-credential",
		);
		expect(await memoryCount(t)).toBe(0);
	});

	test("REFUSED: org member importing into the master namespace; nothing is written", async () => {
		const t = createT();
		await seedOrg(t, "acme");
		const storageId = await storeBundle(t, MASTER_NS);
		await expectRefused(
			asOrg(t, "acme").action(IMPORT_REF, {
				storageId,
				targetNamespace: MASTER_NS,
				mode: "merge",
				idempotencyKey: "member-master",
			}),
			IMPORT_DOOR,
			"not-fleet-master",
		);
		expect(await memoryCount(t)).toBe(0);
	});

	test("PRESENT: the service account imports into the master namespace", async () => {
		const t = createT();
		const storageId = await storeBundle(t, MASTER_NS);
		const result = await asMaster(t).action(IMPORT_REF, {
			storageId,
			targetNamespace: MASTER_NS,
			mode: "merge",
			idempotencyKey: "master-master",
		});
		expect(result.imported.memories).toBe(1);
		expect(await memoryCount(t)).toBe(1);
	});

	test("UNCHANGED: an org member importing into its OWN tenant namespace still works", async () => {
		const t = createT();
		await seedOrg(t, "team-zen");
		const storageId = await storeBundle(t, "team/team-zen");
		// import ASSERTS ownership: the blob is bound by the producer path
		// (export / upload / store), here the store path's own binding door
		await t.mutation(internal.kbMutations.bindOrAssertStorageOwnership, {
			storageId: storageId as Id<"_storage">,
			orgId: "team-zen",
		});
		const result = await asOrg(t, "team-zen").action(IMPORT_REF, {
			storageId,
			targetNamespace: "team/team-zen",
			mode: "merge",
			idempotencyKey: "own-tenant",
		});
		expect(result.imported.memories).toBe(1);
		expect(await memoryCount(t)).toBe(1);
	});

	test("UNCHANGED: anonymous import into a tenant namespace is refused RBAC_DENIED", async () => {
		const t = createT();
		const storageId = await storeBundle(t, "team/team-zen");
		await expect(
			t.action(IMPORT_REF, {
				storageId,
				targetNamespace: "team/team-zen",
				mode: "merge",
				idempotencyKey: "anon-tenant",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await memoryCount(t)).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// okfBundleDurable — V8 path (start / cancel / status)
// ─────────────────────────────────────────────────────────────────────────────

async function seedProgress(t: T, jobId: string, namespace: string) {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("okfDurableExportProgress", {
			jobId,
			orgId: namespace,
			namespace,
			sinceMs: undefined,
			memoriesCursor: null,
			memoriesDone: false,
			briefingsCursor: null,
			briefingsDone: false,
			tasksCursor: null,
			tasksDone: false,
			memoryCount: 0,
			briefingCount: 0,
			taskCount: 0,
			stepsCompleted: 0,
			status: "running",
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function progressStatus(t: T, jobId: string) {
	return await t.run(async (ctx) => {
		const row = await ctx.db
			.query("okfDurableExportProgress")
			.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
			.unique();
		return row?.status;
	});
}

const START_DOOR = "okfBundleDurable:startOkfBundleExportDurable";
const CANCEL_DOOR = "okfBundleDurable:cancelOkfBundleExportDurable";
const STATUS_DOOR = "okfBundleDurable:getOkfBundleExportDurableStatus";

describe("okfBundleDurable:startOkfBundleExportDurable — master namespace", () => {
	const args = { namespace: MASTER_NS, totalSteps: 3 };

	test("REFUSED: anonymous caller — the original leak", async () => {
		const t = createT();
		await expectRefused(
			t.mutation(api.okfBundleDurable.startOkfBundleExportDurable, args),
			START_DOOR,
			"no-credential",
		);
	});

	test("REFUSED: signed-in caller with no organisation", async () => {
		const t = createT();
		await expectRefused(
			asNoOrg(t).mutation(
				api.okfBundleDurable.startOkfBundleExportDurable,
				args,
			),
			START_DOOR,
			"not-fleet-master",
		);
	});

	test("REFUSED: ordinary org member; PRESENT: the service account passes the gate (fails only on the component harness)", async () => {
		const t = createT();
		await seedOrg(t, "acme");
		await expectRefused(
			asOrg(t, "acme").mutation(
				api.okfBundleDurable.startOkfBundleExportDurable,
				args,
			),
			START_DOOR,
			"not-fleet-master",
		);
		await expectPassesAuthGate(
			asMaster(t).mutation(
				api.okfBundleDurable.startOkfBundleExportDurable,
				args,
			),
		);
	});
});

describe("okfBundleDurable:cancelOkfBundleExportDurable — master-namespace job", () => {
	test("REFUSED: anonymous and signed-in-no-org callers; the job is not cancelled", async () => {
		const t = createT();
		await seedProgress(t, "job-master", MASTER_NS);
		await expect(
			t.mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-master",
			}),
		).rejects.toThrow(/AUTH_NO_IDENTITY/);
		await expectRefused(
			asNoOrg(t).mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-master",
			}),
			CANCEL_DOOR,
			"not-fleet-master",
		);
		expect(await progressStatus(t, "job-master")).toBe("running");
	});

	test("REFUSED: org member (incl. org named elpi-corp); PRESENT: service account passes the gate", async () => {
		const t = createT();
		await seedOrg(t, "acme");
		await seedOrg(t, "elpi-corp");
		await seedProgress(t, "job-master-2", MASTER_NS);
		for (const slug of ["acme", "elpi-corp"]) {
			await expectRefused(
				asOrg(t, slug).mutation(
					api.okfBundleDurable.cancelOkfBundleExportDurable,
					{ jobId: "job-master-2" },
				),
				CANCEL_DOOR,
				"not-fleet-master",
			);
		}
		await expectPassesAuthGate(
			asMaster(t).mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-master-2",
			}),
		);
	});
});

describe("okfBundleDurable:getOkfBundleExportDurableStatus — master-namespace job", () => {
	test("REFUSED: org member reading a master-namespace job (incl. org named elpi-corp)", async () => {
		const t = createT();
		await seedOrg(t, "acme");
		await seedOrg(t, "elpi-corp");
		await seedProgress(t, "job-status", MASTER_NS);
		for (const slug of ["acme", "elpi-corp"]) {
			await expectRefused(
				asOrg(t, slug).query(
					api.okfBundleDurable.getOkfBundleExportDurableStatus,
					{ jobId: "job-status" },
				),
				STATUS_DOOR,
				"not-fleet-master",
			);
		}
	});
});
