import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	MCP_CALLED_FUNCTIONS,
	REQUIRED_CONTRACT_VERSION,
} from "../src/backendContract.js";

/**
 * The README states the backend contract this release requires; those numbers are STATE, read
 * from mcp-server/src/backendContract.ts, never typed (derive-never-type). 5.0.3 moved the
 * contract 29 -> 30 and the README kept "29" in two current-state sentences (minos on #1775).
 *
 * Census of the current-state sentences (mcp-server/README.md, outside the release notes, whose
 * per-version numbers are history and stay as written):
 *   - "### Backend compatibility check": "contract version is below **<N>**" and
 *     "any of the **<M>** backend functions"
 *   - "## Requirements": "A backend of the same release (contract version <N>,"
 * Each anchor must be found exactly once: a sentence reworded out of the pattern fails loudly,
 * naming it, instead of passing because nothing matched.
 */
const readme = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"),
	"utf8",
);

function only(pattern: RegExp, name: string): string {
	const hits = [...readme.matchAll(new RegExp(pattern.source, "g"))];
	expect(
		hits.length,
		`README sentence "${name}" (${pattern}) found ${hits.length} times; expected exactly 1`,
	).toBe(1);
	return hits[0][1];
}

describe("README backend contract numbers equal the code", () => {
	it("Backend compatibility check: contract version", () => {
		expect(
			Number(only(/contract version is below \*\*(\d+)\*\*/, "below **N**")),
		).toBe(REQUIRED_CONTRACT_VERSION);
	});

	it("Backend compatibility check: called function count", () => {
		expect(
			Number(
				only(
					/any of the \*\*(\d+)\*\* backend functions/,
					"**M** backend functions",
				),
			),
		).toBe(MCP_CALLED_FUNCTIONS.length);
	});

	it("Requirements: contract version of the same release", () => {
		expect(
			Number(
				only(
					/A backend of the same release \(contract version (\d+),/,
					"same release (contract version N,",
				),
			),
		).toBe(REQUIRED_CONTRACT_VERSION);
	});
});
