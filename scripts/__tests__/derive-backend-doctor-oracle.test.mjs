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
			expect(committed.rbac_adjustment_needed).toMatch(
				/^JUSTIFIED: master-only/,
			);
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
			const get = rowsOf(outOf(root)).find(
				(x) => x.outil === "get_repo_mapping",
			);
			expect(get.rbac_coherence_table).toBe(
				"INCOHERENT read=master+org write=master",
			);
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
			expect(side).toHaveLength(54);
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

	it(
		"PRESENT — a patch filled under a computed key is could-not-judge (`?`), never UPDATE, and keeps its writer row",
		() => {
			for (const tool of DYNAMIC_PATCH_WRITERS) {
				expect(committed(tool).crud, tool).toBe("?");
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
