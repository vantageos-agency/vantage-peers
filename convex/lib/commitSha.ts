/**
 * One commit-identity rule for every writer of `issues.fixCommits`
 * (issues:linkCommit and the auto-link on tasks:complete).
 *
 * A commit SHA is 7-40 hex characters. Two SHAs name the same commit when, trimmed and
 * lowercased, one is a prefix of the other (a short SHA matches a stored full SHA and vice
 * versa) AND both are at least 7 characters. Below 7 characters a value is never a prefix
 * match: "ab" is not the same commit as "abcdef1234567".
 */

export const MIN_COMMIT_SHA_LENGTH = 7;
export const MAX_COMMIT_SHA_LENGTH = 40;

const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

/** Trimmed, lowercased SHA when it is 7-40 hex; null for anything else. */
export function normaliseCommitSha(raw: string): string | null {
	const sha = raw.trim().toLowerCase();
	return COMMIT_SHA.test(sha) ? sha : null;
}

/** True when `a` and `b` name the same commit (see the module comment). */
export function sameCommit(a: string, b: string): boolean {
	const x = a.trim().toLowerCase();
	const y = b.trim().toLowerCase();
	if (x.length === 0 || y.length === 0) return false;
	if (x === y) return true;
	if (x.length < MIN_COMMIT_SHA_LENGTH || y.length < MIN_COMMIT_SHA_LENGTH) return false;
	return x.startsWith(y) || y.startsWith(x);
}

/**
 * `stored` with `incoming` appended, unless `stored` already holds the same commit. Returns
 * the SAME array when nothing is appended (callers may compare by identity). `incoming` must
 * already be a valid SHA (`normaliseCommitSha`); an invalid one is returned unchanged.
 */
export function appendCommit(stored: string[], incoming: string): string[] {
	const sha = normaliseCommitSha(incoming);
	if (sha === null) return stored;
	return stored.some((s) => sameCommit(s, sha)) ? stored : [...stored, sha];
}
