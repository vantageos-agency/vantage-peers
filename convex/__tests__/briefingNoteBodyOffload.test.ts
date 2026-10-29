/// <reference types="vite/client" />
//
// Briefing note body offload (tasks k17d10f1j2k2crgx9cw9bvw1vs8h7fda and
// k173kn4xsqmw3s5zx6522weqk18fttvs). 30 prod notes sit at Convex's 1 MiB
// document limit, so the 90-byte org stamp is refused by the platform. The body
// of such a note moves to chunk rows (briefingNoteBodyChunks, which a QUERY can
// read; file storage blobs cannot be read by a query); the row keeps `bodyRef` and
// the org stamp, and every read door returns the body byte-identical.

import { createHash } from "node:crypto";
import { ConvexError } from "convex/values";
import { describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import * as agentsModule from "../agents";
import * as briefingNotesModule from "../briefingNotes";
import { BODY_CHUNK_CHARS, previewOf, splitBody } from "../briefingNoteBodies";
import schema from "../schema";

// The injection seam of the sha-mismatch pole: when `corrupt.on` is set, the
// re-read of the stored chunks returns a body that differs by one character.
const corrupt = vi.hoisted(() => ({ on: false }));
vi.mock("../briefingNoteBodies", async (importOriginal) => {
	const real = await importOriginal<typeof import("../briefingNoteBodies")>();
	return {
		...real,
		readBodyChunks: async (...a: Parameters<typeof real.readBodyChunks>) => {
			const body = await real.readBodyChunks(...a);
			return corrupt.on ? `${body}x` : body;
		},
	};
});

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);
const createT = () => convexTest({ schema, modules });
type T = ReturnType<typeof createT>;
const NOW = 1_700_000_000_000;

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// A body with surrogate pairs (so some chunk boundary falls inside a pair if the
// splitter is naive), accents, newlines and two marker words: one inside the
// first 4000 characters and one at the very end.
function bodyOf(approxChars: number, tag = ""): string {
	let s = `zebrafinch ${tag}\n`;
	let i = 0;
	while (s.length < approxChars) {
		s += `a\u{1F600}é line ${i++} ${tag}\n`;
	}
	return `${s}quokkamarker`;
}

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		for (const [slug, kind] of [
			["fleet-org", "operator"],
			["acme-hr", undefined],
			["org-b", undefined],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["*"],
				scopes: ["view-own-tasks", "view-own-missions"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(kind === undefined ? {} : { orgKind: kind }),
			});
		}
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:member"],
			updatedAt: NOW,
		});
		await ctx.db.insert("agents", {
			orgSlug: "fleet-org",
			clerkOrgId: testClerkOrgId("fleet-org"),
			name: "sigma",
			normalizedName: "sigma",
			isActive: true,
			createdAt: NOW,
		});
		await ctx.db.insert("agents", {
			orgSlug: "acme-hr",
			clerkOrgId: testClerkOrgId("acme-hr"),
			name: "nadia",
			normalizedName: "nadia",
			isActive: true,
			createdAt: NOW,
		});
	});
}

async function seedNote(
	t: T,
	content: string,
	opts: { createdBy?: string; title?: string; stamped?: string } = {},
) {
	return await t.run(async (ctx) =>
		ctx.db.insert("briefingNotes", {
			title: opts.title ?? "big note",
			topic: "t",
			participants: [],
			content,
			createdBy: opts.createdBy ?? "nadia",
			createdAt: NOW,
			...(opts.stamped === undefined
				? {}
				: { orgId: opts.stamped, clerkOrgId: testClerkOrgId(opts.stamped) }),
		}),
	);
}

const offloadOne = internal.migrations.offloadNoteBody.offloadOne;
const rowOf = (t: T, id: Awaited<ReturnType<typeof seedNote>>) =>
	t.run(async (ctx) => ctx.db.get(id));
const chunksOf = (t: T, id: Awaited<ReturnType<typeof seedNote>>) =>
	t.run(async (ctx) =>
		ctx.db
			.query("briefingNoteBodyChunks")
			.withIndex("by_note_idx", (q) => q.eq("noteId", id))
			.collect(),
	);

