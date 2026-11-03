/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// CLASS: a retired (erased / superseded) row never comes back through a read path.
// One test group per table the schema flags as ERASURE (convex/lib/retired.ts
// RETIREMENT): memories (isLatest), missionTemplates (deletedAt), orgMembership
// (deletedAt). The RAG search paths of `memories` are pinned in
// kbRetiredChunkLeavesRag.test.ts; the static conformance of every read site is
// pinned in retiredRowsConformance.test.ts.
//
// Every read below runs under a scoped CLIENT identity (an active member of
// org X, a JWT with org_id), never the service account. missionTemplates is a
// fleet-wide catalog that refuses an org member by design, so for it the client
// pole is "refused, and the retired row is not in what the refusal says", and the
// fleet pole (internal twin / master) is "live names only".

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { storeClaimed } from "../../tests/fixtures/storeClaimed";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { __setQueryEmbedderForTests, __setRagSearcherForTests } from "../search";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const X = "org-x";
const X_ID = testClerkOrgId(X);

const asMember = (t: T) =>
	t.withIdentity({
		subject: "user-x",
		organizationId: X,
		organizationSlug: X,
		org_id: X_ID,
	} as Identity);

async function seedOrg(t: T): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: X,
			clerkOrgId: X_ID,
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: X,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

