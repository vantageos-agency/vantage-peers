/**
 * tasks-table primitive — SEP-1865 ui:// resource.
 * Renders compact HTML table of VantagePeers tasks.
 *
 * Query params :
 *   assignedTo : creator name (optional filter)
 *   status     : single status, alias (open|active|all), or comma-separated array (e.g. "todo,in_progress")
 *   fields     : "lite" (default) | "full"
 *   limit      : 1-200 (default 20)
 *   createdBy  : creator filter (optional)
 *
 * Output : HTML <table> wrapped in <div class="vp-tasks-table"> with embedded CSS.
 * Scoped via :host selector for Shadow DOM root rendering by Claude Desktop / vantage-bridge sidepanel.
 *
 * WCAG AA + bilingual FR+EN labels (parametrized via lang query param).
 */
export declare function renderTasksTable(query: URLSearchParams, fetchConvex: (functionName: string, args: Record<string, unknown>) => Promise<unknown>): Promise<string>;
