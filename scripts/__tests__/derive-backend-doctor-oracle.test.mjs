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
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO, "scripts", "derive-backend-doctor-oracle.mjs");
const COMMITTED_CSV = join(REPO, ".backend-doctor", "vp-by-tool.csv");
const COMMITTED_WRITER_CSV = join(
	REPO,
	".backend-doctor",
	"vp-writer-tier.csv",
);
const TIMEOUT = 120_000;

/**
 * The number of MCP tools the registry holds, DERIVED rather than typed: the
 * data rows of the committed oracle CSV (one row per registered defineTool),
 * counted with a quote-aware pass because cells may hold newlines. A typed
 * count drifted every time a tool was added (108 -> 109 with
 * get_bulk_complete_run); the PRESENT test below still proves the committed
 * CSV is byte-identical to a fresh derivation, so a stale CSV cannot make this
 * number lie.
 */
function countCsvDataRows(text) {
	let rows = 0;
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			if (inQuotes && text[i + 1] === '"') i++;
			else inQuotes = !inQuotes;
		} else if (ch === "\n" && !inQuotes) rows++;
	}
	return rows - 1; // minus the header line
}
const TOOL_COUNT = countCsvDataRows(readFileSync(COMMITTED_CSV, "utf8"));
const TOOL_COUNT_SHORT = TOOL_COUNT - 1;

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
		".backend-doctor/vp-writer-tier.csv",
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
		`PRESENT — the normal tree derives ${TOOL_COUNT} rows, byte-identical to the committed CSV`,
		() => {
			const root = copyTree();
			rmSync(join(root, ".backend-doctor"), { recursive: true });
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			expect(r.stdout).toContain(`${TOOL_COUNT} rows`);
			const fresh = readFileSync(
				join(root, ".backend-doctor", "vp-by-tool.csv"),
				"utf8",
			);
			expect(fresh).toBe(readFileSync(COMMITTED_CSV, "utf8"));
			expect(fresh.trimEnd().split("\n")).toHaveLength(TOOL_COUNT + 1); // header + one row per tool
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
			`REFUSED — one defineTool hidden from the AST walk (non-literal name) => exit 2 expected ${TOOL_COUNT} found ${TOOL_COUNT_SHORT} ${mode.join(" ") || "(write)"}`,
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
					`expected ${TOOL_COUNT} tools (lexical defineTool( count across mcp-server/src), found ${TOOL_COUNT_SHORT} (AST enumeration)`,
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
		"PRESENT — the coherence flag compares what the Convex handlers enforce, not the MCP transport label (githubRepoMapping: org-scoped door beside org writes is COHERENT(org))",
		() => {
			const rows = rowsOf(COMMITTED_CSV);
			// githubRepoMapping: the MCP label of the reads is `filtered`; what counts
			// is the handlers: getByRepo and list serve a member only its own org's
			// rows and add/remove write only the caller's own org => one tier.
			const repo = rows.filter((r) =>
				r.table.split("+").includes("githubRepoMapping"),
			);
			expect(repo.length).toBeGreaterThanOrEqual(4);
			// Repo mappings are tenant-owned (orgId stamped server-side): the reads
			// (list/get) and the writes (add/remove) all resolve ONE org tier at the
			// Convex door, so the table is COHERENT(org), not master.
			for (const r of repo)
				expect(r.rbac_coherence_table, r.outil).toBe("COHERENT(org)");
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
			expect(incoherent.map((r) => r.table)).not.toContain("githubRepoMapping");
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
			expect(committed.rbac_adjustment_needed).toMatch(
				/^JUSTIFIED: master-only/,
			);
		},
		TIMEOUT,
	);

	it(
		"BOTH POLES — get_repo_mapping is COHERENT(org) as committed; a read door that becomes master-only again beside the org-scoped writes flips the table to INCOHERENT",
		() => {
			// PRESENT pole: the committed row.
			const committed = rowsOf(COMMITTED_CSV).find(
				(x) => x.outil === "get_repo_mapping",
			);
			expect(committed.rbac_coherence_table).toBe("COHERENT(org)");
			// ABSENT-of-the-control pole: re-impose masterOnly on getByRepo.
			const root = copyTree();
			mutate(
				root,
				"convex/githubRepoMapping.ts",
				'requireResolvedCaller(scope, "githubRepoMapping:getByRepo", {\n\t\t\talsoRefusePreOrg: true,\n\t\t});',
				'requireResolvedCaller(scope, "githubRepoMapping:getByRepo", {\n\t\t\talsoRefusePreOrg: true,\n\t\t\tmasterOnly: true,\n\t\t});',
			);
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			const get = rowsOf(outOf(root)).find(
				(x) => x.outil === "get_repo_mapping",
			);
			expect(get.rbac_coherence_table).toMatch(/^INCOHERENT /);
			expect(get.rbac_coherence_table).not.toBe(committed.rbac_coherence_table);
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
			expect(r.stderr).toContain(
				"oracle-justified marker carries no reason text",
			);
		},
		TIMEOUT,
	);
});