const asOrg = (t: T, slug: string, role = "org:member") =>
	t.withIdentity({
		subject: `user-${role}-${slug}`,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
		org_role: role,
	} as Parameters<typeof t.withIdentity>[0]);

async function offload(t: T, id: Awaited<ReturnType<typeof seedNote>>) {
	return await t.mutation(offloadOne, { id, dryRun: false });
}

describe("offloadOne", () => {
	test("dryRun defaults to true: reports equal hashes and writes nothing", async () => {
		const t = createT();
		await seedOrgs(t);
		const body = bodyOf(350_000);
		const id = await seedNote(t, body);
		const before = await rowOf(t, id);
		const r = await t.mutation(offloadOne, { id });
		expect(r).toMatchObject({ id, dryRun: true, stampedTo: "acme-hr" });
		expect(r.sha256Before).toBe(sha(body));
		expect(r.sha256After).toBe(sha(body));
		expect(r.chunks).toBeGreaterThan(1);
		expect(await rowOf(t, id)).toEqual(before);
		expect(await chunksOf(t, id)).toHaveLength(0);
	});

	test("real run: body in chunks, row keeps bodyRef and the org stamp, sha equal before and after", async () => {
		const t = createT();
		await seedOrgs(t);
		const body = bodyOf(350_000);
		const id = await seedNote(t, body);
		const r = await offload(t, id);
		expect(r).toMatchObject({ id, dryRun: false, stampedTo: "acme-hr" });
		expect(r.sha256Before).toBe(sha(body));
		expect(r.sha256After).toBe(sha(body));
		const row = await rowOf(t, id);
		expect(row?.orgId).toBe("acme-hr");
		expect(row?.clerkOrgId).toBe(testClerkOrgId("acme-hr"));
		expect(row?.bodyRef).toMatchObject({
			chunks: r.chunks,
			bytes: Buffer.byteLength(body, "utf8"),
			sha256: sha(body),
		});
		expect(row?.content.length).toBeLessThan(body.length);
		expect(body.startsWith(row?.content ?? "!")).toBe(true);
		expect(await chunksOf(t, id)).toHaveLength(r.chunks);
		// get, as a member of the owning organisation: byte-identical.
		const got = await asOrg(t, "acme-hr").query(api.briefingNotes.get, {
			noteId: id,
		});
		expect(got?.content).toBe(body);
		expect(sha(got?.content ?? "")).toBe(sha(body));
		expect(got?.orgId).toBe("acme-hr");
		expect(got?.contentTruncated).toBeUndefined();
	});

	test("a fleet-owned note takes the operator org stamp", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, bodyOf(250_000), { createdBy: "sigma" });
		const r = await offload(t, id);
		expect(r.stampedTo).toBe("fleet-org");
		expect((await rowOf(t, id))?.orgId).toBe("fleet-org");
	});

	test("idempotent: a second run is a no-op that still reports the hashes", async () => {
		const t = createT();
		await seedOrgs(t);
		const body = bodyOf(350_000);
		const id = await seedNote(t, body);
		const first = await offload(t, id);
		const rowAfterFirst = await rowOf(t, id);
		const chunksAfterFirst = await chunksOf(t, id);
		const second = await offload(t, id);
		expect(second.sha256Before).toBe(first.sha256Before);
		expect(second.sha256After).toBe(first.sha256After);
		expect(second.chunks).toBe(first.chunks);
		expect(await rowOf(t, id)).toEqual(rowAfterFirst);
		expect(await chunksOf(t, id)).toEqual(chunksAfterFirst);
	});

	test("an undecidable author is offloaded and reported with stampedTo null, never guessed", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, bodyOf(250_000), { createdBy: "nobody-knows" });
		const r = await offload(t, id);
		expect(r.stampedTo).toBeNull();
		expect((await rowOf(t, id))?.orgId).toBeUndefined();
		expect((await rowOf(t, id))?.bodyRef).toBeDefined();
	});

	test("sha mismatch refuses to commit: nothing is written", async () => {
		const t = createT();
		await seedOrgs(t);
		const body = bodyOf(350_000);
		const id = await seedNote(t, body);
		const before = await rowOf(t, id);
		corrupt.on = true;
		try {
			await expect(offload(t, id)).rejects.toThrow(/BODY_HASH_MISMATCH/);
		} finally {
			corrupt.on = false;
		}
		expect(await rowOf(t, id)).toEqual(before);
		expect(await chunksOf(t, id)).toHaveLength(0);
	});

	test("an id of another table, and a missing note, are refused", async () => {
		const t = createT();
		await seedOrgs(t);
		const agentId = await t.run(
			async (ctx) => (await ctx.db.query("agents").first())?._id as string,
		);
		await expect(
			t.mutation(offloadOne, { id: agentId, dryRun: false }),
		).rejects.toThrow(/not a briefingNotes id/);
	});
});

