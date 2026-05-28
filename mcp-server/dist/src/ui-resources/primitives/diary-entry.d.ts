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
export declare function renderDiaryEntry(query: URLSearchParams, fetchConvex: (functionName: string, args: Record<string, unknown>) => Promise<unknown>): Promise<string>;