const writerOut = (root) => join(root, ".backend-doctor", "vp-writer-tier.csv");
const WRITE_VERBS = new Set([
	"CREATE",
	"UPDATE",
	"DELETE",
	"TRANSITION",
	"UPSERT",
	"BULK-WRITE",
]);
const BU_DOOR_GATE =
	"\t\tconst scope = await withOrgScope(ctx);\n\t\tif (!scope.isMaster) {\n\t\t\tthrow new ConvexError(\n\t\t\t\t`RBAC_DENIED: business unit deletion";
const BU_DOOR_REST =
	"\n\t\t\tthrow new ConvexError(\n\t\t\t\t`RBAC_DENIED: business unit deletion";
const MASTER_TOOL_SCOPE = '\t\t{ kind: "master" },\n\t\t"delete_bu",';

/** delete_bu's writer tier after rewriting its Convex door's gate. */
function deleteBuWriter(gateLines, { mcp = false } = {}) {
	const root = copyTree();
	mutate(
		root,
		"convex/businessUnits.ts",
		BU_DOOR_GATE,
		`${gateLines}${BU_DOOR_REST}`,
	);
	if (mcp)
		mutate(
			root,
			"mcp-server/src/tools.ts",
			MASTER_TOOL_SCOPE,
			'\t\t{ kind: "public", reason: "test" },\n\t\t"delete_bu",',
		);
	const r = derive(root);
	expect(r.status, r.stderr).toBe(0);
	return {
		root,
		row: rowsOf(writerOut(root)).find((x) => x.outil === "delete_bu"),
	};
}

/** The committed side-car must carry these exact derived tiers; a derivation
 * that mislabels any of them is red here. */
function assertWriterTiers(rows) {
	const tier = (name) => rows.find((x) => x.outil === name);
	expect(tier("delete_bu")).toMatchObject({
		writer_tier: "master",
		writer_gate: "masterOnly",
	});
	expect(tier("update_profile")).toMatchObject({
		writer_tier: "master",
		writer_gate: "masterOnly",
	});
	expect(tier("create_bu")).toMatchObject({
		writer_tier: "org-member",
		writer_gate: "orgResolver",
	});
	expect(tier("send_message")).toMatchObject({
		writer_tier: "org-member",
		writer_gate: "orgResolver",
	});
}

const DYNAMIC_PATCH_WRITERS = ["update_bu", "update_mandate", "update_mission"];

