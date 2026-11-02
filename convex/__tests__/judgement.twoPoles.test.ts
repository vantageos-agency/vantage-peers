/// <reference types="vite/client" />
/**
 * Task k174abvtvm5mh7y5ye2v39rcvd8g6wwx: the backend-doctor judgement findings
 * that no module task owns, each pinned at both poles.
 *
 * R-26  convex/convex.config.ts declares, at each app.use seam, the authority
 *       tier and the boundary key the component is used under.
 * R-44  the briefingNoteParticipants backfill writes through ONE helper on
 *       purpose; the migration file records why (a reviewer-readable reason).
 * R-45  briefingNoteBodyChunks and briefingNoteParticipants: a test builds the
 *       source briefingNotes row by direct ctx.db.insert (not the create path),
 *       asserts before, runs the migration, asserts after. The doctor's loader
 *       skips every __tests__ directory (mcp-doctor walk(): SKIP_DIRS has
 *       "__tests__", it drops "*.test.ts"), so it can never see these tests; the
 *       schema carries a written pointer to them instead, and the pointer is
 *       checked here to name files that exist.
 * R-47  migrations/reindexMemoriesByPeriod:countByPeriod no longer collects a
 *       whole-table scan: it reads a declared bound and REFUSES, naming startMs /
 *       endMs, when the window holds more than the bound.
 *
 * Read cases run under SCOPED org identities (an ordinary member of an active
 * org): the two internal functions exercised here are not reachable by such a
 * caller, so the identity must change nothing about what they return.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { internal } from "../_generated/api";
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

const CONVEX_DIR = resolve(__dirname, "..");
const readSrc = (rel: string) => readFileSync(resolve(CONVEX_DIR, rel), "utf8");

const asMember = (t: T) =>
	t.withIdentity({
		subject: "member-acme",
		org_slug: "acme",
		org_id: testClerkOrgId("acme"),
		org_role: "org:member",
	} as Identity);

// ── the predicates, as the rules read them ──────────────────────────────────
// Same token shape the doctor reads (a recorded reason, colon-anchored,
// never a negation such as UNJUSTIFIED).
const TOKEN = /(?<![A-Za-zÀ-ÿ-])(JUSTIFI(É|E|ED)|STATELESS|ACCEPT(É|E|ED)|WONTFIX)\s*:/i;
const SEAM_CONTRACT =
	/authority tier|boundary key|isolation contract|org-scoped|fleet-internal|master-only|namespace-bound|tenant boundary/i;

/** R-26: each `app.use(x)` has a seam declaration within 6 lines either side. */
function undeclaredSeams(src: string): string[] {
	const lines = src.split("\n");
	const out: string[] = [];
	lines.forEach((raw, i) => {
		if (/^\s*\/\//.test(raw)) return;
		const m = raw.match(/app\.use\s*\(\s*(\w+)/);
		if (!m) return;
		const window = lines.slice(Math.max(0, i - 6), i + 6).join("\n");
		if (!SEAM_CONTRACT.test(window) && !TOKEN.test(window)) out.push(m[1]);
	});
	return out;
}

/** R-47: a handler that collects a wide scan with no bound and no refusal. */
function wideUnboundedCollects(src: string): number {
	let n = 0;
	for (const stmt of src.split(";")) {
		const unbounded =
			/\.collect\s*\(\s*\)/.test(stmt) &&
			!/\.(?:take|paginate|first|unique)\s*\(/.test(stmt);
		if (!unbounded) continue;
		if (/\.withIndex\s*\(/.test(stmt)) continue;
		if (/SCAN_CAP|scan cap|incomplete|indistinguishable|refus/i.test(src))
			continue;
		n++;
	}
	return n;
}

describe("R-26 seam boundary, convex/convex.config.ts", () => {
	test("both app.use seams declare an authority tier and a boundary key", () => {
		const src = readSrc("convex.config.ts");
		expect(undeclaredSeams(src)).toEqual([]);
		// The declaration is specific, not a bare token: each seam names the key
		// its component is actually used under.
		expect(src).toMatch(/rag[\s\S]*boundary key[\s\S]*namespace/i);
		expect(src).toMatch(/agentEngine[\s\S]*boundary key[\s\S]*orgId/i);
	});

	test("control: a seam with no declaration is still undeclared", () => {
		expect(undeclaredSeams("const app = defineApp();\napp.use(rag);\n")).toEqual(
			["rag"],
		);
	});

	test("the boundary each seam claims is the one the code uses", () => {
		const search = readSrc("search.ts");
		expect(search).toContain("resolveSearchNamespace");
		const engine = readSrc("okfBundleDurable.ts");
		expect(engine).toMatch(/orgId: tenantOrgId/);
		expect(engine).toContain("withOrgScope");
	});
});

describe("R-44 one writer for the participants backfill, convex/migrations.ts", () => {
	test("the migration file records why the backfill goes through the helper", () => {
		const src = readSrc("migrations.ts");
		expect(src).toMatch(TOKEN);
		// The reason names the thing it protects, not the finding it answers.
		expect(src).toMatch(/JUSTIFIED:[\s\S]*labelResolverOfNote/);
	});

	test("control: the reason is read from a colon-anchored token only", () => {
		expect(TOKEN.test("this is not justified by design")).toBe(false);
		expect(TOKEN.test("UNJUSTIFIED: x")).toBe(false);
		expect(TOKEN.test("JUSTIFIED: one writer")).toBe(true);
	});
});

describe("R-45 fixture independence for the two briefing derived tables", () => {
	test("the schema points at tests that exist, for both tables", () => {
		const schemaSrc = readSrc("schema.ts");
		const lines = schemaSrc.split("\n");
		for (const [table, testFile] of [
			["briefingNoteBodyChunks", "__tests__/judgement.twoPoles.test.ts"],
			["briefingNoteParticipants", "__tests__/judgement.twoPoles.test.ts"],
		] as const) {
			const at = lines.findIndex((l) =>
				new RegExp(`^\\s*${table}\\s*:\\s*defineTable\\s*\\(`).test(l),
			);
			expect(at).toBeGreaterThan(-1);
			const window = lines.slice(Math.max(0, at - 6), at + 6).join("\n");
			expect(window).toMatch(TOKEN);
			expect(window).toContain(testFile);
			expect(existsSync(resolve(CONVEX_DIR, testFile))).toBe(true);
		}
	});

	test("participants: a note built by direct insert has no junction rows until the migration runs, and the run is idempotent", async () => {
		const t = createT();
		await seedFleetAgents(t, ["laurent", "pi"]);
		const noteId = await t.run(async (ctx) =>
			ctx.db.insert("briefingNotes", {
				title: "pre-existing note",
				topic: "pre-existing-topic",
				participants: ["laurent", "pi"],
				content: "written before the junction table existed",
				createdBy: "sigma",
				createdAt: 1,
			}),
		);
		const count = () =>
			t.run(async (ctx) =>
				(
					await ctx.db
						.query("briefingNoteParticipants")
						.withIndex("by_note", (q) => q.eq("noteId", noteId))
						.collect()
				).map((r) => r.participant),
			);
		expect(await count()).toEqual([]);

		await asMember(t).mutation(
			internal.migrations.backfillBriefingNoteParticipants,
			{},
		);
		expect((await count()).sort()).toEqual(["laurent", "pi"]);

		await asMember(t).mutation(
			internal.migrations.backfillBriefingNoteParticipants,
			{},
		);
		expect((await count()).sort()).toEqual(["laurent", "pi"]);
	});

	test("chunks: a note built by direct insert has no body chunks until the offload migration runs", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "fleet-org",
				clerkOrgId: testClerkOrgId("fleet-org"),
				allowedOrchestrators: ["*"],
				scopes: [],
				displayName: "fleet-org",
				isActive: true,
				createdAt: 1,
				orgKind: "operator",
			});
			await ctx.db.insert("agents", {
				orgSlug: "fleet-org",
				clerkOrgId: testClerkOrgId("fleet-org"),
				name: "sigma",
				normalizedName: "sigma",
				isActive: true,
				createdAt: 1,
			});
		});
		const body = `chunked body ${"x".repeat(5000)}`;
		const noteId = await t.run(async (ctx) =>
			ctx.db.insert("briefingNotes", {
				title: "big note",
				topic: "big-topic",
				participants: ["sigma"],
				content: body,
				createdBy: "sigma",
				createdAt: 1,
			}),
		);
		const chunks = () =>
			t.run(async (ctx) =>
				(
					await ctx.db
						.query("briefingNoteBodyChunks")
						.withIndex("by_note_idx", (q) => q.eq("noteId", noteId))
						.collect()
				).map((r) => r.text),
			);
		expect(await chunks()).toEqual([]);

		const result = await asMember(t).mutation(
			internal.migrations.offloadNoteBody.offloadOne,
			{ id: noteId, dryRun: false },
		);
		expect(result.body).toBe("offloaded");
		const after = await chunks();
		expect(after.length).toBeGreaterThan(0);
		expect(after.join("")).toBe(body);
		expect(result.sha256Before).toBe(result.sha256After);

		// Idempotent: a second run rewrites nothing.
		const again = await asMember(t).mutation(
			internal.migrations.offloadNoteBody.offloadOne,
			{ id: noteId, dryRun: false },
		);
		expect(again.body).toBe("alreadyOffloaded");
		expect((await chunks()).join("")).toBe(body);
	});
});

