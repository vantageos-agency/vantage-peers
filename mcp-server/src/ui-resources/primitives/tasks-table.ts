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

type TaskRow = {
	_id: string;
	title: string;
	status: string;
	priority?: string;
	assignedTo?: string;
	_creationTime?: number;
};

export async function renderTasksTable(
	query: URLSearchParams,
	fetchConvex: (
		functionName: string,
		args: Record<string, unknown>,
	) => Promise<unknown>,
): Promise<string> {
	const assignedTo = query.get("assignedTo") ?? undefined;
	const statusRaw = query.get("status") ?? undefined;
	const fields = (query.get("fields") ?? "lite") as "lite" | "full";
	const limitRaw = query.get("limit");
	const limitParsed =
		limitRaw !== null ? Number.parseInt(limitRaw, 10) : Number.NaN;
	const limit = Number.isNaN(limitParsed)
		? 20
		: Math.min(200, Math.max(1, limitParsed));
	const createdBy = query.get("createdBy") ?? undefined;
	const lang = (query.get("lang") ?? "en").toLowerCase();

	// status array support (comma-separated) — matches backend tasks.list signature
	let status: string | string[] | undefined;
	if (statusRaw === undefined) {
		status = undefined;
	} else if (statusRaw.includes(",")) {
		status = statusRaw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	} else {
		status = statusRaw;
	}

	const args: Record<string, unknown> = { limit, fields };
	if (assignedTo) args.assignedTo = assignedTo;
	if (status !== undefined) args.status = status;
	if (createdBy) args.createdBy = createdBy;

	let tasks: TaskRow[] = [];
	try {
		const result = (await fetchConvex("tasks:list", args)) as TaskRow[];
		tasks = Array.isArray(result) ? result : [];
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return `<div class="vp-tasks-table-error">${esc(msg)}</div>`;
	}

	const headerLabels =
		lang === "fr"
			? {
					title: "Titre",
					status: "Statut",
					priority: "Priorité",
					assignedTo: "Attribué à",
				}
			: {
					title: "Title",
					status: "Status",
					priority: "Priority",
					assignedTo: "Assigned to",
				};

	const rows = tasks
		.map(
			(t) => `<tr>
  <td>${esc(t.title || "(no title)")}</td>
  <td><span class="vp-status vp-status-${esc(t.status)}">${esc(t.status)}</span></td>
  <td>${esc(t.priority ?? "")}</td>
  <td>${esc(t.assignedTo ?? "")}</td>
</tr>`,
		)
		.join("\n");

	const countLabel =
		lang === "fr"
			? `${tasks.length} tâche${tasks.length === 1 ? "" : "s"}`
			: `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;

	return `<div class="vp-tasks-table" role="region" aria-label="${esc(lang === "fr" ? "Liste des tâches VantagePeers" : "VantagePeers tasks list")}">
  <style>
    .vp-tasks-table { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #1f2328; }
    .vp-tasks-table table { width: 100%; border-collapse: collapse; }
    .vp-tasks-table th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #d0d7de; font-weight: 600; background: #f6f8fa; }
    .vp-tasks-table td { padding: 8px 12px; border-bottom: 1px solid #eaeef2; }
    .vp-tasks-table .vp-status { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
    .vp-status-todo { background: #ddf4ff; color: #0969da; }
    .vp-status-in_progress { background: #fff8c5; color: #9a6700; }
    .vp-status-review { background: #fbefff; color: #8250df; }
    .vp-status-blocked { background: #ffebe9; color: #cf222e; }
    .vp-status-done { background: #dafbe1; color: #1a7f37; }
    .vp-tasks-count { color: #656d76; font-size: 12px; margin-top: 8px; }
  </style>
  <table>
    <thead>
      <tr>
        <th scope="col">${esc(headerLabels.title)}</th>
        <th scope="col">${esc(headerLabels.status)}</th>
        <th scope="col">${esc(headerLabels.priority)}</th>
        <th scope="col">${esc(headerLabels.assignedTo)}</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <div class="vp-tasks-count" aria-live="polite">${esc(countLabel)}</div>
</div>`;
}
