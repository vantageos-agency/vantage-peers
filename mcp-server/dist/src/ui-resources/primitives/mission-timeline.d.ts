/**
 * mission-timeline primitive — SEP-1865 ui:// resource.
 * Renders a missions timeline for VantagePeers.
 *
 * Query params :
 *   pilot    : pilot name filter (optional)
 *   project  : project filter (optional)
 *   status   : status filter, comma-separated (optional)
 *   limit    : 1-200 (default 20)
 *   lang     : "en" (default) | "fr"
 *
 * Backend : missions:list
 *
 * Output : HTML list wrapped in <div class="vp-mission-timeline"> with embedded CSS.
 * WCAG AA + bilingual FR+EN labels.
 */
export declare function renderMissionTimeline(query: URLSearchParams, fetchConvex: (functionName: string, args: Record<string, unknown>) => Promise<unknown>): Promise<string>;
