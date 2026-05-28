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

type MissionRow = {
	_id: string;
	name: string;
	project?: string;
	status: string;
	pilot?: string;
	priority?: string;
	progress?: number;
};

export async function renderMissionTimeline(
	query: URLSearchParams,
	fetchConvex: (
		functionName: string,
		args: Record<string, unknown>,
	) => Promise<unknown>,
): Promise<string> {
	const pilot = query.get("pilot") ?? undefined;
	const project = query.get("project") ?? undefined;
	const statusRaw = query.get("status") ?? undefined;
	const limitRaw = query.get("limit");
	const limitParsed =
		limitRaw !== null ? Number.parseInt(limitRaw, 10) : Number.NaN;
	const limit = Number.isNaN(limitParsed)
		? 20
		: Math.min(200, Math.max(1, limitParsed));
	const lang = (query.get("lang") ?? "en").toLowerCase();

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

	const args: Record<string, unknown> = { limit, fields: "lite" };
	if (pilot) args.pilot = pilot;
	if (project) args.project = project;
	if (status !== undefined) args.status = status;

	let missions: MissionRow[] = [];
	try {
		const result = (await fetchConvex("missions:list", args)) as MissionRow[];
		missions = Array.isArray(result) ? result : [];
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return `<div class="vp-mission-timeline-error" role="alert">${esc(msg)}</div>`;
	}

	const labels =
		lang === "fr"
			? {
					heading: "Missions VantagePeers",
					name: "Mission",
					project: "Projet",
					status: "Statut",
					pilot: "Pilote",
					priority: "Priorité",
					progress: "Avancement",
					empty: "Aucune mission trouvée.",
					count: (n: number) => `${n} mission${n === 1 ? "" : "s"}`,
				}
			: {
					heading: "VantagePeers Missions",
					name: "Mission",
					project: "Project",
					status: "Status",
					pilot: "Pilot",
					priority: "Priority",
					progress: "Progress",
					empty: "No missions found.",
					count: (n: number) => `${n} mission${n === 1 ? "" : "s"}`,
				};

	const style = `<style>
    .vp-mission-timeline { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #1f2328; }
    .vp-mission-timeline table { width: 100%; border-collapse: collapse; }
    .vp-mission-timeline th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #d0d7de; font-weight: 600; background: #f6f8fa; }
    .vp-mission-timeline td { padding: 8px 12px; border-bottom: 1px solid #eaeef2; }
    .vp-mission-status { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
    .vp-mission-status-active { background: #fff8c5; color: #9a6700; }
    .vp-mission-status-done { background: #dafbe1; color: #1a7f37; }
    .vp-mission-status-paused { background: #f6f8fa; color: #656d76; }
    .vp-mission-status-planning { background: #ddf4ff; color: #0969da; }
    .vp-mission-progress { height: 6px; background: #eaeef2; border-radius: 3px; overflow: hidden; min-width: 60px; }
    .vp-mission-progress-bar { height: 100%; background: #1a7f37; border-radius: 3px; }
    .vp-mission-count { color: #656d76; font-size: 12px; margin-top: 8px; }
    .vp-mission-empty { color: #656d76; padding: 12px 0; }
  </style>`;

	if (missions.length === 0) {
		return `<div class="vp-mission-timeline" role="region" aria-label="${esc(labels.heading)}">
  ${style}
  <p class="vp-mission-empty">${esc(labels.empty)}</p>
</div>`;
	}

	const rows = missions
		.map((m) => {
			const progressPct =
				m.progress !== undefined
					? Math.min(100, Math.max(0, m.progress))
					: null;
			const progressCell =
				progressPct !== null
					? `<td><div class="vp-mission-progress" role="progressbar" aria-valuenow="${progressPct}" aria-valuemin="0" aria-valuemax="100"><div class="vp-mission-progress-bar" style="width:${progressPct}%"></div></div></td>`
					: "<td></td>";
			return `<tr>
  <td>${esc(m.name || "")}</td>
  <td>${esc(m.project ?? "")}</td>
  <td><span class="vp-mission-status vp-mission-status-${esc(m.status)}">${esc(m.status)}</span></td>
  <td>${esc(m.pilot ?? "")}</td>
  <td>${esc(m.priority ?? "")}</td>
  ${progressCell}
</tr>`;
		})
		.join("\n");

	const countLabel = labels.count(missions.length);

	return `<div class="vp-mission-timeline" role="region" aria-label="${esc(labels.heading)}">
  ${style}
  <table>
    <thead>
      <tr>
        <th scope="col">${esc(labels.name)}</th>
        <th scope="col">${esc(labels.project)}</th>
        <th scope="col">${esc(labels.status)}</th>
        <th scope="col">${esc(labels.pilot)}</th>
        <th scope="col">${esc(labels.priority)}</th>
        <th scope="col">${esc(labels.progress)}</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <div class="vp-mission-count" aria-live="polite">${esc(countLabel)}</div>
</div>`;
}
