/**
 * OKF v0.1 frontmatter serializer (Phase 1 — T1).
 *
 * Maps VantagePeers Convex entities → OKF v0.1 markdown files with YAML
 * frontmatter + opaque markdown body. Pure functions, no Convex runtime
 * dependency — safe to unit-test in vitest without convex-test.
 *
 * Design notes:
 *  - Frontmatter is emitted with `yaml.stringify({ sortMapEntries: true })` so
 *    keys are alphabetically sorted, which yields byte-stable output and makes
 *    roundtrip parse-emit deterministic (RFC §3.2 + T5).
 *  - Empty / null / undefined optional fields are OMITTED from the frontmatter
 *    (we do not emit `null` literals or `[]` for empty arrays). This keeps
 *    bundle diffs noise-free between entities that lack optional metadata.
 *  - The body is passed through VERBATIM — UTF-8 preserved, no escaping, no
 *    truncation. Bodies that contain `---` separators are safe because
 *    gray-matter only treats the FIRST `---\n...\n---\n` block at offset 0 as
 *    frontmatter (verified in tests).
 *  - filePath conventions follow RFC §3.3:
 *      memories/<id>.md  briefing-notes/<id>.md  tasks/<id>.md
 *      index.md  log.md  at bundle root.
 *  - References to Doc<"memories"> etc. are intentionally narrowed to a local
 *    structural type so this module remains importable from node-only tests
 *    (no _generated coupling). The shape mirrors convex/schema.ts verbatim.
 *
 * RFC parent: decisions/okf-bridge-phase-1-rfc-2026-06-18.md (commit 6613610).
 * ADR: decisions/adr-okf-exporter-arch.md (commit 2cd357e).
 */

import yaml from "yaml";

// ─────────────────────────────────────────────────────────────────────────────
// Structural types (mirror convex/schema.ts; intentionally not imported from
// _generated so this module unit-tests without a Convex sandbox).
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryType =
	| "user"
	| "feedback"
	| "project"
	| "reference"
	| "episode";

export interface MemoryDoc {
	_id: string;
	_creationTime?: number;
	namespace: string;
	type: MemoryType;
	content: string;
	createdBy: string;
	instanceId?: string;
	tags?: string[];
	description?: string;
	title?: string;
	ttl?: string;
	updatedAt?: number;
	createdAt?: number;
}

export interface BriefingNoteDoc {
	_id: string;
	_creationTime?: number;
	title: string;
	topic: string;
	participants: string[];
	content: string;
	decisions?: string[];
	createdBy: string;
	createdAt?: number;
	updatedAt?: number;
	tags?: string[];
}

export type TaskStatus = "todo" | "in_progress" | "review" | "blocked" | "done";

export type TaskPriority = "urgent" | "high" | "medium" | "low";

export interface TaskDoc {
	_id: string;
	_creationTime?: number;
	title: string;
	description?: string;
	project?: string;
	tags?: string[];
	assignedTo: string;
	priority: TaskPriority;
	status: TaskStatus;
	completionNote?: string;
	dependsOn?: string[];
	missionId?: string | null;
	createdBy: string;
	createdAt?: number;
	updatedAt?: number;
}

export interface SerializedFile {
	filePath: string;
	content: string;
}

