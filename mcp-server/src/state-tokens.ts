/**
 * State tokens — server-side resolution of "living artifact" state at
 * send_message time.
 *
 * ROOT CAUSE (Day 128 brief, VP task from Sigma):
 * Orchestrators hand-type living-artifact state into `send_message` prose
 * ("PR #54 -> OPEN", "latest 0.4.6-alpha", "task k17... todo"). That state
 * is read at the START of composing a long message and can be stale by the
 * time the message is actually sent — a hand-typed state is a lie in
 * waiting.
 *
 * FIX: callers write a REFERENCE token (`{{pr:owner/repo#123}}`,
 * `{{npm:pkg}}` / `{{npm:pkg@tag}}`, `{{task:taskId}}`) instead of a typed
 * value. `resolveStateTokens` is called by `send_message` at the instant the
 * message is dispatched, resolves the token against the live source
 * (GitHub API / npm registry / Convex `tasks:get`), and substitutes the
 * resolved value **plus the resolution instant** — a value without a
 * timestamp is a proof that silently expires.
 *
 * FAIL-CLOSED CONTRACT (non-negotiable — see brief):
 *   - Any token that cannot be resolved (network unreachable, artifact does
 *     not exist, malformed reference) makes `resolveStateTokens` REJECT.
 *     The caller (send_message) MUST NOT fall back to the literal token
 *     text, a cache, or an empty string, and MUST NOT send the message.
 *   - Content with ZERO tokens passes through completely unchanged — this
 *     module never touches ratios, SHAs, diffs, or past-tense prose.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type StateTokenKind = "pr" | "npm" | "task";

export interface StateTokenResolutionDeps {
	/** Injectable fetch implementation (tests stub this; prod uses global fetch). */
	fetchImpl: typeof fetch;
	/** Injectable Convex query caller — mirrors `convex.query(name, args)`. */
	convexQuery: (
		name: string,
		args: Record<string, unknown>,
	) => Promise<unknown>;
	/** Injectable clock so the resolution instant is deterministic in tests. */
	now: () => Date;
	/** Optional GitHub token for higher rate limits / private repos. */
	githubToken?: string;
}

/**
 * Thrown when a token cannot be resolved. `resolveStateTokens` never
 * swallows this — it always propagates to the caller, which must abort the
 * send rather than substitute a silent fallback.
 */
export class StateTokenError extends Error {
	readonly tokenKind: StateTokenKind;
	readonly tokenRef: string;

