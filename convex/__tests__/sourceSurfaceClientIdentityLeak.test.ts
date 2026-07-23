/**
 * Source-surface client-identity leak guard.
 *
 * PR #1119 follow-up (Eta's third category): the packaged-artifact leak
 * guard (`scripts/leak_guard.py`) and the branch-ref guard
 * (`scripts/guard_git_refs.py`, PR #1099) both already refuse to ship a
 * client identity, but neither one scans this repo's SOURCE
 * description/comment surface directly. A client name in a Convex
 * `description` field or a schema comment is neither a packaged artifact
 * nor a branch name, and slipped through both existing guards -- 8 lines
 * at HEAD d6e43c0, all now redacted (see git history for this file's
 * introducing commit for the exact locations; this docstring
 * deliberately does not restate the redacted names or their file:line
 * addresses, to avoid becoming a second publication of what was just
 * removed).
 *
 * SCOPE: this guard checks the "auth profile perimeter" files --
 * convex/oauth.ts, convex/schema.ts, convex/migrations/**\/*.ts -- plus
 * ITS OWN new source files (this test, and the two `emit_client_*.py`
 * resolver scripts it depends on). A guard that refuses a client name
 * must refuse it inside itself too, or it is blind to its own
 * recurrence -- see PERIMETER_FILES below. It is intentionally narrower
 * than a whole-repo sweep (docs/, mcp-server/, existing tests use
 * client/BU vocabulary pervasively in legitimate, previously reviewed
 * prose -- purging that repo-wide is a distinct, larger class tracked
 * separately, not silently folded into this gate).
 *
 * WHY WHITESPACE-ONLY JOINING (not reusing `emit_client_patterns.py`):
 * the branch-ref guard deliberately treats `-`/`_`/`.`/`/` as
 * word-joiners because a git branch name can never contain a space. This
 * repo's own AUTHORIZATION IDENTIFIERS legitimately spell client
 * identities as a kebab-case slug (e.g. a two-word org name folded into
 * `profileId: "acme-co-hr"` or `namespaceReadPrefixes: ["project/acme-co"]`)
 * -- those are ABSOLUTE DO-NOT-TOUCH constants, not prose, and must never
 * be flagged by this guard. So this guard resolves RAW tokens
 * (`emit_client_tokens.py`) and joins multi-word tokens with WHITESPACE
 * ONLY: natural-language prose can contain a space (a two-word name like
 * "Acme Co"), a kebab-case identifier never legitimately does.
 *
 * FAIL-LOUD contract: "I could not resolve the vocabulary" and "the repo
 * is clean" must NEVER produce the same passing result. If the
 * vocabulary cannot be resolved, this test throws -- it never silently
 * skips or passes green.
 *
 * This test file contains NO client name, anywhere, ever -- the
 * vocabulary is resolved OUTSIDE the repo, from `~/.claude/
 * vantage-client-identities.json` (or `$VANTAGE_CLIENT_IDENTITIES`).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EMIT_TOKENS_SCRIPT = path.join(
	REPO_ROOT,
	"scripts",
	"emit_client_tokens.py",
);

/** The auth-profile perimeter this guard gates -- the surface the 8
 * HEAD-d6e43c0 findings came from, PLUS this guard's own new source
 * files. A guard that documents a client name "as an example" in its own
 * docstring, or in the scripts it shells out to, has become the leak it
 * exists to prevent -- so it must scan itself, not just the files it was
 * written to catch. Widening this list further is a deliberate decision,
 * not something this guard should silently do on its own. */
const PERIMETER_FILES = [
	"convex/oauth.ts",
	"convex/schema.ts",
	"convex/migrations/patch_marie_iris_rh_scope.ts",
	"convex/__tests__/sourceSurfaceClientIdentityLeak.test.ts",
	"scripts/emit_client_tokens.py",
	"scripts/emit_client_patterns.py",
];