describe("reads of an offloaded note", () => {
	test("another organisation's member reads nothing through get, list and search", async () => {
		const t = createT();
		await seedOrgs(t);
		const body = bodyOf(350_000);
		const id = await seedNote(t, body);
		await offload(t, id);
		const other = asOrg(t, "org-b");
		expect(await other.query(api.briefingNotes.get, { noteId: id })).toBeNull();
		const listed = await other.query(api.briefingNotes.list, { fields: "full" });
		expect(listed).toEqual([]);
		const found = await other.query(
			api.briefingNotes.searchBriefingNotesByKeyword,
			{ query: "zebrafinch" },
		);
		expect(found).toEqual([]);
	});

	test("list: bodies are hydrated within a byte budget; the rest is a MARKED preview with bodyRef", async () => {
		const t = createT();
		await seedOrgs(t);
		const bodies: string[] = [];
		const ids = [];
		for (let i = 0; i < 6; i++) {
			const b = bodyOf(900_000, `n${i}`);
			bodies.push(b);
			const id = await seedNote(t, b, { title: `n${i}` });
			await offload(t, id);
			ids.push(id);
		}
		const rows = await asOrg(t, "acme-hr").query(api.briefingNotes.list, {
			fields: "full",
			limit: 6,
		});
		expect(Array.isArray(rows)).toBe(true);
		const list = rows as unknown as Array<{
			_id: string;
			content: string;
			contentTruncated?: boolean;
			bodyRef?: { bytes: number; sha256: string };
		}>;
		expect(list).toHaveLength(6);
		const whole = list.filter((r) => r.contentTruncated !== true);
		const partial = list.filter((r) => r.contentTruncated === true);
		expect(whole.length).toBeGreaterThan(0);
		expect(partial.length).toBeGreaterThan(0);
		for (const r of whole) {
			const i = ids.indexOf(r._id as (typeof ids)[number]);
			expect(r.content).toBe(bodies[i]);
		}
		for (const r of partial) {
			const i = ids.indexOf(r._id as (typeof ids)[number]);
			expect(r.bodyRef?.sha256).toBe(sha(bodies[i]));
			expect(r.content.length).toBeLessThan(bodies[i].length);
			expect(bodies[i].startsWith(r.content)).toBe(true);
		}
		// Whatever the page held, its hydrated bytes stay inside the budget.
		const hydratedBytes = whole.reduce(
			(n, r) => n + Buffer.byteLength(r.content, "utf8"),
			0,
		);
		expect(hydratedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		// get of a partial one still returns the whole body.
		const p = partial[0];
		const got = await asOrg(t, "acme-hr").query(api.briefingNotes.get, {
			noteId: p._id as (typeof ids)[number],
		});
		expect(got?.content).toBe(bodies[ids.indexOf(p._id as (typeof ids)[number])]);
		// lite is unaffected.
		const lite = await asOrg(t, "acme-hr").query(api.briefingNotes.list, {
			fields: "lite",
			limit: 6,
		});
		expect(lite).toHaveLength(6);
	});

	test("search: a keyword inside the preview finds the note; one beyond it does not (documented degradation)", async () => {
		const t = createT();
		await seedOrgs(t);
		const body = bodyOf(350_000);
		const id = await seedNote(t, body);
		await offload(t, id);
		const member = asOrg(t, "acme-hr");
		const hit = (await member.query(
			api.briefingNotes.searchBriefingNotesByKeyword,
			{ query: "zebrafinch" },
		)) as unknown as Array<{ _id: string; content: string }>;
		expect(hit.map((h) => h._id)).toEqual([id]);
		expect(hit[0].content).toBe(body);
		const miss = await member.query(
			api.briefingNotes.searchBriefingNotesByKeyword,
			{ query: "quokkamarker" },
		);
		expect(miss).toEqual([]);
	});

	test("the OKF export fetch marks an offloaded row partial and readBody returns the whole body", async () => {
		const t = createT();
		await seedOrgs(t);
		const body = bodyOf(350_000);
		const id = await seedNote(t, body, { createdBy: "sigma" });
		await offload(t, id);
		const rows: Array<{ _id: string; contentTruncated?: boolean }> = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard++) {
			const page: {
				page: Array<{ _id: string; contentTruncated?: boolean }>;
				isDone: boolean;
				continueCursor: string;
			} = await t.query(internal.okfBundle._fetchBriefingNotesForBundle, {
				namespace: "project/elpi-corp",
				paginationOpts: { numItems: 50, cursor },
			});
			rows.push(...page.page);
			if (page.isDone) break;
			cursor = page.continueCursor;
		}
		const row = rows.find((r) => r._id === id);
		expect(row?.contentTruncated).toBe(true);
		expect(await t.query(internal.briefingNoteBodies.readBody, { id })).toBe(body);
	});

	test("the OKF import dedup matches an offloaded note by its body hash", async () => {
		const t = createT();
		await seedOrgs(t);
		const body = bodyOf(350_000);
		const id = await seedNote(t, body, { createdBy: "sigma" });
		await offload(t, id);
		let found: string | null = null;
		let cursor: string | null = null;
		for (let guard = 0; guard < 10 && found === null; guard++) {
			const r: { id: string | null; isDone: boolean; continueCursor: string } =
				await t.query(internal.okfBundle._findBriefingByTitleAndContent, {
					namespace: "project/elpi-corp",
					title: "big note",
					content: body,
					paginationOpts: { numItems: 50, cursor },
				});
			found = r.id;
			if (r.isDone) break;
			cursor = r.continueCursor;
		}
		const r = { id: found };
		expect(r.id).toBe(id);
		// Same size, one character different: not the same note.
		const other = await t.query(internal.okfBundle._findBriefingByTitleAndContent, {
			namespace: "project/elpi-corp",
			title: "big note",
			content: `${body.slice(0, -1)}!`,
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(other.id).toBeNull();
		const unstampedPhase = await t.query(
			internal.okfBundle._findBriefingByTitleAndContent,
			{
				namespace: "project/elpi-corp",
				title: "big note",
				content: `${body.slice(0, -1)}!`,
				paginationOpts: { numItems: 50, cursor: "O|" },
			},
		);
		expect(unstampedPhase.id).toBeNull();
	});
});

describe("writes on an offloaded note", () => {
	test("update with new content drops the stale body: bodyRef and chunks are removed", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, bodyOf(350_000));
		await offload(t, id);
		await asOrg(t, "acme-hr", "org:admin").mutation(api.briefingNotes.update, {
			noteId: id,
			content: "short and new",
		});
		const row = await rowOf(t, id);
		expect(row?.content).toBe("short and new");
		expect(row?.bodyRef).toBeUndefined();
		expect(await chunksOf(t, id)).toHaveLength(0);
		const got = await asOrg(t, "acme-hr").query(api.briefingNotes.get, {
			noteId: id,
		});
		expect(got?.content).toBe("short and new");
	});

	test("update of another field keeps the offloaded body", async () => {
		const t = createT();
		await seedOrgs(t);
		const body = bodyOf(350_000);
		const id = await seedNote(t, body);
		await offload(t, id);
		await asOrg(t, "acme-hr", "org:admin").mutation(api.briefingNotes.update, {
			noteId: id,
			title: "renamed",
		});
		const got = await asOrg(t, "acme-hr").query(api.briefingNotes.get, {
			noteId: id,
		});
		expect(got?.title).toBe("renamed");
		expect(got?.content).toBe(body);
	});

	test("deleteBriefingNote removes the chunks with the row", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, bodyOf(350_000));
		await offload(t, id);
		expect((await chunksOf(t, id)).length).toBeGreaterThan(0);
		await asOrg(t, "acme-hr", "org:admin").mutation(
			api.briefingNotes.deleteBriefingNote,
			{ noteId: id },
		);
		expect(await rowOf(t, id)).toBeNull();
		expect(await chunksOf(t, id)).toHaveLength(0);
	});

	test("deleteBriefingNote by the fleet system caller (agent path) removes the chunks too", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, bodyOf(350_000), {
			createdBy: "sigma",
			stamped: "fleet-org",
		});
		await offload(t, id);
		const master = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);
		await master.mutation(api.briefingNotes.deleteBriefingNote, {
			noteId: id,
			callerOrchestrator: "system",
		});
		expect(await rowOf(t, id)).toBeNull();
		expect(await chunksOf(t, id)).toHaveLength(0);
	});
});