export interface BundleEntries {
	memories?: MemoryDoc[];
	briefingNotes?: BriefingNoteDoc[];
	tasks?: TaskDoc[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_NAMESPACE = "project/elpi-corp";
const DESCRIPTION_MAX = 255;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip null/undefined/empty-array entries so the YAML output does not contain
 * `key: null` or `key: []` noise. Empty strings are also dropped — OKF spec
 * treats absence and emptiness equivalently for optional fields.
 */
function compact<T extends Record<string, unknown>>(
	obj: T,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		if (typeof v === "string" && v === "") continue;
		if (Array.isArray(v) && v.length === 0) continue;
		out[k] = v;
	}
	return out;
}

/**
 * Convert epoch ms (Convex _creationTime / updatedAt) → ISO 8601 string.
 * Falls back to undefined when input is missing so the caller can omit the key.
 */
function isoFromMs(ms: number | undefined): string | undefined {
	if (ms === undefined || ms === null || !Number.isFinite(ms)) return undefined;
	return new Date(ms).toISOString();
}

/**
 * Derive a short description from a body when none is provided.
 * Strips markdown front-matter-like delimiters that could confuse downstream
 * parsers, takes the first paragraph, and caps at DESCRIPTION_MAX chars.
 */
function deriveDescription(body: string): string {
	const firstPara = body.split(/\n\s*\n/)[0] ?? body;
	const stripped = firstPara.replace(/^\s+|\s+$/g, "").replace(/\s+/g, " ");
	if (stripped.length <= DESCRIPTION_MAX) return stripped;
	return `${stripped.slice(0, DESCRIPTION_MAX - 1)}…`;
}

/**
 * Cap a string at DESCRIPTION_MAX chars without breaking grapheme clusters
 * naïvely (good enough for ASCII / standard UTF-8; ellipsis appended).
 */
function clampDescription(s: string): string {
	if (s.length <= DESCRIPTION_MAX) return s;
	return `${s.slice(0, DESCRIPTION_MAX - 1)}…`;
}

/**
 * Emit a markdown file: deterministic YAML frontmatter + verbatim body.
 * Always wraps the body with a single trailing newline so concatenated bundles
 * stay POSIX-tidy and gray-matter roundtrips cleanly.
 */
function emitFile(frontmatter: Record<string, unknown>, body: string): string {
	const yamlStr = yaml.stringify(frontmatter, {
		sortMapEntries: true,
		lineWidth: 0, // disable folding so long URLs/strings stay on one line
	});
	const trimmedBody = body.endsWith("\n") ? body : `${body}\n`;
	return `---\n${yamlStr}---\n${trimmedBody}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// memory-*
// ─────────────────────────────────────────────────────────────────────────────

export function serializeMemory(entity: MemoryDoc): SerializedFile {
	const body = entity.content ?? "";
	const description = entity.description ?? deriveDescription(body);
	const timestamp =
		isoFromMs(entity.updatedAt) ??
		isoFromMs(entity.createdAt) ??
		isoFromMs(entity._creationTime);
	const title = entity.title ?? deriveTitleFromBody(body);

	const frontmatter = compact({
		type: `memory-${entity.type}`,
		title,
		description: clampDescription(description),
		resource: `vp://memory/${entity._id}`,
		tags: entity.tags,
		timestamp,
		namespace: entity.namespace || DEFAULT_NAMESPACE,
		createdBy: entity.createdBy,
	});

	return {
		filePath: `memories/${entity._id}.md`,
		content: emitFile(frontmatter, body),
	};
}

