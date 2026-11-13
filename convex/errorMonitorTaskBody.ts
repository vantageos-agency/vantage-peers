// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorTaskBody
// ─────────────────────────────────────────────────────────────────────────────
// What the error monitor writes into the VantagePeers task it files for the
// backend owner. Pure, no Convex deps.
//
// The repository the monitor used to file issues on is PUBLIC, and one issue
// body echoed a client name and internal ids taken from the raw error message.
// The task is private, but the rule is kept at the source: the body carries
// the function name, the error CLASS and the time -- never an argument object,
// a row, or the message itself (a message may hold any of them). The class is
// a token matched by shape (`FooError`), not a slice of the message.

/** Dedupe tag prefix: one open task per error group hash. */
export const ERROR_TASK_TAG_PREFIX = "error-monitor:";

const ERROR_CLASS_PATTERN = /\b([A-Z][A-Za-z]{2,40}Error)\b/;
const FUNCTION_NAME_DISALLOWED = /[^A-Za-z0-9_:.,/ -]/g;

/** The error class token in a message, or "Error" when none is present. */
export function errorClassOf(errorMessage: string): string {
	return ERROR_CLASS_PATTERN.exec(errorMessage)?.[1] ?? "Error";
}

/** A Convex identifier list reduced to identifier characters only. */
export function safeFunctionName(functionName: string): string {
	return functionName.replace(FUNCTION_NAME_DISALLOWED, "").slice(0, 200);
}

export function errorTaskTag(hash: string): string {
	return `${ERROR_TASK_TAG_PREFIX}${hash.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}`;
}

export interface ErrorTaskBody {
	title: string;
	description: string;
	tags: string[];
}

export function buildErrorTaskBody(input: {
	functionName: string;
	errorMessage: string;
	hash: string;
	detectedAt: number;
	titlePrefix?: string;
}): ErrorTaskBody {
	const fn = safeFunctionName(input.functionName);
	const cls = errorClassOf(input.errorMessage);
	const when = new Date(input.detectedAt).toISOString();
	const prefix = input.titlePrefix ? `${input.titlePrefix} ` : "";
	return {
		title: `${prefix}[Auto] Error in ${fn}: ${cls}`,
		description: [
			"Auto-detected by the VantagePeers error monitor.",
			"",
			`Function: ${fn}`,
			`Error class: ${cls}`,
			`Detected: ${when}`,
			"",
			"The error message and stack are not copied here. Read them in the Convex dashboard logs.",
		].join("\n"),
		tags: ["auto-detected", "error-monitor", errorTaskTag(input.hash)],
	};
}
