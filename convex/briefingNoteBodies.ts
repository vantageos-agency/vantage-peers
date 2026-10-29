import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "./_generated/server";
import { internalQuery } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// briefingNoteBodies — the body of a briefing note that does not fit in its row.
//
// Convex caps a document at 1 MiB. 30 prod notes sit at that cap, so the org stamp
// (90 bytes) is refused by the platform. Their body moves to `briefingNoteBodyChunks`
// rows and the note row keeps `bodyRef` + a PREVIEW in `content`
// (migrations/offloadNoteBody:offloadOne). Why rows and not file storage: the
// briefingNotes reads are QUERIES, and a query cannot read a storage blob
// (`ctx.storage.get` is action-only; a query only gets a URL). Rows are readable by
// a query, in the same transaction as the note, so a read door stays one reactive
// query.
//
// THE CONTRACT OF A READ. A read door that returns `content` returns, for an
// offloaded note, EITHER the whole body (byte-identical to the original) OR a row
// marked `contentTruncated: true` whose `content` is a preview and whose `bodyRef`
// names the stored body. A preview never travels unmarked.
// ─────────────────────────────────────────────────────────────────────────────

// 100k UTF-16 units is at most ~300 KB of UTF-8, so a chunk row is far inside the
// 1 MiB document cap and a 1 MiB body is ~4 chunks.
export const BODY_CHUNK_CHARS = 100_000;
// What `content` keeps on an offloaded row. It is also the text the BM25
// `search_content` index sees for that note.
export const BODY_PREVIEW_CHARS = 4_000;
// Body bytes a single list/search execution hydrates. The platform reads at most
// 16 MiB per execution and the page's own rows are already part of that read; a
// quarter of it leaves the rest to them.
export const LIST_BODY_BUDGET_BYTES = 4 * 1024 * 1024;

const utf8 = new TextEncoder();

export type BodyRef = NonNullable<Doc<"briefingNotes">["bodyRef"]>;
// A note as a read door returns it: `contentTruncated` is set only when `content`
// is a preview of an offloaded body that the read did not hydrate.
export type HydratedNote = Doc<"briefingNotes"> & { contentTruncated?: true };

// A cut that never lands between the two halves of a surrogate pair.
function cutAt(s: string, from: number, max: number): number {
	let end = Math.min(from + max, s.length);
	if (end < s.length) {
		const last = s.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end--;
	}
	return end;
}

export function splitBody(content: string): string[] {
	const parts: string[] = [];
	let i = 0;
	while (i < content.length) {
		const end = cutAt(content, i, BODY_CHUNK_CHARS);
		parts.push(content.slice(i, end));
		i = end;
	}
	return parts;
}

export function previewOf(content: string): string {
	return content.slice(0, cutAt(content, 0, BODY_PREVIEW_CHARS));
}

export function utf8Length(s: string): number {
	return utf8.encode(s).length;
}

export async function sha256Hex(s: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", utf8.encode(s));
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * readBodyChunks — the stored body of an offloaded note, or a thrown refusal.
 * Never a partial: a missing, extra or out-of-order chunk, or a byte length that
 * is not the one `bodyRef` recorded, raises BODY_CHUNKS_CORRUPT naming the note.
 */
export async function readBodyChunks(
	db: DatabaseReader,
	noteId: Id<"briefingNotes">,
	ref: BodyRef,
): Promise<string> {
	const rows = await db
		.query("briefingNoteBodyChunks")
		.withIndex("by_note_idx", (q) => q.eq("noteId", noteId))
		.take(ref.chunks + 1);
	const intact =
		rows.length === ref.chunks && rows.every((r, i) => r.idx === i);
	const body = intact ? rows.map((r) => r.text).join("") : "";
	if (!intact || utf8Length(body) !== ref.bytes) {
		throw new ConvexError(
			`BODY_CHUNKS_CORRUPT: the stored body of briefing note ${noteId} is not the ${ref.chunks} chunks / ${ref.bytes} bytes its bodyRef records — ${JSON.stringify({ noteId, expectedChunks: ref.chunks, foundChunks: rows.length })}`,
		);
	}
	return body;
}

/** hydrateNote — the note with its whole body in `content` (a plain note is returned as is). */
export async function hydrateNote(
	db: DatabaseReader,
	note: Doc<"briefingNotes">,
): Promise<HydratedNote> {
	if (note.bodyRef === undefined) return note;
	return { ...note, content: await readBodyChunks(db, note._id, note.bodyRef) };
}

/**
 * hydrateWithinBudget — hydrate the offloaded notes of a page in order, each one
 * whole or not at all, until `budgetBytes` of body has been read. A note that does
 * not fit keeps its preview and is MARKED `contentTruncated: true` (with `bodyRef`
 * still on it): a partial body is never passed off as the content. A later, smaller
 * note may still fit.
 */
export async function hydrateWithinBudget(
	db: DatabaseReader,
	notes: Doc<"briefingNotes">[],
	budgetBytes: number = LIST_BODY_BUDGET_BYTES,
): Promise<HydratedNote[]> {
	let left = budgetBytes;
	const out: HydratedNote[] = [];
	for (const note of notes) {
		if (note.bodyRef === undefined) {
			out.push(note);
		} else if (note.bodyRef.bytes <= left) {
			left -= note.bodyRef.bytes;
			out.push(await hydrateNote(db, note));
		} else {
			out.push({ ...note, contentTruncated: true });
		}
	}
	return out;
}

/** deleteBodyChunks — remove the stored body of a note (a note delete, a content rewrite). */
export async function deleteBodyChunks(
	db: DatabaseWriter,
	noteId: Id<"briefingNotes">,
): Promise<number> {
	let n = 0;
	for await (const row of db
		.query("briefingNoteBodyChunks")
		.withIndex("by_note_idx", (q) => q.eq("noteId", noteId))) {
		await db.delete(row._id);
		n++;
	}
	return n;
}

/**
 * readBody — the whole body of one note, for the server-side readers that cannot
 * hydrate a page (the OKF export actions). null when the note does not exist.
 * Internal: reachable only with the deployment admin credential or from another
 * Convex function, which has already decided who may see the note.
 */
export const readBody = internalQuery({
	args: { id: v.id("briefingNotes") },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const note = await ctx.db.get(args.id);
		if (note === null) return null;
		return (await hydrateNote(ctx.db, note)).content;
	},
});