describe("derive-backend-doctor-oracle writer authority (R-10 side-car)", () => {
	it(
		"PRESENT — one row per write tool of the oracle, byte-identical to the committed side-car, derived tiers as measured",
		() => {
			const oracle = rowsOf(COMMITTED_CSV);
			// Plus the patch-only tools whose patch carries a dynamic key: the verb is
			// could-not-judge (`?`) but the tool certainly writes, so it keeps its row.
			const writes = oracle.filter(
				(r) =>
					WRITE_VERBS.has(r.crud) || DYNAMIC_PATCH_WRITERS.includes(r.outil),
			);
			const side = rowsOf(COMMITTED_WRITER_CSV);
			expect(side.map((r) => r.outil).sort()).toEqual(
				writes.map((r) => r.outil).sort(),
			);
			expect(side.length).toBeGreaterThan(0);
			expect(side).toHaveLength(writes.length);
			for (const r of side)
				expect(r.writer_tier, r.outil).toMatch(
					/^(public|org-member|org-admin|fleet-internal|master)$/,
				);
			assertWriterTiers(side);
			const root = copyTree();
			rmSync(writerOut(root));
			const d = derive(root);
			expect(d.status, d.stderr).toBe(0);
			expect(readFileSync(writerOut(root), "utf8")).toBe(
				readFileSync(COMMITTED_WRITER_CSV, "utf8"),
			);
		},
		TIMEOUT,
	);

	it(
		"REFUSED — a stale side-car fails --check",
		() => {
			const root = copyTree();
			writeFileSync(
				writerOut(root),
				readFileSync(writerOut(root), "utf8").replace(
					"delete_bu,businessUnits,DELETE,master",
					"delete_bu,businessUnits,DELETE,org-member",
				),
			);
			const r = derive(root, "--check");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("vp-writer-tier.csv is stale");
		},
		TIMEOUT,
	);

	const OPEN_MASTER_GATE =
		"\t\tconst scope = await withOrgScope(ctx);\n\t\tif (scope.isMaster === undefined) {";
	it(
		"TIER master — the unmodified door (`if (!scope.isMaster)` refusal)",
		() => {
			expect(
				rowsOf(COMMITTED_WRITER_CSV).find((x) => x.outil === "delete_bu"),
			).toMatchObject({ writer_tier: "master", writer_gate: "masterOnly" });
		},
		TIMEOUT,
	);
	it(
		"TIER org-member — the same door with its master refusal removed",
		() => {
			const { row } = deleteBuWriter(OPEN_MASTER_GATE);
			expect(row).toMatchObject({
				writer_tier: "org-member",
				writer_gate: "orgResolver",
			});
		},
		TIMEOUT,
	);
	it(
		"TIER org-admin — the same door gated by requireOrgAdmin",
		() => {
			const { row } = deleteBuWriter(
				OPEN_MASTER_GATE.replace(
					"\n",
					'\n\t\tawait requireOrgAdmin(ctx, "acme");\n',
				),
			);
			expect(row).toMatchObject({
				writer_tier: "org-admin",
				writer_gate: "orgAdmin",
			});
		},
		TIMEOUT,
	);
	it(
		"TIER fleet-internal — the same door gated by requireResolvedCaller({ mcpBoundOnly: true })",
		() => {
			const { row } = deleteBuWriter(
				OPEN_MASTER_GATE.replace(
					"\n",
					'\n\t\trequireResolvedCaller(scope, "businessUnits:remove", { mcpBoundOnly: true });\n',
				),
			);
			expect(row).toMatchObject({
				writer_tier: "fleet-internal",
				writer_gate: "mcpBoundOnly",
			});
		},
		TIMEOUT,
	);
	it(
		"TIER public — no Convex gate and a public MCP scope",
		() => {
			const { row } = deleteBuWriter(
				"\t\tconst scope = { isMaster: true, orgSlug: null };\n\t\tif (scope.isMaster === undefined) {",
				{ mcp: true },
			);
			expect(row).toMatchObject({
				writer_tier: "public",
				writer_gate: "mcp-scope:public",
			});
		},
		TIMEOUT,
	);
	it(
		"FALLBACK — no Convex gate keeps the MCP-scope tier (master scope -> fleet-internal)",
		() => {
			const { row } = deleteBuWriter(
				"\t\tconst scope = { isMaster: true, orgSlug: null };\n\t\tif (scope.isMaster === undefined) {",
			);
			expect(row).toMatchObject({
				writer_tier: "fleet-internal",
				writer_gate: "mcp-scope:master",
			});
		},
		TIMEOUT,
	);

	it(
		"MUTANT — a derivation that mislabels a tier turns the committed-tier pole red",
		() => {
			const root = copyTree();
			// the mutated copy resolves `typescript` through a link to the repo's
			const dir = mkdtempSync(join(tmpdir(), "oracle-mutant-"));
			temps.push(dir);
			mkdirSync(join(dir, "scripts"));
			symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
			const mutantScript = join(dir, "scripts", "derive.mjs");
			const text = readFileSync(SCRIPT, "utf8");
			expect(text).toContain('\tmasterOnly: "master",');
			writeFileSync(
				mutantScript,
				text.replace('\tmasterOnly: "master",', '\tmasterOnly: "org-member",'),
			);
			const r = spawnSync(process.execPath, [mutantScript, "--root", root], {
				encoding: "utf8",
			});
			expect(r.status, r.stderr).toBe(0);
			const mutated = rowsOf(writerOut(root));
			expect(mutated.find((x) => x.outil === "delete_bu").writer_tier).toBe(
				"org-member",
			);
			// the pole that passes on the real derivation fails on the mutant
			expect(() => assertWriterTiers(mutated)).toThrow();
			expect(() =>
				assertWriterTiers(rowsOf(COMMITTED_WRITER_CSV)),
			).not.toThrow();
		},
		TIMEOUT,
	);
});

