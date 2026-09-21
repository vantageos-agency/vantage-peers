/**
 * iframeEmbedSessionsRemoved.test.ts — a source-tree-derived guard proving
 * the unauthenticated iframeEmbedSessions functions (createSession,
 * touchSession, revokeSession, getSession) are gone.
 *
 * `api` is Convex's `anyApi` proxy (see convex/_generated/api.js) — it
 * resolves any property path at runtime regardless of whether a module
 * exists, so `api.iframeEmbedSessions.createSession` cannot be asserted
 * "undefined" that way. The honest, source-tree-derived assertions are:
 *   1. convex/iframeEmbedSessions.ts does not exist on disk.
 *   2. No file under convex/ (besides schema.ts, which only defines the
 *      table) exports a mutation/query that inserts into, patches, or
 *      queries the "iframeEmbedSessions" table.
 *
 * The table itself is intentionally KEPT in convex/schema.ts (existing rows
 * must not fail schema validation) — this test does not assert the table is
 * gone, only that no public function operates on it.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONVEX_DIR = join(__dirname, "..");

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (["_generated", "__tests__", "node_modules"].includes(entry.name)) continue;
			out.push(...listSourceFiles(full));
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".d.ts") &&
			entry.name !== "schema.ts"
		) {
			out.push(full);
		}
	}
	return out;
}

describe("iframeEmbedSessions functions removed", () => {
	it("convex/iframeEmbedSessions.ts does not exist", () => {
		expect(existsSync(join(CONVEX_DIR, "iframeEmbedSessions.ts"))).toBe(false);
	});

	it("no public function under convex/ operates on the iframeEmbedSessions table", () => {
		const offenders: string[] = [];
		for (const path of listSourceFiles(CONVEX_DIR)) {
			const text = readFileSync(path, "utf-8");
			if (text.includes('"iframeEmbedSessions"') || text.includes("'iframeEmbedSessions'")) {
				offenders.push(path);
			}
		}
		expect(offenders).toEqual([]);
	});
});
