/// <reference types="vite/client" />
/**
 * taskDeliverable.test.ts -- a task may name the artifact it delivers
 * ({ pkg, export }); every read exposes a DERIVED delivery signal beside the
 * typed status, never overwriting it (task k17cn84f2hm555cgqeegw0bq7n8ahsak).
 *
 * Poles:
 *   READ      stored deliverableState "delivered" + open status -> the readers
 *             say "delivered-but-open" and leave `status` untouched; every other
 *             combination carries NO new key (a task without a deliverable reads
 *             byte-identically to before).
 *   RESOLVER  a stubbed npm registry: export present -> delivered + version;
 *             export absent -> not_found; 404 / throw / garbage -> unresolved
 *             (fail-closed, NEVER delivered).
 *   WRITE     create / update schedule the resolution; an update by a caller of
 *             another organisation is refused exactly like any other cross-org
 *             update, and writes neither the deliverable nor a job.
 *   CRON      the recheck is bounded and skips terminal tasks.
 */

import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest as convexTestWithOrgs } from "convex-test";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import {
	actingWith,
	insertTaskRow,
	seedFleetAgents,
	seedOrgAgents,
} from "../../tests/lib/seedFleetAgents";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

function createT() {
	return convexTest(schema, modules).withIdentity({
		subject: "test-service-account-user-id",
	});
}
type T = ReturnType<typeof createT>;

// ── a minimal npm tarball (.tgz) built in memory ─────────────────────────────

function tarEntry(name: string, body: string): Buffer {
	const data = Buffer.from(body, "utf8");
	const header = Buffer.alloc(512, 0);
	header.write(name, 0, "utf8");
	header.write("0000644\0", 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("        ", 148);
	header.write("0", 156);
	header.write("ustar\0", 257);
	header.write("00", 263);
	let sum = 0;
	for (const b of header) sum += b;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
	return Buffer.concat([header, data, pad]);
}

function tgz(files: Record<string, string>): Uint8Array {
	const parts = Object.entries(files).map(([n, b]) => tarEntry(`package/${n}`, b));
	parts.push(Buffer.alloc(1024, 0));
	return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

const REGISTRY = "https://registry.npmjs.org";

/** Stubs fetch as the npm registry serving one package. */
function stubRegistry(opts: {
	pkg: string;
	version?: string;
	manifest?: Record<string, unknown>;
	files: Record<string, string>;
}) {
	const version = opts.version ?? "1.2.3";
	const tarballUrl = `${REGISTRY}/${opts.pkg}/-/pkg-${version}.tgz`;
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown) => {
			const url = String(input);
			calls.push(url);
			if (url === `${REGISTRY}/${opts.pkg.replace("/", "%2F")}/latest`) {
				return new Response(
					JSON.stringify({
						name: opts.pkg,
						version,
						types: "index.d.ts",
						dist: { tarball: tarballUrl },
						...opts.manifest,
					}),
					{ status: 200 },
				);
			}
			if (url === tarballUrl) return new Response(Buffer.from(tgz(opts.files)), { status: 200 });
			return new Response("not found", { status: 404 });
		}),
	);
	return calls;
}

// ── seeds ────────────────────────────────────────────────────────────────────

const DELIVERABLE = { pkg: "@vantageos/widget", export: "WidgetPanel" };
const FRESH_STATE = {
	state: "delivered" as const,
	version: "1.2.3",
	checkedAt: 1_700_000_000_000,
};

async function seedRow(
	t: T,
	over: Record<string, unknown> = {},
): Promise<import("../_generated/dataModel").Id<"tasks">> {
	return await t.run(async (ctx) =>
		insertTaskRow(ctx, {
			title: "ship the widget",
			assignedTo: "eta",
			createdBy: "eta",
			priority: "medium",
			status: "todo",
			createdAt: 1,
			updatedAt: 1,
			...over,
		}),
	);
}

async function scheduledResolveJobs(t: T): Promise<number> {
	return await t.run(async (ctx) => {
		const jobs = await ctx.db.system.query("_scheduled_functions").collect();
		return jobs.filter((j) => j.name.includes("taskDeliverable")).length;
	});
}

