/**
 * validate-task-payload.ts
 *
 * Multi-axis payload validator for VantagePeers write-path tools.
 * Replaces 5 sequential PreToolUse hooks with a single lint pass that
 * surfaces ALL failures at once — eliminating the 2-3 retry loops that
 * Laurent Day 92 diagnosed ("tu échoue 2 ou 3 fois à chaque fois avant
 * de pouvoir créer une simple tache!").
 *
 * Retired hooks this consolidates:
 *   1. enforce-task-quality.py       — VERIFICATION: + TESTS: check
 *   2. enforce-task-delegation.py    — delegation-triplet check
 *   3. enforce-no-task-in-message.py — [STATUS]/task-ref check on send_message
 *   4. enforce-evidence-bound-completion.py — evidence token in completionNote
 *   5. enforce-friction-field.py     — friction_observed: auto-inject + warn
 *
 * Kept standalone:
 *   - block-time-estimates.py        — broader scope (Edit/Write/missions etc.)
 *
 * Behaviour modes:
 *   HARD-BLOCK: returns valid=false, errors non-empty, tool call must not proceed.
 *   AUTO-INJECT-WARN: injects placeholder text into modified_payload, returns
 *     valid=true with warnings — tool call proceeds with enriched payload.
 *
 * VantageOS — Day 92 F1
 */

import * as re from "./validate-task-payload-re.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type ToolName =
	| "create_task"
	| "update_task"
	| "complete_task"
	| "send_message";

