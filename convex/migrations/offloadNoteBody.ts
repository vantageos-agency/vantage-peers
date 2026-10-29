// offloadNoteBody — move the body of ONE briefing note out of its row, so the row
// can carry the organisation stamp (tasks k17d10f1j2k2crgx9cw9bvw1vs8h7fda and
// k173kn4xsqmw3s5zx6522weqk18fttvs).
//
// Why: 30 prod briefing notes sit at Convex's 1 MiB document limit, and the
// platform refuses the 90-byte org stamp on them (backfill_org_stamp:stampOne:
// "Value is too large (1.00 MiB > maximum size 1 MiB)"). Pi's ruling: the BODY
// leaves the row, the row keeps a reference and the stamp itself, every read
// returns the body, and nothing is trimmed.
//
// What it does, in ONE transaction (it all happens or none of it does):
//   1. hashes the original body (sha256 of its UTF-8 bytes);
//   2. writes it to `briefingNoteBodyChunks`, in order;
//   3. READS THE CHUNKS BACK, rebuilds the body and hashes it again; if the two
//      hashes differ it raises BODY_HASH_MISMATCH and the transaction rolls back,
//      so a row is never left pointing at a body that is not the one it had;
//   4. patches the row: `content` -> a preview (the first characters), `bodyRef`
//      -> { chunks, bytes, sha256 }, and the org columns, decided by the SAME
//      resolver and rule A as backfill_org_stamp (loadResolver / byAgent / stampOf).
// Idempotent: a note that already has a `bodyRef` is not rewritten; its stored
// body is re-read and both hashes are reported again (its org stamp is still
// completed if it lacked one).
//
// DRY RUN BY DEFAULT: the same computation, nothing written.
//
//   npx convex run migrations/offloadNoteBody:offloadOne '{"id":"<id>"}'
//   npx convex run migrations/offloadNoteBody:offloadOne '{"id":"<id>","dryRun":false}'
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { ConvexError, v } from "convex/values";
import {
	type BodyRef,
	previewOf,
	readBodyChunks,
	sha256Hex,
	splitBody,
	utf8Length,
} from "../briefingNoteBodies";
import { internalMutation } from "../_generated/server";
import { clerkOrgIdForSlug } from "../lib/orgClerkId";
import { ORG_COLUMNS } from "./backfill_org_clerk_id";
import { byAgent, loadResolver, stampOf } from "./backfill_org_stamp";

const door = "offloadNoteBody:offloadOne";

export const offloadOne = internalMutation({
	args: {
		id: v.string(),
		dryRun: v.optional(v.boolean()),
	},
	returns: v.object({
		id: v.string(),
		dryRun: v.boolean(),
		// "offloaded": the body moved (or would, on a dry run); "alreadyOffloaded": it had.
		body: v.union(v.literal("offloaded"), v.literal("alreadyOffloaded")),
		// sha256 of the body as it was in the row, and of the body re-read from the chunks.
		sha256Before: v.string(),
		sha256After: v.string(),
		chunks: v.number(),
		bytes: v.number(),
		// The org slug written (or that a real run would write); null when nothing is written.
		stampedTo: v.union(v.string(), v.null()),
		// "stamp": decided now; "alreadyStamped": the row had an org; "undecidable": rule A
		// found no single agent, the row is left unstamped (never guessed).
		stamp: v.union(
			v.literal("fleet"),
			v.literal("org"),
			v.literal("alreadyStamped"),
			v.literal("undecidable"),
		),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const id = ctx.db.normalizeId("briefingNotes", args.id);
		if (id === null) {
			throw new ConvexError(
				`${door}: ${args.id} is not a briefingNotes id; refusing.`,
			);
		}
		const row = await ctx.db.get(id);
		if (row === null) {
			throw new ConvexError(`${door}: briefingNotes ${id} not found.`);
		}

		// ── the org stamp: the same resolver and rule A as backfill_org_stamp ──
		let stampedTo: string | null = null;
		let stamp: "fleet" | "org" | "alreadyStamped" | "undecidable" =
			"alreadyStamped";
		if (row.orgId === undefined) {
			const resolver = await loadResolver(ctx.db);
			const verdict = byAgent(resolver, row.createdBy);
			stampedTo = stampOf(resolver, verdict);
			stamp =
				verdict.kind === "fleet"
					? "fleet"
					: verdict.kind === "org"
						? "org"
						: "undecidable";
		}
		const clerkOrgId =
			stampedTo === null ? undefined : await clerkOrgIdForSlug(ctx, stampedTo);
		const orgPatch =
			stampedTo === null
				? {}
				: {
						orgId: stampedTo,
						...(clerkOrgId === undefined
							? {}
							: { [ORG_COLUMNS.briefingNotes.idField]: clerkOrgId }),
					};

		// ── already offloaded: re-read the stored body, report, complete the stamp ──
		if (row.bodyRef !== undefined) {
			const stored = await readBodyChunks(ctx.db, id, row.bodyRef);
			const sha256After = await sha256Hex(stored);
			if (sha256After !== row.bodyRef.sha256) {
				throw new ConvexError(
					`BODY_HASH_MISMATCH: the stored body of briefing note ${id} hashes to ${sha256After}, its bodyRef records ${row.bodyRef.sha256}; nothing written.`,
				);
			}
			if (!dryRun && stampedTo !== null) {
				await ctx.db.patch("briefingNotes", id, orgPatch as never);
			}
			return {
				id,
				dryRun,
				body: "alreadyOffloaded" as const,
				sha256Before: row.bodyRef.sha256,
				sha256After,
				chunks: row.bodyRef.chunks,
				bytes: row.bodyRef.bytes,
				stampedTo,
				stamp,
			};
		}

		// ── offload ──
		const original = row.content;
		const parts = splitBody(original);
		if (parts.length === 0) {
			throw new ConvexError(
				`${door}: briefing note ${id} has an empty body; there is nothing to offload.`,
			);
		}
		const sha256Before = await sha256Hex(original);
		const ref: BodyRef = {
			chunks: parts.length,
			bytes: utf8Length(original),
			sha256: sha256Before,
		};
		let rebuilt: string;
		if (dryRun) {
			rebuilt = parts.join("");
		} else {
			for (let idx = 0; idx < parts.length; idx++) {
				await ctx.db.insert("briefingNoteBodyChunks", {
					noteId: id,
					idx,
					text: parts[idx],
				});
			}
			rebuilt = await readBodyChunks(ctx.db, id, ref);
		}
		const sha256After = await sha256Hex(rebuilt);
		if (sha256After !== sha256Before) {
			throw new ConvexError(
				`BODY_HASH_MISMATCH: briefing note ${id} hashed to ${sha256Before} in its row and ${sha256After} rebuilt from its chunks; nothing written.`,
			);
		}
		if (!dryRun) {
			await ctx.db.patch("briefingNotes", id, {
				content: previewOf(original),
				bodyRef: ref,
				...orgPatch,
			} as never);
		}
		return {
			id,
			dryRun,
			body: "offloaded" as const,
			sha256Before,
			sha256After,
			chunks: ref.chunks,
			bytes: ref.bytes,
			stampedTo,
			stamp,
		};
	},
});