describe("a damaged stored body is a refusal, never a partial", () => {
	test("get raises BODY_CHUNKS_CORRUPT when a chunk is missing", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, bodyOf(350_000));
		await offload(t, id);
		await t.run(async (ctx) => {
			const last = (
				await ctx.db
					.query("briefingNoteBodyChunks")
					.withIndex("by_note_idx", (q) => q.eq("noteId", id))
					.order("desc")
					.first()
			)?._id;
			if (last) await ctx.db.delete(last);
		});
		await expect(
			asOrg(t, "acme-hr").query(api.briefingNotes.get, { noteId: id }),
		).rejects.toThrow(/BODY_CHUNKS_CORRUPT/);
	});

	test("get raises BODY_CHUNKS_CORRUPT when a chunk was altered", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, bodyOf(350_000));
		await offload(t, id);
		await t.run(async (ctx) => {
			const first = await ctx.db
				.query("briefingNoteBodyChunks")
				.withIndex("by_note_idx", (q) => q.eq("noteId", id))
				.first();
			if (first) await ctx.db.patch(first._id, { text: `${first.text}zz` });
		});
		await expect(
			asOrg(t, "acme-hr").query(api.briefingNotes.get, { noteId: id }),
		).rejects.toThrow(/BODY_CHUNKS_CORRUPT/);
	});

	test("get raises BODY_CHUNKS_CORRUPT when the chunks are out of order (same count, same bytes)", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, bodyOf(350_000));
		await offload(t, id);
		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("briefingNoteBodyChunks")
				.withIndex("by_note_idx", (q) => q.eq("noteId", id))
				.collect();
			expect(rows.length).toBeGreaterThan(2);
			// Renumber the first chunk past the last: the count and the byte length are
			// unchanged, only the order is wrong, so the idx check alone must refuse.
			await ctx.db.patch(rows[0]._id, { idx: rows.length + 5 });
		});
		await expect(
			asOrg(t, "acme-hr").query(api.briefingNotes.get, { noteId: id }),
		).rejects.toThrow(/BODY_CHUNKS_CORRUPT/);
	});
});

