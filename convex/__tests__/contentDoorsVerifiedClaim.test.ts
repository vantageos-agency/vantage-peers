/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, batch F1 (backend standard R-54): every content door the
// fleet service account can reach acts inside an organisation the transport
// VERIFIED for the call; a call that carries no verified claim is refused, never
// served as master.
//
// Every MCP caller reaches Convex as ONE service account, which resolves to
// master. The doors in this file (diary, memories, memoriesScoped, episodes, the
// knowledge-base mutations and actions, the OKF bundle actions, the durable
// export) therefore take `verifiedOrg` and:
//   - refuse a service-account call that carries none (RBAC_DENIED,
//     `verified-claim-required`, naming the door);
//   - refuse the claim from anyone but the service account (`verified-org-not-trusted`);
//   - refuse a claim naming no active organisation (`org-not-active`);
//   - run a CLIENT org's claim under that org's MEMBER scope: its own rows are
//     served, another org's never are;
//   - keep the FLEET's reach for the operator org's claim.
//
// Poles per door: REFUSED (claimless / untrusted / foreign), ABSENT (a claimed
// caller reading nothing is served an empty SUCCESS), PRESENT (the claimed org's
// own rows are served), plus a cross-org deny (a claim for org B never reaches
// org A's row).

import { ConvexError } from "convex/values";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import agentEngineSchema from "../../node_modules/@vantageos/agent-engine/dist/component/schema.js";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
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

// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (okfBundleDurable / kb are added to the typed api by codegen)
const apiAny = api as any;

const SERVICE_ACCOUNT = "test-service-account-user-id";
const NOW = 1_780_000_000_000;
const DATE = "2026-10-01";

const OP_SLUG = "fleet-op";
const OP_ID = testClerkOrgId(OP_SLUG);
const A_SLUG = "acme-a";
const A_ID = testClerkOrgId(A_SLUG);
const B_SLUG = "acme-b";
const B_ID = testClerkOrgId(B_SLUG);
const OFF_SLUG = "acme-off";

// A stored memory schedules its RAG indexing; the scheduler is drained under fake
// timers (the RAG module is not part of this harness), as the knowledge-base suite does.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT } as Identity);
const asMember = (t: T, slug: string) =>
	t.withIdentity({
		subject: `member-of-${slug}`,
		organizationSlug: slug,
		org_id: testClerkOrgId(slug),
		org_role: "org:member",
	} as Identity);
const claim = (orgSlug: string) => ({ verifiedOrg: { orgSlug } });

/** The ConvexError data (or the Error message) a refused call carries. */
async function refusal(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (e) {
		return e instanceof ConvexError
			? String((e as ConvexError<string>).data)
			: String((e as Error).message);
	}
	throw new Error("expected a refusal, got a success");
}

type World = {
	t: T;
	ids: Record<string, Id<"agents">>;
};

async function world(t: T = createT()): Promise<World> {
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
		ids.opPi = await agent(OP_SLUG, OP_ID, "pi");
		ids.aSeat = await agent(A_SLUG, A_ID, "seat-x");
		ids.bSeat = await agent(B_SLUG, B_ID, "seat-x");
		const mapping = (
			slug: string,
			clerkOrgId: string,
			roster: string[],
			agentIds: Id<"agents">[],
			extra: Record<string, unknown> = {},
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId,
				allowedOrchestrators: roster,
				allowedAgentIds: agentIds,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...extra,
			});
		await mapping(OP_SLUG, OP_ID, ["pi"], [ids.opPi], {
			orgKind: "operator",
			fleetWide: true,
		});
		await mapping(A_SLUG, A_ID, ["seat-x"], [ids.aSeat]);
		await mapping(B_SLUG, B_ID, ["seat-x"], [ids.bSeat]);
		await mapping(OFF_SLUG, testClerkOrgId(OFF_SLUG), [], [], {
			isActive: false,
		});
	});
	return { t, ids };
}

async function seedDiary(w: World): Promise<Record<string, Id<"diary">>> {
	return await w.t.run(async (ctx) => {
		const row = (
			content: string,
			agentId: Id<"agents">,
			slug: string,
			orgId: string,
		) =>
			ctx.db.insert("diary", {
				date: DATE,
				orchestrator: "seat-x",
				agentId,
				content,
				createdAt: 1,
				orgId: slug,
				clerkOrgId: orgId,
			});
		return {
			a: await row("a's entry", w.ids.aSeat, A_SLUG, A_ID),
			b: await row("b's entry", w.ids.bSeat, B_SLUG, B_ID),
		};
	});
}

