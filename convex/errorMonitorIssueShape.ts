// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorIssueShape — the PUBLIC issue carries shape only
// ─────────────────────────────────────────────────────────────────────────────
// Operator ruling (2026-11-28, via Pi): the GitHub issue is the trigger of the
// repair loop and it is filed on a PUBLIC repository. Its title and body name
// only: the function(s), the error CLASS (and a code prefix such as
// RBAC_DENIED), the deployment, first/last seen, the count and the repo
// file:line of the throw.
//
// Everything else a raw error carries — the message sentence, "Path:" /
// "Value:" argument echoes, row contents, ids, stack message lines, emails,
// client names — stays in the private `errorLogs` row and is never copied here.
//
// The shaping is an ALLOW-LIST: each output field is built from a value that
// matched a closed pattern. Text that matches no pattern is dropped, never
// echoed. Pure module: no Convex imports, so it is unit-testable and shared by
// the issue filer and by the redaction of already-filed issues.
// ─────────────────────────────────────────────────────────────────────────────

export interface ShapeInput {
	/** "module:function" identifiers of the group. */
	functionNames: string[];
	/** Raw error message (never copied into the output). */
	errorMessage: string;
	/** Raw stack / log lines (only a repo file:line is read from it). */
	stackTrace: string;
	deployment: string;
	firstSeen?: number;
	lastSeen?: number;
	count?: number;
	/** Title prefix such as the recurring-escalation marker. */
	titlePrefix?: string;
	/** Footer line (italic markdown) naming the filing orchestrator. */
	footer?: string;
}

export interface ShapedIssue {
	title: string;
	body: string;
}

export interface ErrorClassification {
	errorClass: string;
	code: string | null;
}

export const SHAPE_ONLY_MARKER = "(shape only)";
export const UNCLASSIFIED = "Unclassified";
const UNKNOWN = "unknown";
const MAX_FUNCTIONS_IN_TITLE = 3;
const MAX_FUNCTIONS_IN_BODY = 10;

const CLASS_TOKEN = "[A-Z][A-Za-z0-9]*(?:Error|Exception)";
// An explicit "Uncaught X" at the start of a line (X may be the bare "Error").
const UNCAUGHT_LINE_RE = new RegExp(
	`(?:^|\\n)[ \\t]*Uncaught[ \\t]+(${CLASS_TOKEN}|Error)\\b([^\\n]*)`,
);
// A named class at the start of a line followed by a colon.
const NAMED_LINE_RE = new RegExp(`(?:^|\\n)[ \\t]*(${CLASS_TOKEN})[ \\t]*:([^\\n]*)`);
// A code prefix directly after the class colon: RBAC_DENIED, ORG_MISMATCH...
const CODE_RE = /^[ \t]*:?[ \t]*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/;

const SAFE_FUNCTION_RE = /^[A-Za-z0-9_\-./]{1,100}(?::[A-Za-z0-9_$-]{1,80})?$/;
const SAFE_DEPLOYMENT_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SAFE_FOOTER_RE = /^\*Auto-created by VantagePeers Error Monitor\.[A-Za-z0-9 —|:.-]{0,120}\*$/;

// Only a repo path (convex/ or mcp-server/src/) is a throw site. The look-behind
// refuses a path that is merely the tail of a foreign absolute path.
const SITE_RE =
	/(?<![\w.\-/])(?:\.{1,2}\/)*((?:convex|mcp-server\/src)\/[\w\-./]+\.(?:ts|tsx|js)):(\d+)/;

/** Error class (and code prefix) read from the head of the message. */
export function classifyError(errorMessage: string): ErrorClassification {
	const uncaught = UNCAUGHT_LINE_RE.exec(errorMessage);
	if (uncaught) {
		const cls = uncaught[1];
		return {
			errorClass: cls === "Error" ? "Uncaught Error" : cls,
			code: CODE_RE.exec(uncaught[2])?.[1] ?? null,
		};
	}
	const named = NAMED_LINE_RE.exec(errorMessage);
	if (named) {
		return {
			errorClass: named[1],
			code: CODE_RE.exec(named[2])?.[1] ?? null,
		};
	}
	return { errorClass: UNCLASSIFIED, code: null };
}

/** `convex/x.ts:12` from the first stack frame naming a repo path, else null. */
export function extractThrowSite(
	errorMessage: string,
	stackTrace: string,
): string | null {
	for (const text of [stackTrace, errorMessage]) {
		for (const line of text.split("\n")) {
			if (!/^\s*at\s/.test(line)) continue;
			const m = SITE_RE.exec(line);
			if (m) return `${m[1]}:${m[2]}`;
		}
	}
	return null;
}

function safeFunctions(names: string[]): string[] {
	const out: string[] = [];
	for (const n of names) {
		const safe = SAFE_FUNCTION_RE.test(n) ? n : UNKNOWN;
		if (!out.includes(safe)) out.push(safe);
	}
	return out.length > 0 ? out : [UNKNOWN];
}