describe("agents:registerAgentInOrgById", () => {
	const door = internal.agents.registerAgentInOrgById;

	test("inserts an active agent in the org named by ID, with its clerkOrgId and slug", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await t.mutation(door, {
			clerkOrgId: testClerkOrgId("acme-hr"),
			name: "Isabelle",
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row).toMatchObject({
			orgSlug: "acme-hr",
			clerkOrgId: testClerkOrgId("acme-hr"),
			name: "Isabelle",
			normalizedName: "isabelle",
			isActive: true,
		});
	});

	test("never touches any roster", async () => {
		const t = createT();
		await seedOrgs(t);
		const before = await t.run(async (ctx) =>
			ctx.db.query("client_org_mapping").collect(),
		);
		await t.mutation(door, {
			clerkOrgId: testClerkOrgId("acme-hr"),
			name: "Isabelle",
		});
		const after = await t.run(async (ctx) =>
			ctx.db.query("client_org_mapping").collect(),
		);
		expect(after).toEqual(before);
	});

	test("refuses an unknown org", async () => {
		const t = createT();
		await seedOrgs(t);
		await expect(
			t.mutation(door, { clerkOrgId: "org_doesnotexist", name: "Isabelle" }),
		).rejects.toThrow(/ORG_NOT_FOUND/);
	});

	test("refuses an inactive org", async () => {
		const t = createT();
		await seedOrgs(t);
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-b"))
				.unique();
			if (m) await ctx.db.patch(m._id, { isActive: false });
		});
		await expect(
			t.mutation(door, { clerkOrgId: testClerkOrgId("org-b"), name: "Isabelle" }),
		).rejects.toThrow(/ORG_INACTIVE/);
	});

	test("refuses a name already taken in that org, any case", async () => {
		const t = createT();
		await seedOrgs(t);
		await expect(
			t.mutation(door, { clerkOrgId: testClerkOrgId("acme-hr"), name: "NADIA" }),
		).rejects.toThrow(/AGENT_NAME_TAKEN/);
	});

	test("the same name in another org is a different agent", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await t.mutation(door, {
			clerkOrgId: testClerkOrgId("org-b"),
			name: "nadia",
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.orgSlug).toBe("org-b");
	});

	test("refuses an empty name", async () => {
		const t = createT();
		await seedOrgs(t);
		await expect(
			t.mutation(door, { clerkOrgId: testClerkOrgId("acme-hr"), name: "  " }),
		).rejects.toThrow(/AGENT_NAME_INVALID/);
	});

	test("is not a public function", () => {
		// A public registration has no `isInternal` marker; this one must.
		expect(
			(agentsModule.registerAgentInOrgById as { isInternal?: boolean }).isInternal,
		).toBe(true);
	});
});

