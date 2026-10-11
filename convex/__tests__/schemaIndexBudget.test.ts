/**
 * Convex refuses a schema push in which one table carries more than 32 database
 * indexes. convex-test does not enforce that limit, so a schema can pass every
 * test here and still never deploy (Argus REVISE on PR #1508: `tasks` reached 36).
 * This pins the limit where a tool reads it, instead of a commit message.
 */
import { describe, expect, test } from "vitest";
import schema from "../schema";

const CONVEX_MAX_INDEXES_PER_TABLE = 32;

type TableWithIndexes = { indexes: Array<{ indexDescriptor: string }> };

function indexCounts(): Array<[string, number]> {
	return Object.entries(schema.tables as Record<string, unknown>).map(
		([name, table]) => [name, (table as TableWithIndexes).indexes.length],
	);
}

describe("schema index budget", () => {
	test("the instrument reads indexes (positive control: tasks has some)", () => {
		const tasks = indexCounts().find(([name]) => name === "tasks");
		expect(tasks?.[1]).toBeGreaterThan(0);
	});

	test(`no table carries more than ${CONVEX_MAX_INDEXES_PER_TABLE} database indexes`, () => {
		const over = indexCounts().filter(
			([, count]) => count > CONVEX_MAX_INDEXES_PER_TABLE,
		);
		expect(over).toEqual([]);
	});
});
