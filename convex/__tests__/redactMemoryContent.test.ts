/// <reference types="vite/client" />
//
// redactMemoryContent — bipolar erase proof.
//
// softDeleteMemory only flips isLatest to false; the body stays readable by
// id and the RAG entry keeps the original text. redactMemoryContent is the
// real erase path: it patches the body in place, recomputes contentHash,
// and (via convex/ragSync.ts's replaceRagEntryContent, exercised on a real
// deployment — see the note below) purges the superseded RAG chunks.
//
// The RAG component itself CANNOT be driven under convex-test here:
//   - convex/ragSync.ts and convex/search.ts both carry "use node" and
//     import convex/lib/aiClient.ts, which eagerly constructs the embedding
//     client at module load (`getAITextEmbeddingProvider()` — throws unless
//     AI_GATEWAY_API_KEY / OPENAI_API_KEY is set).
//   - Every existing test in this directory that touches memories.ts
//     (memories.softDeleteMemory.wrongTable.test.ts, auth-namespace-deny.test.ts,
//     okfBundleDurable.test.ts) excludes "ragSync" and "search" from the
//     convex-test module map for exactly this reason.
//   - convex-test also does not cross a REAL component boundary for the
//     RAG component's call shapes (see okfBundleDurable.test.ts's
//     documented `getFunctionMetadata` limitation for a sibling component).
//
// So this file proves the DB-level (and text-search-proxy) bipolar contract
// — the part that runs entirely inside convex-test — and leaves the actual
// rag.add()/rag.delete() purge to convex/__tests__/../lib/ragEntryReplacement
// unit coverage (ragEntryReplacement.test.ts) plus a live-deployment check.
// The scheduled replaceRagEntryContent call is left PENDING under fake
// timers below (never executed), exactly like the existing softDeleteMemory
// tests do for its sibling markRagEntrySuperseded.
//
// Cross-tenant deny: convex/ragSync.ts is touched by this task, so this file
// also carries a `cross-tenant deny` regression check confirming redaction
// does not weaken the existing per-namespace isolation on memoriesScoped —
// required by .claude/hooks/enforce-rag-namespace-deny-test.py.

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// Fake-shaped, clearly-not-real credential value. Deliberately not 32 chars
// and not a plausible real key format — this is a test fixture, not a leak.
const FAKE_TOKEN = "fake-cred-marker-zzz-should-be-erased";

// storeMemory/redactMemoryContent schedule ragSync functions via
// ctx.scheduler.runAfter. ragSync is excluded from `modules` above, so on
// real timers those scheduled jobs fire after the test and reject as
// UNHANDLED errors — green assertions, red CI job. Fake timers keep the
// scheduler under test control (same pattern as
// memories.softDeleteMemory.wrongTable.test.ts).
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

// The fleet service account: the only caller the redact door admits.
function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

const newMemoryWithToken = (t: ReturnType<typeof createT>, content: string) =>
	asMaster(t).mutation(api.memories.storeMemory, {
		namespace: "global",
		type: "reference",
		content,
		createdBy: "sigma",
	});

