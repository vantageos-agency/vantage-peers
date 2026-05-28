/**
 * diary-entry primitive — SEP-1865 ui:// resource.
 * Renders a single VantagePeers diary entry (or list of recent entries).
 *
 * Query params :
 *   date         : YYYY-MM-DD (required for single-entry lookup)
 *   orchestrator : orchestrator name (required for single-entry lookup)
 *   limit        : 1-100 (default 5) — used when date/orchestrator not provided
 *   lang         : "en" (default) | "fr"
 *
 * Backend :
 *   diary:get   — when date + orchestrator provided
 *   diary:list  — when only orchestrator provided or no params (recent entries)
 *
 * Output : HTML card wrapped in <div class="vp-diary-entry"> with embedded CSS.
 * WCAG AA + bilingual FR+EN labels.
 */
// Minimal escape — avoid XSS in injected content
function esc(s) {
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
function renderEntryCard(entry, lang) {
    const highlightsLabel = lang === "fr" ? "Points clés" : "Highlights";
    const blockersLabel = lang === "fr" ? "Bloquants" : "Blockers";
    const highlightsHtml = entry.highlights && entry.highlights.length > 0
        ? `<div class="vp-diary-section">
      <strong>${esc(highlightsLabel)}</strong>
      <ul>${entry.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
    </div>`
        : "";
    const blockersHtml = entry.blockers && entry.blockers.length > 0
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
export async function renderDiaryEntry(query, fetchConvex) {
    const date = query.get("date") ?? undefined;
    const orchestrator = query.get("orchestrator") ?? undefined;
    const limitRaw = query.get("limit");
    const limitParsed = limitRaw !== null ? Number.parseInt(limitRaw, 10) : Number.NaN;
    const limit = Number.isNaN(limitParsed)
        ? 5
        : Math.min(100, Math.max(1, limitParsed));
    const lang = (query.get("lang") ?? "en").toLowerCase();
    const heading = lang === "fr" ? "Journal VantagePeers" : "VantagePeers Diary";
    const emptyLabel = lang === "fr"
        ? "Aucune entrée de journal trouvée."
        : "No diary entry found.";
    let entries = [];
    try {
        if (date && orchestrator) {
            // Single-entry lookup
            const result = (await fetchConvex("diary:get", {
                date,
                orchestrator,
            }));
            entries = result ? [result] : [];
        }
        else {
            // List mode
            const args = { limit };
            if (orchestrator)
                args.orchestrator = orchestrator;
            const result = (await fetchConvex("diary:list", args));
            entries = Array.isArray(result) ? result : [];
        }
    }
    catch (err) {
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
    const countLabel = lang === "fr"
        ? `${entries.length} entrée${entries.length === 1 ? "" : "s"}`
        : `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
    return `<div class="vp-diary-entry" role="region" aria-label="${esc(heading)}">
  ${style}
  ${cards}
  <div class="vp-diary-count" aria-live="polite">${esc(countLabel)}</div>
</div>`;
}
