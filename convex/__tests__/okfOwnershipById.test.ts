/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, batch F1 (identity by ID, OKF bundle and knowledge base).
//
// The OKF doors decide on organisations by their permanent Clerk org ID, never by
// a slug label:
//   - a namespace names an organisation (`team/<id>`, or its legacy slug), and the
//     rows of a bundle are the rows STAMPED WITH THAT ID (`namespaceTarget`,
//     `ownsRow`); a row carrying only a label belongs to no client org;
//   - the ownership binding of a stored blob (`kbUploads`) carries the bound org's
//     ID, and validate / import judge it with the package's `sameOrg`; a binding
//     written before the ID column is owned by nobody (until the backfill runs);
//   - an imported task's assignee is resolved to an agent of the TARGET org; a
//     label that names none is reported as a conflict, never imported under a
//     dangling name.
//
// Poles: REFUSED (a foreign org's blob, a legacy binding, a foreign namespace),
// ABSENT (an org with nothing to export), PRESENT (the org's own rows and blob),
// cross-org (two orgs holding one label).

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { namespaceTarget, ownsRow } from "../okfBundle";
import { packTarball } from "../okfBundleNode";
import {
	serializeBriefingNote,
	serializeMemory,
	serializeTask,
} from "../okfSerializer";
import schema from "../schema";

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
type Identity = Parameters<T["withIdentity"]>[0];

// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround
const apiAny = api as any;

const SERVICE_ACCOUNT = "test-service-account-user-id";
const NOW = 1_780_000_000_000;
const OP_SLUG = "fleet-op";
const OP_ID = testClerkOrgId(OP_SLUG);
const A_SLUG = "acme-a";
const A_ID = testClerkOrgId(A_SLUG);
const B_SLUG = "acme-b";
const B_ID = testClerkOrgId(B_SLUG);

const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT } as Identity);
const claim = (orgSlug: string) => ({ verifiedOrg: { orgSlug } });

type World = { t: T; ids: Record<string, Id<"agents">> };

async function world(): Promise<World> {
	const t = createT();
	const ids: Record<string, Id<"agents">> = {};
	await t.run(async (ctx) => {
		const agent = (orgSlug: string, clerkOrgId: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		ids.opSigma = await agent(OP_SLUG, OP_ID, "sigma");
		ids.aSeat = await agent(A_SLUG, A_ID, "seat-x");
		ids.bSeat = await agent(B_SLUG, B_ID, "seat-x");
		const mapping = (
			slug: string,
			clerkOrgId: string,
			agentIds: Id<"agents">[],
			extra: Record<string, unknown> = {},
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId,
				allowedOrchestrators: [],
				allowedAgentIds: agentIds,
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...extra,
			});
		await mapping(OP_SLUG, OP_ID, [ids.opSigma], {
			orgKind: "operator",
			fleetWide: true,
		});
		await mapping(A_SLUG, A_ID, [ids.aSeat]);
		await mapping(B_SLUG, B_ID, [ids.bSeat]);
		await mapping("acme-off", testClerkOrgId("acme-off"), [], {
			isActive: false,
		});
	});
	return { t, ids };
}

