#!/usr/bin/env node
/**
 * changelog-assemble — fold changelog.d/ fragments into CHANGELOG.md.
 *
 * Why: every PR used to edit the top of CHANGELOG.md under [Unreleased], so
 * each merge made every other open PR CONFLICTING. A PR now adds ONE new file
 * `changelog.d/<pr-or-branch-slug>.md` and never touches CHANGELOG.md; the
 * fragments are folded in at release time. See docs/changelog-fragments.md.
 *
 * Fragment format (frontmatter is mandatory, body must be non-empty):
 *
 *   ---
 *   section: Fixed
 *   ---
 *   - **One-line headline.** Detail...
 *
 * `section` is one of: Added, Changed, Fixed, Security.
 * `changelog.d/README.md` and any file starting with "_" or "." are ignored.
 *
 * Usage:
 *   node scripts/changelog-assemble.mjs --check
 *       Validate every fragment. Exit 0 if all are well-formed, exit 2 naming
 *       each malformed file otherwise.
 *   node scripts/changelog-assemble.mjs --version <x.y.z> [--date YYYY-MM-DD]
 *       Validate, then insert a `## [x.y.z] — date` section into CHANGELOG.md
 *       directly after the [Unreleased] block, grouped by section (fixed
 *       order) and by filename within a section (codepoint order), then delete
 *       the folded fragments. With zero fragments, nothing is written (exit 0).
 *   Options for tests / other layouts: --dir <fragments dir>, --changelog <file>.
 *
 * Exit codes: 0 ok, 1 usage error, 2 malformed fragment(s).
 * No dependencies: node built-ins only.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SECTIONS = ["Added", "Changed", "Fixed", "Security"];
const IGNORED = new Set(["readme.md"]);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse one fragment's text. Returns {section, body} or {error}. */
export function parseFragment(text) {
	const m = FRONTMATTER_RE.exec(text);
	if (!m) return { error: "missing frontmatter (expected '---\\nsection: <Section>\\n---' at line 1)" };
	const fields = {};
	for (const line of m[1].split(/\r?\n/)) {
		if (!line.trim()) continue;
		const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
		if (!kv) return { error: `unparseable frontmatter line: ${JSON.stringify(line)}` };
		fields[kv[1].toLowerCase()] = kv[2].trim();
	}
	if (!fields.section) return { error: "frontmatter has no 'section' key" };
	if (!SECTIONS.includes(fields.section)) {
		return { error: `unknown section ${JSON.stringify(fields.section)} (allowed: ${SECTIONS.join(", ")})` };
	}
	const body = m[2].trim();
	if (!body) return { error: "empty body" };
	return { section: fields.section, body };
}

/** List fragment file names in dir, sorted by codepoint order. */
export function listFragments(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.toLowerCase().endsWith(".md"))
		.filter((f) => !IGNORED.has(f.toLowerCase()) && !f.startsWith("_") && !f.startsWith("."))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Read + validate all fragments. Returns {fragments, errors}. */
export function loadFragments(dir) {
	const fragments = [];
	const errors = [];
	for (const name of listFragments(dir)) {
		const file = join(dir, name);
		const parsed = parseFragment(readFileSync(file, "utf8"));
		if (parsed.error) errors.push({ file, error: parsed.error });
		else fragments.push({ file, name, ...parsed });
	}
	return { fragments, errors };
}

/** Render the version block for a set of valid fragments. */
export function renderBlock(fragments, version, date) {
	const out = [`## [${version}] — ${date}`, ""];
	for (const section of SECTIONS) {
		const inSection = fragments.filter((f) => f.section === section);
		if (inSection.length === 0) continue;
		out.push(`### ${section}`);
		for (const f of inSection) out.push(f.body);
		out.push("");
	}
	return out.join("\n");
}

/** Insert block after the [Unreleased] section (before the first released header). */
export function insertBlock(changelog, block) {
	const lines = changelog.split("\n");
	const unreleased = lines.findIndex((l) => /^## \[Unreleased\]/i.test(l));
	let at = -1;
	for (let i = unreleased + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i])) {
			at = i;
			break;
		}
	}
	if (at === -1) {
		const tail = changelog.endsWith("\n") ? "" : "\n";
		return `${changelog}${tail}\n${block}`;
	}
	return [...lines.slice(0, at), ...block.split("\n"), ...lines.slice(at)].join("\n");
}

function parseArgs(argv) {
	const args = { check: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--check") args.check = true;
		else if (["--version", "--date", "--dir", "--changelog"].includes(a)) {
			if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
			args[a.slice(2)] = argv[++i];
		} else throw new Error(`unknown argument ${a}`);
	}
	return args;
}

export function main(argv, cwd = process.cwd()) {
	let args;
	try {
		args = parseArgs(argv);
	} catch (e) {
		console.error(`changelog-assemble: ${e.message}`);
		return 1;
	}
	const dir = resolve(cwd, args.dir ?? "changelog.d");
	const changelogPath = resolve(cwd, args.changelog ?? "CHANGELOG.md");
	const { fragments, errors } = loadFragments(dir);

	if (errors.length > 0) {
		for (const { file, error } of errors) console.error(`MALFORMED ${file}: ${error}`);
		return 2;
	}
	if (args.check) {
		console.log(`changelog-assemble --check: ${fragments.length} fragment(s) well-formed`);
		return 0;
	}
	if (!args.version) {
		console.error("changelog-assemble: --version <x.y.z> is required (or use --check)");
		return 1;
	}
	if (fragments.length === 0) {
		console.log("changelog-assemble: no fragments, CHANGELOG.md untouched");
		return 0;
	}
	const date = args.date ?? new Date().toISOString().slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		console.error(`changelog-assemble: --date must be YYYY-MM-DD, got ${date}`);
		return 1;
	}
	const current = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n\n## [Unreleased]\n";
	writeFileSync(changelogPath, insertBlock(current, renderBlock(fragments, args.version, date)));
	for (const f of fragments) unlinkSync(f.file);
	console.log(`changelog-assemble: folded ${fragments.length} fragment(s) into ${changelogPath} as [${args.version}]`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
