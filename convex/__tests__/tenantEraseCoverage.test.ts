/// <reference types="vite/client" />
//
// tenantEraseCoverage — every tenant table of the schema is either COVERED by the one
// shared erase mechanism (convex/lib/eraseRow.ts) or SKIPPED with a written reason, and
// every write path of a covered authored table stores the author's ID.
// Task k170t9bg650dyw6hxjj627p9fx8hhpeq (Pi 2026-11-03: an org admin erases any row of
// its org, an author erases the rows it wrote, by verified ID).
//
// The table list is DERIVED from convex/schema.ts by the same function the org-id
// invariant uses (deriveTenantTables): a NEW tenant table fails this test the day it is
// declared until someone decides, in writing, whether it is erasable.
//
//   ERASE_INVENTORY_OUT=<file> npx vitest run convex/__tests__/tenantEraseCoverage.test.ts
//   -> writes the covered / skipped / uncovered inventory as JSON to <file>.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { deriveTenantTables } from "../migrations/tenantOrgIdInvariant";
import {
	ERASE_COVERED,
	ERASE_SKIPPED,
	eraseInventory,
} from "../lib/eraseRow";
import schema from "../schema";

type FieldLike = { kind: string };
const SCHEMA_TABLES = schema.tables as unknown as Record<
	string,
	{ validator: { kind: string; fields?: Record<string, FieldLike> } }
>;
const derived = deriveTenantTables(SCHEMA_TABLES);
const inventory = eraseInventory(derived);

describe("tenant table erase coverage", () => {
	test("the derived tenant list is the one the org-id invariant counts (non-empty)", () => {
		expect(derived.length).toBeGreaterThan(20);
	});

	test("UNCOVERED is 0: every derived tenant table is covered or skipped in writing", () => {
		if (process.env.ERASE_INVENTORY_OUT) {
			writeFileSync(
				process.env.ERASE_INVENTORY_OUT,
				JSON.stringify(inventory, null, 2),
			);
		}
		expect(inventory.uncovered).toEqual([]);
	});

	test("no table is both covered and skipped, and neither list names a table that is not tenant-scoped", () => {
		const tenant = new Set(derived.map((d) => d.table));
		for (const name of Object.keys(ERASE_COVERED)) {
			expect(ERASE_SKIPPED, name).not.toHaveProperty(name);
			expect(tenant.has(name), `${name} is not a tenant table`).toBe(true);
		}
		for (const name of Object.keys(ERASE_SKIPPED)) {
			expect(tenant.has(name), `${name} is not a tenant table`).toBe(true);
		}
	});

	test("every skip carries a reason of a sentence, not a word", () => {
		for (const [name, reason] of Object.entries(ERASE_SKIPPED)) {
			expect(reason.trim().length, name).toBeGreaterThanOrEqual(40);
		}
	});

	test("a covered table's policy matches the schema: org column is the derived id column, author column is a declared string column", () => {
		for (const [name, policy] of Object.entries(ERASE_COVERED)) {
			const row = derived.find((d) => d.table === name);
			expect(row, name).toBeDefined();
			expect(policy.orgField, name).toBe(row?.idField);
			const fields = SCHEMA_TABLES[name]?.validator.fields ?? {};
			if (policy.authorField === null) {
				expect(policy.authorlessReason?.length ?? 0, name).toBeGreaterThanOrEqual(
					40,
				);
			} else {
				expect(fields[policy.authorField]?.kind, `${name}.${policy.authorField}`).toBe(
					"string",
				);
			}
		}
	});
});

// ── every write path of a covered authored table stores the author's ID ───────────────
function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (["__tests__", "_generated", "node_modules"].includes(entry)) continue;
		if (statSync(path).isDirectory()) sourceFiles(path, out);
		else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
	}
	return out;
}

const AUTHOR_STAMPING_HELPERS =
	/taskActorIdFields\(|\.\.\.actorIds\b|authorIdFieldsOf\(|\.\.\.authorId\b/;
const EXEMPT = /erase-author-exempt:\s*(\S.{9,})/;

describe("write paths store the author's ID", () => {
	const root = resolve(__dirname, "..");
	const authored = Object.entries(ERASE_COVERED).filter(
		([, p]) => p.authorField !== null,
	) as [string, { authorField: string }][];

	test("every insert into a covered authored table carries the author column, an author-stamping helper, or a written erase-author-exempt reason", () => {
		const bad: string[] = [];
		let sites = 0;
		for (const file of sourceFiles(root)) {
			const src = readFileSync(file, "utf8");
			for (const [table, { authorField }] of authored) {
				const re = new RegExp(`\\.insert\\(\\s*["']${table}["']\\s*,\\s*\\{`, "g");
				let m: RegExpExecArray | null = re.exec(src);
				while (m !== null) {
					sites++;
					let depth = 1;
					let i = re.lastIndex;
					while (depth > 0 && i < src.length) {
						const c = src[i++];
						if (c === "{") depth++;
						else if (c === "}") depth--;
					}
					const body = src.slice(re.lastIndex, i);
					const ok =
						body.includes(authorField) ||
						AUTHOR_STAMPING_HELPERS.test(body) ||
						EXEMPT.test(body);
					if (!ok) {
						const line = src.slice(0, m.index).split("\n").length;
						bad.push(`${file.slice(root.length + 1)}:${line} ${table}`);
					}
					m = re.exec(src);
				}
			}
		}
		expect(sites).toBeGreaterThan(10);
		expect(bad).toEqual([]);
	});
});