describe("redactMemoryContent — bipolar erase proof", () => {
	test("redacted memory no longer contains the secret; contentHash changes; the control memory is untouched", async () => {
		const t = createT();

		const targetId = await newMemoryWithToken(
			t,
			`credential leaked: ${FAKE_TOKEN} in a log line`,
		);
		const controlId = await newMemoryWithToken(
			t,
			`credential leaked: ${FAKE_TOKEN} in a log line`,
		);

		const before = await t.run(async (ctx) => ctx.db.get(targetId));
		expect(before?.content).toContain(FAKE_TOKEN);

		const result = await t.mutation(internal.memories.redactMemoryContentFleet, {
			memoryId: targetId,
			redactions: [{ find: FAKE_TOKEN, replaceWith: "[REDACTED]" }],
		});

		expect(result.memoryId).toBe(targetId);
		expect(result.replacements).toBe(1);
		expect(result.contentHashChanged).toBe(true);

		const redacted = await t.run(async (ctx) => ctx.db.get(targetId));
		expect(redacted).not.toBeNull();
		expect(redacted?.content).not.toContain(FAKE_TOKEN);
		expect(redacted?.content).toContain("[REDACTED]");
		expect(redacted?.contentHash).toBeDefined();
		expect(redacted?.contentHash).not.toBe(before?.contentHash);

		// Control memory (same original content, never redacted) still holds
		// the token — proves the patch is scoped to the target id, not global.
		const control = await t.run(async (ctx) => ctx.db.get(controlId));
		expect(control?.content).toContain(FAKE_TOKEN);

		// Text-search proxy: textSearch (the MCP text_search path) reads
		// whatever text was last fed into rag.add() via replaceRagEntryContent
		// — the RAG component itself cannot run in this harness (see file
		// header), so this asserts the EXACT text that call is scheduled with.
		// The redacted memory's scheduled RAG payload must not carry the
		// token; the control memory's original addRagEntry payload still does.
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		const redactedJob = scheduled.find(
			(job) =>
				job.name.includes("ragSync") &&
				job.name.includes("replaceRagEntryContent"),
		);
		expect(redactedJob).toBeDefined();
		const redactedArgs = redactedJob?.args[0] as { content?: string } | undefined;
		expect(redactedArgs?.content).not.toContain(FAKE_TOKEN);

		const controlJob = scheduled.find(
			(job) =>
				job.name.includes("ragSync") &&
				job.name.includes("addRagEntry") &&
				(job.args[0] as { memoryId?: string })?.memoryId === controlId,
		);
		expect(controlJob).toBeDefined();
		const controlArgs = controlJob?.args[0] as { content?: string } | undefined;
		expect(controlArgs?.content).toContain(FAKE_TOKEN);
	});

	test("multiple occurrences of the same find string all get replaced and counted", async () => {
		const t = createT();
		const targetId = await newMemoryWithToken(
			t,
			`${FAKE_TOKEN} appears twice: ${FAKE_TOKEN}`,
		);

		const result = await t.mutation(internal.memories.redactMemoryContentFleet, {
			memoryId: targetId,
			redactions: [{ find: FAKE_TOKEN, replaceWith: "[REDACTED]" }],
		});

		expect(result.replacements).toBe(2);

		const redacted = await t.run(async (ctx) => ctx.db.get(targetId));
		expect(redacted?.content).not.toContain(FAKE_TOKEN);
	});

	test("zero-occurrence redaction throws — refuses a silent no-op", async () => {
		const t = createT();
		const targetId = await newMemoryWithToken(t, "no secrets in here at all");

		await expect(
			t.mutation(internal.memories.redactMemoryContentFleet, {
				memoryId: targetId,
				redactions: [{ find: "not-present-anywhere", replaceWith: "x" }],
			}),
		).rejects.toThrow(/zero occurrences/i);

		// Content is untouched when the call is refused.
		const untouched = await t.run(async (ctx) => ctx.db.get(targetId));
		expect(untouched?.content).toBe("no secrets in here at all");
	});

	test("redacting a nonexistent memoryId throws", async () => {
		const t = createT();
		const targetId = await newMemoryWithToken(t, `${FAKE_TOKEN} present`);
		await t.run(async (ctx) => {
			await ctx.db.delete(targetId);
		});

		await expect(
			t.mutation(internal.memories.redactMemoryContentFleet, {
				memoryId: targetId,
				redactions: [{ find: FAKE_TOKEN, replaceWith: "x" }],
			}),
		).rejects.toThrow(/not found/i);
	});

	test("cross-tenant deny — redacting a memory does not weaken per-namespace isolation on memoriesScoped", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-a",
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: "org-a",
				isActive: true,
				createdAt: Date.now(),
			});
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-b",
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: "org-b",
				isActive: true,
				createdAt: Date.now(),
			});
		});

		const orgBMemoryId: Id<"memories"> = await t.run(async (ctx) =>
			ctx.db.insert("memories", {
				namespace: "team/org-b",
				type: "reference",
				content: `${FAKE_TOKEN} belongs to org-b`,
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		await t.mutation(internal.memories.redactMemoryContentFleet, {
			memoryId: orgBMemoryId,
			redactions: [{ find: FAKE_TOKEN, replaceWith: "[REDACTED]" }],
		});

		const tA = t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
		} as Parameters<typeof t.withIdentity>[0]);

		// org-a still cannot read team/org-b, redacted or not —
		// AUTH_NAMESPACE_DENIED (cross-tenant deny) is unaffected by redaction.
		await expect(
			tA.query(api.memoriesScoped.listMemoriesScoped, {
				namespace: "team/org-b",
			}),
		).rejects.toThrow("AUTH_NAMESPACE_DENIED");
	});


	// ── RBAC: a client erases its own memories ──────────────────────────────
	// Identities: org-a's ADMIN (not the creator "sigma", not the master),
	// org-a's plain MEMBER (no admin role), org-b's ADMIN (another org).

	async function rbacWorld() {
		const t = createT();
		await t.run(async (ctx) => {
			for (const slug of ["org-a", "org-b"]) {
				await ctx.db.insert("client_org_mapping", {
					clerkOrgSlug: slug,
					clerkOrgId: testClerkOrgId(slug),
					allowedOrchestrators: ["sigma"],
					scopes: ["view-own-tasks"],
					displayName: slug,
					isActive: true,
					createdAt: Date.now(),
				});
			}
		});
		const memoryId: Id<"memories"> = await t.run(async (ctx) =>
			ctx.db.insert("memories", {
				namespace: "team/org-a",
				clerkOrgId: testClerkOrgId("org-a"),
				type: "reference",
				content: `${FAKE_TOKEN} present`,
				contentHash: "original-hash",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const as = (org: string, role: string, subject: string) =>
			t.withIdentity({
				subject,
				org_slug: org,
				org_id: testClerkOrgId(org),
				org_role: role,
			} as Parameters<typeof t.withIdentity>[0]);
		return {
			t,
			memoryId,
			args: {
				memoryId,
				redactions: [{ find: FAKE_TOKEN, replaceWith: "[REDACTED]" }],
			},
			adminA: as("org-a", "org:admin", "admin-of-org-a"),
			memberA: as("org-a", "org:member", "member-of-org-a"),
			adminB: as("org-b", "org:admin", "admin-of-org-b"),
		};
	}

	const redactJobs = async (t: ReturnType<typeof createT>) =>
		(
			await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
		).filter((j) => j.name.includes("replaceRagEntryContent")).length;

	test("REFUSED pole 1: an admin of ANOTHER org on org-a's memory is refused typed; the row is unchanged, nothing scheduled", async () => {
		const w = await rbacWorld();
		await expect(
			w.adminB.mutation(api.memories.redactMemoryContent, w.args),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await w.t.run((ctx) => ctx.db.get(w.memoryId));
		expect(row?.content).toContain(FAKE_TOKEN);
		expect(row?.contentHash).toBe("original-hash");
		expect(await redactJobs(w.t)).toBe(0);
	});

	test("REFUSED pole 2: a SAME-org member without the admin role is refused typed; the row is unchanged, nothing scheduled", async () => {
		const w = await rbacWorld();
		await expect(
			w.memberA.mutation(api.memories.redactMemoryContent, w.args),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await w.t.run((ctx) => ctx.db.get(w.memoryId));
		expect(row?.content).toContain(FAKE_TOKEN);
		expect(row?.contentHash).toBe("original-hash");
		expect(await redactJobs(w.t)).toBe(0);
	});

	test("REFUSED: anonymous is refused typed; the row is unchanged", async () => {
		const w = await rbacWorld();
		await expect(
			w.t.mutation(api.memories.redactMemoryContent, w.args),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await w.t.run((ctx) => ctx.db.get(w.memoryId));
		expect(row?.content).toContain(FAKE_TOKEN);
	});

	test("PRESENT pole: a same-org ADMIN who is neither the creator nor the master erases: body gone, contentHash recomputed, re-index (with purge) scheduled without the secret", async () => {
		const w = await rbacWorld();
		const result = await w.adminA.mutation(api.memories.redactMemoryContent, w.args);
		expect(result.replacements).toBe(1);
		const row = await w.t.run((ctx) => ctx.db.get(w.memoryId));
		expect(row?.content).not.toContain(FAKE_TOKEN);
		expect(row?.content).toContain("[REDACTED]");
		expect(row?.contentHash).not.toBe("original-hash");
		const jobs = (
			await w.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
		).filter((j) => j.name.includes("replaceRagEntryContent"));
		expect(jobs).toHaveLength(1);
		expect((jobs[0]?.args[0] as { content?: string }).content).not.toContain(
			FAKE_TOKEN,
		);
	});

	// ── authorship: a MEMBER erases what it authored itself ─────────────────
	// Authorship is the stored `createdBy` ("user:<verified subject>") against
	// the verified caller's actor name, never a typed name.

	const insertOwn = (
		w: Awaited<ReturnType<typeof rbacWorld>>,
		createdBy: string,
	) =>
		w.t.run(async (ctx) =>
			ctx.db.insert("memories", {
				namespace: "team/org-a",
				clerkOrgId: testClerkOrgId("org-a"),
				type: "reference",
				content: `${FAKE_TOKEN} authored`,
				contentHash: "original-hash",
				createdBy,
				relations: [],
				isLatest: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

	test("PRESENT (authorship): a same-org MEMBER, not admin, erases the memory whose stored author is its own verified subject", async () => {
		const w = await rbacWorld();
		const mine = await insertOwn(w, "user:member-of-org-a");
		const result = await w.memberA.mutation(api.memories.redactMemoryContent, {
			memoryId: mine,
			redactions: [{ find: FAKE_TOKEN, replaceWith: "[REDACTED]" }],
		});
		expect(result.replacements).toBe(1);
		const row = await w.t.run((ctx) => ctx.db.get(mine));
		expect(row?.content).not.toContain(FAKE_TOKEN);
		expect(row?.contentHash).not.toBe("original-hash");
		expect(await redactJobs(w.t)).toBe(1);
	});

	test("REFUSED (authorship): a same-org member, not admin, on a row authored by ANOTHER verified subject is refused; the row is unchanged", async () => {
		const w = await rbacWorld();
		const theirs = await insertOwn(w, "user:someone-else-in-org-a");
		await expect(
			w.memberA.mutation(api.memories.redactMemoryContent, {
				memoryId: theirs,
				redactions: [{ find: FAKE_TOKEN, replaceWith: "[REDACTED]" }],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await w.t.run((ctx) => ctx.db.get(theirs));
		expect(row?.content).toContain(FAKE_TOKEN);
		expect(await redactJobs(w.t)).toBe(0);
	});

	test("REFUSED (authorship): another org's member whose subject equals the stored author is refused (the org check precedes authorship)", async () => {
		const w = await rbacWorld();
		const mine = await insertOwn(w, "user:member-of-org-b");
		const memberB = w.t.withIdentity({
			subject: "member-of-org-b",
			org_slug: "org-b",
			org_id: testClerkOrgId("org-b"),
			org_role: "org:member",
		} as Parameters<typeof w.t.withIdentity>[0]);
		await expect(
			memberB.mutation(api.memories.redactMemoryContent, {
				memoryId: mine,
				redactions: [{ find: FAKE_TOKEN, replaceWith: "[REDACTED]" }],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await w.t.run((ctx) => ctx.db.get(mine));
		expect(row?.content).toContain(FAKE_TOKEN);
	});
});
