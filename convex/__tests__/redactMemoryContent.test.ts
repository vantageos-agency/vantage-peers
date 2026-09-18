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

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

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

const newMemoryWithToken = (t: ReturnType<typeof createT>, content: string) =>
	t.mutation(api.memories.storeMemory, {
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

		const result = await t.mutation(internal.memories.redactMemoryContent, {
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

		const result = await t.mutation(internal.memories.redactMemoryContent, {
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
			t.mutation(internal.memories.redactMemoryContent, {
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
			t.mutation(internal.memories.redactMemoryContent, {
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

		await t.mutation(internal.memories.redactMemoryContent, {
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
});