describe("derive-backend-doctor-oracle verb and guard derivation (R-37 inputs)", () => {
	const committed = (name) =>
		rowsOf(COMMITTED_CSV).find((x) => x.outil === name);

	it(
		"PRESENT — a list that probes another table per row (`.first()` on briefingNoteParticipants) is READ-LIST, not `?`",
		() => {
			expect(committed("list_briefing_notes").crud).toBe("READ-LIST");
			expect(committed("get_briefing_note").crud).toBe("READ-GET");
		},
		TIMEOUT,
	);

	it(
		"BOTH POLES — a `db.get(id)` added to the same list handler makes the mix undecidable again",
		() => {
			const root = copyTree();
			mutate(
				root,
				"convex/briefingNotes.ts",
				"// v2.3.3 — auto-clamp limit when fields=full + no explicit limit",
				'// v2.3.3 — auto-clamp limit when fields=full + no explicit limit\n\t\tawait ctx.db.get("x" as never);',
			);
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			expect(
				rowsOf(outOf(root)).find((x) => x.outil === "list_briefing_notes").crud,
			).toBe("?");
		},
		TIMEOUT,
	);

	it(
		"PRESENT — a helper named only in a comment is not a guard the handler calls",
		() => {
			const search = committed("search_briefing_notes_by_keyword");
			expect(search.scope_enforcement).not.toContain("convex:filterByOrgScope");
			expect(search.scope_enforcement).toContain("requireScope");
		},
		TIMEOUT,
	);

	it(
		"BOTH POLES — a real call to the helper IS recorded",
		() => {
			const root = copyTree();
			mutate(
				root,
				"convex/briefingNotes.ts",
				'requireScope(scope, "view-own-tasks");\n\n\t\tconst limit = Math.min(Math.max(args.limit ?? 20, 1), 200);',
				'requireScope(scope, "view-own-tasks");\n\t\tfilterByOrgScope(scope, []);\n\n\t\tconst limit = Math.min(Math.max(args.limit ?? 20, 1), 200);',
			);
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			expect(
				rowsOf(outOf(root)).find(
					(x) => x.outil === "search_briefing_notes_by_keyword",
				).scope_enforcement,
			).toContain("convex:filterByOrgScope/requireScope");
		},
		TIMEOUT,
	);

	it(
		"PRESENT — the two real asymmetries carry a JUSTIFIED reason citing the code",
		() => {
			expect(committed("list_diaries").rbac_adjustment_needed).toMatch(
				/^JUSTIFIED: .*convex\/diary\.ts:\d+/,
			);
			expect(
				committed("search_briefing_notes_by_keyword").rbac_adjustment_needed,
			).toMatch(/^JUSTIFIED: .*briefingNotes\.ts:\d+/);
		},
		TIMEOUT,
	);

	it(
		"ABSENT — without its source marker list_diaries carries no JUSTIFIED token",
		() => {
			const root = copyTree();
			mutate(
				root,
				"mcp-server/src/tools.ts",
				"// oracle-justified: list vs get_diary differ by design",
				"// note: list vs get_diary differ by design",
			);
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			expect(
				rowsOf(outOf(root)).find((x) => x.outil === "list_diaries")
					.rbac_adjustment_needed,
			).not.toMatch(/JUSTIFIED/);
		},
		TIMEOUT,
	);

	it(
		"BOTH POLES — a patch built in a local (`const patch = { status }`) is TRANSITION, like the inline form (tasks:start vs tasks:resume)",
		() => {
			const root = copyTree();
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			const crud = (name) =>
				rowsOf(outOf(root)).find((x) => x.outil === name).crud;
			expect(crud("resume_task")).toBe("TRANSITION");
			expect(crud("start_task")).toBe("TRANSITION");
			expect(committed("start_task").crud).toBe("TRANSITION");

			// ABSENT pole: the local patch no longer names status -> UPDATE again.
			const root2 = copyTree();
			mutate(
				root2,
				"convex/tasks.ts",
				'const patch: Record<string, unknown> = {\n\t\t\tstatus: "in_progress" as const,\n\t\t\tupdatedAt: now,\n\t\t\tpausedAt: undefined,',
				"const patch: Record<string, unknown> = {\n\t\t\tupdatedAt: now,\n\t\t\tpausedAt: undefined,",
			);
			const r2 = derive(root2);
			expect(r2.status, r2.stderr).toBe(0);
			expect(
				rowsOf(outOf(root2)).find((x) => x.outil === "start_task").crud,
			).toBe("UPDATE");
		},
		TIMEOUT,
	);

	// ── patchWritesStatus: the two property-assignment forms (Argus, PR #1457,
	// mutant M2) ── synthetic edits of tasks:start's local patch: the literal no
	// longer names `status`, the handler assigns it afterwards.
	const LITERAL =
		'status: "in_progress" as const,\n\t\t\tupdatedAt: now,\n\t\t\tpausedAt: undefined,\n\t\t};';
	const withoutLiteralStatus = (assignment) => [
		LITERAL,
		`updatedAt: now,\n\t\t\tpausedAt: undefined,\n\t\t};\n\t\t${assignment}`,
	];
	const startVerb = (root) => {
		const r = derive(root);
		expect(r.status, r.stderr).toBe(0);
		return rowsOf(outOf(root)).find((x) => x.outil === "start_task").crud;
	};

	it(
		"BOTH POLES — `patch.status = …` after a status-less literal is TRANSITION; with no assignment at all it is UPDATE",
		() => {
			const root = copyTree();
			mutate(
				root,
				"convex/tasks.ts",
				...withoutLiteralStatus('patch.status = "in_progress";'),
			);
			expect(startVerb(root)).toBe("TRANSITION");

			const absent = copyTree();
			mutate(absent, "convex/tasks.ts", ...withoutLiteralStatus(""));
			expect(startVerb(absent)).toBe("UPDATE");
		},
		TIMEOUT,
	);

	it(
		'BOTH POLES — `patch["status"] = …` after a status-less literal is TRANSITION; a different literal key is UPDATE',
		() => {
			const root = copyTree();
			mutate(
				root,
				"convex/tasks.ts",
				...withoutLiteralStatus('patch["status"] = "in_progress";'),
			);
			expect(startVerb(root)).toBe("TRANSITION");

			const other = copyTree();
			mutate(
				other,
				"convex/tasks.ts",
				...withoutLiteralStatus('patch["statusNote"] = "in_progress";'),
			);
			expect(startVerb(other)).toBe("UPDATE");
		},
		TIMEOUT,
	);

	// ── dynamic `patch[key] = value` (tasks:update, businessUnits:update, …) ──
	const DYNAMIC_LOOP =
		"for (const [key, value] of Object.entries(fields)) {\n\t\t\tif (value !== undefined) {\n\t\t\t\tpatch[key] = value;\n\t\t\t}\n\t\t}";

	// The computed keys come from `Object.entries(fields)`, `fields` the rest of
	// the handler's own args: the args validator decides whether `status` can be
	// among them (task k17dvkdh8c8r5xhmt5nxdk9kys8fs5aw, #1457 follow-up).
	const verbOfTool = (root, tool) => {
		const r = derive(root);
		expect(r.status, r.stderr).toBe(0);
		return rowsOf(outOf(root)).find((x) => x.outil === tool).crud;
	};

	it(
		"POLE (a) — computed keys from the handler's args, whose validator declares `status`, are TRANSITION and keep their writer row",
		() => {
			const root = copyTree();
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			const fresh = rowsOf(outOf(root));
			for (const tool of DYNAMIC_PATCH_WRITERS) {
				expect(fresh.find((x) => x.outil === tool).crud, tool).toBe(
					"TRANSITION",
				);
				expect(committed(tool).crud, tool).toBe("TRANSITION");
				const writer = rowsOf(COMMITTED_WRITER_CSV).find(
					(x) => x.outil === tool,
				);
				expect(writer, tool).toBeDefined();
				expect(writer.writer_tier, tool).toMatch(
					/^(org-member|org-admin|fleet-internal|master)$/,
				);
			}
		},
		TIMEOUT,
	);

	it(
		"POLE (b) — the same computed-key loop over args that do NOT declare `status` is UPDATE",
		() => {
			const root = copyTree();
			mutate(
				root,
				"convex/mandates.ts",
				"\t\tstatus: v.optional(mandateStatusValidator),\n\t\ttokensCost",
				"\t\ttokensCost",
			);
			expect(verbOfTool(root, "update_mandate")).toBe("UPDATE");

			// `status` declared, but destructured out by name before the rest:
			// the rest the loop reads cannot carry it.
			const named = copyTree();
			mutate(
				named,
				"convex/businessUnits.ts",
				"const { buId, callerOrchestrator, ...fields } = args;",
				"const { buId, callerOrchestrator, status: _status, ...fields } = args;",
			);
			expect(verbOfTool(named, "update_bu")).toBe("UPDATE");
		},
		TIMEOUT,
	);

	it(
		"POLE (c) — computed keys the derivation cannot trace to a declared field set stay could-not-judge (`?`)",
		() => {
			// keys from an object that is not the handler's args
			const root = copyTree();
			mutate(
				root,
				"convex/mandates.ts",
				"for (const [key, value] of Object.entries(fields)) {",
				"const elsewhere: Record<string, unknown> = JSON.parse(String(fields.tokensCost));\n\t\tfor (const [key, value] of Object.entries(elsewhere)) {",
			);
			expect(verbOfTool(root, "update_mandate")).toBe("?");

			// a key that is not the loop's own key binding
			const computed = copyTree();
			mutate(
				computed,
				"convex/mandates.ts",
				"\t\t\t\tpatch[key] = value;",
				"\t\t\t\tpatch[key.toUpperCase()] = value;",
			);
			expect(verbOfTool(computed, "update_mandate")).toBe("?");

			// no literal `status` in the validator, but a spread that may carry one
			const spread = copyTree();
			mutate(
				spread,
				"convex/mandates.ts",
				"\t\tstatus: v.optional(mandateStatusValidator),\n\t\ttokensCost",
				"\t\t...extraArgs,\n\t\ttokensCost",
			);
			expect(verbOfTool(spread, "update_mandate")).toBe("?");

			// two const rests of args under the loop's name: which field set the
			// loop reads is ambiguous, so argFieldsOf answers nothing
			const ambiguous = copyTree();
			mutate(
				ambiguous,
				"convex/businessUnits.ts",
				"const { buId, callerOrchestrator, ...fields } = args;",
				"const { buId, callerOrchestrator, ...fields } = args;\n\t\t{\n\t\t\tconst { callerOrchestrator: _c, ...fields } = args;\n\t\t\tvoid fields;\n\t\t}",
			);
			expect(verbOfTool(ambiguous, "update_bu")).toBe("?");
		},
		TIMEOUT,
	);

	it(
		"BOTH POLES — replacing the computed-key loop of businessUnits:update with fixed keys makes update_bu UPDATE again",
		() => {
			const root = copyTree();
			mutate(
				root,
				"convex/businessUnits.ts",
				DYNAMIC_LOOP,
				"if (fields.name !== undefined) patch.name = fields.name;",
			);
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			expect(
				rowsOf(outOf(root)).find((x) => x.outil === "update_bu").crud,
			).toBe("UPDATE");
		},
		TIMEOUT,
	);

	it(
		"BOTH POLES — a computed-key write beside a literal-keyed `status` is still TRANSITION (the status write is certain)",
		() => {
			const root = copyTree();
			mutate(
				root,
				"convex/businessUnits.ts",
				DYNAMIC_LOOP,
				`${DYNAMIC_LOOP}\n\t\tpatch.status = "archived";`,
			);
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			expect(
				rowsOf(outOf(root)).find((x) => x.outil === "update_bu").crud,
			).toBe("TRANSITION");
		},
		TIMEOUT,
	);
});

