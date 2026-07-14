#!/usr/bin/env node
/**
 * check-tool-counts.mjs — Day-101 root-fix for fix-pattern m974527p6jbbb5kzj3jt2z636n89fddv.
 *
 * Class of bug it prevents: hand-maintained MCP-tool tallies in docs drift from
 * the actual registered surface. Two prior PRs hit this class in 2 days:
 *   - vantageos-agency/vantage-peers #984     (mcp-server/README.md category integers)
 *   - vantageos-agency/vantage-peers-site #137 (tools-catalogue.mdx Summary + Total)
 *
 * What this script asserts:
 *   1. tools.ts canonical surface
 *        Counts `server.tool(` literals in mcp-server/src/tools.ts AND the
 *        per-tool registrar files in mcp-server/src/tools/*.ts. Used as a
 *        reference for the "<N>+" badge in mcp-server/README.md.
 *   2. mcp-server/README.md self-consistency
 *        Each `### Domain (N)` heading's integer must equal the number of
 *        bullet entries (`- \`tool\``) under it (up to next ###/##/H1).
 *   3. tools-catalogue.mdx + .fr.mdx self-consistency (optional — see modes)
 *        Each `## Domain` table's row count must equal the corresponding entry
 *        in the `## Summary` table, and the Summary `**Total**` must equal the
 *        sum of per-domain row counts.
 *
 * Modes:
 *   node scripts/check-tool-counts.mjs                  # assert in-repo README + counts
 *   node scripts/check-tool-counts.mjs --update         # rewrite drifted integers in-place
 *   node scripts/check-tool-counts.mjs --target=<file>  # also assert against an EN catalogue file
 *   node scripts/check-tool-counts.mjs --target-fr=<file># also assert against a FR catalogue file
 *
 * Stdlib only (Node ≥ 20). Idempotent.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const UPDATE = args.includes("--update");
const targetEn =
	(args.find((a) => a.startsWith("--target=")) || "").slice(9) || null;
const targetFr =
	(args.find((a) => a.startsWith("--target-fr=")) || "").slice(12) || null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
// THREE outcomes, not two: PASS (0), VIOLATION (1, a real drift), or REFUSAL
// TO JUDGE (2, a required input this script needs to read is absent/unreadable).
// A missing tools.ts/README/target file used to `fail()` into the SAME bucket
// as a genuine count drift -- both printed the identical exit 1, so "I could
// not read the file" and "the counts are wrong" were indistinguishable on the
// only signal a CI gate looks at. REFUSALS is that third bucket.
const ERRORS = [];
const REFUSALS = [];
const FIXED = [];

function fail(msg) {
	ERRORS.push(msg);
}

function refuse(msg) {
	REFUSALS.push(msg);
}

function info(msg) {
	process.stdout.write(`${msg}\n`);
}

// ─── 1. tools.ts canonical surface ───────────────────────────────────────────
function countCanonicalSurface() {
	const mainFile = join(REPO_ROOT, "mcp-server/src/tools.ts");
	if (!existsSync(mainFile)) {
		refuse(`tools.ts not found at ${mainFile} — cannot count the canonical MCP-tool surface`);
		return 0;
	}
	let total = 0;
	// Match `server.tool(` at the start of a line (allowing leading tabs/spaces
	// but NOT a comment marker). This skips JSDoc references like
	// "* `server.tool(...)` registrations.".
	const RE = /^[ \t]*server\.tool\(/gm;
	const main = readFileSync(mainFile, "utf8");
	total += (main.match(RE) || []).length;

	const toolsDir = join(REPO_ROOT, "mcp-server/src/tools");
	if (existsSync(toolsDir)) {
		for (const entry of readdirSync(toolsDir)) {
			if (!entry.endsWith(".ts")) continue;
			if (entry.includes("__tests__")) continue;
			const sub = readFileSync(join(toolsDir, entry), "utf8");
			total += (sub.match(RE) || []).length;
		}
	}
	return total;
}

// ─── 2. mcp-server/README.md self-consistency ────────────────────────────────
// Parse blocks of:
//    ### <Domain> (<N>)
//    - `tool_a` — ...
//    - `tool_b` — ...
//
// stop counting at the next ### or ## or H1.
function checkReadmeCategoryCounts(path) {
	if (!existsSync(path)) {
		refuse(`README not found at ${path} — cannot check category-count self-consistency`);
		return null;
	}
	const src = readFileSync(path, "utf8");
	const lines = src.split("\n");
	const drifts = []; // { line, domain, declared, actual }

	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^### (.+?) \((\d+)\)\s*$/);
		if (!m) continue;
		const domain = m[1];
		const declared = Number.parseInt(m[2], 10);
		// Count actual tool entries until next ###/##/# heading. Support two
		// README formats:
		//   bullet:  - `tool_name` — desc
		//   inline:  `a`, `b`, `c` (one or more lines, commas, possibly with "(alias `x`)" wraps)
		// We deduplicate per-domain via a name set so the inline `(alias …)`
		// suffix doesn't double-count.
		const namesInDomain = new Set();
		let stopAt = lines.length;
		for (let j = i + 1; j < lines.length; j++) {
			const ln = lines[j];
			if (/^#{1,3} /.test(ln)) {
				stopAt = j;
				break;
			}
		}
		// Use the FIRST non-empty block following the heading (paragraph or
		// bullet block) as the canonical inventory. Stop at the next blank line
		// after we've seen at least one tool — avoids capturing schema tables
		// or other prose that follow.
		let seenContent = false;
		for (let j = i + 1; j < stopAt; j++) {
			const ln = lines[j];
			if (ln.trim() === "") {
				if (seenContent) break;
				continue;
			}
			// Bullet style: leading "- " followed by `name`
			const bullet = ln.match(/^- `([^`]+)`/);
			if (bullet) {
				namesInDomain.add(bullet[1]);
				seenContent = true;
				continue;
			}
			// Inline style: any backticked identifier on the line.
			// Filter out "alias" parentheticals so they don't add a row.
			if (/^[`A-Za-z]/.test(ln) || ln.startsWith("`")) {
				const stripped = ln.replace(/\(alias `[^`]+`\)/g, "");
				const matches = stripped.match(/`([a-z_][a-z0-9_]+)`/g) || [];
				for (const t of matches) namesInDomain.add(t.slice(1, -1));
				seenContent = true;
				continue;
			}
			// Anything else (code fence, table header, prose) — stop only if
			// we already collected names; otherwise keep scanning for the
			// first content block.
			if (seenContent) break;
		}
		const actual = namesInDomain.size;
		if (actual !== declared) {
			drifts.push({ line: i + 1, domain, declared, actual });
		}
	}
	return { src, lines, drifts };
}

// ─── 3. tools-catalogue.mdx self-consistency ─────────────────────────────────
// Parse `## Domain` blocks (table rows starting `| \`tool\``) until next `## `.
// Then parse `## Summary` table for declared per-domain integers and Total.
function parseCatalogue(path) {
	if (!existsSync(path)) {
		refuse(`Catalogue not found at ${path} — cannot check its Summary/table self-consistency`);
		return null;
	}
	const src = readFileSync(path, "utf8");
	const lines = src.split("\n");

	// Locate the Summary section by detecting the H2 that contains a
	// `| **Total** | **N** |` (or localized equivalent — pattern-match on
	// the bolded number cell). This makes the parser language-agnostic.
	let summaryStartLine = -1;
	let summaryEndLine = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (!/^## /.test(lines[i])) continue;
		// Scan ahead until next H2 looking for the Total row.
		let j = i + 1;
		while (j < lines.length && !/^## /.test(lines[j])) j++;
		for (let k = i + 1; k < j; k++) {
			if (/^\|\s*\*\*[^|*]+\*\*\s*\|\s*\*\*\d+\*\*\s*\|/.test(lines[k])) {
				summaryStartLine = i;
				summaryEndLine = j;
				break;
			}
		}
		if (summaryStartLine !== -1) break;
	}

	// Per-domain row counts. Skip the Summary H2 AND any H2 that comes
	// after it (e.g. ## Cross-references / Références croisées).
	const actual = {}; // domain -> row count
	let currentDomain = null;
	let skipDomain = false;

	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];
		const h2 = ln.match(/^## (.+?)\s*$/);
		if (h2) {
			currentDomain = h2[1];
			skipDomain = summaryStartLine !== -1 && i >= summaryStartLine;
			if (!skipDomain && !(currentDomain in actual)) actual[currentDomain] = 0;
			continue;
		}
		if (!currentDomain || skipDomain) continue;
		if (/^\| `[^`]+` \|/.test(ln)) {
			actual[currentDomain]++;
		}
	}

	// Summary parse (within the located range)
	const declared = {}; // domain -> integer
	let declaredTotal = null;
	for (let i = summaryStartLine + 1; i < summaryEndLine; i++) {
		const ln = lines[i];
		const totalMatch = ln.match(
			/^\|\s*\*\*[^|*]+\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/,
		);
		if (totalMatch) {
			declaredTotal = Number.parseInt(totalMatch[1], 10);
			continue;
		}
		const rowMatch = ln.match(/^\|\s*([^|*]+?)\s*\|\s*(\d+)\s*\|/);
		if (rowMatch) {
			const key = rowMatch[1].trim();
			// Skip table header rows like "| Domain | Tool count |" (no digit
			// in the value cell — guaranteed by the regex). Skip the
			// alignment row "|---|---|" (won't match — no digit).
			declared[key] = Number.parseInt(rowMatch[2], 10);
		}
	}

	return {
		src,
		lines,
		actual,
		declared,
		declaredTotal,
		summaryRange: [summaryStartLine, summaryEndLine],
	};
}

function checkCatalogue(path, label) {
	const parsed = parseCatalogue(path);
	if (!parsed) return null;
	const drifts = [];
	const allDomains = new Set([
		...Object.keys(parsed.actual),
		...Object.keys(parsed.declared),
	]);
	for (const d of allDomains) {
		const a = parsed.actual[d] ?? 0;
		const dec = parsed.declared[d];
		if (dec === undefined) {
			drifts.push({ domain: d, declared: "missing-from-Summary", actual: a });
			continue;
		}
		if (a !== dec) {
			drifts.push({ domain: d, declared: dec, actual: a });
		}
	}
	const actualTotal = Object.values(parsed.actual).reduce((s, n) => s + n, 0);
	const totalDrift = parsed.declaredTotal !== actualTotal;
	return { path, label, parsed, drifts, actualTotal, totalDrift };
}

// ─── Updaters ────────────────────────────────────────────────────────────────
function updateReadmeInPlace(path, parsed) {
	let { src } = parsed;
	for (const d of parsed.drifts) {
		const re = new RegExp(`^### ${escapeRegex(d.domain)} \\(\\d+\\)\\s*$`, "m");
		src = src.replace(re, `### ${d.domain} (${d.actual})`);
		FIXED.push(`README.md: ${d.domain} ${d.declared}→${d.actual}`);
	}
	writeFileSync(path, src);
}

function updateCatalogueInPlace(report) {
	let src = report.parsed.src;
	for (const d of report.drifts) {
		if (typeof d.declared !== "number") continue; // skip "missing"
		// Replace within Summary section only — narrow regex.
		const re = new RegExp(
			`(\\|\\s*${escapeRegex(d.domain)}\\s*\\|\\s*)${d.declared}(\\s*\\|)`,
			"m",
		);
		const before = src;
		src = src.replace(re, `$1${d.actual}$2`);
		if (src !== before)
			FIXED.push(`${report.label}: ${d.domain} ${d.declared}→${d.actual}`);
	}
	if (report.totalDrift) {
		const re = /(\|\s*\*\*Total\*\*\s*\|\s*\*\*)\d+(\*\*\s*\|)/m;
		const before = src;
		src = src.replace(re, `$1${report.actualTotal}$2`);
		if (src !== before) {
			FIXED.push(
				`${report.label}: **Total** ${report.parsed.declaredTotal}→${report.actualTotal}`,
			);
		}
	}
	writeFileSync(report.path, src);
}

function escapeRegex(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
	const canonical = countCanonicalSurface();
	info(`tools.ts canonical surface = ${canonical}`);

	// README check
	const readmePath = join(REPO_ROOT, "mcp-server/README.md");
	const readme = checkReadmeCategoryCounts(readmePath);
	if (readme) {
		if (readme.drifts.length > 0) {
			info(`\nmcp-server/README.md — ${readme.drifts.length} drift(s):`);
			for (const d of readme.drifts) {
				const sign = d.actual > d.declared ? "+" : "";
				info(
					`  line ${d.line}: ### ${d.domain} (${d.declared}) — actual bullets ${d.actual} [${sign}${d.actual - d.declared}]`,
				);
			}
			if (UPDATE) {
				updateReadmeInPlace(readmePath, readme);
			} else {
				fail(`mcp-server/README.md category counts drift`);
			}
		} else {
			info(`mcp-server/README.md — OK (all category integers match)`);
		}
	}

	// Catalogue check — EN
	if (targetEn) {
		const enReport = checkCatalogue(targetEn, "tools-catalogue.mdx");
		if (enReport) {
			reportCatalogue(enReport);
			if (enReport.drifts.length > 0 || enReport.totalDrift) {
				if (UPDATE) updateCatalogueInPlace(enReport);
				else fail(`${enReport.label} drift`);
			}
		}
	}

	// Catalogue check — FR
	if (targetFr) {
		const frReport = checkCatalogue(targetFr, "tools-catalogue.fr.mdx");
		if (frReport) {
			reportCatalogue(frReport);
			if (frReport.drifts.length > 0 || frReport.totalDrift) {
				if (UPDATE) updateCatalogueInPlace(frReport);
				else fail(`${frReport.label} drift`);
			}
		}
	}

	// Summary
	if (FIXED.length > 0) {
		info(`\nApplied ${FIXED.length} fix(es) (--update):`);
		for (const f of FIXED) info(`  ${f}`);
	}
	// REFUSAL TO JUDGE takes priority over reporting drift: if a required input
	// could not be read, any drift/OK verdict computed from the files that
	// COULD be read is partial and must not be presented as the final answer.
	if (REFUSALS.length > 0) {
		process.stderr.write(
			`\nREFUSING TO JUDGE — ${REFUSALS.length} required input(s) could not be read:\n`,
		);
		for (const r of REFUSALS) process.stderr.write(`  ${r}\n`);
		process.exit(2);
	}
	if (ERRORS.length > 0) {
		info(`\nFAIL — ${ERRORS.length} drift class(es) detected:`);
		for (const e of ERRORS) info(`  ${e}`);
		info(`\nRe-run with --update to auto-fix integers.`);
		process.exit(1);
	}
	info(`\nOK — all tool counts consistent.`);
}

function reportCatalogue(report) {
	info(`\n${report.label} (${report.path})`);
	info(`  actual rows per domain: total=${report.actualTotal}`);
	if (report.drifts.length === 0 && !report.totalDrift) {
		info(`  Summary integers + Total — OK`);
		return;
	}
	for (const d of report.drifts) {
		info(`  ${d.domain}: Summary=${d.declared}, table-rows=${d.actual}`);
	}
	if (report.totalDrift) {
		info(
			`  **Total**: declared=${report.parsed.declaredTotal}, sum=${report.actualTotal}`,
		);
	}
}

main();