beforeEach(() => {
	// Any stray network call (an unflushed scheduled resolver) must fail closed.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("network disabled in test");
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("readers: derived deliverableDivergence beside the typed status", () => {
	test("delivered + todo -> 'delivered-but-open' on get/getById/list(full+lite); status untouched", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, {
			deliverable: DELIVERABLE,
			deliverableState: FRESH_STATE,
		});

		const got = await t.query(api.tasks.get, { taskId: id });
		expect(got?.deliverableDivergence).toBe("delivered-but-open");
		expect(got?.status).toBe("todo");
		expect(got?.deliverable).toEqual(DELIVERABLE);
		expect(got?.deliverableState).toEqual(FRESH_STATE);

		const byId = await t.query(api.tasks.getById, { taskId: id });
		expect(byId?.deliverableDivergence).toBe("delivered-but-open");
		expect(byId?.status).toBe("todo");

		const full = await t.query(api.tasks.list, { fields: "full" });
		const fullRow = (full as Array<Record<string, unknown>>).find((r) => r._id === id);
		expect(fullRow?.deliverableDivergence).toBe("delivered-but-open");

		const lite = await t.query(api.tasks.list, { fields: "lite" });
		const liteRow = (lite as Array<Record<string, unknown>>).find((r) => r._id === id);
		expect(liteRow?.deliverableDivergence).toBe("delivered-but-open");
		// lite carries the divergence ONLY, not the stored deliverable fields.
		expect(liteRow).not.toHaveProperty("deliverable");
		expect(liteRow).not.toHaveProperty("deliverableState");
	});

	test.each(["done", "cancelled"] as const)(
		"delivered + %s -> no divergence key",
		async (status) => {
			const t = createT();
			await seedFleetAgents(t, ["eta"]);
			const id = await seedRow(t, {
				status,
				deliverable: DELIVERABLE,
				deliverableState: FRESH_STATE,
				...(status === "cancelled" ? { cancelReason: "r" } : {}),
			});
			const got = await t.query(api.tasks.get, { taskId: id });
			expect(got).not.toHaveProperty("deliverableDivergence");
			expect(got?.status).toBe(status);
		},
	);

	test.each(["not_found", "unresolved"] as const)(
		"state %s + todo -> no divergence key",
		async (state) => {
			const t = createT();
			await seedFleetAgents(t, ["eta"]);
			const id = await seedRow(t, {
				deliverable: DELIVERABLE,
				deliverableState: { state, checkedAt: 5, reason: "x" },
			});
			const got = await t.query(api.tasks.get, { taskId: id });
			expect(got).not.toHaveProperty("deliverableDivergence");
		},
	);

	test("deliverable declared, never resolved -> no divergence key", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, { deliverable: DELIVERABLE });
		const got = await t.query(api.tasks.get, { taskId: id });
		expect(got).not.toHaveProperty("deliverableDivergence");
		expect(got).not.toHaveProperty("deliverableState");
	});

	test("a task without a deliverable reads byte-identically to its stored row (no new keys)", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t);
		const stored = await t.run(async (ctx) => ctx.db.get(id));
		const got = await t.query(api.tasks.get, { taskId: id });
		expect(got).toEqual(stored);
		expect(Object.keys(got ?? {}).sort()).toEqual(Object.keys(stored ?? {}).sort());
		const byId = await t.query(api.tasks.getById, { taskId: id });
		expect(Object.keys(byId ?? {}).sort()).toEqual(Object.keys(stored ?? {}).sort());
		const lite = (await t.query(api.tasks.list, { fields: "lite" })) as Array<
			Record<string, unknown>
		>;
		expect(Object.keys(lite.find((r) => r._id === id) ?? {}).sort()).toEqual(
			["_creationTime", "_id", "assignedTo", "priority", "status", "title"].sort(),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("resolver: npm registry check, fail-closed", () => {
	async function resolve(t: T, id: import("../_generated/dataModel").Id<"tasks">) {
		await t.action(internal.taskDeliverable.resolveTaskDeliverable, {
			taskId: id,
			pkg: DELIVERABLE.pkg,
			export: DELIVERABLE.export,
		});
		return (await t.run(async (ctx) => ctx.db.get(id)))?.deliverableState;
	}

	test("export declared in the published .d.ts -> delivered + version", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, { deliverable: DELIVERABLE });
		stubRegistry({
			pkg: DELIVERABLE.pkg,
			version: "2.0.1",
			files: {
				"index.d.ts": "export declare function WidgetPanel(): void;\n",
				"package.json": "{}",
			},
		});
		const state = await resolve(t, id);
		expect(state?.state).toBe("delivered");
		expect(state?.version).toBe("2.0.1");
		expect(typeof state?.checkedAt).toBe("number");
		// the typed status is never written by the resolver
		expect((await t.run(async (ctx) => ctx.db.get(id)))?.status).toBe("todo");
	});

	test("export reached through `export * from './x'` and `export { A as WidgetPanel }`", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, { deliverable: DELIVERABLE });
		stubRegistry({
			pkg: DELIVERABLE.pkg,
			files: {
				"index.d.ts": 'export * from "./panel";\n',
				"panel.d.ts": "declare const A: number;\nexport { A as WidgetPanel };\n",
			},
		});
		expect((await resolve(t, id))?.state).toBe("delivered");
	});

	test("export absent from the package -> not_found (and the name in a comment does not count)", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, { deliverable: DELIVERABLE });
		stubRegistry({
			pkg: DELIVERABLE.pkg,
			files: {
				"index.d.ts":
					"// export declare const WidgetPanel: number;\nexport declare const Other: number;\n",
			},
		});
		const state = await resolve(t, id);
		expect(state?.state).toBe("not_found");
		expect(state?.version).toBe("1.2.3");
	});

	test("a declaration in a file the entry point does not re-export does not count", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, { deliverable: DELIVERABLE });
		stubRegistry({
			pkg: DELIVERABLE.pkg,
			files: {
				"index.d.ts": "export declare const Other: number;\n",
				"internal/panel.d.ts": "export declare const WidgetPanel: number;\n",
			},
		});
		expect((await resolve(t, id))?.state).toBe("not_found");
	});

	test("registry 404 -> unresolved with a named reason, never delivered", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, { deliverable: DELIVERABLE });
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
		const state = await resolve(t, id);
		expect(state?.state).toBe("unresolved");
		expect(state?.reason).toMatch(/registry_http_404/);
	});

	test("fetch throws -> unresolved, never delivered", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, { deliverable: DELIVERABLE });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNRESET");
			}),
		);
		const state = await resolve(t, id);
		expect(state?.state).toBe("unresolved");
		expect(state?.reason).toMatch(/ECONNRESET/);
	});

	test("garbage tarball -> unresolved, never delivered", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, { deliverable: DELIVERABLE });
		const tarball = `${REGISTRY}/${DELIVERABLE.pkg}/-/pkg-1.0.0.tgz`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: unknown) =>
				String(u).endsWith("/latest")
					? new Response(
							JSON.stringify({ version: "1.0.0", dist: { tarball } }),
							{ status: 200 },
						)
					: new Response(Buffer.from([1, 2, 3, 4, 5]), { status: 200 }),
			),
		);
		expect((await resolve(t, id))?.state).toBe("unresolved");
	});

	test("a tarball URL outside the registry host is not fetched -> unresolved", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, { deliverable: DELIVERABLE });
		const fetchMock = vi.fn(async (u: unknown) =>
			String(u).endsWith("/latest")
				? new Response(
						JSON.stringify({
							version: "1.0.0",
							dist: { tarball: "http://169.254.169.254/x.tgz" },
						}),
						{ status: 200 },
					)
				: new Response("x", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const state = await resolve(t, id);
		expect(state?.state).toBe("unresolved");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("a package name that is not a valid npm name is never fetched -> unresolved", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, {
			deliverable: { pkg: "../etc/passwd", export: "X" },
		});
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		await t.action(internal.taskDeliverable.resolveTaskDeliverable, {
			taskId: id,
			pkg: "../etc/passwd",
			export: "X",
		});
		const state = (await t.run(async (ctx) => ctx.db.get(id)))?.deliverableState;
		expect(state?.state).toBe("unresolved");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("the deliverable changed while the check ran -> the stale result is not written", async () => {
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, {
			deliverable: { pkg: "other-pkg", export: "Other" },
		});
		stubRegistry({
			pkg: DELIVERABLE.pkg,
			files: { "index.d.ts": "export declare const WidgetPanel: number;\n" },
		});
		const state = await resolve(t, id);
		expect(state).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("writes: scheduling and tenant boundary", () => {
	test("create with a deliverable stores it and schedules the resolution", async () => {
		vi.useFakeTimers();
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await t.mutation(api.tasks.create, {
			title: "ship the widget",
			assignedTo: "eta",
			createdBy: "eta",
			priority: "low",
			status: "todo",
			deliverable: DELIVERABLE,
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.deliverable).toEqual(DELIVERABLE);
		expect(row?.deliverableState).toBeUndefined();
		expect(await scheduledResolveJobs(t)).toBe(1);
	});

	test("create without a deliverable schedules nothing", async () => {
		vi.useFakeTimers();
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		await t.mutation(api.tasks.create, {
			title: "plain",
			assignedTo: "eta",
			createdBy: "eta",
			priority: "low",
			status: "todo",
		});
		expect(await scheduledResolveJobs(t)).toBe(0);
	});

	test("update that changes the deliverable clears the stale state and schedules; an identical value does not", async () => {
		vi.useFakeTimers();
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t, {
			deliverable: DELIVERABLE,
			deliverableState: FRESH_STATE,
		});
		await t.mutation(api.tasks.update, {
			taskId: id,
			callerOrchestrator: "eta",
			deliverable: DELIVERABLE,
		});
		expect(await scheduledResolveJobs(t)).toBe(0);
		expect((await t.run(async (ctx) => ctx.db.get(id)))?.deliverableState).toEqual(
			FRESH_STATE,
		);

		await t.mutation(api.tasks.update, {
			taskId: id,
			callerOrchestrator: "eta",
			deliverable: { pkg: "@vantageos/widget", export: "Other" },
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.deliverable?.export).toBe("Other");
		expect(row?.deliverableState).toBeUndefined();
		expect(await scheduledResolveJobs(t)).toBe(1);
	});

	test("an invalid package name is refused at the door, nothing written", async () => {
		vi.useFakeTimers();
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const id = await seedRow(t);
		await expect(
			t.mutation(api.tasks.update, {
				taskId: id,
				callerOrchestrator: "eta",
				deliverable: { pkg: "../x", export: "A" },
			}),
		).rejects.toThrow(/INVALID_DELIVERABLE/);
		expect((await t.run(async (ctx) => ctx.db.get(id)))?.deliverable).toBeUndefined();
		expect(await scheduledResolveJobs(t)).toBe(0);
	});

	test("cross-org: org B setting a deliverable on org A's task is refused exactly like a title update, nothing written or scheduled", async () => {
		vi.useFakeTimers();
		const t = convexTestWithOrgs(schema, modules);
		await t.run(async (ctx) => {
			for (const slug of ["org-a", "org-b"]) {
				await ctx.db.insert("client_org_mapping", {
					clerkOrgSlug: slug,
					clerkOrgId: testClerkOrgId(slug),
					allowedOrchestrators: ["eta"],
					scopes: ["view-own-tasks", "view-own-missions"],
					displayName: slug,
					isActive: true,
					createdAt: Date.now(),
				});
			}
		});
		const secrets = await seedOrgAgents(t, [
			["org-a", "eta"],
			["org-b", "eta"],
		]);
		const asOrg = (slug: string) =>
			actingWith(
				t.withIdentity({
					subject: `user-${slug}`,
					organizationId: slug,
					org_id: testClerkOrgId(slug),
				} as Parameters<typeof t.withIdentity>[0]),
				(name) => secrets.get(`${slug}/${name}`),
			);

		const taskId = await asOrg("org-a").mutation(api.tasks.create, {
			title: "org-a private task",
			assignedTo: "eta",
			priority: "high",
			status: "todo",
			createdBy: "eta",
		});

		const refusalOf = async (extra: Record<string, unknown>) => {
			try {
				await asOrg("org-b").mutation(api.tasks.update, {
					taskId,
					callerOrchestrator: "eta",
					...extra,
				} as never);
			} catch (e) {
				return String((e as Error).message);
			}
			return null;
		};
		const baseline = await refusalOf({ title: "hijack" });
		expect(baseline).not.toBeNull();
		const withDeliverable = await refusalOf({ deliverable: DELIVERABLE });
		expect(withDeliverable).toBe(baseline);

		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.deliverable).toBeUndefined();
		expect(await scheduledResolveJobs(t as unknown as T)).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("cron: bounded re-resolution of open tasks carrying a deliverable", () => {
	test("schedules open deliverable tasks only; skips done/cancelled, no-deliverable and recently checked", async () => {
		vi.useFakeTimers();
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const open = await seedRow(t, { deliverable: DELIVERABLE });
		await seedRow(t, { deliverable: DELIVERABLE, status: "in_progress" });
		await seedRow(t, {
			deliverable: DELIVERABLE,
			status: "done",
			completionNote: "x",
			completedAt: 2,
		});
		await seedRow(t, { deliverable: DELIVERABLE, status: "cancelled", cancelReason: "r" });
		await seedRow(t, {});
		await seedRow(t, {
			deliverable: DELIVERABLE,
			deliverableState: { state: "unresolved", checkedAt: Date.now(), reason: "r" },
		});

		const scheduled = await t.action(internal.taskDeliverable.recheckOpenDeliverables, {});
		expect(scheduled).toBe(2);
		expect(await scheduledResolveJobs(t)).toBe(2);
		expect(open).toBeDefined();
	});

	test("never schedules more than the stated per-run cap", async () => {
		vi.useFakeTimers();
		const t = createT();
		await seedFleetAgents(t, ["eta"]);
		const { RECHECK_MAX_PER_RUN } = await import("../taskDeliverable");
		for (let i = 0; i < RECHECK_MAX_PER_RUN + 5; i++) {
			await seedRow(t, { deliverable: DELIVERABLE });
		}
		const scheduled = await t.action(internal.taskDeliverable.recheckOpenDeliverables, {});
		expect(scheduled).toBe(RECHECK_MAX_PER_RUN);
	});
});
