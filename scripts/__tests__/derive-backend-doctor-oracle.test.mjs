/**
 * Population guard of scripts/derive-backend-doctor-oracle.mjs (PR #1396,
 * Eta REVISE @ 3d587a8): the oracle feeds the deploy gate, so a short
 * enumeration of MCP tools must REFUSE (exit 2) instead of writing a short
 * CSV. Every mutation runs on a temporary COPY of the inputs (--root); the
 * real tree is never modified.
 */
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO, "scripts", "derive-backend-doctor-oracle.mjs");
const COMMITTED_CSV = join(REPO, ".backend-doctor", "vp-by-tool.csv");
const TIMEOUT = 120_000;

const temps = [];
afterEach(() => {
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of exactly the inputs the generator reads. */
function copyTree() {
	const dir = mkdtempSync(join(tmpdir(), "oracle-population-"));
	temps.push(dir);
	const skip = (src) => !/[\\/]node_modules([\\/]|$)/.test(src);
	for (const rel of [
		"mcp-server/src",
		"mcp-server/tool-exposure.json",
		"convex",
		".backend-doctor/vp-by-tool.csv",
	])
		cpSync(join(REPO, rel), join(dir, rel), { recursive: true, filter: skip });
	return dir;
}

function derive(root, ...args) {
	return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], {
		encoding: "utf8",
	});
}

function mutate(root, rel, from, to) {
	const file = join(root, rel);
	const text = readFileSync(file, "utf8");
	expect(text.includes(from)).toBe(true);
	writeFileSync(file, text.replace(from, to));
}

describe("derive-backend-doctor-oracle population guard", () => {
	it(
		"PRESENT — the normal tree derives 108 rows, byte-identical to the committed CSV",
		() => {
			const root = copyTree();
			rmSync(join(root, ".backend-doctor"), { recursive: true });
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			expect(r.stdout).toContain("108 rows");
			const fresh = readFileSync(
				join(root, ".backend-doctor", "vp-by-tool.csv"),
				"utf8",
			);
			expect(fresh).toBe(readFileSync(COMMITTED_CSV, "utf8"));
			expect(fresh.trimEnd().split("\n")).toHaveLength(109);
			const check = derive(root, "--check");
			expect(check.status, check.stderr).toBe(0);
		},
		TIMEOUT,
	);

	for (const mode of [[], ["--check"]])
		it(
			`REFUSED — mcp-server/src/tools.ts absent => exit 2 ${mode.join(" ") || "(write)"}`,
			() => {
				const root = copyTree();
				rmSync(join(root, "mcp-server", "src", "tools.ts"));
				const before = readFileSync(
					join(root, ".backend-doctor", "vp-by-tool.csv"),
					"utf8",
				);
				const r = derive(root, ...mode);
				expect(r.status).toBe(2);
				expect(r.stderr).toContain(
					"required input missing: mcp-server/src/tools.ts",
				);
				// nothing written: the short enumeration never reaches the CSV
				expect(
					readFileSync(join(root, ".backend-doctor", "vp-by-tool.csv"), "utf8"),
				).toBe(before);
			},
			TIMEOUT,
		);

	it(
		"REFUSED — a registration module imported by tools.ts is absent => exit 2 naming the import",
		() => {
			const root = copyTree();
			rmSync(join(root, "mcp-server", "src", "tools", "kbIngest.ts"));
			const r = derive(root);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(
				'mcp-server/src/tools.ts imports "./tools/kbIngest.js", which resolves to no file',
			);
		},
		TIMEOUT,
	);

	for (const mode of [[], ["--check"]])
		it(
			`REFUSED — one defineTool hidden from the AST walk (non-literal name) => exit 2 expected 108 found 107 ${mode.join(" ") || "(write)"}`,
			() => {
				const root = copyTree();
				// store_document_chunked is NOT a core name: only the lexical count
				// can see it go missing.
				mutate(
					root,
					"mcp-server/src/tools/kbIngest.ts",
					'"store_document_chunked",',
					'["store_document_chunked"][0],',
				);
				const r = derive(root, ...mode);
				expect(r.status).toBe(2);
				expect(r.stderr).toContain(
					"expected 108 tools (lexical defineTool( count across mcp-server/src), found 107 (AST enumeration)",
				);
				expect(r.stderr).toContain(
					"mcp-server/src/tools/kbIngest.ts: 3 defineTool( call site(s) in the text, 2 enumerated as tools",
				);
			},
			TIMEOUT,
		);

	it(
		"REFUSED — defineTool aliased (a call shape neither count follows) => exit 2",
		() => {
			const root = copyTree();
			mutate(
				root,
				"mcp-server/src/tools/kbIngest.ts",
				'\tdefineTool(\n\t\tserver,\n\t\tauthCtx,\n\t\tkbFilteredScope,\n\t\t"store_document_chunked",',
				'\tconst register = defineTool;\n\tregister(\n\t\tserver,\n\t\tauthCtx,\n\t\tkbFilteredScope,\n\t\t"store_document_chunked",',
			);
			const r = derive(root);
			expect(r.status).toBe(2);
			expect(r.stderr).toMatch(
				/kbIngest\.ts:\d+ uses defineTool other than as a direct call/,
			);
		},
		TIMEOUT,
	);

	it(
		"REFUSED — a core name of tool-exposure.json not enumerated => exit 2 naming it",
		() => {
			const root = copyTree();
			const p = join(root, "mcp-server", "tool-exposure.json");
			const exposure = JSON.parse(readFileSync(p, "utf8"));
			exposure.core.push("tool_that_is_not_registered");
			writeFileSync(p, JSON.stringify(exposure));
			const r = derive(root);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(
				"1 not enumerated: tool_that_is_not_registered",
			);
		},
		TIMEOUT,
	);
});