function titleFor(
	cls: ErrorClassification,
	functions: string[],
	prefix: string | undefined,
): string {
	const shown = functions.slice(0, MAX_FUNCTIONS_IN_TITLE).join(", ");
	const more =
		functions.length > MAX_FUNCTIONS_IN_TITLE
			? ` (+${functions.length - MAX_FUNCTIONS_IN_TITLE} more)`
			: "";
	const code = cls.code ? ` (${cls.code})` : "";
	const head = `[Auto] ${cls.errorClass}${code} in ${shown}${more}`;
	return prefix ? `${prefix} ${head}` : head;
}

function isoOrNull(ms: number | undefined): string | null {
	if (ms === undefined || !Number.isFinite(ms)) return null;
	return new Date(ms).toISOString();
}

/** The one place a public issue title and body are built. */
export function shapeIssue(input: ShapeInput): ShapedIssue {
	const cls = classifyError(input.errorMessage);
	const site = extractThrowSite(input.errorMessage, input.stackTrace);
	const functions = safeFunctions(input.functionNames);
	const deployment = SAFE_DEPLOYMENT_RE.test(input.deployment)
		? input.deployment
		: UNKNOWN;
	const first = isoOrNull(input.firstSeen);
	const last = isoOrNull(input.lastSeen);

	const lines: string[] = [
		`## Auto-detected Error ${SHAPE_ONLY_MARKER}`,
		"",
		`**Deployment:** ${deployment}`,
		`**Function:** ${functions
			.slice(0, MAX_FUNCTIONS_IN_BODY)
			.map((f) => `\`${f}\``)
			.join(", ")}`,
		`**Error class:** ${cls.errorClass}`,
	];
	if (cls.code) lines.push(`**Error code:** ${cls.code}`);
	if (site) lines.push(`**Throw site:** \`${site}\``);
	if (first) lines.push(`**First seen:** ${first}`);
	if (last) lines.push(`**Last seen:** ${last}`);
	if (input.count !== undefined && Number.isFinite(input.count)) {
		lines.push(`**Count:** ${Math.trunc(input.count)}`);
	}
	lines.push(
		"",
		"The error message, arguments and stack are withheld from this public issue by design. The full record is kept in the private error log.",
	);
	if (input.footer && SAFE_FOOTER_RE.test(input.footer)) {
		lines.push("", "---", input.footer);
	}

	return {
		title: titleFor(cls, functions, input.titlePrefix),
		body: lines.join("\n"),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Redaction of issues already filed in the old, value-echoing form
// ─────────────────────────────────────────────────────────────────────────────

const RECURRING_PREFIX_RE = /^(\[RECURRING 24h\+[^\]]{0,60}\])\s/;

function fencedBlock(body: string, heading: string): string {
	const start = body.indexOf(`### ${heading}`);
	if (start === -1) return "";
	const open = body.indexOf("```", start);
	if (open === -1) return "";
	const contentStart = body.indexOf("\n", open);
	if (contentStart === -1) return "";
	const close = body.indexOf("\n```", contentStart);
	return body.slice(contentStart + 1, close === -1 ? undefined : close);
}

function inputFromOldBody(oldBody: string): ShapeInput {
	const dep = /\*\*Deployment:\*\*[ \t]*(\S+)/.exec(oldBody)?.[1] ?? UNKNOWN;
	const fnRaw = /\*\*Function:\*\*[ \t]*([^\n]*)/.exec(oldBody)?.[1] ?? "";
	const fns = [...fnRaw.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
	const detected = /\*\*Detected:\*\*[ \t]*(\S+)/.exec(oldBody)?.[1];
	const first = detected && ISO_RE.test(detected) ? Date.parse(detected) : undefined;
	const footerRaw = /^\*Auto-created by VantagePeers Error Monitor\.[^\n]*\*$/m.exec(
		oldBody,
	)?.[0];
	return {
		functionNames: fns.length > 0 ? fns : [UNKNOWN],
		errorMessage: fencedBlock(oldBody, "Error Message"),
		stackTrace: fencedBlock(oldBody, "Stack Trace"),
		deployment: dep,
		firstSeen: first,
		footer: footerRaw,
	};
}

/**
 * Maps an existing auto-issue body (old, value-echoing form) to the shape-only
 * form. A body already in the new form is returned unchanged (idempotent). A
 * body that matches neither form yields a shape-only body of unknown fields —
 * the input text is never carried over.
 */
export function redactIssueBody(oldBody: string): string {
	if (oldBody.includes(SHAPE_ONLY_MARKER)) return oldBody;
	return shapeIssue(inputFromOldBody(oldBody)).body;
}

/**
 * Rebuilds the title of an existing auto-issue from its shape. The old title
 * carried the first 80 characters of the raw message. A recurring-escalation
 * prefix is kept; a title already in the new form is returned unchanged.
 */
export function redactIssueTitle(oldTitle: string, oldBody: string): string {
	if (oldBody.includes(SHAPE_ONLY_MARKER)) return oldTitle;
	const input = inputFromOldBody(oldBody);
	if (input.functionNames.length === 1 && input.functionNames[0] === UNKNOWN) {
		const fromTitle = /Error in ([^\s:]+(?::[A-Za-z0-9_$-]+)?)/.exec(oldTitle)?.[1];
		if (fromTitle) input.functionNames = [fromTitle];
	}
	const prefix = RECURRING_PREFIX_RE.exec(oldTitle)?.[1];
	return shapeIssue({ ...input, titlePrefix: prefix }).title;
}
