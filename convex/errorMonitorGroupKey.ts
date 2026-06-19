// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorGroupKey
// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for computing the auto-IRP group key (the dedup primitive).
//
// Day 80 friction → Day 107 root cause:
//   The previous groupKey was `${moduleName}:${errorMessage}` where
//   `errorMessage` was the FULL Convex log line — request IDs, timestamps,
//   hex-encoded argument blobs in the tail. Two errors thrown from the same
//   function path by the same validator code produced different hashes when
//   their tails differed, defeating the dedup. Day 90 cascade #596-#601:
//   5 dup IRPs + 1 distinct from a single root cause.
//
// Fix-pattern reference:
//   m97cw4xf93qxgf3gg1f46fz4eh87xgfp
//   (generator-dedup-gap-on-validator-error-tail-variance)
//
// The new groupKey is a TUPLE (function_path, validator_keyword):
//   - validator_keyword is extracted from the structured part of the error
//     (path + code for ArgumentValidationError, error class name for others)
//   - tail variance (request ID, timestamps, hex args) is collapsed
//   - structural variance (different validator path, different code) is
//     preserved → distinct hashes → distinct IRPs
//
// Public surface:
//   extractValidatorKeyword(errorMessage)  → string
//   computeGroupKey(moduleName, errorMessage) → string
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts a stable "validator keyword" from a raw Convex error message.
 *
 * Extraction strategy (first match wins):
 *
 *   1. ArgumentValidationError with structured `"path": [...]` + `"code": "..."` JSON
 *      snippets → return `argval:<path>:<code>` (path joined by `.`).
 *      Example:
 *        "ArgumentValidationError: ... \"path\": [\"missionId\"] ... \"code\": \"InvalidId\" ..."
 *        → "argval:missionId:InvalidId"
 *      Tail variance (req-IDs, timestamps, hex args) is fully collapsed.
 *
 *   2. ArgumentValidationError WITHOUT parseable path/code → return
 *      `argval:unparsed`. Different ArgValErrors with no structured fields
 *      still group together (rare, observed in malformed log entries).
 *
 *   3. Other Convex-typed errors with a `<Name>Error:` prefix (ConvexError,
 *      ServerError, Uncaught Error, etc.) → return `<className>` (lowercased).
 *      Example: "ServerError: foo bar req=abc123" → "servererror".
 *
 *   4. Fallback for everything else → first 200 chars of the message,
 *      normalised: collapse whitespace, strip request IDs (hex 16-32 chars)
 *      and ISO-timestamp-looking substrings. Preserves enough signal to
 *      group similar messages while dropping high-cardinality tails.
 *
 *   5. Empty / non-string input → return `unknown`.
 *
 * Tail variance collapsed:
 *   - `Request ID: <hex>` — stripped (case 4 normaliser; cases 1-3 don't see it)
 *   - ISO timestamps `2026-06-19T12:34:56.789Z` — stripped (case 4)
 *   - Argument hex blobs `args: 0xdeadbeef...` — never reach the keyword
 *     in cases 1-3 because we only keep the structured path+code
 *
 * Variance preserved (distinct groupKey):
 *   - Different `path` (e.g. `missionId` vs `taskId`)
 *   - Different `code` (e.g. `InvalidId` vs `Missing`)
 *   - Different Convex error class
 *   - Different fallback-normalised first 200 chars
 */
export function extractValidatorKeyword(errorMessage: string): string {
	if (typeof errorMessage !== "string" || errorMessage.length === 0) {
		return "unknown";
	}

	// Case 1+2 — ArgumentValidationError
	if (errorMessage.includes("ArgumentValidationError")) {
		// Try to pull the FIRST "path": [...] occurrence + FIRST "code": "..."
		// occurrence. We tolerate Convex's pretty-printed JSON snippets where
		// path elements may be quoted strings or bare identifiers separated
		// by commas/whitespace.
		const pathMatch = errorMessage.match(/"path"\s*:\s*\[([^\]]*)\]/);
		const codeMatch = errorMessage.match(/"code"\s*:\s*"([^"]+)"/);

		let pathToken = "";
		if (pathMatch?.[1]) {
			// Strip quotes + whitespace, join with "." to form a stable path
			// like `missionId` or `args.assignedTo.userId`.
			pathToken = pathMatch[1]
				.split(",")
				.map((p) => p.trim().replace(/^"|"$/g, ""))
				.filter((p) => p.length > 0)
				.join(".");
		}

		const codeToken = codeMatch?.[1] ?? "";

		if (pathToken || codeToken) {
			return `argval:${pathToken || "_"}:${codeToken || "_"}`;
		}
		return "argval:unparsed";
	}

	// Case 3 — other Convex-typed error classes (prefix `<Name>Error:`)
	const classMatch = errorMessage.match(/^([A-Z][A-Za-z]*Error)\s*:/);
	if (classMatch?.[1]) {
		return classMatch[1].toLowerCase();
	}

	// Case 4 — fallback: first 200 chars, normalised
	return normaliseFallback(errorMessage).slice(0, 200);
}

/**
 * Normalises a free-form error message for fallback grouping:
 *   - Collapse all whitespace runs to single spaces
 *   - Strip `Request ID: <hex>` clauses
 *   - Strip ISO-8601 timestamps
 *   - Strip standalone long hex runs (≥16 hex chars) — request IDs without label
 *
 * Visible for testing.
 */
export function normaliseFallback(s: string): string {
	return s
		.replace(/Request ID\s*:\s*[0-9a-f]+/gi, "")
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "")
		.replace(/\b[0-9a-f]{16,}\b/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Computes the dedup group key for an error.
 *
 * groupKey = `${moduleName}:${validatorKeyword}` where validatorKeyword
 * comes from extractValidatorKeyword(). If moduleName is empty/falsy, only
 * the keyword is used.
 *
 * This key is then fed to simpleHash() by the caller (errorMonitorActions)
 * to produce the `hash` column stored on errorLogs.
 */
export function computeGroupKey(
	moduleName: string,
	errorMessage: string,
): string {
	const keyword = extractValidatorKeyword(errorMessage);
	if (!moduleName) return keyword;
	return `${moduleName}:${keyword}`;
}