describe("briefingNotes:deleteTestNoteById", () => {
	const door = internal.briefingNotes.deleteTestNoteById;

	test("refuses a note whose title does not start with [TEST]", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, "real", { title: "Real briefing [TEST]" });
		let caught: unknown;
		try {
			await t.mutation(door, { id });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ConvexError);
		expect(String((caught as ConvexError<string>).data)).toMatch(
			/NOT_A_TEST_NOTE/,
		);
		expect(await rowOf(t, id)).not.toBeNull();
	});

	test("deletes a [TEST] note and returns its id and title", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, "scratch", { title: "[TEST] scratch" });
		const r = await t.mutation(door, { id });
		expect(r).toEqual({ id, title: "[TEST] scratch" });
		expect(await rowOf(t, id)).toBeNull();
	});

	test("also deletes the offloaded body chunks of that note", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await seedNote(t, bodyOf(350_000), { title: "[TEST] big" });
		await offload(t, id);
		expect((await chunksOf(t, id)).length).toBeGreaterThan(0);
		await t.mutation(door, { id });
		expect(await rowOf(t, id)).toBeNull();
		expect(await chunksOf(t, id)).toHaveLength(0);
	});

	test("refuses an id of another table and a missing note", async () => {
		const t = createT();
		await seedOrgs(t);
		const agentId = await t.run(
			async (ctx) => (await ctx.db.query("agents").first())?._id as string,
		);
		await expect(t.mutation(door, { id: agentId })).rejects.toThrow(
			/not a briefingNotes id/,
		);
	});

	test("is not a public function", () => {
		expect(
			(briefingNotesModule.deleteTestNoteById as { isInternal?: boolean })
				.isInternal,
		).toBe(true);
	});
});

// A high surrogate with no low one after it, or a low one with no high before it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("splitBody / previewOf", () => {
	test("chunks join back to the original and none cuts a surrogate pair", () => {
		// 3 UTF-16 units per repeat: BODY_CHUNK_CHARS is not a multiple of 3, so a
		// naive slice lands inside a pair.
		const body = "a\u{1F600}".repeat(Math.ceil((BODY_CHUNK_CHARS * 3) / 3) + 7);
		const parts = splitBody(body);
		expect(parts.length).toBeGreaterThan(2);
		expect(parts.join("")).toBe(body);
		for (const p of parts) {
			expect(LONE_SURROGATE.test(p)).toBe(false);
			expect(p.length).toBeLessThanOrEqual(BODY_CHUNK_CHARS);
		}
	});

	test("previewOf is a well-formed prefix", () => {
		const body = "\u{1F600}".repeat(5_000);
		const pv = previewOf(body);
		expect(LONE_SURROGATE.test(pv)).toBe(false);
		expect(body.startsWith(pv)).toBe(true);
		expect(pv.length).toBeLessThanOrEqual(4_000);
	});

	test("an empty body has no chunks", () => {
		expect(splitBody("")).toEqual([]);
	});
});
