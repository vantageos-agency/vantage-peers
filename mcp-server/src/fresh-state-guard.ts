/**
 * fresh-state-guard.ts — Layer 2 safety net for stale hand-typed
 * living-artifact state in outbound `send_message` prose.
 *
 * Port of `artifacts/enforce-fresh-state-in-messages.py` (NOT INSTALLED as a
 * Python hook; that file was a local-machine-only hook — this module is the
 * server-side equivalent, invoked unconditionally by every caller of
 * `send_message`, so it binds all orchestrators regardless of which machine
 * they run on).
 *
 * ROOT CAUSE (Day 128 brief): "un état tapé à la main est un mensonge en
 * sursis". Three orchestrators hand-typed a living-artifact state into a
 * message the same day; all three claims went stale between writing and
 * reading. Layer 1 (`state-tokens.ts`, `resolveStateTokens`) fixes this for
 * anyone who explicitly used a `{{pr:...}}` / `{{npm:...}}` / `{{task:...}}`
 * token. This module is the belt over prose that never used a token —
 * free-form hand-typed claims that Layer 1 never saw because they were never
 * marked as tokens.
 *
 * SCOPE (must stay narrow — MUST_PASS class):
 *   Only the `evidence:` field is scanned. `finding:`, `action:`, `next:`,
 *   `nb:`, `note:`, `context:` are where an author NARRATES — including
 *   quoting their own past proofs verbatim, arrows and all:
 *
 *       finding: at the time I gated it, PR #870 (owner/repo) -> OPEN —
 *                that is what I cited, and it was true.
 *
 *   This is exact, lawful and honest. An earlier version of the ported
 *   Python hook scanned the WHOLE body and blocked this exact sentence,
 *   because it heard only the current tree and refused the send. The
 *   docstring of that earlier version also promised this same carve-out on
 *   the theory that past-tense prose says "was" and never "->" — that
 *   theory was FALSE: the arrow IS the proof syntax, and it gets quoted in
 *   past-tense narration constantly, precisely because that is the form the
 *   proof was produced in. Caught by Eta on PR #1094; the fix is SCOPE
 *   (evidence: only), not grammar. This port carries that fix forward from
 *   the start.
 *
 * CLAIM GRAMMARS recognised inside the `evidence:` scope:
 *   1. PR state:  `PR #123 (owner/repo) -> OPEN|MERGED|CLOSED`
 *   2. npm state: `<pkg>@<tag> -> <version>`
 *   3. Task state: `task <k...id> -> todo|in_progress|review|blocked|done`
 *
 * Each recognized claim is RE-VERIFIED live (reusing the same GitHub /
 * npm / Convex resolution as `state-tokens.ts`) at guard time. A
 * contradiction between the typed claim and the live value is a hard
 * refusal — throws `McpError(ErrorCode.InvalidParams, ...)` citing BOTH
 * values and naming the token to use instead. Nothing is sent.
 *
 * FAIL-OPEN ON "CANNOT VERIFY" (deliberate, and DIFFERENT from Layer 1):
 *   Layer 1 is fail-CLOSED — a token the caller explicitly asked to resolve
 *   MUST resolve or the send is aborted. This Layer 2 guard is a safety net
 *   over free-form prose the caller did NOT mark as a live claim. If
 *   GitHub/npm/Convex is unreachable, or the repo/package/task cannot be
 *   determined from the claim text, this guard logs a warning to stderr and
 *   ALLOWS the send. Blocking a legitimate message because a network call
 *   failed would recreate the exact "silence read as good news" failure
 *   this whole doctrine exists to kill — but for an *unmarked* claim (not a
 *   token the author explicitly requested resolved), erring toward
 *   not-blocking is the correct trade-off.
 *
 * OVERRIDE: `// allow-stale-state-claim: <reason, >= 6 chars>` anywhere in
 * the inspected text — reserved for verbatim citation of historical claims,
 * matching the existing hook convention (`enforce-full-ids.py`).
 *
 * WHAT THIS GUARD NEVER TOUCHES: ratios ("788/788"), bare SHAs, unified
 * diffs — no claim grammar, no match. Content with no `evidence:` field, or
 * an `evidence:` field with no recognized claim, passes through unmodified.
 */

import type { StateTokenResolutionDeps } from "./state-tokens.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scope extraction — evidence: field only
// ─────────────────────────────────────────────────────────────────────────────

const EVIDENCE_START_RE = /^\s*evidence\s*:/gim;
const GRID_LABEL_RE = /^\s*(finding|action|next|nb|note|context)\s*:/gim;

/**
 * Return only the `evidence:` block(s) of `content` — the region where a
 * LIVE state is asserted. Returns "" when the message carries no evidence
 * field at all.
 *
 * A message with no `evidence:` field asserts nothing verifiable and is
 * left alone: this net catches over-claiming, not free speech. That it
 * therefore misses a live claim written as ordinary prose ("PR #1092 is
 * already merged") is a REAL and DELIBERATE hole — Layer 1 (state tokens,
 * resolved server-side) is what actually closes the class; this guard is
 * only the belt over prose Layer 1 never saw.
 */