export interface ValidationError {
	/** Dot-path identifier for the failing axis, e.g. "description.VERIFICATION" */
	field: string;
	/** Human-readable explanation */
	message: string;
	/** Exact text the caller can paste to fix the issue */
	copy_paste_fix: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
	warnings: string[];
	/** Axis keys for which a placeholder was auto-injected into modified_payload */
	auto_inject_applied: string[];
	/**
	 * When auto-inject was applied this contains the patched payload.
	 * The MCP hook writes this to stdout so Claude Code uses it instead
	 * of the original input. Undefined when no injection occurred.
	 */
	modified_payload?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal accumulators
// ─────────────────────────────────────────────────────────────────────────────

interface Acc {
	errors: ValidationError[];
	warnings: string[];
	auto_inject: string[];
	patched: Record<string, unknown>;
}

function mkAcc(payload: Record<string, unknown>): Acc {
	return {
		errors: [],
		warnings: [],
		auto_inject: [],
		patched: { ...payload },
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Axis: time-estimate detection (hard-block, all tools)
// ─────────────────────────────────────────────────────────────────────────────

function checkTimeEstimate(text: string, acc: Acc): void {
	const violations = re.findTimeEstimateViolations(text);
	if (violations.length === 0) return;

	acc.errors.push({
		field: "time_estimate",
		message: `Time/effort estimate detected: ${violations.slice(0, 3).join("; ")}`,
		copy_paste_fix:
			"Remove the estimate. Replace with 'TBD' or omit the line entirely.\n" +
			"Override (cron schedules only): add `// allow-time-estimate: <reason>` on the same line.",
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Axis: VERIFICATION: + TESTS: in description (auto-inject-warn)
// ─────────────────────────────────────────────────────────────────────────────

function checkVerificationTests(description: string, acc: Acc): void {
	const lower = description.toLowerCase();
	const missingVerification = !lower.includes("verification:");
	const missingTests = !lower.includes("tests:");

	if (missingVerification) {
		acc.auto_inject.push("description.VERIFICATION");
		acc.warnings.push(
			"AUTO-INJECT: VERIFICATION: section missing — added placeholder. " +
			"Replace 'TBD' with actual acceptance criteria before closing the task.",
		);
	}

	if (missingTests) {
		acc.auto_inject.push("description.TESTS");
		acc.warnings.push(
			"AUTO-INJECT: TESTS: section missing — added placeholder. " +
			"Replace 'TBD' with actual test strategy before closing the task.",
		);
	}

	if (missingVerification || missingTests) {
		// Inject into patched payload
		const current = (acc.patched.description as string | undefined) ?? description;
		let patched = current;
		if (missingVerification) {
			patched += "\n\nVERIFICATION: TBD";
		}
		if (missingTests) {
			patched += "\n\nTESTS: TBD";
		}
		acc.patched.description = patched;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Axis: delegation triplet (hard-block when partial)
// ─────────────────────────────────────────────────────────────────────────────

const DELEGATION_KEYS = ["subagent_type", "run_in_background", "model"] as const;

function checkDelegationTriplet(description: string, acc: Acc): void {
	// Skip if [META] tag present (orchestrator meta-tasks exempt from delegation rules)
	if (/\[META\]/i.test(description)) return;

	const lower = description.toLowerCase();

	// Detect partial presence: any one of the three keys triggers the check
	const present = DELEGATION_KEYS.filter((k) => lower.includes(k + ":") || lower.includes(k + " "));
	if (present.length === 0) return; // no delegation intent — not required

	const missing = DELEGATION_KEYS.filter((k) => !present.includes(k));
	if (missing.length === 0) return; // all three present — valid

	acc.errors.push({
		field: "delegation.triplet",
		message:
			`Partial delegation triplet detected — present: [${present.join(", ")}], ` +
			`missing: [${missing.join(", ")}]. All three fields are required together.`,
		copy_paste_fix:
			"Add all three delegation fields to the description:\n" +
			"  subagent_type: <agent-role>\n" +
			"  run_in_background: true\n" +
			"  model: claude-sonnet-4-5\n" +
			"Or add [META] to exempt this task from delegation checks.",
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Axis: evidence-bound completionNote (hard-block on terminal status)
// ─────────────────────────────────────────────────────────────────────────────

const EVIDENCE_PATTERNS: RegExp[] = [
	/https?:\/\/\S+/,                                          // URL
	/\b[0-9a-f]{7,40}\b/,                                      // commit SHA
	/#\d{1,6}\b/,                                              // PR / issue number
	/\b[a-z0-9]{20,}\b/,                                       // VantagePeers / Convex ID
	/\b\d+\s*\/\s*\d+\b/,                                      // test / gate ratio
	/\b\d+\s+(tests?|pass|passed|passing|green|errors?|rows?|lignes?|lines?|files?|fichiers?|issues?|commits?|insertions?|deletions?|tools?|gates?)\b/i,
	/\b[\w./\-]+\.(png|jpe?g|gif|webp|svg|md|mdx|json|jsonl|xlsx|csv|html|pdf|tsx?|jsx?|py|sh|ya?ml|css|txt)\b/i,
];

const OPT_OUT_EVIDENCE = "allow-no-evidence:";

function hasEvidence(note: string): boolean {
	return EVIDENCE_PATTERNS.some((p) => p.test(note));
}

const CLAIM_WORDS_RE = /\b(done|merged|deployed|all\s+good|pass|passed|completed|finished|c'est\s+fait|terminé)\b/i;

function checkEvidence(note: string, acc: Acc): void {
	if (note.includes(OPT_OUT_EVIDENCE)) return;

	if (!note.trim()) {
		acc.errors.push({
			field: "completionNote.length",
			message: "completionNote is missing or empty.",
			copy_paste_fix:
				"Add a completionNote with ≥40 chars and at least one evidence token:\n" +
				"  completionNote: PR #<n> merged. <X>/<Y> tests passing. commit <sha>. friction_observed: none",
		});
		return;
	}

	if (note.trim().length < 40) {
		acc.errors.push({
			field: "completionNote.length",
			message: `completionNote too short (${note.trim().length} chars — minimum 40).`,
			copy_paste_fix:
				"Expand the note to ≥40 chars. Include at least one evidence token:\n" +
				"  PR #<n> merged. <X>/<Y> tests passing. commit <sha>.",
		});
	}

	if (!hasEvidence(note) && CLAIM_WORDS_RE.test(note)) {
		acc.errors.push({
			field: "completionNote.evidence",
			message:
				"completionNote uses claim words ('done', 'merged', 'deployed'…) without verifiable evidence.",
			copy_paste_fix:
				"Replace or extend with a verifiable token. Examples:\n" +
				"  PR #42 merged. 15/15 tests passing. commit d8ceef5.\n" +
				"  https://github.com/.../pull/42\n" +
				"  15 tests passing. file: src/feature.test.ts\n" +
				"Opt-out (no artifact): add `// allow-no-evidence: <reason>` in the note.",
		});
	} else if (!hasEvidence(note) && note.trim().length >= 40) {
		acc.errors.push({
			field: "completionNote.evidence",
			message: "completionNote carries no verifiable evidence token.",
			copy_paste_fix:
				"Add at least one verifiable token to the note. Examples:\n" +
				"  PR #42 merged. 15/15 tests passing. commit d8ceef5.\n" +
				"  https://github.com/.../pull/42\n" +
				"Opt-out (no artifact): add `// allow-no-evidence: <reason>` in the note.",
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Axis: friction_observed (auto-inject-warn, complete_task only)
// ─────────────────────────────────────────────────────────────────────────────

// Matches friction_observed: at start of line OR anywhere mid-note (after ". " or "; ")
const FRICTION_LINE_RE = /(?:^|\.\s+|;\s+)friction_observed:\s*\S/im;
const FRICTION_OPT_OUT_RE = /\/\/\s*allow-no-friction-field\s*:\s*\S{3,}/i;

function checkFriction(note: string, acc: Acc): void {
	if (FRICTION_OPT_OUT_RE.test(note)) return;
	if (FRICTION_LINE_RE.test(note)) return;

	// Auto-inject: append friction_observed: none to modified completionNote
	acc.auto_inject.push("friction_observed");
	acc.warnings.push(
		"AUTO-INJECT: friction_observed missing — added 'friction_observed: none' placeholder. " +
		"RULE #15 Auto-Amelioration (Day 89): every complete_task must declare observed friction. " +
		"Replace 'none' with what you actually hit, or keep 'none' if truly frictionless.\n" +
		"FIX: append the following line to completionNote:\n" +
		"  friction_observed: none",
	);

	const current = (acc.patched.completionNote as string | undefined) ?? note;
	acc.patched.completionNote = current.trimEnd() + "\nfriction_observed: none";
}

// ─────────────────────────────────────────────────────────────────────────────
// Axis: send_message — task-ref / info-marker check
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL_EXEMPT = new Set(["pi-chromebook", "pi-vps", "broadcast"]);

const IMPERATIVE_VERBS_RE = /\b(fais|faire|exécute|execute|amende|amend|crée|create|mets?\s+à\s+jour|update|corrige|fix|déploie|deploy|merge|mergez?|installe|install|configure|configurez?|renomme|rename|supprimer|supprime|delete|remove|ajoute|ajouter|add|modifie|modifier|modify|retire|retirer|applique|appliquer|apply|vérifie|verify|check|génère|generate|construis|construire|build|écris|écrire|write|push|pushe|poussez?|pousse|pull|pulle|tirez?|commit|commits?|rebase|rebasez?|run|lance|lancez?|démarre|start|stop|arrête)\b/i;

const NUMBERED_LIST_RE = /(?:^|\n)\s*\d+\.\s+[A-Za-zÀ-ÿ]/gm;

const TASK_REF_RES = [
	/task\s+k[a-z0-9]{15,}/i,
	/taskId\s*[:=]/i,
	/task\s+ID\s*[:=]/i,
];

const INFO_MARKER_RES = [
	/^\s*\[INFO\s*ONLY\]/im,
	/^\s*\[STATUS\]/im,
	/^\s*\[DONE\]/im,
	/^\s*Info\s*:/im,
	/^\s*Status\s*:/im,
];

function checkMessageTaskRef(
	channel: string,
	content: string,
	acc: Acc,
): void {
	if (CHANNEL_EXEMPT.has(channel)) return;
	if (!content.trim()) return;

	const hasVerb = IMPERATIVE_VERBS_RE.test(content);
	const numberedItems = (content.match(NUMBERED_LIST_RE) ?? []).length;
	const hasActionList = numberedItems >= 3;

	if (content.length < 120 && !hasVerb && !hasActionList) return;

	// Check exemptions
	for (const pat of TASK_REF_RES) {
		if (pat.test(content)) return;
	}
	for (const pat of INFO_MARKER_RES) {
		if (pat.test(content)) return;
	}

	if (!hasVerb && !hasActionList) return;

	acc.errors.push({
		field: "content.task_ref",
		message:
			"Message contains action instructions without a task reference or info marker.",
		copy_paste_fix:
			"Option A — prefix content with an info marker (if informational):\n" +
			"  [INFO ONLY] <your message>\n" +
			"  [STATUS] <your message>\n" +
			"Option B — add a task reference:\n" +
			"  ... task k<convex-id> ...\n" +
			"Option C — create a task first, then reference it:\n" +
			"  create_task { title, assignedTo, description with VERIFICATION: and TESTS: }\n" +
			"  then include `task k<id>` in this message.",
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-tool dispatch
// ─────────────────────────────────────────────────────────────────────────────

function dispatchCreateOrUpdateTask(
	toolName: ToolName,
	payload: Record<string, unknown>,
	acc: Acc,
): void {
	const description =
		typeof payload.description === "string" ? payload.description : null;

	// For update_task: only check description if it's being updated
	if (toolName === "update_task" && description === null) {
		// No description update — only check status-dependent axes
		const status = payload.status as string | undefined;
		if (status === "review" || status === "done") {
			const note =
				typeof payload.completionNote === "string"
					? payload.completionNote
					: "";
			const textForEstimate = note;
			checkTimeEstimate(textForEstimate, acc);
			checkEvidence(note, acc);
			checkFriction(note, acc);
		} else {
			// Non-terminal status update with no description — just check time estimates in any text fields
			const allText = Object.values(payload)
				.filter((v): v is string => typeof v === "string")
				.join("\n");
			checkTimeEstimate(allText, acc);
		}
		return;
	}

	if (toolName === "create_task" && !description) {
		acc.errors.push({
			field: "description",
			message: "description is required for create_task.",
			copy_paste_fix:
				"Add a description field:\n" +
				"  description: <what needs to be done>\n\n" +
				"  VERIFICATION: <what will be checked to confirm done>\n\n" +
				"  TESTS: <how it will be tested>",
		});
		return;
	}

	if (description !== null) {
		// Time estimate check on all text
		const allText = [
			description,
			typeof payload.title === "string" ? payload.title : "",
			typeof payload.completionNote === "string" ? payload.completionNote : "",
		].join("\n");
		checkTimeEstimate(allText, acc);

		// VERIFICATION + TESTS (auto-inject mode)
		checkVerificationTests(description, acc);

		// Delegation triplet (hard-block if partial)
		checkDelegationTriplet(description, acc);
	}
}

function dispatchCompleteTask(
	payload: Record<string, unknown>,
	acc: Acc,
): void {
	const note =
		typeof payload.completionNote === "string" ? payload.completionNote : "";

	// Time estimate check
	checkTimeEstimate(note, acc);

	// Evidence-bound (hard-block)
	checkEvidence(note, acc);

	// Friction (auto-inject-warn)
	// Only run friction check when evidence check didn't hard-block the note
	// (if note is empty/too-short, friction inject would be redundant noise)
	const noteOk =
		note.trim().length >= 40 &&
		(hasEvidence(note) || note.includes(OPT_OUT_EVIDENCE));
	if (noteOk) {
		checkFriction(note, acc);
	} else if (note.trim().length >= 40 && !acc.errors.some((e) => e.field === "completionNote.evidence")) {
		checkFriction(note, acc);
	}
}

function dispatchSendMessage(
	payload: Record<string, unknown>,
	acc: Acc,
): void {
	const channel =
		typeof payload.channel === "string" ? payload.channel : "";
	const content =
		typeof payload.content === "string" ? payload.content : "";

	// Time estimate in content
	checkTimeEstimate(content, acc);

	// Task-ref / info-marker check (exempt channels skip this)
	checkMessageTaskRef(channel, content, acc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * validateTaskPayload — pure lint function, no side effects.
 *
 * Runs all applicable validation axes for the given tool and payload,
 * accumulates ALL failures, and returns them in a single result. Auto-inject
 * axes patch the payload in modified_payload and emit warnings instead of
 * hard errors.
 *
 * @param toolName  One of the four VP write-path tools.
 * @param payload   The tool_input as a plain object.
 * @returns         ValidationResult — always contains errors, warnings, auto_inject_applied.
 */
export function validateTaskPayload(
	toolName: ToolName,
	payload: Record<string, unknown>,
): ValidationResult {
	const acc = mkAcc(payload);

	switch (toolName) {
		case "create_task":
		case "update_task":
			dispatchCreateOrUpdateTask(toolName, payload, acc);
			break;
		case "complete_task":
			dispatchCompleteTask(payload, acc);
			break;
		case "send_message":
			dispatchSendMessage(payload, acc);
			break;
	}

	const valid = acc.errors.length === 0;
	const hasInjections = acc.auto_inject.length > 0;

	return {
		valid,
		errors: acc.errors,
		warnings: acc.warnings,
		auto_inject_applied: acc.auto_inject,
		modified_payload: hasInjections ? acc.patched : undefined,
	};
}
