/**
 * Client-filled list arguments (task k172pt7ync7d6vw8a5gc7h03098hb7b7).
 *
 * Some MCP clients (Claude.ai's connector, measured) serialise an array
 * argument as a JSON string. A schema that validates the raw value then refuses
 * a well-formed list: `mark_as_read` refused `"[\"k…\",\"k…\"]"` against the
 * 32-char ID pattern, so a client agent had to mark receipts one call at a time.
 *
 * Every client-filled list argument goes through one of these helpers, so the
 * value is normalised BEFORE validation and each element is still checked.
 */

import { z } from "zod";

/** A string holding a JSON array is parsed; anything else passes unchanged. */
export function parseJsonArrayString(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed.startsWith("[")) return value;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return Array.isArray(parsed) ? parsed : value;
	} catch {
		return value;
	}
}

/** Same, then a bare string becomes a list of one. */
function toList(value: unknown): unknown {
	const parsed = parseJsonArrayString(value);
	return typeof parsed === "string" ? [parsed.trim()] : parsed;
}

/**
 * A non-empty list of IDs, advertised as a plain JSON array (never an anyOf
 * union). A JSON-string list and a single bare ID are both accepted.
 */
export function idListSchema(item: z.ZodString) {
	return z.preprocess(toList, z.array(item).min(1));
}

/**
 * A list of free-text strings, advertised as a plain JSON array. Same
 * normalisation as {@link idListSchema}; may be empty.
 */
export const stringListSchema = z.preprocess(toList, z.array(z.string()));

/**
 * Wraps a schema whose union is meaningful (a single filter value OR a list):
 * the union stays, and a list sent as a JSON string is parsed first.
 */
export function acceptsJsonArrayString<T extends z.ZodType>(schema: T) {
	return z.preprocess(parseJsonArrayString, schema);
}

/**
 * A status filter in ONE published shape (standard S-43): an array of one or
 * more tokens, each a status or an alias. A bare string or a JSON-string list
 * becomes that array before validation. An alias ("open", "active", "all")
 * stands alone: mixed with other tokens it is refused. What the backend
 * receives is unchanged: one token as a string, several statuses as an array.
 */
export function statusListSchema(
	statuses: readonly [string, ...string[]],
	aliases: readonly string[],
) {
	const tokens = [...statuses, ...aliases] as [string, ...string[]];
	return z.preprocess(
		toList,
		z
			.array(z.enum(tokens))
			.min(1)
			.refine(
				(list) => list.length === 1 || !list.some((t) => aliases.includes(t)),
				{
					message:
						"a status alias (open, active, all) stands alone; list direct statuses instead",
				},
			)
			.transform((list) => (list.length === 1 ? list[0] : list)),
	);
}