describe("memories (isLatest): a retired memory is not served to an org member", () => {
	async function seed(t: T) {
		return await t.run(async (ctx) => {
			const base = {
				namespace: `team/${X_ID}/notes`,
				type: "project" as const,
				createdBy: "kb" as const,
				relations: [],
				clerkOrgId: X_ID,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			const live = await ctx.db.insert("memories", {
				...base,
				content: "live",
				isLatest: true,
			});
			const dead = await ctx.db.insert("memories", {
				...base,
				content: "dead",
				isLatest: false,
			});
			return { live, dead };
		});
	}

	test("getMemory: a retired memory's ID answers like a missing one; the live one is served", async () => {
		const t = createT();
		await seedOrg(t);
		const { live, dead } = await seed(t);
		expect(
			await asMember(t).query(api.memories.getMemory, { memoryId: dead }),
		).toBeNull();
		const got = await asMember(t).query(api.memories.getMemory, {
			memoryId: live,
		});
		expect(got?._id).toBe(live);
	});

	test("listMemories: a member's includeSuperseded is ignored; no retired row on any branch", async () => {
		const t = createT();
		await seedOrg(t);
		const { live } = await seed(t);
		const ns = `team/${X_ID}/notes`;
		const variants = [
			{ namespace: ns },
			{ namespace: ns, includeSuperseded: true },
			{ namespace: ns, type: "project" as const, includeSuperseded: true },
			{
				namespace: ns,
				includeSuperseded: true,
				paginationOpts: { numItems: 10, cursor: null },
			},
		];
		for (const args of variants) {
			const r = await asMember(t).query(api.memories.listMemories, args);
			expect(r.value.map((m) => m._id)).toEqual([live]);
		}
	});

	test("listEpisodes: a superseded episode is not listed", async () => {
		const t = createT();
		await seedOrg(t);
		const ids = await t.run(async (ctx) => {
			const ep = {
				namespace: `team/${X_ID}/eps`,
				type: "episode" as const,
				createdBy: "kb" as const,
				relations: [],
				clerkOrgId: X_ID,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				episode: {
					context: "c",
					goal: "g",
					action: "a",
					outcome: "o",
					insight: "i",
					severity: "minor" as const,
				},
			};
			const live = await ctx.db.insert("memories", {
				...ep,
				content: "live ep",
				isLatest: true,
			});
			await ctx.db.insert("memories", {
				...ep,
				content: "dead ep",
				isLatest: false,
			});
			return live;
		});
		const rows = await asMember(t).query(api.episodes.listEpisodes, {
			namespace: `team/${X_ID}/eps`,
		});
		expect(rows.map((r) => r._id)).toEqual([ids]);
	});

	test("OKF export fetch: a retired memory is not in the bundle page", async () => {
		const t = createT();
		await seedOrg(t);
		const { live } = await seed(t);
		const page = await t.query(internal.okfBundle._fetchMemoriesForBundle, {
			namespace: `team/${X_ID}/notes`,
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(page.page.map((r: { _id: string }) => r._id)).toEqual([live]);
	});
});

describe("missionTemplates (deletedAt): a soft-deleted template is not served", () => {
	async function seed(t: T) {
		await t.run(async (ctx) => {
			const base = {
				steps: [{ title: "S1", description: "d" }],
				isDefault: false,
				createdBy: "sigma" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			await ctx.db.insert("missionTemplates", { ...base, name: "tpl-live" });
			await ctx.db.insert("missionTemplates", {
				...base,
				name: "tpl-dead",
				deletedAt: Date.now(),
			});
		});
	}

	test("fleet read (internal twin): live name found, retired name is null", async () => {
		const t = createT();
		await seed(t);
		expect(
			(await t.query(internal.missionTemplates.getByNameInternal, {
				name: "tpl-live",
			}))?.name,
		).toBe("tpl-live");
		expect(
			await t.query(internal.missionTemplates.getByNameInternal, {
				name: "tpl-dead",
			}),
		).toBeNull();
	});

	test("org member: the catalog is refused (listNames, getByName); nothing about the retired row is served", async () => {
		const t = createT();
		await seedOrg(t);
		await seed(t);
		const names = await asMember(t)
			.query(api.missionTemplates.listNames, {})
			.catch((e: unknown) => String(e));
		expect(JSON.stringify(names)).not.toContain("tpl-dead");
		const one = await asMember(t)
			.query(api.missionTemplates.getByName, { name: "tpl-dead" })
			.catch((e: unknown) => String(e));
		expect(one === null || typeof one === "string").toBe(true);
	});

	test("master listNames: the retired name is absent", async () => {
		const t = createT();
		await seed(t);
		const names = await t
			.withIdentity({ subject: "test-service-account-user-id" } as Identity)
			.query(api.missionTemplates.listNames, {});
		expect(names).toContain("tpl-live");
		expect(names).not.toContain("tpl-dead");
	});

	test("org member: instantiating a retired template is 'Template not found'", async () => {
		const t = createT();
		await seedOrg(t);
		await seed(t);
		const missionId = await t.run(async (ctx) =>
			ctx.db.insert("missions", {
				name: "m",
				project: "p",
				status: "execute",
				priority: "urgent",
				pilot: "sigma",
				agents: ["sigma"],
				createdBy: "sigma",
				clerkOrgId: X_ID,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		await expect(
			asMember(t).mutation(api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: "tpl-dead",
				missionId,
			}),
		).rejects.toThrow(/Template not found|RBAC_DENIED/);
	});
});

describe("orgMembership (deletedAt): a removed member is not listed", () => {
	test("getMembership: the tombstoned member is absent for an org member reading its own org and itself", async () => {
		const t = createT();
		await seedOrg(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			const row = {
				clerkOrgSlug: X,
				clerkOrgId: X_ID,
				role: "member" as const,
				createdAt: now,
				updatedAt: now,
			};
			await ctx.db.insert("orgMembership", { ...row, clerkUserId: "user-x" });
			await ctx.db.insert("orgMembership", {
				...row,
				clerkUserId: "user-gone",
				deletedAt: now,
			});
		});
		const org = await asMember(t).query(api.orgMembership.getMembership, {
			clerkOrgSlug: X,
		});
		expect(org.map((m) => m.clerkUserId)).toEqual(["user-x"]);
		const self = await asMember(t).query(api.orgMembership.getMembership, {});
		expect(self.map((m) => m.clerkUserId)).toEqual(["user-x"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// KB documents. A KB document is a set of `memories` rows filed in the namespace
// `team/<orgId>/<docId>` (kbMutations.insertChunk, type "reference"), so its
// retirement marker is memories.isLatest -- the same marker as every memory. The
// document is ingested through the REAL kb:storeDocumentChunked action and
// retired through the REAL kb:softDeleteDocument action (-> markDocSoftDeleted
// -> scheduleRagRetire), then read as an org member.
//
// KB listing doors: none exists. convex/kb.ts exports storeDocumentChunked and
// softDeleteDocument only; convex/kbMutations.ts has upload/claim mutations and
// internal helpers; mcp-server/src/tools/kbIngest.ts registers
// store_document_chunked, soft_delete_document, generate_upload_url, claim_upload.
// A KB document is therefore read only through search (recall / text_search /
// hybrid_search), getMemory, listMemories and the OKF export fetch -- all below.
//
// The RAG backend is a fake that ORs its filters like the component
// (node_modules/@convex-dev/rag/dist/component/embeddings/index.js:49,
// component/search.js:129). ragSync is "use node" and not loadable: its scheduled
// jobs are read from _scheduled_functions and applied to the fake, as the real
// actions would add / re-add the entry under the same key.
// ─────────────────────────────────────────────────────────────────────────────

describe("KB document (memories rows, marker memories.isLatest): a soft-deleted document is read by no door", () => {
	type Entry = {
		key: string;
		text: string;
		type: string;
		isLatest: "true" | "false";
	};
	const indexed = new Map<string, Entry[]>();

	beforeEach(() => {
		vi.useFakeTimers();
		indexed.clear();
		__setQueryEmbedderForTests(async () => [0.1, 0.2, 0.3]);
		__setRagSearcherForTests((async (
			_ctx: unknown,
			args: {
				namespace: string;
				limit?: number;
				filters?: Array<{ name: string; value: string }>;
			},
		) => {
			const filters = args.filters ?? [];
			const matched = (indexed.get(args.namespace) ?? [])
				.filter((e) => {
					if (filters.length === 0) return true;
					const fields: Record<string, string> = {
						namespace: args.namespace,
						type: e.type,
						isLatest: e.isLatest,
					};
					return filters.some((f) => fields[f.name] === f.value);
				})
				.slice(0, args.limit ?? 10);
			return {
				results: matched.map((r, i) => ({
					entryId: `${args.namespace}#${r.key}`,
					score: 0.9 - i * 0.01,
					content: [{ text: r.text }],
				})),
				entries: matched.map((r) => ({
					entryId: `${args.namespace}#${r.key}`,
					key: r.key,
					filterValues: [
						{ name: "namespace", value: args.namespace },
						{ name: "type", value: r.type },
						{ name: "isLatest", value: r.isLatest },
					],
				})),
			};
		}) as unknown as Parameters<typeof __setRagSearcherForTests>[0]);
	});
	afterEach(() => {
		vi.useRealTimers();
		__setRagSearcherForTests(null);
		__setQueryEmbedderForTests(null);
	});

	/** Applies the scheduled ragSync jobs (add / re-add) to the fake index, in order. */
	async function applyScheduledRagJobs(t: T): Promise<void> {
		const jobs = await t.run(async (ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		for (const job of jobs) {
			const name = String(job.name);
			const isAdd = name.includes("addRagEntry");
			const isRetire = name.includes("markRagEntrySuperseded");
			if (!isAdd && !isRetire) continue;
			const a = job.args[0] as {
				memoryId: string;
				content: string;
				namespace: string;
				type: string;
			};
			const list = indexed.get(a.namespace) ?? [];
			const existing = list.find((e) => e.key === a.memoryId);
			const latest = isRetire ? "false" : "true";
			if (existing) {
				existing.isLatest = latest;
			} else {
				list.push({
					key: a.memoryId,
					text: a.content,
					type: a.type,
					isLatest: latest,
				});
			}
			indexed.set(a.namespace, list);
		}
	}

	async function ingest(t: T, text: string): Promise<string> {
		const storageId = await t.run(async (ctx) =>
			storeClaimed(ctx, X_ID, new Blob([text], { type: "text/plain" })),
		);
		const res = await asMember(t).action(api.kb.storeDocumentChunked, {
			storageId,
			mimeType: "text/plain",
			filename: "doc.txt",
			orgId: X_ID,
			namespace: `team/${X_ID}`,
		});
		return res.docId;
	}

	const TOOLS = [
		{ name: "recall", ref: api.search.recall },
		{ name: "textSearch", ref: api.search.textSearch },
		{ name: "hybridSearch", ref: api.search.hybridSearch },
	] as const;

	test("a retired KB document is absent from search (root and exact), getMemory, listMemories and the OKF fetch; its live twin is served", async () => {
		const t = createT();
		await seedOrg(t);
		const deadDoc = await ingest(t, "doomed document body");
		const liveDoc = await ingest(t, "surviving document body");
		const dead = `team/${X_ID}/${deadDoc}`;
		const live = `team/${X_ID}/${liveDoc}`;

		const rowIds = async (ns: string) =>
			t.run(async (ctx) =>
				(
					await ctx.db
						.query("memories")
						.withIndex("by_namespace", (q) => q.eq("namespace", ns))
						.collect()
				).map((r) => r._id),
			);
		const deadRows = await rowIds(dead);
		const liveRows = await rowIds(live);
		expect(deadRows.length).toBeGreaterThan(0);
		expect(liveRows.length).toBeGreaterThan(0);

		await applyScheduledRagJobs(t); // the ingest's addRagEntry jobs

		// PRESENT before the delete: both documents are found on the root.
		for (const { ref } of TOOLS) {
			const root = (await asMember(t).action(ref, {
				query: "document",
				namespace: `team/${X_ID}`,
			})) as Array<{ memoryId: string }>;
			expect(root.map((r) => r.memoryId).sort()).toEqual(
				[...deadRows, ...liveRows].sort(),
			);
		}

		// Soft-delete through the real door: markDocSoftDeleted + scheduleRagRetire.
		const del = await asMember(t).action(api.kb.softDeleteDocument, {
			docId: deadDoc,
			orgId: X_ID,
			namespace: `team/${X_ID}`,
		});
		expect(del.markedCount).toBe(deadRows.length);
		await applyScheduledRagJobs(t); // the retire jobs

		for (const { name, ref } of TOOLS) {
			const root = (await asMember(t).action(ref, {
				query: "document",
				namespace: `team/${X_ID}`,
			})) as Array<{ memoryId: string }>;
			expect(root.map((r) => r.memoryId).sort(), `${name} root`).toEqual(
				[...liveRows].sort(),
			);
			const exactDead = (await asMember(t).action(ref, {
				query: "document",
				namespace: dead,
			})) as unknown[];
			expect(exactDead, `${name} exact (retired)`).toEqual([]);
			const exactLive = (await asMember(t).action(ref, {
				query: "document",
				namespace: live,
			})) as Array<{ memoryId: string }>;
			expect(
				exactLive.map((r) => r.memoryId).sort(),
				`${name} exact (live twin)`,
			).toEqual([...liveRows].sort());
		}

		// getMemory by the chunk's memory id.
		for (const id of deadRows) {
			expect(
				await asMember(t).query(api.memories.getMemory, { memoryId: id }),
			).toBeNull();
		}
		const twin = await asMember(t).query(api.memories.getMemory, {
			memoryId: liveRows[0],
		});
		expect(twin?._id).toBe(liveRows[0]);

		// listMemories (default, and with the member's includeSuperseded ignored).
		for (const extra of [{}, { includeSuperseded: true }]) {
			const deadList = await asMember(t).query(api.memories.listMemories, {
				namespace: dead,
				...extra,
			});
			expect(deadList.value).toEqual([]);
			const liveList = await asMember(t).query(api.memories.listMemories, {
				namespace: live,
				...extra,
			});
			expect(liveList.value.map((r) => r._id).sort()).toEqual(
				[...liveRows].sort(),
			);
		}

		// OKF export fetch (internal; the export action calls it after its own gate).
		const deadPage = await t.query(internal.okfBundle._fetchMemoriesForBundle, {
			namespace: dead,
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(deadPage.page).toEqual([]);

		// Legacy shape: a document retired BEFORE the re-index existed (rows
		// isLatest=false, RAG entries still "true") is hidden the same way.
		const legacyDoc = await ingest(t, "legacy document body");
		await applyScheduledRagJobs(t);
		const legacyNs = `team/${X_ID}/${legacyDoc}`;
		await t.mutation(internal.kbMutations.markDocSoftDeleted, {
			namespace: legacyNs,
		});
		// (retire jobs deliberately NOT applied: the RAG entries stay isLatest="true")
		for (const { name, ref } of TOOLS) {
			const exact = (await asMember(t).action(ref, {
				query: "document",
				namespace: legacyNs,
			})) as unknown[];
			expect(exact, `${name} legacy exact`).toEqual([]);
		}
	});
});
