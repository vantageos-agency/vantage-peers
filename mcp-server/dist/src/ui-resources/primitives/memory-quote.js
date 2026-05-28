/**
 * memory-quote primitive — SEP-1865 ui:// resource.
 * Renders memory quotes from a VantagePeers namespace.
 *
 * Query params :
 *   namespace  : memory namespace (required)
 *   type       : memory type filter (optional)
 *   limit      : 1-100 (default 10)
 *   lang       : "en" (default) | "fr"
 *
 * Backend : memories:listMemories (args: namespace, type?, limit?)
 *
 * Output : HTML quote cards wrapped in <div class="vp-memory-quote"> with embedded CSS.
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
export async function renderMemoryQuote(query, fetchConvex) {
    const namespace = query.get("namespace") ?? undefined;
    const type = query.get("type") ?? undefined;
    const limitRaw = query.get("limit");
    const limitParsed = limitRaw !== null ? Number.parseInt(limitRaw, 10) : Number.NaN;
    const limit = Number.isNaN(limitParsed)
        ? 10
        : Math.min(100, Math.max(1, limitParsed));
    const lang = (query.get("lang") ?? "en").toLowerCase();
    const heading = lang === "fr" ? "Mémoires VantagePeers" : "VantagePeers Memories";
    const emptyLabel = lang === "fr" ? "Aucune mémoire trouvée." : "No memories found.";
    const noNamespaceLabel = lang === "fr"
        ? "Paramètre requis manquant : namespace."
        : "Missing required parameter: namespace.";
    if (!namespace) {
        return `<div class="vp-memory-quote-error" role="alert">${esc(noNamespaceLabel)}</div>`;
    }
    let memories = [];
    try {
        const args = { namespace, limit };
        if (type)
            args.type = type;
        const result = (await fetchConvex("memories:listMemories", args));
        // listMemories returns either a paginated result or a plain array
        if (Array.isArray(result)) {
            memories = result;
        }
        else if (result &&
            typeof result === "object" &&
            "value" in result &&
            Array.isArray(result.value)) {
            memories = result.value;
        }
        else {
            memories = [];
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `<div class="vp-memory-quote-error" role="alert">${esc(msg)}</div>`;
    }
    const style = `<style>
    .vp-memory-quote { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #1f2328; }
    .vp-memory-card { border-left: 4px solid #8250df; padding: 12px 16px; margin-bottom: 10px; background: #fbefff; border-radius: 0 8px 8px 0; }
    .vp-memory-meta { display: flex; justify-content: space-between; margin-bottom: 6px; }
    .vp-memory-type { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; background: #8250df; color: #fff; }
    .vp-memory-namespace { color: #656d76; font-size: 11px; }
    .vp-memory-content { line-height: 1.6; word-break: break-word; }
    .vp-memory-count { color: #656d76; font-size: 12px; margin-top: 8px; }
    .vp-memory-empty { color: #656d76; padding: 12px 0; }
  </style>`;
    if (memories.length === 0) {
        return `<div class="vp-memory-quote" role="region" aria-label="${esc(heading)}">
  ${style}
  <p class="vp-memory-empty">${esc(emptyLabel)}</p>
</div>`;
    }
    const cards = memories
        .map((m) => `<div class="vp-memory-card">
  <div class="vp-memory-meta">
    <span class="vp-memory-type">${esc(m.type || "")}</span>
    <span class="vp-memory-namespace">${esc(m.namespace || "")}</span>
  </div>
  <div class="vp-memory-content">${esc(m.content || "")}</div>
</div>`)
        .join("\n");
    const countLabel = lang === "fr"
        ? `${memories.length} mémoire${memories.length === 1 ? "" : "s"}`
        : `${memories.length} memor${memories.length === 1 ? "y" : "ies"}`;
    return `<div class="vp-memory-quote" role="region" aria-label="${esc(heading)}">
  ${style}
  ${cards}
  <div class="vp-memory-count" aria-live="polite">${esc(countLabel)}</div>
</div>`;
}
