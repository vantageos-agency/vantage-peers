/// <reference types="vite/client" />
/**
 * OKF tenant namespace — owned by the RESOLVED org (client_org_mapping), never
 * by the raw org-slug claim on the identity.
 *
 * DEFECT (pre-fix, origin/main c851851, reviewer Eta's sandbox probe): an
 * identity carrying organizationSlug "pi" with NO client_org_mapping row was
 * SERVED a bundleUrl for `orchestrator/pi`, `project/vantage-peers` and
 * `orchestrator/eta`. The tenant path compared the RAW claim to the namespace
 * suffix: no mapping lookup, no active check. Latent while the Clerk "convex"
 * template carries no org claim; live the moment `org_slug` is added to it.
 *
 * RULE: a non-master caller may export/import ONLY `team/<resolvedOrgSlug>`,
 * where the slug comes from an ACTIVE client_org_mapping row
 * (withOrgScope / resolveOrgScopeForAction). Every other namespace
 * (orchestrator/*, project/*, global, master) is master-only. Refusals are
 * `RBAC_DENIED` naming the door (`requireResolvedCaller`).
 *
 * Poles: REFUSED (Eta's probe, own-looking namespace but unmapped, inactive
 * mapping, other org's team namespace, non-team namespace of a mapped org) /
 * PRESENT (mapped active member on team/<its org>; service account anywhere)
 * / import mirrors export / durable start, cancel, status.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (cf. okfMasterNamespaceExport.test.ts)
const EXPORT_REF = "okfBundleNode:exportOkfBundle" as any;
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (cf. okfMasterNamespaceExport.test.ts)
const IMPORT_REF = "okfBundleNode:importOkfBundle" as any;

const EXPORT_DOOR = "okfBundleNode:exportOkfBundle";
const IMPORT_DOOR = "okfBundleNode:importOkfBundle";
const START_DOOR = "okfBundleDurable:startOkfBundleExportDurable";
const CANCEL_DOOR = "okfBundleDurable:cancelOkfBundleExportDurable";
const STATUS_DOOR = "okfBundleDurable:getOkfBundleExportDurableStatus";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedOrg(t: T, slug: string, isActive = true) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive,
			createdAt: Date.now(),
		});
	});
}

function asMaster(t: T) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asOrg(t: T, slug: string) {
	return t.withIdentity({
		subject: `user-${slug}`,
		tokenIdentifier: `test|user-${slug}`,
		organizationSlug: slug,
	} as Parameters<typeof t.withIdentity>[0]);
}

async function capture(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (err) {
		return err;
	}
	throw new Error("expected the call to be refused, but it resolved");
}

/** RBAC_DENIED; `door` is asserted whenever the refusal can name it. */
async function expectRbacDenied(p: Promise<unknown>, door?: string) {
	const err = await capture(p);
	const data = String((err as { data?: unknown }).data ?? err);
	expect(data).toContain("RBAC_DENIED");
	if (door) expect(data).toContain(door);
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

async function seedProgress(t: Caller, jobId: string, namespace: string) {
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

// Eta's probe namespaces: each looks "owned" by the claim and is not a tenant namespace.
const PROBE_NAMESPACES = [
	"orchestrator/pi",
	"project/vantage-peers",
	"orchestrator/eta",
];

type Caller = Pick<T, "action" | "mutation" | "query" | "run">;

type Door = {
	name: string;
	door: string;
	call: (t: Caller, namespace: string) => Promise<unknown>;
};

const exportDoor: Door = {
	name: "exportOkfBundle",
	door: EXPORT_DOOR,
	call: (t, namespace) =>
		t.action(EXPORT_REF, { namespace, format: "tarball" }),
};
const importDoor: Door = {
	name: "importOkfBundle",
	door: IMPORT_DOOR,
	call: (t, namespace) =>
		t.action(IMPORT_REF, {
			targetNamespace: namespace,
			mode: "dry-run",
		}),
};
const startDoor: Door = {
	name: "startOkfBundleExportDurable",
	door: START_DOOR,
	call: (t, namespace) =>
		t.mutation(api.okfBundleDurable.startOkfBundleExportDurable, {
			namespace,
			totalSteps: 3,
		}),
};
const cancelDoor: Door = {
	name: "cancelOkfBundleExportDurable",
	door: CANCEL_DOOR,
	call: async (t, namespace) => {
		const jobId = `job-${namespace.replace(/\//g, "-")}`;
		await seedProgress(t, jobId, namespace);
		return t.mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
			jobId,
		});
	},
};
const statusDoor: Door = {
	name: "getOkfBundleExportDurableStatus",
	door: STATUS_DOOR,
	call: async (t, namespace) => {
		const jobId = `job-${namespace.replace(/\//g, "-")}`;
		await seedProgress(t, jobId, namespace);
		return t.query(api.okfBundleDurable.getOkfBundleExportDurableStatus, {
			jobId,
		});
	},
};

const DOORS = [exportDoor, importDoor, startDoor, cancelDoor, statusDoor];

describe.each(DOORS)("$name — tenant namespace from the mapping", (d) => {
	test("REFUSED: org claim with NO mapping row, on Eta's probe namespaces", async () => {
		for (const ns of PROBE_NAMESPACES) {
			const t = createT();
			await expectRbacDenied(d.call(asOrg(t, "pi"), ns));
		}
	});

	test("REFUSED: unmapped claim naming its own team namespace", async () => {
		const t = createT();
		await expectRbacDenied(d.call(asOrg(t, "ghost"), "team/ghost"));
	});

	test("REFUSED: INACTIVE mapping, even on team/<its org>", async () => {
		const t = createT();
		await seedOrg(t, "dormant", false);
		await expectRbacDenied(d.call(asOrg(t, "dormant"), "team/dormant"));
	});

	test("REFUSED: active member on another org's team namespace", async () => {
		const t = createT();
		await seedOrg(t, "acme");
		await seedOrg(t, "other");
		await expectRbacDenied(d.call(asOrg(t, "acme"), "team/other"), d.door);
	});

	test("REFUSED: active member on a non-team namespace named after its org", async () => {
		const t = createT();
		await seedOrg(t, "pi");
		for (const ns of [...PROBE_NAMESPACES, "global", "project/elpi-corp"]) {
			await expectRbacDenied(d.call(asOrg(t, "pi"), ns), d.door);
		}
	});

	test("PRESENT: active member passes the gate on team/<its org>", async () => {
		const t = createT();
		await seedOrg(t, "acme");
		await expectPassesAuthGate(d.call(asOrg(t, "acme"), "team/acme"));
	});

	test("PRESENT: the service account passes the gate on any namespace", async () => {
		const t = createT();
		for (const ns of [
			"team/acme",
			"orchestrator/pi",
			"project/vantage-peers",
			"global",
			"project/elpi-corp",
		]) {
			await expectPassesAuthGate(d.call(asMaster(t), ns));
		}
	});
});

describe("a refused durable cancel leaves the job running", () => {
	test("unmapped claim cannot cancel an orchestrator/pi job", async () => {
		const t = createT();
		await seedProgress(t, "job-keep", "orchestrator/pi");
		await expectRbacDenied(
			asOrg(t, "pi").mutation(
				api.okfBundleDurable.cancelOkfBundleExportDurable,
				{ jobId: "job-keep" },
			),
		);
		expect(await progressStatus(t, "job-keep")).toBe("running");
	});
});
