/**
 * The ONE source of the build identity this process serves under.
 *
 * RAILWAY_GIT_COMMIT_SHA is set by Railway's build system at build time, never
 * hand-typed. Without it (local dev, stdio on an operator's machine) the value
 * is the honest string "unknown", never a value shaped like a SHA: a
 * placeholder indistinguishable from a real commit would defeat the field.
 *
 * Read at call time, not at import, so /health and initialize's serverInfo
 * (mcp-doctor rule C25) always report the same value from the same read path.
 */
export const UNKNOWN_COMMIT = "unknown";

export function buildCommit(): string {
	return process.env.RAILWAY_GIT_COMMIT_SHA || UNKNOWN_COMMIT;
}
