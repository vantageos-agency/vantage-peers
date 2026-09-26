/// <reference types="vite/client" />
/**
 * publicMutationAuthGuard.test.ts — a source-tree-derived guard, in the
 * spirit of mcp-server/test/tool-exposure.test.ts's registration-point
 * interception: it walks every non-test .ts file under convex/ (excluding
 * _generated/ and __tests__/), finds every exported PUBLIC `mutation(...)`
 * (never `internalMutation`), and asserts its handler derives the caller's
 * identity/scope — via a call to `ctx.auth.getUserIdentity`, an
 * identity/scope helper actually defined in convex/lib/auth.ts or
 * convex/tasks.ts (derived from those two files, never hand-maintained), or
 * an explicit `// public-mutation: <reason>` allow-marker in or directly
 * above the export.
 *
 * This test does not FIX any mutation. It is a ratchet: known, classified
 * offenders are listed in KNOWN_OFFENDERS below — see
 * memoriesWriteScope.test.ts (the memories.ts fix) and
 * messagesWriteScope.test.ts (the messages.ts markAsRead/deleteMessage fix)
 * for the entries this ratchet has already resolved. The test fails if:
 *   - a NEW offender appears (an unguarded, unmarked public mutation not in
 *     KNOWN_OFFENDERS), or
 *   - a KNOWN offender becomes guarded/marked without being removed from
 *     KNOWN_OFFENDERS (the ratchet must tighten, never silently loosen).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const CONVEX_DIR = join(__dirname, "..");
const REPO_ROOT = join(CONVEX_DIR, "..");

// ─────────────────────────────────────────────────────────────────────────────
// 1. Source file discovery — every non-test .ts file under convex/, minus
//    _generated/ and __tests__/.
// ─────────────────────────────────────────────────────────────────────────────

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (["_generated", "__tests__", "node_modules"].includes(entry.name)) continue;
			out.push(...listSourceFiles(full));
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".d.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

type ParsedFile = { path: string; rel: string; sf: ts.SourceFile; text: string };

function parseAll(dir: string): ParsedFile[] {
	return listSourceFiles(dir).map((path) => {
		const text = readFileSync(path, "utf-8");
		return {
			path,
			rel: relative(REPO_ROOT, path),
			text,
			sf: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Helper set — SEEDED from convex/lib/auth.ts and convex/tasks.ts (the
//    two files the brief names as the canonical identity/scope helper
//    modules — withOrgScope, requireOrgAdmin, requireAgentCredentialMatch,
//    requireScope, requireAuthenticatedCaller), then GROWN by a fixed point
//    over the WHOLE convex/ tree: a function (exported or module-local, in
//    ANY scanned file) qualifies as an identity/scope helper if its body
//    calls `ctx.auth.getUserIdentity` directly, or calls another
//    already-recognised helper. Restricting the seed to lib/auth.ts +
//    tasks.ts keeps the canonical set derived from those two files "not by
//    hand"; growing the fixed point across the tree (not just those two
//    files) is required so a real, file-local auth helper — e.g.
//    memoriesScoped.ts's resolveOrgId, which itself calls
//    ctx.auth.getUserIdentity — is recognised as guarding the mutation that
//    calls it, per classification (a) in the brief ("guarded through a
//    helper the scanner missed -> extend the derived helper set").
// ─────────────────────────────────────────────────────────────────────────────

type NamedFn = { name: string; body: ts.Node };

function namedFunctionsIn(sf: ts.SourceFile): NamedFn[] {
	const out: NamedFn[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isFunctionDeclaration(node) && node.name && node.body) {
			out.push({ name: node.name.text, body: node.body });
		} else if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
			node.initializer.body
		) {
			out.push({ name: node.name.text, body: node.initializer.body });
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

// True if `node`'s subtree contains a call whose callee is a property access
// chain ending in `.auth.getUserIdentity` (covers `ctx.auth.getUserIdentity`
// and any other locally-named ctx parameter).
function callsGetUserIdentity(node: ts.Node): boolean {
	let found = false;
	const visit = (n: ts.Node) => {
		if (found) return;
		if (
			ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			n.expression.name.text === "getUserIdentity"
		) {
			found = true;
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

// True if `node`'s subtree references the BEARER_SECRET_MASTER identifier —
// the fleet's shared master-credential env var (see this repo's CLAUDE.md /
// vitest.config.ts). A function that reads this value to gate a caller (the
// requireMasterAuth pattern duplicated file-locally in convex/oauth.ts,
// convex/licenses.ts, convex/oauthMigrations.ts — each does a constant-time
// compare of a caller-supplied token against it) is a real, deliberate
// identity-verification helper the ctx.auth.getUserIdentity-only seed
// otherwise misses (classification (a) in the brief: "guarded through a
// helper the scanner missed -> extend the derived helper set").
function referencesMasterSecretEnvVar(node: ts.Node): boolean {
	let found = false;
	const visit = (n: ts.Node) => {
		if (found) return;
		if (ts.isIdentifier(n) && n.text === "BEARER_SECRET_MASTER") {
			found = true;
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

// True if `node`'s subtree contains a call to any identifier in `known`.
function callsKnownHelper(node: ts.Node, known: Set<string>): boolean {
	let found = false;
	const visit = (n: ts.Node) => {
		if (found) return;
		if (
			ts.isCallExpression(n) &&
			ts.isIdentifier(n.expression) &&
			known.has(n.expression.text)
		) {
			found = true;
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

function deriveAuthHelperNames(allFiles: ParsedFile[]): Set<string> {
	const allFns = allFiles.flatMap((pf) => namedFunctionsIn(pf.sf));
	const known = new Set<string>();

	// Seed: any function ANYWHERE in the tree whose body calls
	// ctx.auth.getUserIdentity directly — includes convex/lib/auth.ts's
	// withOrgScope/requireOrgAdmin, convex/tasks.ts's
	// requireAuthenticatedCaller, and any other file-local helper (e.g.
	// memoriesScoped.ts's resolveOrgId) built the same way.
	//
	// Second seed: any function that reads BEARER_SECRET_MASTER to gate a
	// caller (the requireMasterAuth pattern — see referencesMasterSecretEnvVar
	// above). A shared-secret master-token compare is a distinct but equally
	// real identity-verification mechanism from ctx.auth.getUserIdentity.
	for (const fn of allFns) {
		if (callsGetUserIdentity(fn.body) || referencesMasterSecretEnvVar(fn.body)) {
			known.add(fn.name);
		}
	}

	// Fixed point: grow while any function calls an already-known helper —
	// e.g. requireAuthenticatedCaller (tasks.ts) calling withOrgScope
	// (lib/auth.ts) is picked up without hand-listing either name.
	let grew = true;
	while (grew) {
		grew = false;
		for (const fn of allFns) {
			if (!known.has(fn.name) && callsKnownHelper(fn.body, known)) {
				known.add(fn.name);
				grew = true;
			}
		}
	}

	return known;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Public-mutation discovery — `export const NAME = mutation({ ... })`
//    where `mutation` is imported from "./_generated/server" in that file
//    (never internalMutation, never a same-named local shadowing it).
// ─────────────────────────────────────────────────────────────────────────────

type PublicMutation = {
	file: string;
	name: string;
	line: number;
	callExpr: ts.CallExpression;
	exportNode: ts.Node;
};

function importsMutationFromGeneratedServer(sf: ts.SourceFile): boolean {
	let found = false;
	const visit = (n: ts.Node) => {
		if (found) return;
		if (
			ts.isImportDeclaration(n) &&
			ts.isStringLiteral(n.moduleSpecifier) &&
			n.moduleSpecifier.text === "./_generated/server" &&
			n.importClause?.namedBindings &&
			ts.isNamedImports(n.importClause.namedBindings)
		) {
			for (const el of n.importClause.namedBindings.elements) {
				if (el.name.text === "mutation") {
					found = true;
					return;
				}
			}
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return found;
}

function findPublicMutations(pf: ParsedFile): PublicMutation[] {
	if (!importsMutationFromGeneratedServer(pf.sf)) return [];
	const out: PublicMutation[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isVariableStatement(node) &&
			node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
		) {
			for (const decl of node.declarationList.declarations) {
				if (
					ts.isIdentifier(decl.name) &&
					decl.initializer &&
					ts.isCallExpression(decl.initializer) &&
					ts.isIdentifier(decl.initializer.expression) &&
					decl.initializer.expression.text === "mutation"
				) {
					const line =
						pf.sf.getLineAndCharacterOfPosition(decl.getStart(pf.sf)).line + 1;
					out.push({
						file: pf.rel,
						name: decl.name.text,
						line,
						callExpr: decl.initializer,
						exportNode: node,
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(pf.sf);
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Guard classification for one public mutation.
// ─────────────────────────────────────────────────────────────────────────────

function handlerBodyOf(callExpr: ts.CallExpression): ts.Node | null {
	const [arg] = callExpr.arguments;
	if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
	for (const prop of arg.properties) {
		if (
			ts.isPropertyAssignment(prop) &&
			ts.isIdentifier(prop.name) &&
			prop.name.text === "handler" &&
			(ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))
		) {
			return prop.initializer.body;
		}
	}
	return null;
}

function isGuardedByHelperCall(body: ts.Node, helperNames: Set<string>): boolean {
	if (callsGetUserIdentity(body)) return true;
	return callsKnownHelper(body, helperNames);
}

// Allow-marker: `// public-mutation: <reason>` anywhere inside the export
// statement's leading comments, or inside the mutation() call's own leading
// comments (covers both "directly above the export" and "inside" placements
// the brief asks for).
const ALLOW_MARKER_RE = /\/\/\s*public-mutation:\s*(.+)/;

function allowMarkerReason(pf: ParsedFile, pm: PublicMutation): string | null {
	const ranges = [
		...(ts.getLeadingCommentRanges(pf.text, pm.exportNode.getFullStart()) ?? []),
		...(ts.getLeadingCommentRanges(pf.text, pm.callExpr.getFullStart()) ?? []),
	];
	for (const r of ranges) {
		const text = pf.text.slice(r.pos, r.end);
		const m = text.match(ALLOW_MARKER_RE);
		if (m) return m[1].trim();
	}
	// Also accept the marker anywhere inside the mutation()'s own source span
	// (a comment on a line inside the args object, e.g. above `handler:`).
	const inner = pf.text.slice(pm.callExpr.getStart(pf.sf), pm.callExpr.getEnd());
	const m = inner.match(ALLOW_MARKER_RE);
	return m ? m[1].trim() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Run the scan.
// ─────────────────────────────────────────────────────────────────────────────

type Classified = {
	file: string;
	name: string;
	line: number;
	status: "guarded" | "allow-marked" | "offender";
	reason?: string;
};

function runScan(): Classified[] {
	const parsed = parseAll(CONVEX_DIR);
	const hasAuthTs = parsed.some((p) => p.rel === "convex/lib/auth.ts");
	const hasTasksTs = parsed.some((p) => p.rel === "convex/tasks.ts");
	if (!hasAuthTs || !hasTasksTs) {
		throw new Error(
			"publicMutationAuthGuard: could not locate convex/lib/auth.ts or convex/tasks.ts to derive the helper set from.",
		);
	}
	const helperNames = deriveAuthHelperNames(parsed);

	const results: Classified[] = [];
	for (const pf of parsed) {
		for (const pm of findPublicMutations(pf)) {
			const body = handlerBodyOf(pm.callExpr);
			const marker = allowMarkerReason(pf, pm);
			if (body && isGuardedByHelperCall(body, helperNames)) {
				results.push({ file: pm.file, name: pm.name, line: pm.line, status: "guarded" });
			} else if (marker) {
				results.push({
					file: pm.file,
					name: pm.name,
					line: pm.line,
					status: "allow-marked",
					reason: marker,
				});
			} else {
				results.push({ file: pm.file, name: pm.name, line: pm.line, status: "offender" });
			}
		}
	}
	return results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The ratchet — every offender left un-fixed by this PR, classified.
//    Format: "file:name". A NEW offender not in this list fails the test.
//    A known offender that becomes guarded/marked must be REMOVED from this
//    list in the same PR (the test fails otherwise — tightening only).
// ─────────────────────────────────────────────────────────────────────────────

// Classification notes (file:name -> class):
//   - Every entry below takes NO ctx.auth.getUserIdentity/withOrgScope/
//     master-secret check at all. Several accept an optional/required
//     `callerOrchestrator` STRING ARGUMENT and compare it against a stored
//     field (e.g. briefingNotes.update: `callerOrchestrator === note.createdBy`)
//     — that is a caller-supplied ASSERTION, not a verified identity (the
//     exact defect class .claude/rules/authority-attached-to-anonymous-object.md
//     names), so it does not qualify as guarded.
//   - convex/oauth.ts, convex/licenses.ts, convex/oauthMigrations.ts mutations
//     are NOT in this list — their file-local requireMasterAuth() (constant-time
//     compare against process.env.BEARER_SECRET_MASTER) is recognised by the
//     scanner's second seed criterion (referencesMasterSecretEnvVar), class (a).
//   - convex/messages.ts:markAsRead and convex/messages.ts:deleteMessage are
//     NOT in this list — guarded via withOrgScope +
//     isOrchestratorAllowedForScope, with the pre-existing callerOrchestrator
//     argument kept as a narrowing-only layer on top (never a substitute),
//     class (a). See convex/__tests__/messagesWriteScope.test.ts.
//   - convex/memoriesScoped.ts:storeMemoryScoped is NOT in this list — guarded
//     via its file-local resolveOrgId(), which calls ctx.auth.getUserIdentity,
//     class (a).
//   - convex/briefingNotes.ts:create, convex/briefingNotes.ts:update and
//     convex/briefingNotes.ts:deleteBriefingNote are NOT in this list —
//     guarded via withOrgScope + isOrgAllowedForScope (org-scope owner
//     check on the note's STORED orgId), with the pre-existing
//     callerOrchestrator argument kept as a narrowing-only layer on top
//     (never a substitute), class (a). See
//     convex/__tests__/briefingNotesWriteScope.test.ts.
//   - convex/businessUnits.ts:create, convex/businessUnits.ts:update and
//     convex/businessUnits.ts:remove are NOT in this list — guarded via
//     withOrgScope + isOrchestratorAllowedForScope (org-scope owner check
//     on args.orchestratorId at create, on the row's STORED orchestratorId
//     — and on any reassignment target — at update, and a master-only
//     check mirroring the MCP server's own guardMasterOnly at remove),
//     with the pre-existing callerOrchestrator argument kept as a
//     narrowing-only layer on top (never a substitute), class (a). See
//     convex/publicWriteBoundary.test.ts.
//   - convex/issues.ts:updateStatus, convex/issues.ts:linkCommit,
//     convex/issues.ts:verify, convex/githubRepoMapping.ts:add,
//     convex/githubRepoMapping.ts:remove, convex/errorMonitor.ts:addDeployment
//     and convex/errorMonitor.ts:removeDeployment are NOT in this list —
//     guarded via a file-local requireMasterScope() (withOrgScope +
//     scope.isMaster required, no org-scope fallback: these tables are
//     fleet-internal GitHub-issue/webhook-routing/error-monitor config with
//     no per-org owner field, mirroring convex/orgRoster.ts's
//     getForAccessToken idiom), class (a). convex/issues.ts:upsertFromGitHub,
//     convex/issues.ts:linkTask, convex/issues.ts:close,
//     convex/issues.ts:createExternal, convex/issues.ts:updatePrStatus and
//     convex/githubRepoMapping.ts:seed are ALSO not in this list — converted
//     to internalMutation (zero external callers enumerated in mcp-server/
//     or vantage-peers-dashboard; upsertFromGitHub/updatePrStatus's only
//     real callers, http.ts's HMAC-verified webhook and prMonitor.ts's cron
//     internalAction, present no ctx.auth identity and now call the
//     `internal.*` reference directly). See
//     convex/__tests__/issuesGithubRepoMappingErrorMonitorWriteScope.test.ts.
//   - convex/missions.ts:create, convex/missions.ts:update,
//     convex/missions.ts:updateStatus and convex/missions.ts:updateProgress
//     are NOT in this list — guarded via withOrgScope + isOrgAllowedForScope
//     (org-scope owner check on the mission's STORED orgId), same shape as
//     briefingNotes.ts, class (a). See
//     convex/__tests__/missionsWriteScope.test.ts.
//   - convex/missionTemplates.ts:upsert and
//     convex/missionTemplates.ts:softDelete are NOT in this list — guarded
//     via withOrgScope + a master-only check: the mission-template catalog
//     is a single FLEET-WIDE shared resource (no orgId column — see
//     convex/schema.ts's missionTemplates doc comment), so only the
//     verified master scope may write it, mirroring the MCP server's own
//     pre-existing master-only guard on soft_delete_mission_template,
//     class (a). convex/missionTemplates.ts:instantiateTemplateIntoMission
//     is NOT in this list either — guarded via withOrgScope +
//     isMissionAllowedForScope (org-scope owner check on the TARGET
//     mission's STORED orgId, since the shared template it reads carries no
//     orgId of its own), class (a). See
//     convex/__tests__/missionTemplatesWriteScope.test.ts.
//   - convex/recurringTasks.ts:create, convex/recurringTasks.ts:update,
//     convex/recurringTasks.ts:pause, convex/recurringTasks.ts:resume and
//     convex/recurringTasks.ts:remove are NOT in this list — guarded via
//     convex/tasks.ts's exported requireAuthenticatedCaller (reused, not
//     duplicated — "write no second resolver"). create/update additionally
//     check the row's STORED `assignedTo` against the caller's verified
//     `allowedOrchestrators` (recurringTasks carries no orgId column);
//     pause/resume/remove require the verified master scope, mirroring the
//     MCP server's own pre-existing master-only guards on
//     pause_recurring_task/resume_recurring_task/delete_recurring_task,
//     class (a). See convex/__tests__/recurringTasksWriteScope.test.ts.
const KNOWN_OFFENDERS = new Set<string>([
	// callerOrchestrator-asserted-only (class c) — no verified identity:
	"convex/mandates.ts:create",
	"convex/mandates.ts:accept",
	"convex/mandates.ts:update",
	"convex/mandates.ts:settle",
	// no caller-identity argument or check of any kind (class c):
	"convex/fixPatterns.ts:create",
	"convex/fixPatterns.ts:addAttempt",
	"convex/fixPatterns.ts:validate",
	"convex/fixPatterns.ts:linkIssue",
	"convex/iframeEmbedSessions.ts:createSession",
	"convex/iframeEmbedSessions.ts:touchSession",
	"convex/iframeEmbedSessions.ts:revokeSession",
	"convex/kbMutations.ts:generateUploadUrl",
	"convex/okfBundleDurable.ts:cancelOkfBundleExportDurable",
	"convex/profiles.ts:upsertProfile",
	"convex/profiles.ts:updateDynamic",
]);

describe("public mutation auth guard (source-tree-derived, ratchet)", () => {
	it("every exported public mutation derives identity/scope, or is explicitly marked, or is a known/tracked offender", () => {
		const results = runScan();

		const guarded = results.filter((r) => r.status === "guarded");
		const allowMarked = results.filter((r) => r.status === "allow-marked");
		const offenders = results.filter((r) => r.status === "offender");

		// Positive controls — the scanner reaches real files and classifies
		// correctly both directions.
		expect(results.some((r) => r.file === "convex/memories.ts" && r.name === "storeMemory")).toBe(
			true,
		);
		const storeMemory = results.find(
			(r) => r.file === "convex/memories.ts" && r.name === "storeMemory",
		);
		expect(storeMemory?.status, "memories.storeMemory must be guarded post-fix").toBe("guarded");
		const softDeleteMemory = results.find(
			(r) => r.file === "convex/memories.ts" && r.name === "softDeleteMemory",
		);
		expect(
			softDeleteMemory?.status,
			"memories.softDeleteMemory must be guarded post-fix",
		).toBe("guarded");
		const storeMemoryScoped = results.find(
			(r) => r.file === "convex/memoriesScoped.ts" && r.name === "storeMemoryScoped",
		);
		expect(
			storeMemoryScoped?.status,
			"memoriesScoped.storeMemoryScoped is guarded via resolveOrgId's ctx.auth.getUserIdentity call",
		).toBe("guarded");
		const markAsRead = results.find(
			(r) => r.file === "convex/messages.ts" && r.name === "markAsRead",
		);
		expect(markAsRead?.status, "messages.markAsRead must be guarded post-fix").toBe("guarded");
		const deleteMessage = results.find(
			(r) => r.file === "convex/messages.ts" && r.name === "deleteMessage",
		);
		expect(deleteMessage?.status, "messages.deleteMessage must be guarded post-fix").toBe(
			"guarded",
		);

		console.log(
			`public mutations: ${results.length}; guarded: ${guarded.length}; allow-marked: ${allowMarkedNote(allowMarked)}; offenders: ${offenders.length}`,
		);

		const offenderKeys = offenders.map((o) => `${o.file}:${o.name}`);
		const newOffenders = offenderKeys.filter((k) => !KNOWN_OFFENDERS.has(k));
		const resolvedOffenders = [...KNOWN_OFFENDERS].filter((k) => !offenderKeys.includes(k));

		expect(
			newOffenders,
			`NEW unguarded public mutation(s) found — classify each as (a) extend the helper set, (b) mark // public-mutation: <reason>, or (c) add to KNOWN_OFFENDERS with a reason: ${JSON.stringify(offenders.map((o) => `${o.file}:${o.line} -> ${o.name}`), null, 2)}`,
		).toEqual([]);

		expect(
			resolvedOffenders,
			`Known offender(s) no longer unguarded — remove from KNOWN_OFFENDERS (the ratchet tightens): ${JSON.stringify(resolvedOffenders)}`,
		).toEqual([]);
	});
});

function allowMarkedNote(rows: Classified[]): string {
	return String(rows.length);
}
