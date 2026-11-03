---
section: Fixed
---
- **VantagePeers Cloud KB: a soft-deleted or re-ingested document no longer stays searchable by its exact namespace.** `kbMutations.markDocSoftDeleted` and `supersedePriorChunks` flipped only the `memories` row (`isLatest=false`) and left the RAG entry filed with `isLatest="true"`, so `hybrid_search`/`text_search` on `team/<org ID>/<docId>` still returned a retired chunk while the org-root search (which enumerates live `memories` rows) did not. Both now schedule `ragSync.markRagEntrySuperseded` per chunk, as the memories path already does. Pinned by `convex/__tests__/kbRetiredChunkLeavesRag.test.ts` (3 tests: present, retired, superseded).
