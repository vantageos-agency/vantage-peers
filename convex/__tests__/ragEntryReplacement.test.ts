/// <reference types="vite/client" />
//
// Unit coverage for the entry-replacement decision logic used by
// convex/ragSync.ts's replaceRagEntryContent. This is the part of the RAG
// purge path that CAN run offline: convex/lib/ragEntryReplacement.ts is a
// plain, non-"use node" module with no dependency on the embedding client
// or the RAG component, so it is imported directly here — no convexTest,
// no AI_GATEWAY_API_KEY / OPENAI_API_KEY required.
//
// The two poles pinned below are exactly the two cases rag.add() can return
// for a given key: nothing to replace (first write) vs. something to
// replace (rewrite under an existing key, e.g. after a redaction).

import { describe, expect, test } from "vitest";
import { entryIdToPurgeAfterReplace } from "../lib/ragEntryReplacement";

describe("entryIdToPurgeAfterReplace", () => {
	test("pole 1 — no previous entry (first add for a key) -> nothing to purge", () => {
		expect(entryIdToPurgeAfterReplace(null)).toBeNull();
	});

	test("pole 2 — a previous entry was replaced -> its entryId must be purged", () => {
		const replaced = { entryId: "entry_abc123", status: "replaced" as const };
		expect(entryIdToPurgeAfterReplace(replaced)).toBe("entry_abc123");
	});

	test("does not mutate or otherwise touch the input", () => {
		const replaced = { entryId: "entry_xyz", extra: "untouched" };
		const result = entryIdToPurgeAfterReplace(replaced);
		expect(result).toBe("entry_xyz");
		expect(replaced).toEqual({ entryId: "entry_xyz", extra: "untouched" });
	});
});
