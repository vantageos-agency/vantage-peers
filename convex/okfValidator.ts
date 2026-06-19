/**
 * OKF v0.1 bundle validator (Phase 1 — T2).
 *
 * Validates an OKF v0.1 bundle per the Google Cloud Knowledge Catalog spec §1.5
 * (verbatim in RFC commit 6613610 §3.5). Pure functions, no Convex runtime
 * dependency — safe to unit-test in vitest without convex-test.
 *
 * Rules enforced (RFC §3.5):
 *  1. Frontmatter parsable — every non-reserved `.md` has valid YAML frontmatter
 *  2. `type` field present + non-empty
 *  3. Cross-links resolved — `[text](/path/to/concept.md)` absolute paths must
 *     exist intra-bundle; `vp://...` URIs preserved verbatim (not validated)
 *  4. `index.md` reserved — no frontmatter allowed except root `index.md` which
 *     may have `okf_version: "0.1"` (and OKF-standard metadata)
 *  5. `log.md` reserved — chronological by date ISO 8601, newest first;
 *     no frontmatter
 *  6. Custom field preservation — validator MUST NOT reject documents with
 *     unknown frontmatter fields (extension allowed per spec §1.2)
 *
 * Libraries:
 *  - `gray-matter` — body extraction (matches T1 serializer roundtrip)
 *  - `js-yaml`     — YAML parse with JSON schema (no anchors, no code exec)
 *
 * Note: T1 serializer emits with the `yaml` package; both `yaml` and `js-yaml`
 * produce identical JS objects for OKF-compliant frontmatter (string / number /
 * array / boolean — no anchors, no custom tags).
 *
 * No external OKF parseur tiers was found on npm (searched `okf-parser`,
 * `@googlecloudplatform/okf-parser` — both 404). Per ADR D3 backup is optional;
 * we ship the maison validator only.
 *
 * RFC parent: decisions/okf-bridge-phase-1-rfc-2026-06-18.md (commit 6613610).
 * ADR: decisions/adr-okf-exporter-arch.md (commit 2cd357e).
 */

import matter from "gray-matter";
import yaml from "js-yaml";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface BundleEntry {
	/** Bundle-relative path, e.g. "memories/k176ndcvd.md" or "index.md". */
	path: string;
	/** Full file content including frontmatter delimiters. */
	content: string;
}

export interface BundleEntries {
	entries: BundleEntry[];
}

export type ValidationRule =
	| "MISSING_TYPE"
	| "INVALID_YAML"
	| "BROKEN_CROSSLINK"
	| "FORBIDDEN_FRONTMATTER"
	| "RESERVED_VIOLATION";

export interface ValidationError {
	path: string;
	rule: ValidationRule;
	message: string;
}