function evidenceScope(content: string): string {
	const out: string[] = [];
	EVIDENCE_START_RE.lastIndex = 0;
	let m: RegExpExecArray | null = EVIDENCE_START_RE.exec(content);
	while (m !== null) {
		const start = m.index;
		GRID_LABEL_RE.lastIndex = m.index + m[0].length;
		const nxt = GRID_LABEL_RE.exec(content);
		out.push(content.slice(start, nxt ? nxt.index : content.length));
		EVIDENCE_START_RE.lastIndex = m.index + m[0].length;
		m = EVIDENCE_START_RE.exec(content);
	}
	return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Override marker
// ─────────────────────────────────────────────────────────────────────────────

const OVERRIDE_RE = /\/\/\s*allow-stale-state-claim:\s*\S.{5,}/;

// ─────────────────────────────────────────────────────────────────────────────
// Claim grammars
// ─────────────────────────────────────────────────────────────────────────────

const PR_CLAIM_RE =
	/\bPR\s*#(\d+)\s*(?:\(([\w.-]+\/[\w.-]+)\))?\s*->\s*(OPEN|MERGED|CLOSED)\b/g;

const NPM_CLAIM_RE =
	/(@?[\w.-]+(?:\/[\w.-]+)?)@([\w.-]+)\s*->\s*([0-9][\w.+-]*)/g;

const TASK_CLAIM_RE =
	/\btask\s+(k[0-9a-z]{6,32})\s*->\s*(todo|in_progress|review|blocked|done)\b/g;

// ─────────────────────────────────────────────────────────────────────────────
// Guard error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a hand-typed claim in `evidence:` contradicts the live
 * value. `send_message` MUST catch this and abort the send — never send
 * partially, never substitute the live value silently.
 */
export class FreshStateGuardError extends Error {
	readonly claimKind: "pr" | "npm" | "task";
	readonly ref: string;
	readonly typedValue: string;
	readonly liveValue: string;

	constructor(
		claimKind: "pr" | "npm" | "task",
		ref: string,
		typedValue: string,
		liveValue: string,
		replacementToken: string,
	) {
		super(
			`hand-typed state claim contradicts live reality — kind: ${claimKind}, ` +
				`ref: ${ref}, typed: ${typedValue}, live: ${liveValue}. ` +
				`Use a state token instead of typing this by hand: ${replacementToken} — ` +
				`it resolves at send time and cannot go stale. If this is a verbatim ` +
				`historical citation, not a live claim: ` +
				`\`// allow-stale-state-claim: <reason>\`.`,
		);
		this.name = "FreshStateGuardError";
		this.claimKind = claimKind;
		this.ref = ref;
		this.typedValue = typedValue;
		this.liveValue = liveValue;
	}
}

export interface FreshStateGuardDeps extends StateTokenResolutionDeps {
	/** Warning sink for "cannot verify, allowing" cases. Defaults to console.warn. */
	warn?: (message: string) => void;
	/** Optional default repo for bare "PR #123 -> OPEN" claims with no (owner/repo). */
	defaultRepo?: string;
	/** Optional Convex query name override for task status lookups (test seam). */
	taskQueryName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind checks
// ─────────────────────────────────────────────────────────────────────────────

async function checkPrClaims(
	text: string,
	deps: FreshStateGuardDeps,
	warn: (message: string) => void,
): Promise<void> {
	PR_CLAIM_RE.lastIndex = 0;
	const matches = [...text.matchAll(PR_CLAIM_RE)];
	for (const m of matches) {
		const [, number, repoInClaim, typedState] = m;
		const repo = repoInClaim ?? deps.defaultRepo;
		if (!repo) {
			warn(
				`PR #${number} claim has no repo (add "(owner/repo)" or set defaultRepo) — cannot verify, allowing.`,
			);
			continue;
		}
		const [owner, name] = repo.split("/");
		const url = `https://api.github.com/repos/${owner}/${name}/pulls/${number}`;
		let res: Response;
		try {
			res = await deps.fetchImpl(url, {
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "vantage-peers-fresh-state-guard",
					...(deps.githubToken
						? { Authorization: `Bearer ${deps.githubToken}` }
						: {}),
				},
			});
		} catch (err) {
			warn(
				`GitHub unreachable for PR #${number} (${err instanceof Error ? err.message : String(err)}) — cannot verify, allowing.`,
			);
			continue;
		}
		if (res.status === 404) {
			warn(`PR #${number} not found on ${repo} — cannot verify claim, allowing.`);
			continue;
		}
		if (!res.ok) {
			warn(
				`GitHub API returned HTTP ${res.status} for PR #${number} — cannot verify, allowing.`,
			);
			continue;
		}
		let body: { state?: string; merged?: boolean };
		try {
			body = (await res.json()) as { state?: string; merged?: boolean };
		} catch (err) {
			warn(
				`GitHub API returned non-JSON for PR #${number} (${err instanceof Error ? err.message : String(err)}) — cannot verify, allowing.`,
			);
			continue;
		}
		const liveState = body.merged
			? "MERGED"
			: body.state === "open"
				? "OPEN"
				: body.state
					? "CLOSED"
					: undefined;
		if (!liveState) {
			warn(`PR #${number} returned no readable state — cannot verify, allowing.`);
			continue;
		}
		if (liveState !== typedState) {
			throw new FreshStateGuardError(
				"pr",
				`${repo}#${number}`,
				typedState,
				liveState,
				`{{pr:${repo}#${number}}}`,
			);
		}
	}
}

async function checkNpmClaims(
	text: string,
	deps: FreshStateGuardDeps,
	warn: (message: string) => void,
): Promise<void> {
	NPM_CLAIM_RE.lastIndex = 0;
	const matches = [...text.matchAll(NPM_CLAIM_RE)];
	for (const m of matches) {
		const [, pkg, tag, typedVersion] = m;
		const url = `https://registry.npmjs.org/${encodeURIComponent(pkg).replace("%40", "@")}`;
		let res: Response;
		try {
			res = await deps.fetchImpl(url);
		} catch (err) {
			warn(
				`npm registry unreachable for ${pkg} (${err instanceof Error ? err.message : String(err)}) — cannot verify, allowing.`,
			);
			continue;
		}
		if (res.status === 404) {
			warn(`npm package ${pkg} not found — cannot verify claim, allowing.`);
			continue;
		}
		if (!res.ok) {
			warn(
				`npm registry returned HTTP ${res.status} for ${pkg} — cannot verify, allowing.`,
			);
			continue;
		}
		let body: { "dist-tags"?: Record<string, string> };
		try {
			body = (await res.json()) as { "dist-tags"?: Record<string, string> };
		} catch (err) {
			warn(
				`npm registry returned non-JSON for ${pkg} (${err instanceof Error ? err.message : String(err)}) — cannot verify, allowing.`,
			);
			continue;
		}
		const distTags = body["dist-tags"] ?? {};
		const liveVersion = distTags[tag];
		if (!liveVersion) {
			warn(`npm dist-tag ${tag} not found for ${pkg} — cannot verify, allowing.`);
			continue;
		}
		if (liveVersion !== typedVersion) {
			throw new FreshStateGuardError(
				"npm",
				`${pkg}@${tag}`,
				typedVersion,
				liveVersion,
				`{{npm:${pkg}@${tag}}}`,
			);
		}
	}
}

async function checkTaskClaims(
	text: string,
	deps: FreshStateGuardDeps,
	warn: (message: string) => void,
): Promise<void> {
	TASK_CLAIM_RE.lastIndex = 0;
	const matches = [...text.matchAll(TASK_CLAIM_RE)];
	for (const m of matches) {
		const [, taskId, typedStatus] = m;
		let task: unknown;
		try {
			task = await deps.convexQuery(deps.taskQueryName ?? "tasks:get", {
				taskId,
			});
		} catch (err) {
			warn(
				`Convex unreachable or invalid id for task ${taskId} (${err instanceof Error ? err.message : String(err)}) — cannot verify, allowing.`,
			);
			continue;
		}
		if (task === null || task === undefined) {
			warn(`task ${taskId} does not exist per Convex — cannot verify claim, allowing.`);
			continue;
		}
		const liveStatus = (task as { status?: unknown }).status;
		if (typeof liveStatus !== "string") {
			warn(`task ${taskId} returned no readable status — cannot verify, allowing.`);
			continue;
		}
		if (liveStatus !== typedStatus) {
			throw new FreshStateGuardError(
				"task",
				taskId,
				typedStatus,
				liveStatus,
				`{{task:${taskId}}}`,
			);
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inspect `content` for hand-typed living-artifact state claims inside the
 * `evidence:` field, re-verify each against the live source, and throw
 * `FreshStateGuardError` on the first contradiction found. Does not mutate
 * `content` — this is a pure guard, not a resolver (see `state-tokens.ts`
 * for the resolver that substitutes values).
 *
 * Allows (returns normally, no throw) when:
 *   - `content` carries no `evidence:` field.
 *   - the `evidence:` field carries no recognized claim grammar.
 *   - the `// allow-stale-state-claim: <reason>` override marker is present
 *     anywhere in `content`.
 *   - a recognized claim's live value cannot be determined (network
 *     unreachable, artifact not found, repo/package/task undeterminable) —
 *     fail-open, a warning is emitted via `deps.warn` (default `console.warn`).
 */
export async function guardFreshState(
	content: string,
	deps: FreshStateGuardDeps,
): Promise<void> {

	if (!content.trim()) return;
	if (OVERRIDE_RE.test(content)) return;

	const warn = deps.warn ?? ((message: string) => console.warn(`[fresh-state-guard] ${message}`));

	const scope = evidenceScope(content);
	if (!scope.trim()) return;

	await checkPrClaims(scope, deps, warn);
	await checkNpmClaims(scope, deps, warn);
	await checkTaskClaims(scope, deps, warn);
}