async function seedMemories(w: World): Promise<Record<string, Id<"memories">>> {
	return await w.t.run(async (ctx) => {
		const row = (
			namespace: string,
			content: string,
			orgId: string,
			createdById: Id<"agents">,
		) =>
			ctx.db.insert("memories", {
				namespace,
				type: "project",
				content,
				createdBy: "seat-x",
				createdById,
				relations: [],
				isLatest: true,
				clerkOrgId: orgId,
				createdAt: 1,
				updatedAt: 1,
			});
		const episode = (namespace: string, orgId: string) =>
			ctx.db.insert("memories", {
				namespace,
				type: "episode",
				content: "Context: c | Goal: g | Action: a | Outcome: o | Insight: i",
				createdBy: "seat-x",
				relations: [],
				isLatest: true,
				clerkOrgId: orgId,
				episode: {
					context: "c",
					goal: "g",
					action: "a",
					outcome: "o",
					insight: "i",
					severity: "critical",
				},
				createdAt: 2,
				updatedAt: 2,
			});
		return {
			a: await row(`team/${A_ID}`, "a's memory", A_ID, w.ids.aSeat),
			b: await row(`team/${B_ID}`, "b's memory", B_ID, w.ids.bSeat),
			aEpisode: await episode(`team/${A_ID}`, A_ID),
			bEpisode: await episode(`team/${B_ID}`, B_ID),
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE CONTRACT, said at every door: claimless / untrusted / inactive.
// ─────────────────────────────────────────────────────────────────────────────

type DoorCall = (
	w: World,
	who: "service" | "member",
	extra: Record<string, unknown>,
) => Promise<unknown>;

/** The doors whose valid call needs only the claim argument added. */
function doorCalls(
	w: World,
	ids: {
		diaryA: Id<"diary">;
		memA: Id<"memories">;
		storage: Id<"_storage">;
	},
): Record<string, DoorCall> {
	const svc = (who: "service" | "member") =>
		who === "service" ? asService(w.t) : asMember(w.t, A_SLUG);
	return {
		"diary:write": (_w, who, extra) =>
			svc(who).mutation(api.diary.write, {
				date: DATE,
				orchestrator: "seat-x",
				content: "x",
				createdBy: "seat-x",
				...extra,
			}),
		"diary:get": (_w, who, extra) =>
			svc(who).query(api.diary.get, { date: DATE, orchestrator: "seat-x", ...extra }),
		"diary:list": (_w, who, extra) => svc(who).query(api.diary.list, { ...extra }),
		"diary:listByDateRange": (_w, who, extra) =>
			svc(who).query(api.diary.listByDateRange, { from: DATE, to: DATE, ...extra }),
		"diary:deleteDiary": (_w, who, extra) =>
			svc(who).mutation(api.diary.deleteDiary, {
				diaryId: ids.diaryA,
				callerOrchestrator: "seat-x",
				...extra,
			}),
		"memories:storeMemory": (_w, who, extra) =>
			svc(who).mutation(api.memories.storeMemory, {
				namespace: `team/${A_ID}`,
				type: "project",
				content: "new",
				createdBy: "seat-x",
				...extra,
			}),
		"memories:getMemory": (_w, who, extra) =>
			svc(who).query(api.memories.getMemory, {
				memoryId: ids.memA,
				...extra,
			}),
		"memories:listMemories": (_w, who, extra) =>
			svc(who).query(api.memories.listMemories, {
				namespace: `team/${A_ID}`,
				...extra,
			}),
		"memoriesScoped:storeMemoryScoped": (_w, who, extra) =>
			svc(who).mutation(api.memoriesScoped.storeMemoryScoped, {
				namespace: `team/${A_ID}`,
				type: "project",
				content: "new",
				createdBy: "seat-x",
				...extra,
			}),
		"memoriesScoped:listMemoriesScoped": (_w, who, extra) =>
			svc(who).query(api.memoriesScoped.listMemoriesScoped, {
				namespace: `team/${A_ID}`,
				...extra,
			}),
		"episodes:storeEpisode": (_w, who, extra) =>
			svc(who).mutation(api.episodes.storeEpisode, {
				namespace: `team/${A_ID}`,
				createdBy: "seat-x",
				context: "c",
				goal: "g",
				action: "a",
				outcome: "o",
				insight: "i",
				severity: "minor",
				...extra,
			}),
		"episodes:listEpisodes": (_w, who, extra) =>
			svc(who).query(api.episodes.listEpisodes, {
				namespace: `team/${A_ID}`,
				...extra,
			}),
		"episodes:getCriticalInsights": (_w, who, extra) =>
			svc(who).query(api.episodes.getCriticalInsights, { ...extra }),
		"kbMutations:generateUploadUrl": (_w, who, extra) =>
			svc(who).mutation(apiAny.kbMutations.generateUploadUrl, {
				orgId: A_ID,
				namespace: `team/${A_ID}/doc`,
				...extra,
			}),
		"kbMutations:generateUploadUrlWithTicket": (_w, who, extra) =>
			svc(who).mutation(apiAny.kbMutations.generateUploadUrlWithTicket, {
				orgId: A_ID,
				namespace: `team/${A_ID}/doc`,
				sha256: "a".repeat(64),
				...extra,
			}),
		"kbMutations:claimUpload": (_w, who, extra) =>
			svc(who).mutation(apiAny.kbMutations.claimUpload, {
				storageId: ids.storage,
				ticket: "b".repeat(64),
				...extra,
			}),
		"okfBundleDurable:startOkfBundleExportDurable": (_w, who, extra) =>
			svc(who).mutation(apiAny.okfBundleDurable.startOkfBundleExportDurable, {
				namespace: `team/${A_ID}`,
				totalSteps: 3,
				...extra,
			}),
		"okfBundleDurable:getOkfBundleExportDurableStatus": (_w, who, extra) =>
			svc(who).query(apiAny.okfBundleDurable.getOkfBundleExportDurableStatus, {
				jobId: "job-a",
				...extra,
			}),
		"okfBundleDurable:cancelOkfBundleExportDurable": (_w, who, extra) =>
			svc(who).mutation(apiAny.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-a",
				...extra,
			}),
		"kb:storeDocumentChunked": (_w, who, extra) =>
			svc(who).action(apiAny.kb.storeDocumentChunked, {
				storageId: ids.storage,
				mimeType: "text/plain",
				filename: "a.txt",
				orgId: A_ID,
				namespace: `team/${A_ID}`,
				...extra,
			}),
		"kb:softDeleteDocument": (_w, who, extra) =>
			svc(who).action(apiAny.kb.softDeleteDocument, {
				docId: "doc-1",
				orgId: A_ID,
				namespace: `team/${A_ID}`,
				...extra,
			}),
		"okfBundleNode:exportOkfBundle": (_w, who, extra) =>
			svc(who).action(apiAny.okfBundleNode.exportOkfBundle, {
				namespace: `team/${A_ID}`,
				format: "tarball",
				...extra,
			}),
		"okfBundleNode:importOkfBundle": (_w, who, extra) =>
			svc(who).action(apiAny.okfBundleNode.importOkfBundle, {
				targetNamespace: `team/${A_ID}`,
				mode: "dry-run",
				...extra,
			}),
		"okfBundleNode:validateOkfBundle": (_w, who, extra) =>
			svc(who).action(apiAny.okfBundleNode.validateOkfBundle, { ...extra }),
	};
}

async function contractWorld(): Promise<{
	w: World;
	calls: Record<string, DoorCall>;
}> {
	const w = await world();
	const diary = await seedDiary(w);
	const mem = await seedMemories(w);
	const storage = await w.t.run(async (ctx) =>
		ctx.storage.store(new Blob(["hello"], { type: "text/plain" })),
	);
	await w.t.run(async (ctx) => {
		await ctx.db.insert("okfDurableExportProgress", {
			jobId: "job-a",
			orgId: A_ID,
			namespace: `team/${A_ID}`,
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
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
	const calls = doorCalls(w, {
		diaryA: diary.a,
		memA: mem.a,
		storage,
	});
	return { w, calls };
}

describe("R-54: every content door refuses a claimless service-account call", () => {
	test("REFUSED: RBAC_DENIED verified-claim-required, naming the door", { timeout: 60_000 }, async () => {
		const { w, calls } = await contractWorld();
		for (const [door, call] of Object.entries(calls)) {
			const data = await refusal(() => call(w, "service", {}));
			expect(data, door).toContain("RBAC_DENIED");
			expect(data, door).toContain("verified-claim-required");
			expect(data, door).toContain(door);
		}
	});

	test("REFUSED: a member presenting the claim is refused, not ignored (trusted from the service account only)", { timeout: 60_000 }, async () => {
		const { w, calls } = await contractWorld();
		for (const [door, call] of Object.entries(calls)) {
			const data = await refusal(() => call(w, "member", claim(B_SLUG)));
			expect(data, door).toContain("RBAC_DENIED");
			expect(data, door).toContain("verified-org-not-trusted");
		}
	});

	test("REFUSED: a claim naming an inactive or unknown organisation is refused (org-not-active)", { timeout: 60_000 }, async () => {
		const { w, calls } = await contractWorld();
		for (const slug of [OFF_SLUG, "org-does-not-exist"]) {
			for (const [door, call] of Object.entries(calls)) {
				const data = await refusal(() => call(w, "service", claim(slug)));
				expect(data, door).toContain("RBAC_DENIED");
				expect(data, door).toContain("org-not-active");
			}
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// diary
// ─────────────────────────────────────────────────────────────────────────────

describe("diary doors under a verified claim", () => {
	test("PRESENT: the claimed org's own entry is read, listed and range-read", async () => {
		const w = await world();
		await seedDiary(w);
		const svc = asService(w.t);
		const got = await svc.query(api.diary.get, {
			date: DATE,
			orchestrator: "seat-x",
			...claim(A_SLUG),
		});
		expect(got?.content).toBe("a's entry");
		const listed = await svc.query(api.diary.list, { ...claim(A_SLUG) });
		expect(Array.isArray(listed)).toBe(true);
		expect((listed as { content: string }[]).map((r) => r.content)).toEqual([
			"a's entry",
		]);
		const ranged = await svc.query(api.diary.listByDateRange, {
			from: DATE,
			to: DATE,
			...claim(A_SLUG),
		});
		expect(ranged.map((r) => r.content)).toEqual(["a's entry"]);
	});

	test("FOREIGN: a claim for org B never reaches org A's entry (the same name and date, another agent)", async () => {
		const w = await world();
		await seedDiary(w);
		const svc = asService(w.t);
		const got = await svc.query(api.diary.get, {
			date: DATE,
			orchestrator: "seat-x",
			...claim(B_SLUG),
		});
		expect(got?.content).toBe("b's entry");
		const listed = await svc.query(api.diary.list, { ...claim(B_SLUG) });
		expect((listed as { content: string }[]).map((r) => r.content)).toEqual([
			"b's entry",
		]);
	});

	test("ABSENT: a claimed org with no entries is served an empty SUCCESS, never a refusal", async () => {
		const w = await world();
		const svc = asService(w.t);
		expect(
			await svc.query(api.diary.get, {
				date: DATE,
				orchestrator: "seat-x",
				...claim(A_SLUG),
			}),
		).toBeNull();
		expect(await svc.query(api.diary.list, { ...claim(A_SLUG) })).toEqual([]);
		expect(
			await svc.query(api.diary.listByDateRange, {
				from: DATE,
				to: DATE,
				...claim(A_SLUG),
			}),
		).toEqual([]);
	});

	test("PRESENT: write stamps the claimed org and the orchestrator's agent ID; FOREIGN: another org's same-named agent is another row", async () => {
		const w = await world();
		const svc = asService(w.t);
		const idA = await svc.mutation(api.diary.write, {
			date: DATE,
			orchestrator: "seat-x",
			content: "written for a",
			createdBy: "seat-x",
			...claim(A_SLUG),
		});
		const idB = await svc.mutation(api.diary.write, {
			date: DATE,
			orchestrator: "seat-x",
			content: "written for b",
			createdBy: "seat-x",
			...claim(B_SLUG),
		});
		expect(idA).not.toBe(idB);
		const rows = await w.t.run(async (ctx) => [
			await ctx.db.get(idA),
			await ctx.db.get(idB),
		]);
		expect(rows[0]).toMatchObject({
			agentId: w.ids.aSeat,
			clerkOrgId: A_ID,
			orgId: A_SLUG,
			createdBy: "seat-x",
			createdById: w.ids.aSeat,
		});
		expect(rows[1]).toMatchObject({ agentId: w.ids.bSeat, clerkOrgId: B_ID });
	});

	test("REFUSED: a label that names no agent on the claimed org's roster cannot be written for", async () => {
		const w = await world();
		const data = await refusal(() =>
			asService(w.t).mutation(api.diary.write, {
				date: DATE,
				orchestrator: "pi",
				content: "x",
				createdBy: "seat-x",
				...claim(A_SLUG),
			}),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("orchestrator-not-listed");
	});

	test("the operator org's claim keeps the fleet's reach (an operator agent's entry, unstamped)", async () => {
		const w = await world();
		const svc = asService(w.t);
		const id = await svc.mutation(api.diary.write, {
			date: DATE,
			orchestrator: "pi",
			content: "fleet entry",
			createdBy: "pi",
			...claim(OP_SLUG),
		});
		const row = await w.t.run(async (ctx) => ctx.db.get(id));
		expect(row).toMatchObject({ agentId: w.ids.opPi });
		expect(row?.clerkOrgId).toBeUndefined();
		const got = await svc.query(api.diary.get, {
			date: DATE,
			orchestrator: "pi",
			...claim(OP_SLUG),
		});
		expect(got?.content).toBe("fleet entry");
	});

	test("deleteDiary: the owner agent deletes; another org's claim is refused; REFUSED claimless", async () => {
		const w = await world();
		const ids = await seedDiary(w);
		const svc = asService(w.t);
		const foreign = await refusal(() =>
			svc.mutation(api.diary.deleteDiary, {
				diaryId: ids.a,
				callerOrchestrator: "seat-x",
				...claim(B_SLUG),
			}),
		);
		expect(foreign).toContain("RBAC_DENIED");
		expect(foreign).toContain("row-not-in-caller-org");
		expect(
			await svc.mutation(api.diary.deleteDiary, {
				diaryId: ids.a,
				callerOrchestrator: "seat-x",
				...claim(A_SLUG),
			}),
		).toEqual({ deleted: true });
		// ABSENT: the entry is gone; the claimed caller is told so, plainly.
		await expect(
			svc.mutation(api.diary.deleteDiary, {
				diaryId: ids.a,
				callerOrchestrator: "seat-x",
				...claim(A_SLUG),
			}),
		).rejects.toThrow(/not found/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// memories, memoriesScoped, episodes
// ─────────────────────────────────────────────────────────────────────────────

describe("memory-table doors under a verified claim", () => {
	test("PRESENT: store files a row under the claimed org (stamp, author, author ID); REFUSED: another org's namespace", async () => {
		const w = await world();
		const svc = asService(w.t);
		const id = await svc.mutation(api.memories.storeMemory, {
			namespace: `team/${A_ID}`,
			type: "project",
			content: "remember this",
			createdBy: "seat-x",
			...claim(A_SLUG),
		});
		await drain(w.t);
		const row = await w.t.run(async (ctx) => ctx.db.get(id));
		expect(row).toMatchObject({
			clerkOrgId: A_ID,
			createdBy: "seat-x",
			createdById: w.ids.aSeat,
		});
		const data = await refusal(() =>
			svc.mutation(api.memories.storeMemory, {
				namespace: `team/${B_ID}`,
				type: "project",
				content: "into b",
				createdBy: "seat-x",
				...claim(A_SLUG),
			}),
		);
		expect(data).toContain("RBAC_DENIED");
	});

	test("PRESENT / FOREIGN / ABSENT: getMemory and listMemories are the claimed org's alone", async () => {
		const w = await world();
		const mem = await seedMemories(w);
		const svc = asService(w.t);
		expect(
			(await svc.query(api.memories.getMemory, { memoryId: mem.a, ...claim(A_SLUG) }))
				?.content,
		).toBe("a's memory");
		// FOREIGN: org B asks for A's row by ID: answered null, like a missing row.
		expect(
			await svc.query(api.memories.getMemory, { memoryId: mem.a, ...claim(B_SLUG) }),
		).toBeNull();
		const listA = await svc.query(api.memories.listMemories, {
			namespace: `team/${A_ID}`,
			type: "project",
			...claim(A_SLUG),
		});
		expect(listA.value.map((r) => r.content)).toEqual(["a's memory"]);
		// FOREIGN: org B reading A's namespace is served the empty page.
		expect(
			(
				await svc.query(api.memories.listMemories, {
					namespace: `team/${A_ID}`,
					type: "project",
					...claim(B_SLUG),
				})
			).value,
		).toEqual([]);
		// ABSENT: a claimed org's namespace with no rows is an empty SUCCESS.
		expect(
			(
				await svc.query(api.memories.listMemories, {
					namespace: `team/${A_ID}/empty`,
					...claim(A_SLUG),
				})
			).value,
		).toEqual([]);
	});

	test("softDeleteMemory: a client claim confines; another org's row is refused; a master-only tool's claimless call is the fleet's (declared)", async () => {
		const w = await world();
		const mem = await seedMemories(w);
		const svc = asService(w.t);
		const foreign = await refusal(() =>
			svc.mutation(api.memories.softDeleteMemory, { memoryId: mem.a, ...claim(B_SLUG) }),
		);
		expect(foreign).toContain("RBAC_DENIED");
		expect(foreign).toContain("memory-not-in-caller-org");
		await svc.mutation(api.memories.softDeleteMemory, {
			memoryId: mem.a,
			...claim(A_SLUG),
		});
		// The fleet's own claimless call (the master-only MCP tool) still retires any row.
		await svc.mutation(api.memories.softDeleteMemory, { memoryId: mem.b });
		await drain(w.t);
		const rows = await w.t.run(async (ctx) => [
			await ctx.db.get(mem.a),
			await ctx.db.get(mem.b),
		]);
		expect(rows.map((r) => r?.isLatest)).toEqual([false, false]);
	});

	test("memoriesScoped: PRESENT own namespace, FOREIGN refused, ABSENT empty", async () => {
		const w = await world();
		await seedMemories(w);
		const svc = asService(w.t);
		const own = await svc.query(api.memoriesScoped.listMemoriesScoped, {
			namespace: `team/${A_ID}`,
			type: "project",
			...claim(A_SLUG),
		});
		expect(own.map((r) => r.content)).toEqual(["a's memory"]);
		await expect(
			svc.query(api.memoriesScoped.listMemoriesScoped, {
				namespace: `team/${A_ID}`,
				...claim(B_SLUG),
			}),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
		expect(
			await svc.query(api.memoriesScoped.listMemoriesScoped, {
				namespace: `team/${A_ID}/none`,
				...claim(A_SLUG),
			}),
		).toEqual([]);
		const id = await svc.mutation(api.memoriesScoped.storeMemoryScoped, {
			namespace: `team/${A_ID}`,
			type: "project",
			content: "scoped",
			createdBy: "seat-x",
			...claim(A_SLUG),
		});
		const row = await w.t.run(async (ctx) => ctx.db.get(id));
		expect(row).toMatchObject({ clerkOrgId: A_ID, createdById: w.ids.aSeat });
	});

	test("episodes: PRESENT own, FOREIGN never, ABSENT empty (store, list, critical insights)", async () => {
		const w = await world();
		await seedMemories(w);
		const svc = asService(w.t);
		const stored = await svc.mutation(api.episodes.storeEpisode, {
			namespace: `team/${A_ID}`,
			createdBy: "seat-x",
			context: "c",
			goal: "g",
			action: "a",
			outcome: "o",
			insight: "stored insight",
			severity: "critical",
			...claim(A_SLUG),
		});
		await drain(w.t);
		const row = await w.t.run(async (ctx) => ctx.db.get(stored));
		expect(row).toMatchObject({ clerkOrgId: A_ID, createdById: w.ids.aSeat });
		await expect(
			svc.mutation(api.episodes.storeEpisode, {
				namespace: `team/${B_ID}`,
				createdBy: "seat-x",
				context: "c",
				goal: "g",
				action: "a",
				outcome: "o",
				insight: "i",
				severity: "minor",
				...claim(A_SLUG),
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const listed = await svc.query(api.episodes.listEpisodes, {
			namespace: `team/${A_ID}`,
			...claim(A_SLUG),
		});
		expect(listed).toHaveLength(2);
		expect(
			await svc.query(api.episodes.listEpisodes, {
				namespace: `team/${A_ID}`,
				...claim(B_SLUG),
			}),
		).toEqual([]);
		const critical = await svc.query(api.episodes.getCriticalInsights, {
			...claim(B_SLUG),
		});
		expect(critical.map((c) => c.namespace)).toEqual([`team/${B_ID}`]);
		const own = await svc.query(api.episodes.getCriticalInsights, {
			...claim(A_SLUG),
		});
		expect(own.length).toBeGreaterThan(0);
		expect(own.every((c) => c.namespace === `team/${A_ID}`)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// knowledge-base mutations and actions
// ─────────────────────────────────────────────────────────────────────────────

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("knowledge-base doors under a verified claim", () => {
	test("PRESENT: a claimed org mints its own upload URL and ticket; FOREIGN: another org's namespace is refused", async () => {
		const w = await world();
		const svc = asService(w.t);
		const url = await svc.mutation(apiAny.kbMutations.generateUploadUrl, {
			orgId: A_ID,
			namespace: `team/${A_ID}/doc`,
			...claim(A_SLUG),
		});
		expect(typeof url).toBe("string");
		const minted = await svc.mutation(apiAny.kbMutations.generateUploadUrlWithTicket, {
			orgId: A_ID,
			namespace: `team/${A_ID}/doc`,
			sha256: sha256Hex("file"),
			...claim(A_SLUG),
		});
		expect(minted.ticket).toMatch(/^[0-9a-f]{64}$/);
		const data = await refusal(() =>
			svc.mutation(apiAny.kbMutations.generateUploadUrlWithTicket, {
				orgId: A_ID,
				namespace: `team/${A_ID}/doc`,
				sha256: sha256Hex("file"),
				...claim(B_SLUG),
			}),
		);
		expect(data).toContain("RBAC_DENIED");
	});

	test("claimUpload binds the blob to the claimed org BY ID; another org's claim cannot use the ticket; an unknown ticket is invalid", async () => {
		const w = await world();
		const svc = asService(w.t);
		const body = "claimed file";
		const minted = await svc.mutation(apiAny.kbMutations.generateUploadUrlWithTicket, {
			orgId: A_ID,
			namespace: `team/${A_ID}/doc`,
			sha256: sha256Hex(body),
			...claim(A_SLUG),
		});
		const storageId = await w.t.run(async (ctx) =>
			ctx.storage.store(new Blob([body], { type: "text/plain" })),
		);
		const foreign = await refusal(() =>
			svc.mutation(apiAny.kbMutations.claimUpload, {
				storageId,
				ticket: minted.ticket,
				...claim(B_SLUG),
			}),
		);
		expect(foreign).toContain("AUTH_UPLOAD_TICKET_NOT_YOURS");
		const unknown = await refusal(() =>
			svc.mutation(apiAny.kbMutations.claimUpload, {
				storageId,
				ticket: "0".repeat(64),
				...claim(A_SLUG),
			}),
		);
		expect(unknown).toContain("AUTH_UPLOAD_TICKET_INVALID");
		const claimed = await svc.mutation(apiAny.kbMutations.claimUpload, {
			storageId,
			ticket: minted.ticket,
			...claim(A_SLUG),
		});
		expect(claimed).toEqual({ storageId, orgId: A_SLUG });
		const bound = await w.t.run(async (ctx) =>
			ctx.db.query("kbUploads").collect(),
		);
		expect(bound).toHaveLength(1);
		expect(bound[0]).toMatchObject({ orgId: A_SLUG, clerkOrgId: A_ID });
	});

	test("storeDocumentChunked / softDeleteDocument: PRESENT own org, FOREIGN refused, the binding carries the org ID", async () => {
		const w = await world();
		const svc = asService(w.t);
		const storageId = await w.t.run(async (ctx) =>
			ctx.storage.store(new Blob(["# hello\n\nworld"], { type: "text/markdown" })),
		);
		const stored = await svc.action(apiAny.kb.storeDocumentChunked, {
			storageId,
			mimeType: "text/markdown",
			filename: "a.md",
			orgId: A_ID,
			namespace: `team/${A_ID}`,
			docId: "doc-1",
			...claim(A_SLUG),
		});
		expect(stored.chunkCount).toBeGreaterThan(0);
		await drain(w.t);
		const bound = await w.t.run(async (ctx) => ctx.db.query("kbUploads").collect());
		expect(bound[0]).toMatchObject({ clerkOrgId: A_ID });
		const foreign = await refusal(() =>
			svc.action(apiAny.kb.storeDocumentChunked, {
				storageId,
				mimeType: "text/markdown",
				filename: "a.md",
				orgId: A_ID,
				namespace: `team/${A_ID}`,
				docId: "doc-2",
				...claim(B_SLUG),
			}),
		);
		expect(foreign).toContain("AUTH_NAMESPACE_DENIED");
		const deleted = await svc.action(apiAny.kb.softDeleteDocument, {
			docId: "doc-1",
			orgId: A_ID,
			namespace: `team/${A_ID}`,
			...claim(A_SLUG),
		});
		await drain(w.t);
		expect(deleted.markedCount).toBeGreaterThan(0);
		const nothing = await svc.action(apiAny.kb.softDeleteDocument, {
			docId: "doc-none",
			orgId: A_ID,
			namespace: `team/${A_ID}`,
			...claim(A_SLUG),
		});
		expect(nothing.markedCount).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// OKF bundle actions
// ─────────────────────────────────────────────────────────────────────────────

describe("OKF bundle doors under a verified claim", () => {
	test("export: PRESENT own namespace (bound to the org ID), FOREIGN refused, ABSENT empty bundle", async () => {
		const w = await world();
		await seedMemories(w);
		const svc = asService(w.t);
		const out = await svc.action(apiAny.okfBundleNode.exportOkfBundle, {
			namespace: `team/${A_ID}`,
			format: "tarball",
			...claim(A_SLUG),
		});
		expect(out.manifest.types.memoryCount).toBe(2);
		const bound = await w.t.run(async (ctx) => ctx.db.query("kbUploads").collect());
		expect(bound).toHaveLength(1);
		expect(bound[0]).toMatchObject({ orgId: A_SLUG, clerkOrgId: A_ID });
		const foreign = await refusal(() =>
			svc.action(apiAny.okfBundleNode.exportOkfBundle, {
				namespace: `team/${A_ID}`,
				format: "tarball",
				...claim(B_SLUG),
			}),
		);
		expect(foreign).toContain("RBAC_DENIED");
		const empty = await svc.action(apiAny.okfBundleNode.exportOkfBundle, {
			namespace: `team/${A_ID}/none`,
			format: "tarball",
			...claim(A_SLUG),
		});
		expect(empty.manifest.types.memoryCount).toBe(0);
	});

	test("import: the target namespace is the claimed org's; another org's is refused before any source is read", async () => {
		const w = await world();
		const svc = asService(w.t);
		// PRESENT: past the gate, the next refusal is the missing SOURCE, not RBAC.
		const present = await refusal(() =>
			svc.action(apiAny.okfBundleNode.importOkfBundle, {
				targetNamespace: `team/${A_ID}`,
				mode: "dry-run",
				...claim(A_SLUG),
			}),
		);
		expect(present).toContain("OKF_IMPORT_NO_SOURCE");
		const foreign = await refusal(() =>
			svc.action(apiAny.okfBundleNode.importOkfBundle, {
				targetNamespace: `team/${A_ID}`,
				mode: "dry-run",
				...claim(B_SLUG),
			}),
		);
		expect(foreign).toContain("RBAC_DENIED");
	});

	test("validate: PRESENT own blob, FOREIGN blob refused by ID, ABSENT source asked for", async () => {
		const w = await world();
		const svc = asService(w.t);
		const storageId = await w.t.run(async (ctx) => {
			const id = await ctx.storage.store(new Blob(["not a tarball"]));
			await ctx.db.insert("kbUploads", {
				storageId: id,
				orgId: A_SLUG,
				clerkOrgId: A_ID,
				createdAt: 1,
			});
			return id;
		});
		const own = await svc.action(apiAny.okfBundleNode.validateOkfBundle, {
			storageId,
			...claim(A_SLUG),
		});
		expect(own.valid).toBe(false);
		const foreign = await refusal(() =>
			svc.action(apiAny.okfBundleNode.validateOkfBundle, {
				storageId,
				...claim(B_SLUG),
			}),
		);
		expect(foreign).toContain("AUTH_STORAGE_NOT_OWNED");
		const absent = await refusal(() =>
			svc.action(apiAny.okfBundleNode.validateOkfBundle, { ...claim(A_SLUG) }),
		);
		expect(absent).toContain("OKF_VALIDATE_INPUT_MISSING");
	});

	test("durable export: a claimed org passes the gate (the engine boundary is the harness's), a foreign namespace and a foreign job are refused", async () => {
		const base = createT();
		base.registerComponent(
			"agentEngine",
			agentEngineSchema as never,
			import.meta.glob(
				"../../node_modules/@vantageos/agent-engine/dist/component/**/*.js",
			) as never,
		);
		const w = await world(base);
		await w.t.run(async (ctx) => {
			await ctx.db.insert("okfDurableExportProgress", {
				jobId: "job-a",
				orgId: A_ID,
				namespace: `team/${A_ID}`,
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
				createdAt: NOW,
				updatedAt: NOW,
			});
		});
		const svc = asService(w.t);
		// PRESENT: past the claim and the namespace gate, the harness cannot cross the
		// component boundary: that error is not a refusal.
		const present = await refusal(() =>
			svc.mutation(apiAny.okfBundleDurable.startOkfBundleExportDurable, {
				namespace: `team/${A_ID}`,
				totalSteps: 3,
				...claim(A_SLUG),
			}),
		);
		expect(present).not.toContain("RBAC_DENIED");
		const foreignNs = await refusal(() =>
			svc.mutation(apiAny.okfBundleDurable.startOkfBundleExportDurable, {
				namespace: `team/${A_ID}`,
				totalSteps: 3,
				...claim(B_SLUG),
			}),
		);
		expect(foreignNs).toContain("RBAC_DENIED");
		const foreignStatus = await refusal(() =>
			svc.query(apiAny.okfBundleDurable.getOkfBundleExportDurableStatus, {
				jobId: "job-a",
				...claim(B_SLUG),
			}),
		);
		expect(foreignStatus).toContain("RBAC_DENIED");
		const foreignCancel = await refusal(() =>
			svc.mutation(apiAny.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-a",
				...claim(B_SLUG),
			}),
		);
		expect(foreignCancel).toContain("RBAC_DENIED");
		// ABSENT: an unknown job is told so to a claimed member, never served as empty.
		const absent = await refusal(() =>
			svc.query(apiAny.okfBundleDurable.getOkfBundleExportDurableStatus, {
				jobId: "job-none",
				...claim(A_SLUG),
			}),
		);
		expect(absent).toContain("OKF_DURABLE_JOB_NOT_FOUND");
	});
});
