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

/** Minimal RFC-4180 reader: the oracle has quoted cells with commas/newlines. */
function parseCsv(text) {
	const rows = [];
	let row = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"') quoted = true;
		else if (c === ",") {
			row.push(cell);
			cell = "";
		} else if (c === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += c;
	}
	const [header, ...data] = rows;
	return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const rowsOf = (csvPath) => parseCsv(readFileSync(csvPath, "utf8"));
const outOf = (root) => join(root, ".backend-doctor", "vp-by-tool.csv");

describe("derive-backend-doctor-oracle coherence tier + written justification", () => {
	it(
		"PRESENT — the coherence flag compares what the Convex handlers enforce, not the MCP transport label",
		() => {
			const rows = rowsOf(COMMITTED_CSV);
			// githubRepoMapping: the MCP label of the two reads is `filtered`, but
			// the handlers are master-only (requireResolvedCaller masterOnly), the
			// same door as the master-only writes => one tier.
			const repo = rows.filter((r) => r.table === "githubRepoMapping");
			expect(repo.length).toBeGreaterThanOrEqual(4);
			for (const r of repo)
				expect(r.rbac_coherence_table, r.outil).toBe("COHERENT(master)");
			// tasks: actor-bound writes and org-filtered reads resolve ONE org tier
			// at the Convex door (assertTaskVisibleToCaller == the readers' predicate).
			for (const r of rows.filter((x) => x.table === "tasks"))
				expect(r.rbac_coherence_table, r.outil).toMatch(/^COHERENT/);
		},
		TIMEOUT,
	);

	it(
		"PRESENT — every row that stays INCOHERENT carries a written JUSTIFIED: reason from its source",
		() => {
			const rows = rowsOf(COMMITTED_CSV);
			const incoherent = rows.filter((r) =>
				r.rbac_coherence_table.startsWith("INCOHERENT"),
			);
			expect(incoherent.map((r) => r.table)).toEqual(
				expect.arrayContaining(["businessUnits", "profiles"]),
			);
			for (const r of incoherent)
				expect(r.rbac_adjustment_needed, r.outil).toMatch(/^JUSTIFIED: \S/);
		},
		TIMEOUT,
	);

	it(
		"ABSENT — without its source marker a tool row carries no JUSTIFIED token (nothing is generated)",
		() => {
			const root = copyTree();
			mutate(
				root,
				"mcp-server/src/tools.ts",
				"// oracle-justified: master-only by design: deleting a business unit",
				"// note: master-only by design: deleting a business unit",
			);
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			const del = rowsOf(outOf(root)).find((x) => x.outil === "delete_bu");
			expect(del.rbac_adjustment_needed).toBe("?");
			const committed = rowsOf(COMMITTED_CSV).find(
				(x) => x.outil === "delete_bu",
			);
			expect(committed.rbac_adjustment_needed).toMatch(/^JUSTIFIED: master-only/);
		},
		TIMEOUT,
	);

	it(
		"BOTH POLES — a read that stops being master-only at its Convex door flips the table to INCOHERENT",
		() => {
			const root = copyTree();
			mutate(
				root,
				"convex/githubRepoMapping.ts",
				'requireResolvedCaller(scope, "githubRepoMapping:getByRepo", {\n\t\t\talsoRefusePreOrg: true,\n\t\t\tmasterOnly: true,\n\t\t});',
				'requireResolvedCaller(scope, "githubRepoMapping:getByRepo", {\n\t\t\talsoRefusePreOrg: true,\n\t\t});',
			);
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			const get = rowsOf(outOf(root)).find((x) => x.outil === "get_repo_mapping");
			expect(get.rbac_coherence_table).toBe("INCOHERENT read=master+org write=master");
		},
		TIMEOUT,
	);

	it(
		"REFUSED — an oracle-justified marker with no reason text => exit 2",
		() => {
			const root = copyTree();
			mutate(
				root,
				"mcp-server/src/tools.ts",
				'\tdefineTool(\n\t\tserver,\n\t\tauthCtx,\n\t\t{ kind: "master" },\n\t\t"delete_bu",',
				'\t// oracle-justified:\n\tdefineTool(\n\t\tserver,\n\t\tauthCtx,\n\t\t{ kind: "master" },\n\t\t"delete_bu",',
			);
			const r = derive(root);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("oracle-justified marker carries no reason text");
		},
		TIMEOUT,
	);
});