describe("namespaceTarget / ownsRow decide by organisation ID", () => {
	test("a namespace names an org by ID or by its legacy slug; the fleet by the master namespace; nothing otherwise", async () => {
		const w = await world();
		const targets = await w.t.run(async (ctx) => ({
			byId: await namespaceTarget(ctx.db, `team/${A_ID}`),
			bySlug: await namespaceTarget(ctx.db, `team/${A_SLUG}`),
			fleet: await namespaceTarget(ctx.db, "project/elpi-corp"),
			unknown: await namespaceTarget(ctx.db, "team/no-such-org"),
			inactive: await namespaceTarget(ctx.db, "team/acme-off"),
		}));
		expect(targets.byId).toMatchObject({ kind: "org", slug: A_SLUG, clerkOrgId: A_ID });
		expect(targets.bySlug).toMatchObject({ kind: "org", slug: A_SLUG, clerkOrgId: A_ID });
		expect(targets.fleet.kind).toBe("fleet");
		expect(targets.unknown).toEqual({ kind: "none" });
		expect(targets.inactive).toEqual({ kind: "none" });
	});

	test("ownsRow: the org's ID owns, a label alone never does, the fleet owns unstamped and operator-stamped rows", async () => {
		const w = await world();
		const verdicts = await w.t.run(async (ctx) => {
			const org = await namespaceTarget(ctx.db, `team/${A_ID}`);
			const fleet = await namespaceTarget(ctx.db, "project/elpi-corp");
			return {
				ownId: ownsRow({ orgId: A_SLUG, clerkOrgId: A_ID }, org),
				labelOnly: ownsRow({ orgId: A_SLUG }, org),
				otherId: ownsRow({ orgId: A_SLUG, clerkOrgId: B_ID }, org),
				unstampedForOrg: ownsRow({}, org),
				fleetUnstamped: ownsRow({}, fleet),
				fleetOperator: ownsRow({ orgId: OP_SLUG, clerkOrgId: OP_ID }, fleet),
				fleetClient: ownsRow({ orgId: A_SLUG, clerkOrgId: A_ID }, fleet),
				fleetClientLabelOnly: ownsRow({ orgId: A_SLUG }, fleet),
				none: ownsRow({ clerkOrgId: A_ID }, { kind: "none" }),
			};
		});
		expect(verdicts).toEqual({
			ownId: true,
			labelOnly: false,
			otherId: false,
			unstampedForOrg: false,
			fleetUnstamped: true,
			fleetOperator: true,
			fleetClient: false,
			fleetClientLabelOnly: false,
			none: false,
		});
	});
});

describe("export reads the org's rows by ID", () => {
	test("PRESENT / cross-org / legacy: only rows stamped with the org's ID are exported", async () => {
		const w = await world();
		await w.t.run(async (ctx) => {
			const task = (title: string, slug: string | undefined, orgId: string | undefined, agent: Id<"agents">) =>
				ctx.db.insert("tasks", {
					title,
					description: "d",
					assignedTo: "seat-x",
					assignedToId: agent,
					priority: "medium",
					status: "todo",
					createdBy: "seat-x",
					createdAt: 1,
					updatedAt: 1,
					...(slug === undefined ? {} : { orgId: slug }),
					...(orgId === undefined ? {} : { clerkOrgId: orgId }),
				});
			await task("a task", A_SLUG, A_ID, w.ids.aSeat);
			await task("b task", B_SLUG, B_ID, w.ids.bSeat);
			// A client row written before IDs: a label only. It is nobody's.
			await task("legacy label-only task", A_SLUG, undefined, w.ids.aSeat);
			await ctx.db.insert("briefingNotes", {
				title: "a note",
				topic: "daily",
				participants: ["seat-x"],
				content: "c",
				createdBy: "seat-x",
				createdAt: 1,
				orgId: A_SLUG,
				clerkOrgId: A_ID,
			});
		});
		const out = await asService(w.t).action(apiAny.okfBundleNode.exportOkfBundle, {
			namespace: `team/${A_ID}`,
			format: "tarball",
			types: ["task", "briefing-note"],
			...claim(A_SLUG),
		});
		expect(out.manifest.types.taskCount).toBe(1);
		expect(out.manifest.types.briefingCount).toBe(1);
		// ABSENT: org B has no briefing note and exports an empty family.
		const b = await asService(w.t).action(apiAny.okfBundleNode.exportOkfBundle, {
			namespace: `team/${B_ID}`,
			format: "tarball",
			types: ["briefing-note"],
			...claim(B_SLUG),
		});
		expect(b.manifest.types.briefingCount).toBe(0);
	});
});