// ── table_conserver_supprimer: the disposition declared at the tool ─────────
// backend-standard §5 R-13: a disposition from a closed set (stays / goes /
// undecided with an owner and a deadline). The doctor reads it from
// `table_conserver_supprimer` (backend-doctor src/detectors/predicates.ts r13:
// conform on ^CONSERVER / ^SUPPRIMER, or undecided + owner: + deadline). The
// only source is the tool author's `// oracle-disposition: <value>` comment in
// the block before its defineTool( call; nothing is generated, so an
// undeclared tool keeps an empty cell and still counts under R-13.

const DELETE_BU_JUSTIFIED_TAIL =
	"//   create, update and list, which admit a member by roster.\n\tdefineTool(";

function declareDeleteBu(root, value) {
	mutate(
		root,
		"mcp-server/src/tools.ts",
		DELETE_BU_JUSTIFIED_TAIL,
		DELETE_BU_JUSTIFIED_TAIL.replace(
			"\n\tdefineTool(",
			`\n\t// oracle-disposition:${value === "" ? "" : ` ${value}`}\n\tdefineTool(`,
		),
	);
}

// The tools that declare their R-13 disposition at their definition in
// mcp-server/src/tools.ts. Every other tool declares nothing and stays empty.
const DECLARED_DISPOSITION = {
	bind_github_owner:
		"CONSERVER — githubInstallStates is the single-use install state of the GitHub-verified owner binding",
	get_github_owner_bindings:
		"CONSERVER — githubOwnerBindings is the proof an owner belongs to an org, the only basis on which a repo routes to it",
};