function deriveTitleFromBody(body: string): string {
	const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
	const stripped = firstLine.replace(/^#+\s*/, "").trim();
	if (stripped.length <= 80) return stripped || "untitled";
	return `${stripped.slice(0, 79)}…`;
}

// ─────────────────────────────────────────────────────────────────────────────
// briefing-note
// ─────────────────────────────────────────────────────────────────────────────

export function serializeBriefingNote(entity: BriefingNoteDoc): SerializedFile {
	const body = entity.content ?? "";
	const timestamp =
		isoFromMs(entity.updatedAt) ??
		isoFromMs(entity.createdAt) ??
		isoFromMs(entity._creationTime);

	const tags: string[] = ["snapshot"];
	if (entity.topic) tags.push(entity.topic);
	if (entity.tags) {
		for (const t of entity.tags) {
			if (!tags.includes(t)) tags.push(t);
		}
	}

	const frontmatter = compact({
		type: "briefing-note",
		title: entity.title,
		resource: `vp://briefing/${entity._id}`,
		tags,
		timestamp,
		participants: entity.participants,
		topic: entity.topic,
	});

	return {
		filePath: `briefing-notes/${entity._id}.md`,
		content: emitFile(frontmatter, body),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// task
// ─────────────────────────────────────────────────────────────────────────────

export function serializeTask(entity: TaskDoc): SerializedFile {
	const body = entity.description ?? "";
	const description = clampDescription(deriveDescription(body || entity.title));
	const timestamp =
		isoFromMs(entity.updatedAt) ??
		isoFromMs(entity.createdAt) ??
		isoFromMs(entity._creationTime);

	const tags: string[] = ["vp-task"];
	if (entity.status) tags.push(`status:${entity.status}`);
	if (entity.missionId) tags.push(`mission:${entity.missionId}`);
	if (entity.tags) {
		for (const t of entity.tags) {
			if (!tags.includes(t)) tags.push(t);
		}
	}

	const frontmatter = compact({
		type: "task",
		title: entity.title,
		description,
		resource: `vp://task/${entity._id}`,
		tags,
		timestamp,
		assignedTo: entity.assignedTo,
		priority: entity.priority,
		status: entity.status,
		missionId: entity.missionId ?? undefined,
		dependsOn: entity.dependsOn,
		createdBy: entity.createdBy,
		completionNote:
			entity.status === "done" ? entity.completionNote : undefined,
	});

	return {
		filePath: `tasks/${entity._id}.md`,
		content: emitFile(frontmatter, body),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// index.md / log.md (bundle root)
// ─────────────────────────────────────────────────────────────────────────────

export function serializeIndex(entries: BundleEntries): SerializedFile {
	const counts = {
		memories: entries.memories?.length ?? 0,
		briefingNotes: entries.briefingNotes?.length ?? 0,
		tasks: entries.tasks?.length ?? 0,
	};
	const total = counts.memories + counts.briefingNotes + counts.tasks;

	const frontmatter = compact({
		type: "index",
		title: "OKF Bundle Index",
		description: `VantagePeers OKF v0.1 bundle — ${total} entries`,
		generatedAt: new Date(0).toISOString(), // overwritten by caller in T3 if needed
		counts,
	});

	const lines: string[] = [];
	lines.push("# Bundle index");
	lines.push("");
	lines.push(`- memories: ${counts.memories}`);
	lines.push(`- briefing-notes: ${counts.briefingNotes}`);
	lines.push(`- tasks: ${counts.tasks}`);
	lines.push("");
	if (entries.memories?.length) {
		lines.push("## memories");
		for (const m of entries.memories) {
			lines.push(`- memories/${m._id}.md — memory-${m.type}`);
		}
		lines.push("");
	}
	if (entries.briefingNotes?.length) {
		lines.push("## briefing-notes");
		for (const b of entries.briefingNotes) {
			lines.push(`- briefing-notes/${b._id}.md — ${b.title}`);
		}
		lines.push("");
	}
	if (entries.tasks?.length) {
		lines.push("## tasks");
		for (const t of entries.tasks) {
			lines.push(`- tasks/${t._id}.md — [${t.status}] ${t.title}`);
		}
		lines.push("");
	}

	return {
		filePath: "index.md",
		content: emitFile(frontmatter, lines.join("\n")),
	};
}

export function serializeLog(entries: BundleEntries): SerializedFile {
	const total =
		(entries.memories?.length ?? 0) +
		(entries.briefingNotes?.length ?? 0) +
		(entries.tasks?.length ?? 0);

	const frontmatter = compact({
		type: "log",
		title: "OKF Bundle Log",
		description: `Export log — ${total} entries serialized`,
	});

	const lines: string[] = [];
	lines.push("# Export log");
	lines.push("");
	lines.push(`Total entries serialized: ${total}`);
	lines.push("");
	if (entries.memories?.length) {
		lines.push(`memories: ${entries.memories.length}`);
	}
	if (entries.briefingNotes?.length) {
		lines.push(`briefing-notes: ${entries.briefingNotes.length}`);
	}
	if (entries.tasks?.length) {
		lines.push(`tasks: ${entries.tasks.length}`);
	}

	return {
		filePath: "log.md",
		content: emitFile(frontmatter, lines.join("\n")),
	};
}
