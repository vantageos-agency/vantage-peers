# Knowledge Base Ingest (B5)

VantagePeers Cloud multi-tenant KB ingest pipeline. Converts document binaries
(PDF, Markdown, plain text) into searchable memory chunks scoped to
`team/<orgId>/<docId>`.

## Upload flow

```
Client                      MCP server              Convex
  │                              │                     │
  │  generateUploadUrl()         │                     │
  │─────────────────────────────►│ kb.generateUploadUrl│
  │◄─────────────────────────────│ uploadUrl           │
  │                              │                     │
  │  POST <uploadUrl> + binary   │                     │
  │─────────────────────────────────────────────────── ► _storage
  │◄─────────────────────────────────────────────────── storageId
  │                              │                     │
  │  store_document_chunked      │                     │
  │  storageId, mimeType,        │                     │
  │  filename [, docId]          │                     │
  │─────────────────────────────►│ kb:storeDocument    │
  │                              │  Chunked            │
  │                              │────────────────────►│
  │                              │  extract → chunk    │
  │                              │  insert memories[]  │
  │◄─────────────────────────────│ {docId,chunkCount,  │
  │                              │  storageId}         │
```

1. Call `generateUploadUrl` (Convex mutation, requires auth) to get a signed
   upload URL.
2. `POST` the raw binary to that URL; Convex storage returns a `storageId`.
3. Call `store_document_chunked` MCP tool with `storageId`, `mimeType`, and
   `filename`. An optional `docId` may be supplied for idempotent re-ingest.
4. Each stored chunk schedules a `ragSync.addRagEntry` job, embedding the chunk
   for vector search. Ingested documents are therefore searchable via
   `recall`, `text_search`, and `hybrid_search` — not just retrievable by
   direct namespace lookup (Day 122 fix).

## Chunk strategy

- **Target size**: ~2 000 characters per chunk (~512 tokens at 4 chars/token).
- **Overlap**: ~50 characters carried from the end of the previous chunk.
- **Splitter**: paragraph-aware — text is first split on double-newlines
  (`\n\n`). Paragraphs that individually exceed the target are hard-sliced
  with overlap. Single-paragraph documents produce one chunk.
- **Minimum chunks**: always at least 1, even for empty or PDF-stub content.

## Namespace: `team/<orgId>/<docId>`

Every chunk is stored as a `memories` row with:

| Field       | Value                          |
|-------------|-------------------------------|
| `type`      | `reference`                   |
| `namespace` | `team/<orgId>/<docId>`        |
| `isLatest`  | `true`                        |
| `createdBy` | `system`                      |

`orgId` is resolved from the Clerk JWT `org_id` claim at ingest time — it is
never supplied by the caller. Cross-tenant writes are structurally impossible.

## mimeType support matrix

| mimeType          | Extraction            | Notes                                      |
|-------------------|-----------------------|--------------------------------------------|
| `application/pdf` | pdf-parse             | Falls back to `[PDF_STUB]` if unavailable  |
| `text/markdown`   | Raw UTF-8 decode      | Full fidelity                              |
| `text/plain`      | Raw UTF-8 decode      | Full fidelity                              |

## Idempotent re-ingest

Supplying the same `docId` on a second call supersedes the prior version:

1. All `isLatest=true` chunks for `team/<orgId>/<docId>` are patched to
   `isLatest=false` (soft supersede).
2. New chunks are inserted with `isLatest=true`.
3. Active recall and search (`isLatest=true` filter) return only the latest
   version. Prior chunks remain in the DB for audit.

## Soft-delete semantics

`soft_delete_document { docId }` marks every `isLatest=true` chunk for
`team/<orgId>/<docId>` as `isLatest=false`. The rows are **not** removed from
the database — they are invisible to recall and search but retrievable for
forensic review via direct DB query with `isLatest=false`.

To hard-delete, a separate admin mutation is required (not exposed in B5).

## Auth requirements

Both `store_document_chunked` and `soft_delete_document` require a Clerk JWT
with an `org_id` claim. No-org bearers (users without an org) receive:

```
AUTH_NO_ORG_ID: Clerk JWT has no org_id claim — store_document_chunked
requires a team org. No-org bearers cannot write to team/* namespace.
```

Master callers (MCP server deploy key, no Clerk identity) are also rejected —
the KB ingest pipeline is exclusively team-scoped.

## Cross-tenant isolation

`orgId` is extracted server-side from the Clerk JWT. Callers cannot forge a
different org's namespace. Convex-layer enforcement via `memoriesScoped.ts`
additionally ensures `listMemoriesScoped` throws `AUTH_NAMESPACE_DENIED` if
a Clerk caller attempts to read `team/<other-org>/…`.

## MCP tools

### `store_document_chunked`

```
store_document_chunked
  storageId: string     # Convex _storage id (upload first)
  mimeType:  enum       # application/pdf | text/markdown | text/plain
  filename:  string     # e.g. "spec.md"
  docId?:    string     # optional stable id; UUID generated if absent
```

Returns:

```json
{ "docId": "uuid-or-supplied", "chunkCount": 4, "storageId": "kg2a…" }
```

### `soft_delete_document`

```
soft_delete_document
  docId: string         # document ID returned by store_document_chunked
```

Returns:

```json
{ "docId": "uuid", "markedCount": 4 }
```

## Convex functions

| Function                          | Runtime | Type             | Purpose                              |
|-----------------------------------|---------|------------------|--------------------------------------|
| `kb:storeDocumentChunked`         | Node    | `action`         | Main ingest pipeline (public)        |
| `kb:softDeleteDocument`           | Node    | `action`         | Soft-delete all chunks (public)      |
| `kbMutations:listChunkIdsForDoc`  | V8      | `internalQuery`  | List active chunk IDs for supersede  |
| `kbMutations:insertChunk`         | V8      | `internalMutation` | Insert one chunk row               |
| `kbMutations:supersedePriorChunks`| V8      | `internalMutation` | Mark prior chunks isLatest=false   |
| `kbMutations:markDocSoftDeleted`  | V8      | `internalMutation` | Soft-delete all chunks for docId   |

Runtime split follows the `okfBundle.ts` / `okfBundleNode.ts` pattern:
`internalQuery` and `internalMutation` cannot be co-exported in a `"use node"`
file (Convex constraint); they live in `convex/kbMutations.ts` (V8 runtime).

## Related

- B4 PR #915 — RAG namespace `team/<orgId>` tenant enforcement (prerequisite)
- `convex/memoriesScoped.ts` — `listMemoriesScoped` / `storeMemoryScoped` (B4)
- `docs/cloud/security-multi-tenant.md` — namespace isolation doctrine
- Mission `k5779qbxhwrfjmj02t31yvehns8911jp` — VP Cloud Dashboard OKF Phase 2
