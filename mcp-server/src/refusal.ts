// The typed refusal envelope a subscribed list read answers a refused caller with
// (`{ refused: true, items: [] }`). A refusal is not an absence: every MCP reader
// of an envelope-capable door tests this BEFORE coalescing to an empty array.
// See .claude/rules/refusal-is-distinguishable-from-absence.md and
// test/refusal-marker-survives-transport.test.ts.
export function isRefusedEnvelope(
	value: unknown,
): value is { refused: true; items: unknown[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { refused?: unknown }).refused === true
	);
}