export interface ValidationResult {
	pass: boolean;
	errors: ValidationError[];
	validatedCount: number;
	skippedCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

const ROOT_INDEX = "index.md";
const ROOT_LOG = "log.md";

/**
 * Detect whether a file begins with a YAML frontmatter block. gray-matter is
 * permissive (returns empty `data` if no `---` opener), so we sniff manually
 * to distinguish "no frontmatter" from "broken frontmatter".
 */
function hasFrontmatter(content: string): boolean {
	return /^---\r?\n/.test(content);
}

/**
 * Extract all markdown cross-links of the form `[text](path)` where `path`
 * starts with `/` (absolute intra-bundle path) and does NOT use a URI scheme
 * (`vp://`, `http(s)://`, `mailto:` are preserved verbatim per spec §1.5).
 *
 * Returns paths normalised without the leading slash so they can be looked up
 * directly against the bundle's path set.
 */
function extractIntraBundleLinks(body: string): string[] {
	const out: string[] = [];
	const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
	let m: RegExpExecArray | null = linkRe.exec(body);
	while (m !== null) {
		const raw = m[1].trim();
		// Skip URI-scheme links — vp://, http(s)://, mailto:, etc.
		if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && raw.startsWith("/")) {
			// Strip leading slash + drop anchor / query.
			const stripped = raw.replace(/^\/+/, "").split(/[#?]/, 1)[0];
			if (stripped.length > 0) out.push(stripped);
		}
		m = linkRe.exec(body);
	}
	return out;
}

/**
 * Extract ISO 8601 date(time) tokens from text in order of appearance.
 * Used by log.md chronological check (rule 5).
 */
function extractIsoDates(text: string): string[] {
	const out: string[] = [];
	const re =
		/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		out.push(m[0]);
		m = re.exec(text);
	}
	return out;
}

/**
 * Parse the frontmatter block. Pushes INVALID_YAML on failure. Returns the
 * parsed mapping on success, or undefined on failure (caller short-circuits).
 *
 * Uses js-yaml with JSON_SCHEMA (no anchors, no custom tags, no code exec) to
 * stay aligned with what gray-matter+`yaml` produce for OKF-compliant docs.
 */
function parseFrontmatter(
	path: string,
	content: string,
	errors: ValidationError[],
): Record<string, unknown> | undefined {
	const fenceRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
	const m = fenceRe.exec(content);
	if (m === null) {
		errors.push({
			path,
			rule: "INVALID_YAML",
			message: "Frontmatter fence is malformed (missing closing `---`).",
		});
		return undefined;
	}
	try {
		const parsed = yaml.load(m[1], { schema: yaml.JSON_SCHEMA });
		if (parsed === null || parsed === undefined) {
			// Empty frontmatter is treated as an empty mapping; caller will flag
			// MISSING_TYPE on standard entries.
			return {};
		}
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			errors.push({
				path,
				rule: "INVALID_YAML",
				message: "Frontmatter must be a YAML mapping (object).",
			});
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		errors.push({
			path,
			rule: "INVALID_YAML",
			message: `YAML parse error: ${msg}`,
		});
		return undefined;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate one entry. `allPaths` is the set of bundle-relative paths present in
 * the bundle (with no leading slash) used for cross-link resolution (rule 3).
 */
export function validateEntry(
	entry: BundleEntry,
	allPaths: Set<string>,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const { path, content } = entry;

	// ── Rule 5: log.md reserved (no frontmatter; chronological newest-first) ─
	if (path === ROOT_LOG) {
		if (hasFrontmatter(content)) {
			errors.push({
				path,
				rule: "RESERVED_VIOLATION",
				message: "log.md MUST NOT have YAML frontmatter (spec §1.5).",
			});
		}
		const dates = extractIsoDates(content);
		for (let i = 1; i < dates.length; i++) {
			// Lexicographic compare is correct for ISO 8601 (RFC 3339) strings.
			if (dates[i] > dates[i - 1]) {
				errors.push({
					path,
					rule: "RESERVED_VIOLATION",
					message:
						"log.md entries MUST be chronological newest-first (ISO 8601).",
				});
				break;
			}
		}
		return errors;
	}

	// ── Rule 4: index.md reserved ──────────────────────────────────────────
	// Root index.md MAY carry frontmatter (e.g. `okf_version: "0.1"`).
	// Nested `*/index.md` MUST NOT carry frontmatter.
	if (path === ROOT_INDEX) {
		if (hasFrontmatter(content)) {
			const parsed = parseFrontmatter(path, content, errors);
			if (
				parsed !== undefined &&
				parsed.type !== undefined &&
				typeof parsed.type === "string" &&
				parsed.type !== "" &&
				parsed.type !== "index"
			) {
				errors.push({
					path,
					rule: "RESERVED_VIOLATION",
					message: `Root index.md type must be "index", got "${String(parsed.type)}".`,
				});
			}
		}
		return errors;
	}

	if (path.endsWith("/index.md")) {
		if (hasFrontmatter(content)) {
			errors.push({
				path,
				rule: "FORBIDDEN_FRONTMATTER",
				message:
					"Nested index.md files MUST NOT have frontmatter (only root index.md may).",
			});
		}
		return errors;
	}

	// ── Standard markdown entry ────────────────────────────────────────────
	if (!path.endsWith(".md")) {
		// Non-markdown files are out of OKF validation scope.
		return errors;
	}

	if (!hasFrontmatter(content)) {
		errors.push({
			path,
			rule: "INVALID_YAML",
			message: "Missing YAML frontmatter (file must start with `---`).",
		});
		return errors;
	}

	const data = parseFrontmatter(path, content, errors);
	if (data === undefined) return errors;

	// Rule 2: `type` present + non-empty string.
	const t = data.type;
	if (t === undefined || t === null) {
		errors.push({
			path,
			rule: "MISSING_TYPE",
			message: "Required field `type` is missing from frontmatter.",
		});
	} else if (typeof t !== "string" || t.trim() === "") {
		errors.push({
			path,
			rule: "MISSING_TYPE",
			message: "Field `type` must be a non-empty string.",
		});
	}

	// Rule 6 (custom field preservation): no further field whitelist — unknown
	// fields are accepted by construction (we never reject on unknown keys).

	// Rule 3: cross-link resolution (body only).
	const body = matter(content).content ?? "";
	const links = extractIntraBundleLinks(body);
	for (const link of links) {
		if (!allPaths.has(link)) {
			errors.push({
				path,
				rule: "BROKEN_CROSSLINK",
				message: `Cross-link target not found in bundle: /${link}`,
			});
		}
	}

	return errors;
}

/**
 * Validate a whole bundle. Iterates each entry, accumulates errors, and
 * computes pass/fail + counts. Non-`.md` files are skipped (and counted).
 */
export function validateBundle(bundle: BundleEntries): ValidationResult {
	const allPaths = new Set<string>(bundle.entries.map((e) => e.path));
	const errors: ValidationError[] = [];
	let validatedCount = 0;
	let skippedCount = 0;

	for (const entry of bundle.entries) {
		if (!entry.path.endsWith(".md")) {
			skippedCount++;
			continue;
		}
		validatedCount++;
		errors.push(...validateEntry(entry, allPaths));
	}

	return {
		pass: errors.length === 0,
		errors,
		validatedCount,
		skippedCount,
	};
}