describe("blob ownership is judged by the org's ID", () => {
	async function storeBlob(w: World, binding?: { orgId: string; clerkOrgId?: string }) {
		return await w.t.run(async (ctx) => {
			const id = await ctx.storage.store(new Blob(["no tar here"]));
			if (binding !== undefined) {
				await ctx.db.insert("kbUploads", {
					storageId: id,
					orgId: binding.orgId,
					...(binding.clerkOrgId === undefined
						? {}
						: { clerkOrgId: binding.clerkOrgId }),
					createdAt: 1,
				});
			}
			return id;
		});
	}

	test("PRESENT own blob, REFUSED another org's blob and an unbound one, the fleet reads any", async () => {
		const w = await world();
		const mine = await storeBlob(w, { orgId: A_SLUG, clerkOrgId: A_ID });
		const theirs = await storeBlob(w, { orgId: B_SLUG, clerkOrgId: B_ID });
		const unbound = await storeBlob(w);
		const svc = asService(w.t);
		const own = await svc.action(apiAny.okfBundleNode.validateOkfBundle, {
			storageId: mine,
			...claim(A_SLUG),
		});
		expect(own.valid).toBe(false);
		await expect(
			svc.action(apiAny.okfBundleNode.validateOkfBundle, {
				storageId: theirs,
				...claim(A_SLUG),
			}),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
		await expect(
			svc.action(apiAny.okfBundleNode.validateOkfBundle, {
				storageId: unbound,
				...claim(A_SLUG),
			}),
		).rejects.toThrow(/AUTH_STORAGE_UNBOUND/);
		const fleet = await svc.action(apiAny.okfBundleNode.validateOkfBundle, {
			storageId: theirs,
			...claim(OP_SLUG),
		});
		expect(fleet.valid).toBe(false);
	});

	test("a binding whose KEY is a label another org took is owned by nobody: a label never grants", async () => {
		const w = await world();
		// A binding written before IDs under the label "acme-a": no org ID recorded.
		const legacy = await storeBlob(w, { orgId: A_SLUG });
		const svc = asService(w.t);
		await expect(
			svc.action(apiAny.okfBundleNode.validateOkfBundle, {
				storageId: legacy,
				...claim(A_SLUG),
			}),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
		await expect(
			svc.action(apiAny.okfBundleNode.validateOkfBundle, {
				storageId: legacy,
				...claim(B_SLUG),
			}),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
	});

	test("import refuses a blob another org owns, before reading a byte of it", async () => {
		const w = await world();
		const theirs = await storeBlob(w, { orgId: B_SLUG, clerkOrgId: B_ID });
		await expect(
			asService(w.t).action(apiAny.okfBundleNode.importOkfBundle, {
				storageId: theirs,
				targetNamespace: `team/${A_ID}`,
				mode: "merge",
				...claim(A_SLUG),
			}),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
	});
});

describe("import resolves an assignee to an agent of the TARGET org", () => {
	async function bundleWith(assignedTo: string): Promise<Buffer> {
		const mem = serializeMemory({
			_id: "k179mem001" as never,
			_creationTime: NOW,
			type: "reference",
			namespace: "x",
			content: "Imported memory body.",
			createdBy: "seat-x",
			createdAt: NOW,
			updatedAt: NOW,
		});
		const bri = serializeBriefingNote({
			_id: "k179bri001" as never,
			_creationTime: NOW,
			topic: "daily",
			title: "Imported briefing",
			content: "Body.",
			participants: ["seat-x"],
			createdBy: "seat-x",
			createdAt: NOW,
			updatedAt: NOW,
		});
		const tsk = serializeTask({
			_id: "k179tsk001" as never,
			_creationTime: NOW,
			title: "Imported task",
			description: "Body.",
			status: "todo",
			priority: "medium",
			assignedTo,
			createdBy: "seat-x",
			createdAt: NOW,
			updatedAt: NOW,
		});
		return await packTarball([
			{
				path: "index.md",
				content: '---\nokf_version: "0.1"\ntype: index\n---\n# Bundle\n',
			},
			{ path: mem.filePath, content: mem.content },
			{ path: bri.filePath, content: bri.content },
			{ path: tsk.filePath, content: tsk.content },
		]);
	}

	async function store(w: World, buf: Buffer, org: { slug: string; id: string }) {
		return await w.t.run(async (ctx) => {
			const id = await ctx.storage.store(new Blob([new Uint8Array(buf)]));
			await ctx.db.insert("kbUploads", {
				storageId: id,
				orgId: org.slug,
				clerkOrgId: org.id,
				createdAt: 1,
			});
			return id;
		});
	}

	test("PRESENT: an assignee that is an agent of the org is stored by ID and by its current label; rows are stamped with the org's ID; a replay is a no-op", async () => {
		const w = await world();
		const storageId = await store(w, await bundleWith("seat-x"), {
			slug: A_SLUG,
			id: A_ID,
		});
		const svc = asService(w.t);
		const first = await svc.action(apiAny.okfBundleNode.importOkfBundle, {
			storageId,
			targetNamespace: `team/${A_ID}`,
			mode: "merge",
			...claim(A_SLUG),
		});
		expect(first.imported).toEqual({ memories: 1, briefings: 1, tasks: 1 });
		expect(first.conflicts).toEqual([]);
		const rows = await w.t.run(async (ctx) => ({
			task: (await ctx.db.query("tasks").collect())[0],
			briefing: (await ctx.db.query("briefingNotes").collect())[0],
			memory: (await ctx.db.query("memories").collect())[0],
		}));
		expect(rows.task).toMatchObject({
			assignedTo: "seat-x",
			assignedToId: w.ids.aSeat,
			orgId: A_SLUG,
			clerkOrgId: A_ID,
		});
		expect(rows.briefing).toMatchObject({ orgId: A_SLUG, clerkOrgId: A_ID });
		expect(rows.memory).toMatchObject({ clerkOrgId: A_ID });
		const replay = await svc.action(apiAny.okfBundleNode.importOkfBundle, {
			storageId,
			targetNamespace: `team/${A_ID}`,
			mode: "merge",
			...claim(A_SLUG),
		});
		expect(replay.skipped).toBe(3);
		expect(replay.imported).toEqual({ memories: 0, briefings: 0, tasks: 0 });
	});

	test("REFUSED: an assignee that names no agent of the target org is a conflict, and the task is not imported", async () => {
		const w = await world();
		const storageId = await store(w, await bundleWith("ghost"), {
			slug: A_SLUG,
			id: A_ID,
		});
		const out = await asService(w.t).action(apiAny.okfBundleNode.importOkfBundle, {
			storageId,
			targetNamespace: `team/${A_ID}`,
			mode: "merge",
			...claim(A_SLUG),
		});
		expect(out.imported.tasks).toBe(0);
		expect(out.conflicts).toHaveLength(1);
		expect(out.conflicts[0].reason).toContain("ASSIGNEE_NOT_IN_ORG");
		const tasks = await w.t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(tasks).toEqual([]);
	});

	test("cross-org: the same label is another org's agent, so org B's import resolves to org B's agent", async () => {
		const w = await world();
		const storageId = await store(w, await bundleWith("seat-x"), {
			slug: B_SLUG,
			id: B_ID,
		});
		await asService(w.t).action(apiAny.okfBundleNode.importOkfBundle, {
			storageId,
			targetNamespace: `team/${B_ID}`,
			mode: "merge",
			...claim(B_SLUG),
		});
		const task = await w.t.run(async (ctx) => (await ctx.db.query("tasks").collect())[0]);
		expect(task).toMatchObject({ assignedToId: w.ids.bSeat, clerkOrgId: B_ID });
	});

	test("the fleet's import (operator claim) into the master namespace stays unstamped and resolves in the operator org", async () => {
		const w = await world();
		const storageId = await w.t.run(async (ctx) => {
			const bytes = await bundleWith("sigma");
			return await ctx.storage.store(new Blob([new Uint8Array(bytes)]));
		});
		await asService(w.t).action(apiAny.okfBundleNode.importOkfBundle, {
			storageId,
			targetNamespace: "project/elpi-corp",
			mode: "merge",
			...claim(OP_SLUG),
		});
		const task = await w.t.run(async (ctx) => (await ctx.db.query("tasks").collect())[0]);
		expect(task).toMatchObject({ assignedToId: w.ids.opSigma, assignedTo: "sigma" });
		expect(task.clerkOrgId).toBeUndefined();
		expect(task.orgId).toBeUndefined();
	});
});