describe("R-47 countByPeriod refuses rather than truncate", () => {
	const SCAN_CAP = 5000;

	test("the source reads a declared bound, not a whole-table collect", () => {
		const src = readSrc("migrations/reindexMemoriesByPeriod.ts");
		expect(wideUnboundedCollects(src)).toBe(0);
		expect(src).toContain("COUNT_SCAN_CAP_EXCEEDED");
	});

	test("control: a wide collect with no bound and no refusal still violates the predicate", () => {
		const wide =
			'export const f = internalQuery({ handler: async (ctx) => { const rows = await ctx.db.query("memories").collect(); return rows.length; } });';
		expect(wideUnboundedCollects(wide)).toBe(1);
		const indexed =
			'const r = await ctx.db.query("memories").withIndex("by_x", (q) => q.eq("x", 1)).collect();';
		expect(wideUnboundedCollects(indexed)).toBe(0);
		const bounded =
			'const r = await ctx.db.query("memories").filter(f).take(10);';
		expect(wideUnboundedCollects(bounded)).toBe(0);
	});

	const memory = (createdAt: number) => ({
		namespace: "global",
		type: "project" as const,
		content: "abcd",
		createdBy: "sigma",
		relations: [],
		isLatest: true,
		createdAt,
		updatedAt: createdAt,
	});

	test("ABSENT: an empty window answers a real zero, to a scoped caller", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("memories", memory(1000));
		});
		const r = await asMember(t).query(
			internal.migrations.reindexMemoriesByPeriod.countByPeriod,
			{ startMs: 5000, endMs: 6000 },
		);
		expect(r.count).toBe(0);
	});

	test("PRESENT: a window under the bound is counted in full", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) await ctx.db.insert("memories", memory(1000 + i));
			await ctx.db.insert("memories", memory(9000));
		});
		const r = await asMember(t).query(
			internal.migrations.reindexMemoriesByPeriod.countByPeriod,
			{ startMs: 1000, endMs: 2000 },
		);
		expect(r.count).toBe(3);
		expect(r.sampleAvgContentChars).toBe(4);
	});

	test("REFUSED: a window over the bound raises, naming the args that narrow it", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i <= SCAN_CAP; i++)
				await ctx.db.insert("memories", memory(1000 + i));
		});
		let thrown: unknown;
		try {
			await asMember(t).query(
				internal.migrations.reindexMemoriesByPeriod.countByPeriod,
				{ startMs: 0, endMs: 10_000_000 },
			);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeDefined();
		const text = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown));
		expect(text).toContain("COUNT_SCAN_CAP_EXCEEDED");
		expect(text).toContain("startMs");
		expect(text).toContain("endMs");
	}, 60_000);
});