describe("derive-backend-doctor-oracle declared disposition (R-13)", () => {
	it(
		"ABSENT — a tool with no oracle-disposition marker has an empty disposition; a declared one carries its own",
		() => {
			const rows = rowsOf(COMMITTED_CSV);
			expect(rows).toHaveLength(TOOL_COUNT);
			for (const r of rows)
				expect(r.table_conserver_supprimer, r.outil).toBe(
					DECLARED_DISPOSITION[r.outil] ?? "",
				);
		},
		TIMEOUT,
	);

	it(
		"PRESENT — a declared tool carries its disposition verbatim; an undeclared neighbour stays empty; the justification is not swallowed",
		() => {
			const root = copyTree();
			declareDeleteBu(
				root,
				"CONSERVER — business units are the tenant hierarchy",
			);
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			const rows = rowsOf(outOf(root));
			const del = rows.find((x) => x.outil === "delete_bu");
			expect(del.table_conserver_supprimer).toBe(
				"CONSERVER — business units are the tenant hierarchy",
			);
			// the oracle-justified block above it ends where the next marker starts
			expect(del.rbac_adjustment_needed).toMatch(/^JUSTIFIED: master-only/);
			expect(del.rbac_adjustment_needed).not.toContain("oracle-disposition");
			expect(del.rbac_adjustment_needed).not.toContain("CONSERVER");
			// the same table's other tools declared nothing: nothing is inferred
			for (const x of rows.filter((y) => y.outil !== "delete_bu"))
				expect(x.table_conserver_supprimer, x.outil).toBe(
					DECLARED_DISPOSITION[x.outil] ?? "",
				);
		},
		TIMEOUT,
	);

	it(
		"PRESENT — a declaration placed BEFORE an oracle-justified block, with a continuation line, reads to the next marker",
		() => {
			const root = copyTree();
			mutate(
				root,
				"mcp-server/src/tools.ts",
				"\t// oracle-justified: master-only by design: deleting a business unit",
				"\t// oracle-disposition: SUPPRIMER — superseded by the org roster\n\t//   (survivor: update_bu)\n\t// oracle-justified: master-only by design: deleting a business unit",
			);
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			const del = rowsOf(outOf(root)).find((x) => x.outil === "delete_bu");
			expect(del.table_conserver_supprimer).toBe(
				"SUPPRIMER — superseded by the org roster (survivor: update_bu)",
			);
			expect(del.rbac_adjustment_needed).toMatch(/^JUSTIFIED: master-only/);
		},
		TIMEOUT,
	);

	it(
		"PRESENT — an undecided disposition carrying an owner and a deadline is accepted",
		() => {
			const root = copyTree();
			declareDeleteBu(root, "UNDECIDED owner: sigma deadline: 2026-11-30");
			const r = derive(root);
			expect(r.status, r.stderr).toBe(0);
			expect(
				rowsOf(outOf(root)).find((x) => x.outil === "delete_bu")
					.table_conserver_supprimer,
			).toBe("UNDECIDED owner: sigma deadline: 2026-11-30");
		},
		TIMEOUT,
	);

	for (const [label, value, message] of [
		[
			"a value outside the closed set",
			"KEEP",
			"outside {CONSERVER, SUPPRIMER, UNDECIDED}",
		],
		[
			"a lower-case keyword",
			"conserver",
			"outside {CONSERVER, SUPPRIMER, UNDECIDED}",
		],
		[
			"a keyword run into another word",
			"CONSERVERS",
			"outside {CONSERVER, SUPPRIMER, UNDECIDED}",
		],
		["a bare UNDECIDED", "UNDECIDED", "UNDECIDED without owner: and deadline:"],
		[
			"an UNDECIDED with an owner and no deadline",
			"UNDECIDED owner: sigma",
			"UNDECIDED without owner: and deadline:",
		],
		["an empty marker", "", "oracle-disposition marker carries no value"],
	])
		for (const mode of [[], ["--check"]])
			it(
				`REFUSED — ${label} => exit 2, nothing written ${mode.join(" ") || "(write)"}`,
				() => {
					const root = copyTree();
					declareDeleteBu(root, value);
					const before = readFileSync(outOf(root), "utf8");
					const r = derive(root, ...mode);
					expect(r.status, r.stdout).toBe(2);
					expect(r.stderr).toContain("delete_bu");
					expect(r.stderr).toContain(message);
					expect(readFileSync(outOf(root), "utf8")).toBe(before);
				},
				TIMEOUT,
			);
});
