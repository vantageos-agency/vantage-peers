/**
 * diary-entry primitive — SEP-1865 ui:// resource.
 * Renders a single VantagePeers diary entry (or list of recent entries).
 *
 * Query params :
 *   date         : YYYY-MM-DD (required for single-entry lookup)
 *   orchestrator : orchestrator name (required for single-entry lookup)
 *   createdBy    : auth-derived author filter (list mode, optional)
 *   limit        : 1-100 (default 5) — used when date/orchestrator not provided
 *   lang         : "en" (default) | "fr"
 *
 * Backend :
 *   diary:get   — when date + orchestrator provided
 *   diary:list  — when only orchestrator provided or no params (recent entries)
 *
 * Scope (task k17apssqnw2xcf72r27c83338s8hc180): the SAME arguments and gates
 * as get_diary / list_diaries. diary:get / diary:list take no scope argument
 * today (they are not in DOOR_SCOPE), so the MCP-side gates are the whole
 * control here: get mode keeps the row only if scopeFilterGet admits it; list
 * mode refuses a non-master caller unless orchestrator or createdBy names
 * itself. DEPENDENCY: the diary door's tenant fix ships separately (branch
 * sigma/diary-tenant-scope); when it adds diary:* to DOOR_SCOPE, the pin in
 * test/ui-resource-read-org-scoped.test.ts fails until this primitive spreads
 * `scope.doorArgs(...)` into both calls.
 *
 * Output : HTML card wrapped in <div class="vp-diary-entry"> with embedded CSS.
 * WCAG AA + bilingual FR+EN labels.
 */

import { scopeFilterGet } from "@vantageos/cloud-identity";
import { isRefusedEnvelope } from "../../refusal.js";
import { type UiReadScope, uiReadRefusal } from "../scope.js";

// Minimal escape — avoid XSS in injected content
function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => {
		switch (c) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			case "'":
				return "&#39;";
			default:
				return c;
		}
	});
}

type DiaryRow = {
	_id: string;
	date: string;
	orchestrator: string;
	createdBy?: string;
	content: string;
	highlights?: string[];
	blockers?: string[];
};

function renderEntryCard(entry: DiaryRow, lang: string): string {
	const highlightsLabel = lang === "fr" ? "Points clés" : "Highlights";
	const blockersLabel = lang === "fr" ? "Bloquants" : "Blockers";

	const highlightsHtml =
		entry.highlights && entry.highlights.length > 0
			? `<div class="vp-diary-section">
      <strong>${esc(highlightsLabel)}</strong>
      <ul>${entry.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
    </div>`
			: "";

	const blockersHtml =
		entry.blockers && entry.blockers.length > 0
			? `<div class="vp-diary-section vp-diary-blockers">
      <strong>${esc(blockersLabel)}</strong>
      <ul>${entry.blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
    </div>`
			: "";

	return `<article class="vp-diary-card" aria-label="${esc(entry.orchestrator)} — ${esc(entry.date)}">
  <header class="vp-diary-header">
    <span class="vp-diary-orchestrator">${esc(entry.orchestrator)}</span>
    <span class="vp-diary-date">${esc(entry.date)}</span>
  </header>
  <div class="vp-diary-content">${esc(entry.content)}</div>
  ${highlightsHtml}
  ${blockersHtml}
</article>`;
}

export async function renderDiaryEntry(
	query: URLSearchParams,
	fetchConvex: (
		functionName: string,
		args: Record<string, unknown>,
	) => Promise<unknown>,
	scope: UiReadScope,
): Promise<string> {
	const date = query.get("date") ?? undefined;
	const orchestrator = query.get("orchestrator") ?? undefined;
	const createdBy = query.get("createdBy") ?? undefined;
	const singleEntry = date !== undefined && orchestrator !== undefined;
	// list_diaries' gate: a non-master caller lists only its own entries.
	if (
		!singleEntry &&
		scope.gated &&
		orchestrator !== scope.oauthCtx.userId &&
		createdBy !== scope.oauthCtx.userId
	) {
		throw uiReadRefusal(
			"resources/read ui://vp/v1/diary-entry",
			"diary-not-self",
			`requires orchestrator='${scope.oauthCtx.userId}' or createdBy='${scope.oauthCtx.userId}' for a non-master caller`,
		);
	}
	const limitRaw = query.get("limit");
	const limitParsed =
		limitRaw !== null ? Number.parseInt(limitRaw, 10) : Number.NaN;
	const limit = Number.isNaN(limitParsed)
		? 5
		: Math.min(100, Math.max(1, limitParsed));
	const lang = (query.get("lang") ?? "en").toLowerCase();

	const heading = lang === "fr" ? "Journal VantagePeers" : "VantagePeers Diary";
	const emptyLabel =
		lang === "fr"
			? "Aucune entrée de journal trouvée."
			: "No diary entry found.";

	let entries: DiaryRow[] = [];

	try {
		if (singleEntry) {
			// Single-entry lookup; get_diary's row filter decides visibility.
			const result = (await fetchConvex("diary:get", {
				date,
				orchestrator,
			})) as DiaryRow | null;
			const visible = scope.gated
				? scopeFilterGet(scope.oauthCtx, result)
				: result;
			entries = visible ? [visible] : [];
		} else {
			// List mode
			const args: Record<string, unknown> = { limit };
			if (orchestrator) args.orchestrator = orchestrator;
			if (createdBy) args.createdBy = createdBy;
			const result = (await fetchConvex("diary:list", args)) as
				| DiaryRow[]
				| { refused: true; items: unknown[] };
			// A refusal is not an absence: never render it as "No diary entry found."
			if (isRefusedEnvelope(result)) {
				return `<div class="vp-diary-entry-error" role="alert">REFUSED (RBAC_DENIED): the backend read "diary:list" refused this identity. This is NOT an empty result: entries may exist that you cannot see.</div>`;
			}
			entries = Array.isArray(result) ? result : [];
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return `<div class="vp-diary-entry-error" role="alert">${esc(msg)}</div>`;
	}

	const style = `<style>
    .vp-diary-entry { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #1f2328; }
    .vp-diary-card { border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; margin-bottom: 12px; background: #fff; }
    .vp-diary-header { display: flex; justify-content: space-between; margin-bottom: 8px; }
    .vp-diary-orchestrator { font-weight: 600; color: #0969da; }
    .vp-diary-date { color: #656d76; font-size: 12px; }
    .vp-diary-content { line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
    .vp-diary-section { margin-top: 10px; }
    .vp-diary-section ul { margin: 4px 0 0 16px; padding: 0; }
    .vp-diary-section li { margin-bottom: 2px; }
    .vp-diary-blockers strong { color: #cf222e; }
    .vp-diary-count { color: #656d76; font-size: 12px; margin-top: 8px; }
    .vp-diary-empty { color: #656d76; padding: 12px 0; }
  </style>`;

	if (entries.length === 0) {
		return `<div class="vp-diary-entry" role="region" aria-label="${esc(heading)}">
  ${style}
  <p class="vp-diary-empty">${esc(emptyLabel)}</p>
</div>`;
	}

	const cards = entries.map((e) => renderEntryCard(e, lang)).join("\n");
	const countLabel =
		lang === "fr"
			? `${entries.length} entrée${entries.length === 1 ? "" : "s"}`
			: `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;

	return `<div class="vp-diary-entry" role="region" aria-label="${esc(heading)}">
  ${style}
  ${cards}
  <div class="vp-diary-count" aria-live="polite">${esc(countLabel)}</div>
</div>`;
}
