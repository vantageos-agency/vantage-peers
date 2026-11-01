/**
 * mcp-server/test/release-notes-name-readme-sections.test.ts
 *
 * The package release notes and the package README travel together
 * (task k17c08t4w70dgw21gp0qq0d07s8hczg9).
 *
 * `mcp-server/CHANGELOG.md` and `mcp-server/README.md` both ship in the npm
 * tarball (`files` in package.json). A release used to bump the version and
 * list its changes in the CHANGELOG while the README kept describing the
 * previous behaviour (for example the default agent-identity mode). This test
 * makes the mapping between the two explicit and checkable:
 *
 *   1. The CHANGELOG has a `## [<package.json version>]` section, and its
 *      `## [Unreleased]` section carries no entry (the release absorbed them).
 *   2. Every top-level entry of that section names at least one README
 *      section through a link `(README.md#<anchor>)`.
 *   3. Every named anchor is the GitHub slug of a README heading.
 *   4. Every named README section states which product it applies to, on its
 *      own line, before its first sub-heading:
 *      `_Applies to: Cloud._`, `_Applies to: Self-host._` or
 *      `_Applies to: Cloud and Self-host._`
 *   5. The README's release notes carry a heading for that version.
 *
 * Pure file reads: no build, no network.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
	version: string;
};
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

const APPLIES_TO_RE =
	/^_Applies to: (Cloud|Self-host|Cloud and Self-host)\._$/m;
const README_LINK_RE = /\]\(README\.md#([a-z0-9-]+)\)/g;

/** GitHub heading slug: lower-case, drop punctuation except `-`, spaces to `-`. */
function githubSlug(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s/g, "-");
}

interface Heading {
	level: number;
	text: string;
	slug: string;
	/** Body from the line after the heading to the next heading of ANY level. */
	ownBody: string;
}

/** Headings outside fenced code blocks, with GitHub's duplicate suffixes. */
function readmeHeadings(text: string): Heading[] {
	const lines = text.split("\n");
	const found: { level: number; text: string; line: number }[] = [];
	let inFence = false;
	lines.forEach((line, i) => {
		if (/^```/.test(line)) inFence = !inFence;
		if (inFence) return;
		const m = /^(#{1,6})\s+(.*)$/.exec(line);
		if (m) found.push({ level: m[1].length, text: m[2], line: i });
	});
	const seen = new Map<string, number>();
	return found.map((h, idx) => {
		const base = githubSlug(h.text);
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		const end = idx + 1 < found.length ? found[idx + 1].line : lines.length;
		return {
			level: h.level,
			text: h.text,
			slug: n === 0 ? base : `${base}-${n}`,
			ownBody: lines.slice(h.line + 1, end).join("\n"),
		};
	});
}

/** The body of `## [<version>]` up to the next `## ` heading, or null. */
function versionSection(text: string, version: string): string | null {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
	if (start === -1) return null;
	const rel = lines.slice(start + 1).findIndex((l) => l.startsWith("## "));
	const end = rel === -1 ? lines.length : start + 1 + rel;
	return lines.slice(start + 1, end).join("\n");
}

/** Top-level `- ` entries of a section, each joined with its continuation lines. */
function topLevelEntries(section: string): string[] {
	const entries: string[] = [];
	for (const line of section.split("\n")) {
		if (line.startsWith("- ")) entries.push(line);
		else if (entries.length > 0 && /^\s+\S/.test(line))
			entries[entries.length - 1] += `\n${line}`;
	}
	return entries;
}

const headings = readmeHeadings(readme);
const bySlug = new Map(headings.map((h) => [h.slug, h]));
const section = versionSection(changelog, pkg.version);
const entries = section === null ? [] : topLevelEntries(section);

describe(`release notes of vantage-peers-mcp ${pkg.version} name README sections`, () => {
	it(`CHANGELOG.md has a [${pkg.version}] section with entries`, () => {
		expect(
			section,
			`no "## [${pkg.version}]" heading in mcp-server/CHANGELOG.md`,
		).not.toBeNull();
		expect(entries.length).toBeGreaterThan(0);
	});

	it("the [Unreleased] section carries no entry once the version is cut", () => {
		const unreleased = versionSection(changelog, "Unreleased") ?? "";
		expect(topLevelEntries(unreleased)).toEqual([]);
	});

	it("every entry links at least one README section", () => {
		const unlinked = entries.filter(
			(e) => [...e.matchAll(README_LINK_RE)].length === 0,
		);
		expect(unlinked.map((e) => e.slice(0, 100))).toEqual([]);
	});

	it("every linked anchor is a README heading", () => {
		const missing = entries.flatMap((e) =>
			[...e.matchAll(README_LINK_RE)]
				.map((m) => m[1])
				.filter((slug) => !bySlug.has(slug)),
		);
		expect(missing).toEqual([]);
	});

	it("every linked README section states Cloud, Self-host or both", () => {
		const slugs = new Set(
			entries.flatMap((e) => [...e.matchAll(README_LINK_RE)].map((m) => m[1])),
		);
		const unlabelled = [...slugs].filter((slug) => {
			const h = bySlug.get(slug);
			return h !== undefined && !APPLIES_TO_RE.test(h.ownBody);
		});
		expect(unlabelled).toEqual([]);
	});

	it(`the README release notes carry a ${pkg.version} heading`, () => {
		expect(
			headings.some((h) => h.level === 3 && h.text.trim() === pkg.version),
		).toBe(true);
	});
});

describe("the mapping helpers", () => {
	it("slugs headings the way GitHub does", () => {
		expect(githubSlug("Connect to VantagePeers Cloud")).toBe(
			"connect-to-vantagepeers-cloud",
		);
		expect(githubSlug("Knowledge bundles (OKF) (2)")).toBe(
			"knowledge-bundles-okf-2",
		);
		expect(githubSlug("Self-host (a separate product)")).toBe(
			"self-host-a-separate-product",
		);
	});

	it("an entry without a README link is reported, one with a link is not", () => {
		const s =
			"\n### Added\n\n- linked ([X](README.md#tools)).\n- bare entry.\n";
		const got = topLevelEntries(s).filter(
			(e) => [...e.matchAll(README_LINK_RE)].length === 0,
		);
		expect(got).toEqual(["- bare entry."]);
	});

	it("a section whose own body lacks the label line is unlabelled", () => {
		const hs = readmeHeadings(
			"## A\n\n_Applies to: Cloud._\n\n## B\n\ntext\n\n### C\n\n_Applies to: Cloud._\n",
		);
		expect(hs.map((h) => [h.slug, APPLIES_TO_RE.test(h.ownBody)])).toEqual([
			["a", true],
			["b", false],
			["c", true],
		]);
	});
});
