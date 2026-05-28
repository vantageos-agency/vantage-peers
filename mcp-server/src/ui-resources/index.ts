/**
 * SEP-1865 ui:// resources for VantagePeers Generative UI.
 *
 * URI pattern : ui://vp/v1/<primitive>?<query>
 * Examples :
 *   ui://vp/v1/tasks-table?assignedTo=pi&status=review&fields=lite&limit=10
 *   ui://vp/v1/messages-feed?recipient=sigma&limit=20
 *
 * M1 scope : 1 primitive (tasks-table) — proves the pipeline.
 * M2 scope : ≥6 primitives (tasks/messages/diary/missions/briefingNotes/memories).
 *
 * Pattern Hybrid 60% static lit-ui + 11% Gen UI + 27% Hybrid (cf vp-gui-views-research-2026-05-28.md).
 * Returns HTML inline with embedded JS + CSS Shadow DOM scoped.
 *
 * Reference instance Theta : theta-vantage-crm-gui-iframe-embed-v1 (blissful-gopher-531).
 * Mission Sigma : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
 */

import { renderBriefingNote } from "./primitives/briefing-note.js";
import { renderDiaryEntry } from "./primitives/diary-entry.js";
import { renderMemoryQuote } from "./primitives/memory-quote.js";
import { renderMessagesFeed } from "./primitives/messages-feed.js";
import { renderMissionTimeline } from "./primitives/mission-timeline.js";
import { renderTasksTable } from "./primitives/tasks-table.js";

// URI parser : ui://vp/v1/<primitive>?<query>
const UI_URI_RE = /^ui:\/\/vp\/v1\/([a-z][a-z0-9-]*)(?:\?(.*))?$/;

export type UiResourceParsed = {
	primitive: string;
	query: URLSearchParams;
};

export function parseUiUri(uri: string): UiResourceParsed | null {
	const match = UI_URI_RE.exec(uri);
	if (!match) return null;
	const primitive = match[1];
	const queryString = match[2] ?? "";
	return {
		primitive,
		query: new URLSearchParams(queryString),
	};
}

// Primitive registry — M1 ships 1 (tasks-table). M2 adds 5 more.
export const PRIMITIVES = [
	"tasks-table",
	"messages-feed",
	"diary-entry",
	"mission-timeline",
	"briefing-note",
	"memory-quote",
] as const;
export type Primitive = (typeof PRIMITIVES)[number];

export const PRIMITIVE_DESCRIPTIONS: Record<Primitive, string> = {
	"tasks-table":
		"Render a compact table of tasks. Query params: assignedTo, status, fields=lite|full, limit. Mirrors list_tasks tool semantics.",
	"messages-feed":
		"Render a chronological feed of VantagePeers messages. Query params: from, channel, limit, lang.",
	"diary-entry":
		"Render a single diary entry or list of recent entries. Query params: date (YYYY-MM-DD), orchestrator, limit, lang.",
	"mission-timeline":
		"Render a missions timeline. Query params: pilot, project, status, limit, lang.",
	"briefing-note":
		"Render briefing note details. Query params: noteId or (topic + limit), lang.",
	"memory-quote":
		"Render memory quotes from a namespace. Query params: namespace, type, limit, lang.",
};

// Resource list — returned by resources/list MCP handler
export function listUiResources(): Array<{
	uri: string;
	name: string;
	description: string;
	mimeType: string;
}> {
	return PRIMITIVES.map((p) => ({
		uri: `ui://vp/v1/${p}`,
		name: p,
		description: PRIMITIVE_DESCRIPTIONS[p],
		mimeType: "text/html",
	}));
}

// Resource read — dispatched by primitive name. Returns HTML inline.
export async function readUiResource(
	uri: string,
	fetchConvex: (
		functionName: string,
		args: Record<string, unknown>,
	) => Promise<unknown>,
): Promise<{ uri: string; mimeType: string; text: string }> {
	const parsed = parseUiUri(uri);
	if (!parsed) {
		throw new Error(`[VP UI Resources] Invalid ui:// URI: ${uri}`);
	}
	if (!PRIMITIVES.includes(parsed.primitive as Primitive)) {
		throw new Error(
			`[VP UI Resources] Unknown primitive: ${parsed.primitive}. Available: ${PRIMITIVES.join(", ")}`,
		);
	}
	let html: string;
	switch (parsed.primitive as Primitive) {
		case "tasks-table":
			html = await renderTasksTable(parsed.query, fetchConvex);
			break;
		case "messages-feed":
			html = await renderMessagesFeed(parsed.query, fetchConvex);
			break;
		case "diary-entry":
			html = await renderDiaryEntry(parsed.query, fetchConvex);
			break;
		case "mission-timeline":
			html = await renderMissionTimeline(parsed.query, fetchConvex);
			break;
		case "briefing-note":
			html = await renderBriefingNote(parsed.query, fetchConvex);
			break;
		case "memory-quote":
			html = await renderMemoryQuote(parsed.query, fetchConvex);
			break;
		default:
			throw new Error(
				`[VP UI Resources] Unimplemented primitive: ${parsed.primitive}`,
			);
	}
	return {
		uri,
		mimeType: "text/html",
		text: html,
	};
}
