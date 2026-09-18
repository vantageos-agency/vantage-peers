// ─────────────────────────────────────────────────────────────────────────────
// ragEntryReplacement — pure decision logic for the RAG replace-then-purge
// step used by convex/ragSync.ts's replaceRagEntryContent.
//
// rag.add() (from @convex-dev/rag) replacing an existing key only marks the
// PREVIOUS version's status "replaced" — it does not delete anything. See
// node_modules/@convex-dev/rag/dist/component/entries.js:308-316
// (promoteToReadyHandler: `previousEntry.status = { kind: "replaced",
// replacedAt: Date.now() }`). The previous entry's chunks — which hold the
// OLD text, i.e. exactly the secret a redaction is trying to erase — are
// left untouched in the chunks table until something calls
// rag.delete/rag.deleteAsync on that entryId (deleteEntrySync,
// node_modules/@convex-dev/rag/dist/component/entries.js:382-395, which
// walks chunks.deleteChunksPage before deleting the entry row itself).
//
// This module is the pure "which entryId (if any) needs that purge call"
// decision, extracted out of ragSync.ts (a "use node" file that also
// eagerly constructs the embedding client at module load — see
// convex/lib/aiClient.ts) so it can be unit-tested without a configured
// AI_GATEWAY_API_KEY / OPENAI_API_KEY and without the RAG component's
// node-only runtime.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given the `replacedEntry` returned by `rag.add()`, returns the entryId
 * that must be purged so the old text is not retrievable through any RAG
 * read path — or `null` when there was nothing to replace (first add for
 * that key).
 */
export function entryIdToPurgeAfterReplace<T extends { entryId: unknown }>(
  replacedEntry: T | null,
): T["entryId"] | null {
  return replacedEntry === null ? null : replacedEntry.entryId;
}