const _LEFT_BOUNDARY = "(?<![A-Za-z0-9])";
const _RIGHT_BOUNDARY = "(?![A-Za-z0-9])";

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveClientTokens(env?: NodeJS.ProcessEnv): string[] {
	let stdout: string;
	try {
		stdout = execFileSync("python3", [EMIT_TOKENS_SCRIPT], {
			encoding: "utf-8",
			cwd: REPO_ROOT,
			env: env ?? process.env,
		});
	} catch (err) {
		const detail =
			err && typeof err === "object" && "stderr" in err
				? String((err as { stderr?: unknown }).stderr)
				: String(err);
		throw new Error(
			"CLIENT VOCABULARY UNRESOLVED -- this guard REFUSES to report the " +
				"repo as clean without a resolved vocabulary. " +
				`Underlying failure: ${detail}`,
		);
	}

	let tokens: unknown;
	try {
		tokens = JSON.parse(stdout);
	} catch (err) {
		throw new Error(
			"CLIENT VOCABULARY UNRESOLVED -- emit_client_tokens.py stdout was " +
				`not valid JSON: ${String(err)}. Raw stdout: ${stdout}`,
		);
	}

	if (!Array.isArray(tokens) || tokens.length === 0) {
		throw new Error(
			"CLIENT VOCABULARY UNRESOLVED -- resolved to zero tokens. An empty " +
				"vocabulary must never be reported as a clean repo.",
		);
	}

	for (const token of tokens) {
		if (typeof token !== "string" || token.trim().length === 0) {
			throw new Error(
				`CLIENT VOCABULARY UNRESOLVED -- malformed token entry: ${String(token)}`,
			);
		}
	}

	return tokens as string[];
}

/** Whitespace-only joiner -- see file header for why this diverges from
 * the branch-ref guard's hyphen/underscore/dot/slash joiner. */
function tokenToProsePattern(token: string): RegExp {
	const words = token.trim().split(/\s+/).filter(Boolean);
	const body = words.map(escapeRegExp).join("\\s+");
	return new RegExp(`${_LEFT_BOUNDARY}${body}${_RIGHT_BOUNDARY}`, "i");
}

function resolveClientProsePatterns(env?: NodeJS.ProcessEnv): RegExp[] {
	return resolveClientTokens(env).map(tokenToProsePattern);
}

function scanFileForVocabulary(relPath: string, patterns: RegExp[]): string[] {
	const absPath = path.join(REPO_ROOT, relPath);
	let content: string;
	try {
		content = readFileSync(absPath, "utf-8");
	} catch (err) {
		throw new Error(
			`Perimeter file ${relPath} could not be read: ${String(err)}`,
		);
	}

	const findings: string[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const pattern of patterns) {
			if (pattern.test(line)) {
				findings.push(`${relPath}:${i + 1} matches ${pattern}`);
			}
		}
	}
	return findings;
}

describe("source-surface client-identity leak guard (auth-profile perimeter)", () => {
	it("resolves a non-empty client vocabulary or throws loudly", () => {
		// Establishes the vocabulary really did resolve for the main test
		// below -- a passing "clean" result on an unresolved vocabulary would
		// be the exact false-assurance failure this guard exists to prevent.
		const tokens = resolveClientTokens();
		expect(tokens.length).toBeGreaterThan(0);
	});

	it("finds no client-identity term in the auth-profile perimeter files", () => {
		const patterns = resolveClientProsePatterns();
		const findings: string[] = PERIMETER_FILES.flatMap((relPath) =>
			scanFileForVocabulary(relPath, patterns),
		);

		if (findings.length > 0) {
			throw new Error(
				`${findings.length} client-identity leak(s) found on the auth-profile ` +
					`perimeter:\n${findings.join("\n")}`,
			);
		}
	});

	it("FAIL-LOUD: throws (never passes green) when the vocabulary cannot be resolved", () => {
		const brokenEnv = {
			...process.env,
			VANTAGE_CLIENT_IDENTITIES: "/nonexistent/path/does-not-exist.json",
		};
		expect(() => resolveClientTokens(brokenEnv)).toThrow(
			/CLIENT VOCABULARY UNRESOLVED/,
		);
	});
});
