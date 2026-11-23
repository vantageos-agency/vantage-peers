import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side DOC-REF gate on task creation.
//
// A task of a project that has a bible repository must cite that bible, at a
// commit, in a `DOC-REF:` line:
//
//   DOC-REF: <owner>/<repo> @ <sha 7-40 hex> <path> §<section>
//
// <owner>/<repo> must equal the repository mapped to the project in the
// `githubRepoMapping` table (active fleet rows flagged `bible`). The mapping is DATA (doctrine:
// no-hardcoded-business-knowledge); this module carries the mechanism only.
//
// Three outcomes, never two:
//   - "accepted":  a mapped project, a valid DOC-REF line naming the mapped repo.
//   - "exempt":    the title opens with an authorization token or [REVIEW]
//                  (optionally after [META] / [ADMIN]): those tasks open no build.
//   - "abstained": the project has no mapping row; the gate does not apply.
// A mapped project without a valid line is refused with DOC_REF_REQUIRED.
// ─────────────────────────────────────────────────────────────────────────────

export type DocRefGateOutcome =
	| { outcome: "accepted" }
	| { outcome: "exempt" }
	| { outcome: "abstained"; project: string };

// `[META]` / `[ADMIN]` prefixes are skipped, then the title must open with an
// authorization token (`[PR-MERGE-AUTHORIZED]`, `[PROD-DEPLOY-AUTHORIZED]`, ...)
// or `[REVIEW]`.
const EXEMPT_TITLE_RE =
	/^\s*(?:\[(?:META|ADMIN)\]\s*)*\[(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-AUTHORIZED|REVIEW)\]/;

// One DOC-REF line: owner/repo @ sha path §section. Case-insensitive on the
// label and the sha; the repo comparison is case-insensitive too (GitHub is).
const DOC_REF_LINE_RE =
	/^[ \t]*DOC-REF:[ \t]*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)[ \t]*@[ \t]*([0-9a-f]{7,40})[ \t]+(\S+)[ \t]+§[ \t]*(\S.*?)[ \t]*$/gim;

export const DOC_REF_EXPECTED_FORM =
	"DOC-REF: <owner>/<repo> @ <sha 7-40 hex> <path> §<section>";

export function isDocRefExemptTitle(title: string): boolean {
	return EXEMPT_TITLE_RE.test(title);
}

/** Every well-formed DOC-REF line of `description`, parsed. Pure. */
export function parseDocRefLines(
	description: string | undefined,
): Array<{ repo: string; sha: string; path: string; section: string }> {
	if (description === undefined) return [];
	const found: Array<{ repo: string; sha: string; path: string; section: string }> = [];
	for (const m of description.matchAll(DOC_REF_LINE_RE)) {
		found.push({
			repo: `${m[1]}/${m[2]}`,
			sha: m[3] as string,
			path: m[4] as string,
			section: m[5] as string,
		});
	}
	return found;
}

/**
 * The bible repos of `project`: the active FLEET rows (no orgId) of
 * githubRepoMapping flagged `bible`. A client org's row never gates, so a
 * member cannot impose a bible on a project it does not own. Empty = the
 * project is unmapped. Reads the per-project index, bounded by BIBLE_SCAN_CAP.
 */
const BIBLE_SCAN_CAP = 50;
export async function getBibleReposForProject(
	ctx: QueryCtx | MutationCtx,
	project: string,
): Promise<string[]> {
	const rows = await ctx.db
		.query("githubRepoMapping")
		.withIndex("by_project", (q) => q.eq("project", project))
		.take(BIBLE_SCAN_CAP);
	return rows
		.filter((r) => r.bible === true && r.active && r.orgId === undefined)
		.map((r) => r.repo);
}

/**
 * Judges a task about to be created. Throws ConvexError DOC_REF_REQUIRED on a
 * mapped project whose description carries no valid DOC-REF line naming the
 * mapped bible repo; otherwise returns the outcome so the caller can say
 * which of the three it was.
 */
export async function enforceDocRefGate(
	ctx: QueryCtx | MutationCtx,
	task: { project: string; title: string; description: string | undefined },
): Promise<DocRefGateOutcome> {
	if (isDocRefExemptTitle(task.title)) return { outcome: "exempt" };
	const bibleRepos = await getBibleReposForProject(ctx, task.project);
	if (bibleRepos.length === 0) return { outcome: "abstained", project: task.project };
	const wanted = new Set(bibleRepos.map((r) => r.toLowerCase()));
	const lines = parseDocRefLines(task.description);
	if (lines.some((l) => wanted.has(l.repo.toLowerCase()))) {
		return { outcome: "accepted" };
	}
	throw new ConvexError(
		`DOC_REF_REQUIRED: a task of project "${task.project}" must cite that project's bible repository at a commit, in a line of the form \`${DOC_REF_EXPECTED_FORM}\` with <owner>/<repo> = ${bibleRepos.join(" or ")} — ${JSON.stringify({
			field: "description",
			door: "tasks:create",
			project: task.project,
			expectedRepos: bibleRepos,
			expectedForm: DOC_REF_EXPECTED_FORM,
			docRefLinesFound: lines.length,
		})}`,
	);
}
