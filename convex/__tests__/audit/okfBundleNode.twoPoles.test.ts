/// <reference types="vite/client" />
/**
 * R4 RED reproduction — okfBundleNode doors (exportOkfBundle task roster, validateOkfBundle URL gate,
 * importOkfBundle frontmatter authority). Origins: rows 0-2 of audit/doors/defects-R4.jsonl (main @16f0907).
 * Identities: ordinary org-a member (organizationId org-a, roster ['sigma']); a signed-in caller with NO org
 * for the URL gate. No real network: global fetch is stubbed and records its calls.
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { packTarball } from "../../okfBundleNode";
import schema from "../../schema";

// biome-ignore lint/suspicious/noExplicitAny: string refs (codegen lag, as okfExportOrgAuthority.test.ts)
const EXPORT = "okfBundleNode:exportOkfBundle" as any;
// biome-ignore lint/suspicious/noExplicitAny: string ref
const VALIDATE = "okfBundleNode:validateOkfBundle" as any;
// biome-ignore lint/suspicious/noExplicitAny: string ref
const IMPORT = "okfBundleNode:importOkfBundle" as any;

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

afterEach(() => {
	vi.unstubAllGlobals();
});

async function seedOrg(t: T, slug: string) {
	await t.run((ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		}),
	);
}
const asMember = (t: T) =>
	t.withIdentity({
		subject: "user-org-a",
		tokenIdentifier: "test|user-org-a",
		organizationId: "org-a",
		orgRole: "org:member",
	} as Parameters<typeof t.withIdentity>[0]);
const asNoOrg = (t: T) =>
	t.withIdentity({ subject: "u1" } as Parameters<typeof t.withIdentity>[0]);

describe("okfBundleNode:exportOkfBundle — task roster", () => {
	test("okfBundleNode:exportOkfBundle — an org-a member's export omits tasks assigned to an orchestrator outside the org roster (tasks:list withholds them)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: "eta task",
				assignedTo: "eta",
				createdBy: "sigma",
				priority: "low",
				status: "todo",
				orgId: "org-a",
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		const listed = await asMember(t).query(
			// biome-ignore lint/suspicious/noExplicitAny: string ref
			"tasks:list" as any,
			{},
		);
		expect(listed).toHaveLength(0); // positive control: the reader withholds the row
		const r = await asMember(t).action(EXPORT, { namespace: "team/org-a", format: "tarball" });
		expect(r.manifest.types.taskCount).toBe(0);
	});

	test("okfBundleNode:exportOkfBundle — positive control: a roster task (sigma) IS exported", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: "sigma task",
				assignedTo: "sigma",
				createdBy: "sigma",
				priority: "low",
				status: "todo",
				orgId: "org-a",
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		const r = await asMember(t).action(EXPORT, { namespace: "team/org-a", format: "tarball" });
		expect(r.manifest.types.taskCount).toBe(1);
	});
});

describe("okfBundleNode:validateOkfBundle — bundleUrl SSRF gate", () => {
	// Origin of every literal: audit row 1 (okfBundleNode.ts:602-617 list ::1, fc, fd, fe8-feb only).
	const MAPPED = [
		"https://[::ffff:7f00:1]/b.tar", // IPv4-mapped 127.0.0.1 (row 1 repro)
		"https://[::ffff:a00:1]/b.tar", // IPv4-mapped 10.0.0.1
		"https://[::ffff:a9fe:a9fe]/b.tar", // IPv4-mapped 169.254.169.254 (cloud metadata)
		"https://[::]/b.tar", // unspecified
	];
	for (const url of MAPPED) {
		test(`okfBundleNode:validateOkfBundle — the URL gate refuses ${url} before any fetch`, async () => {
			const t = createT();
			await seedOrg(t, "org-a");
			const fetchSpy = vi.fn(async () => new Response("no", { status: 404 }));
			vi.stubGlobal("fetch", fetchSpy);
			await asMember(t)
				.action(VALIDATE, { bundleUrl: url })
				.catch(() => undefined);
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	}

	for (const url of ["https://127.0.0.1/b.tar", "https://[::1]/b.tar"]) {
		test(`okfBundleNode:validateOkfBundle — positive control: ${url} is refused with HOST_DENIED and no fetch`, async () => {
			const t = createT();
			await seedOrg(t, "org-a");
			const fetchSpy = vi.fn(async () => new Response("no", { status: 404 }));
			vi.stubGlobal("fetch", fetchSpy);
			await expect(asMember(t).action(VALIDATE, { bundleUrl: url })).rejects.toThrow(
				/OKF_VALIDATE_URL_HOST_DENIED/,
			);
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	}

	test("okfBundleNode:validateOkfBundle — a signed-in caller with no organisation cannot make the server fetch a URL", async () => {
		const t = createT();
		const fetchSpy = vi.fn(async () => new Response("no", { status: 404 }));
		vi.stubGlobal("fetch", fetchSpy);
		await expect(
			asNoOrg(t).action(VALIDATE, { bundleUrl: "https://example.com/b.tar" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("okfBundleNode:importOkfBundle — frontmatter authority", () => {
	test("okfBundleNode:importOkfBundle — an org member cannot plant a task assigned to 'pi' / authored by 'system' through bundle frontmatter", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const task = [
			"---",
			"type: task",
			"title: planted",
			"description: planted task",
			"assignedTo: pi",
			"createdBy: system",
			"status: done",
			"priority: low",
			"---",
			"body of the planted task",
			"",
		].join("\n");
		const buf = await packTarball([
			{ path: "index.md", content: '---\nokf_version: "0.1"\ntype: index\n---\n# Bundle\n' },
			{ path: "tasks/t1.md", content: task },
		]);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(buf)])));
		await t.run((ctx) => ctx.db.insert("kbUploads", { storageId, orgId: "org-a", createdAt: 1 }));
		let err = "NO-ERROR";
		try {
			await asMember(t).action(IMPORT, {
				storageId,
				targetNamespace: "team/org-a",
				mode: "merge",
			});
		} catch (e) {
			err = String(e);
		}
		const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
		const planted = tasks.filter((x) => x.assignedTo === "pi" || x.createdBy === "system");
		expect({ err: err === "NO-ERROR" ? err : "refused", planted: planted.length }).toEqual({
			err: expect.any(String),
			planted: 0,
		});
	});
});
