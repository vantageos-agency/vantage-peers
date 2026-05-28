/**
 * briefing-note primitive — SEP-1865 ui:// resource.
 * Renders a briefing note detail card or list of recent notes.
 *
 * Query params :
 *   noteId   : Convex ID for a specific note (optional)
 *   topic    : topic filter — used when noteId not provided (optional)
 *   limit    : 1-100 (default 20) — used when noteId not provided
 *   lang     : "en" (default) | "fr"
 *
 * Backend :
 *   briefingNotes:get  — when noteId provided
 *   briefingNotes:list — when topic or no params
 *
 * Output : HTML card(s) wrapped in <div class="vp-briefing-note"> with embedded CSS.
 * WCAG AA + bilingual FR+EN labels.
 */
export declare function renderBriefingNote(query: URLSearchParams, fetchConvex: (functionName: string, args: Record<string, unknown>) => Promise<unknown>): Promise<string>;