	constructor(tokenKind: StateTokenKind, tokenRef: string, message: string) {
		super(`state token {{${tokenKind}:${tokenRef}}} unresolved: ${message}`);
		this.name = "StateTokenError";
		this.tokenKind = tokenKind;
		this.tokenRef = tokenRef;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Token grammar — {{kind:ref}}, kind in {pr, npm, task}
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_RE = /\{\{(pr|npm|task):([^}]+)\}\}/g;

/** True if `content` contains at least one recognized state token. */
export function hasStateTokens(content: string): boolean {
	TOKEN_RE.lastIndex = 0;
	return TOKEN_RE.test(content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve every `{{kind:ref}}` token in `content` against its live source
 * and return the content with each token replaced by
 * `"<resolved value> [resolved <ISO-8601 instant>]"`.
 *
 * Content with no tokens is returned byte-for-byte unchanged (MUST_PASS
 * contract — no false positives on ratios/SHAs/diffs/prose).
 *
 * Rejects (throws `StateTokenError`) on the first unresolved token —
 * fail-closed, never a silent fallback.
 */
export async function resolveStateTokens(
	content: string,
	deps: StateTokenResolutionDeps,
): Promise<string> {
	TOKEN_RE.lastIndex = 0;
	const matches = [...content.matchAll(TOKEN_RE)];
	if (matches.length === 0) return content;

	let result = content;
	for (const match of matches) {
		const [full, kindRaw, ref] = match;
		const kind = kindRaw as StateTokenKind;
		const replacement = await resolveOneToken(kind, ref, deps);
		result = result.split(full).join(replacement);
	}
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind resolvers
// ─────────────────────────────────────────────────────────────────────────────

async function resolveOneToken(
	kind: StateTokenKind,
	ref: string,
	deps: StateTokenResolutionDeps,
): Promise<string> {
	switch (kind) {
		case "pr":
			return resolvePr(ref, deps);
		case "npm":
			return resolveNpm(ref, deps);
		case "task":
			return resolveTask(ref, deps);
		default: {
			const _exhaustive: never = kind;
			throw new StateTokenError(
				kind,
				ref,
				`unknown token kind (${_exhaustive})`,
			);
		}
	}
}

const PR_REF_RE = /^([^/\s]+)\/([^#\s]+)#(\d+)$/;

async function resolvePr(
	ref: string,
	deps: StateTokenResolutionDeps,
): Promise<string> {
	const m = PR_REF_RE.exec(ref);
	if (!m) {
		throw new StateTokenError(
			"pr",
			ref,
			`malformed reference, expected "owner/repo#number"`,
		);
	}
	const [, owner, repo, numberStr] = m;
	const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${numberStr}`;

	let res: Response;
	try {
		res = await deps.fetchImpl(url, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "vantage-peers-mcp-state-tokens",
				...(deps.githubToken
					? { Authorization: `Bearer ${deps.githubToken}` }
					: {}),
			},
		});
	} catch (err) {
		throw new StateTokenError(
			"pr",
			ref,
			`GitHub unreachable — ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (res.status === 404) {
		throw new StateTokenError(
			"pr",
			ref,
			`PR not found (owner/repo#number invalid)`,
		);
	}
	if (!res.ok) {
		throw new StateTokenError(
			"pr",
			ref,
			`GitHub API returned HTTP ${res.status}`,
		);
	}

	const body = (await res.json()) as {
		state?: string;
		merged?: boolean;
		merge_commit_sha?: string | null;
		head?: { sha?: string };
		mergeable_state?: string;
	};

	const stateLabel = body.merged
		? "MERGED"
		: body.state === "open"
			? "OPEN"
			: "CLOSED";
	const sha = body.merge_commit_sha ?? body.head?.sha ?? "unknown-sha";
	const mergeStateStatus = body.mergeable_state ?? "unknown";

	return (
		`PR #${numberStr} (${owner}/${repo}) -> ${stateLabel} ` +
		`@ ${sha} mergeStateStatus=${mergeStateStatus} ` +
		`[resolved ${deps.now().toISOString()}]`
	);
}

// Scoped packages start with "@scope/name" — the leading "@" must not be
// mistaken for the "@tag" suffix separator, so scope and tag are matched
// with distinct groups.
const NPM_REF_RE = /^(@[^/\s@]+\/[^@\s]+|[^@\s]+)(?:@([^\s]+))?$/;

async function resolveNpm(
	ref: string,
	deps: StateTokenResolutionDeps,
): Promise<string> {
	const m = NPM_REF_RE.exec(ref);
	if (!m) {
		throw new StateTokenError(
			"npm",
			ref,
			`malformed reference, expected "package" or "package@tag"`,
		);
	}
	const [, pkgName, tagRaw] = m;
	const tag = tagRaw ?? "latest";
	const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName).replace(
		"%40",
		"@",
	)}`;

	let res: Response;
	try {
		res = await deps.fetchImpl(url);
	} catch (err) {
		throw new StateTokenError(
			"npm",
			ref,
			`npm registry unreachable — ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (res.status === 404) {
		throw new StateTokenError(
			"npm",
			ref,
			`package "${pkgName}" not found in registry`,
		);
	}
	if (!res.ok) {
		throw new StateTokenError(
			"npm",
			ref,
			`npm registry returned HTTP ${res.status}`,
		);
	}

	const body = (await res.json()) as { "dist-tags"?: Record<string, string> };
	const distTags = body["dist-tags"] ?? {};
	const version = distTags[tag];
	if (!version) {
		throw new StateTokenError(
			"npm",
			ref,
			`dist-tag "${tag}" not found for package "${pkgName}"`,
		);
	}

	return `${pkgName}@${tag} -> ${version} [resolved ${deps.now().toISOString()}]`;
}

async function resolveTask(
	ref: string,
	deps: StateTokenResolutionDeps,
): Promise<string> {
	const taskId = ref.trim();
	if (!taskId) {
		throw new StateTokenError("task", ref, `empty task id`);
	}

	let task: unknown;
	try {
		task = await deps.convexQuery("tasks:get", { taskId });
	} catch (err) {
		throw new StateTokenError(
			"task",
			ref,
			`Convex unreachable or invalid id — ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	if (task === null || task === undefined) {
		throw new StateTokenError("task", ref, `task "${taskId}" does not exist`);
	}

	const status = (task as { status?: unknown }).status;
	if (typeof status !== "string") {
		throw new StateTokenError(
			"task",
			ref,
			`task "${taskId}" returned no readable status`,
		);
	}

	return `task ${taskId} -> ${status} [resolved ${deps.now().toISOString()}]`;
}
