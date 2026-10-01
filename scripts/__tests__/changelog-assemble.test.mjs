import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "../changelog-assemble.mjs");

const BASE_CHANGELOG = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"### Fixed",
	"- legacy unreleased entry",
	"",
	"## [2.18.0] — 2026-08-11",
	"- old release",
	"",
].join("\n");

function sandbox(fragments) {
	const root = mkdtempSync(join(tmpdir(), "changelog-assemble-"));
	mkdirSync(join(root, "changelog.d"));
	writeFileSync(join(root, "CHANGELOG.md"), BASE_CHANGELOG);
	writeFileSync(join(root, "changelog.d", "README.md"), "# not a fragment\n");
	for (const [name, text] of Object.entries(fragments)) writeFileSync(join(root, "changelog.d", name), text);
	return root;
}

function run(root, ...args) {
	return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
}

const frag = (section, body) => `---\nsection: ${section}\n---\n${body}\n`;

describe("changelog-assemble", () => {
	it("folds two fragments in deterministic order (section order, then filename) and deletes them", () => {
		// Created in reverse order on purpose: the output must not depend on readdir/creation order.
		const fragments = {
			"zz-pr-1405.md": frag("Fixed", "- **Z fix.**"),
			"aa-pr-1402.md": frag("Added", "- **A added.**"),
		};
		const outputs = [];
		for (let i = 0; i < 2; i++) {
			const root = sandbox(fragments);
			const r = run(root, "--version", "2.19.0", "--date", "2026-10-01");
			expect(r.status, r.stderr).toBe(0);
			outputs.push(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
			expect(readdirSync(join(root, "changelog.d"))).toEqual(["README.md"]);
		}
		expect(outputs[0]).toBe(outputs[1]);
		const out = outputs[0];
		const iVersion = out.indexOf("## [2.19.0] — 2026-10-01");
		const iAdded = out.indexOf("- **A added.**");
		const iFixed = out.indexOf("- **Z fix.**");
		expect(iVersion).toBeGreaterThan(out.indexOf("- legacy unreleased entry"));
		expect(iVersion).toBeLessThan(iAdded);
		expect(iAdded).toBeLessThan(iFixed);
		expect(iFixed).toBeLessThan(out.indexOf("## [2.18.0]"));
		expect(out).toContain("### Added\n- **A added.**\n\n### Fixed\n- **Z fix.**\n\n## [2.18.0]");
	});

	it("orders two fragments of the same section by filename", () => {
		const root = sandbox({ "b.md": frag("Fixed", "- second"), "a.md": frag("Fixed", "- first") });
		expect(run(root, "--version", "1.0.0", "--date", "2026-10-01").status).toBe(0);
		const out = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		expect(out).toContain("### Fixed\n- first\n- second\n");
	});

	it.each([
		["no-frontmatter.md", "- just a bullet\n", "missing frontmatter"],
		["bad-section.md", frag("Bugfix", "- x"), "unknown section"],
		["empty-body.md", "---\nsection: Added\n---\n\n", "empty body"],
		["no-section-key.md", "---\ntitle: x\n---\n- x\n", "no 'section' key"],
	])("--check exits 2 and names the malformed file (%s)", (name, text, why) => {
		const root = sandbox({ "good.md": frag("Added", "- ok"), [name]: text });
		const r = run(root, "--check");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(name);
		expect(r.stderr).toContain(why);
		expect(r.stderr).not.toContain("good.md");
	});

	it("assemble refuses (exit 2) and writes nothing when any fragment is malformed", () => {
		const root = sandbox({ "good.md": frag("Added", "- ok"), "bad.md": "nope\n" });
		const r = run(root, "--version", "1.0.0", "--date", "2026-10-01");
		expect(r.status).toBe(2);
		expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(BASE_CHANGELOG);
		expect(existsSync(join(root, "changelog.d", "good.md"))).toBe(true);
	});

	it("--check passes (exit 0) on well-formed fragments", () => {
		const root = sandbox({ "a.md": frag("Security", "- s") });
		const r = run(root, "--check");
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("1 fragment(s) well-formed");
	});

	it("is idempotent when there are no fragments: CHANGELOG.md byte-identical, exit 0", () => {
		const root = sandbox({});
		for (let i = 0; i < 2; i++) {
			const r = run(root, "--version", "1.0.0", "--date", "2026-10-01");
			expect(r.status, r.stderr).toBe(0);
			expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(BASE_CHANGELOG);
		}
	});

	it("a second assemble after a successful one is a no-op", () => {
		const root = sandbox({ "a.md": frag("Added", "- once") });
		expect(run(root, "--version", "1.0.0", "--date", "2026-10-01").status).toBe(0);
		const after1 = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		expect(run(root, "--version", "1.0.0", "--date", "2026-10-01").status).toBe(0);
		expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(after1);
		expect(after1.match(/- once/g)).toHaveLength(1);
	});

	it("exits 1 on assemble without --version", () => {
		const root = sandbox({ "a.md": frag("Added", "- x") });
		expect(run(root).status).toBe(1);
	});

	it("the repository's own changelog.d passes --check", () => {
		const repoRoot = resolve(__dirname, "../..");
		const r = run(repoRoot, "--check");
		expect(r.status, r.stderr).toBe(0);
	});
});
