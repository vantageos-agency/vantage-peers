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

type BriefingNoteRow = {
	_id: string;
	topic: string;
	title: string;
	participants?: string[];
	content?: string;
	createdBy?: string;
};

function renderNoteCard(note: BriefingNoteRow, lang: string): string {
	const participantsLabel = lang === "fr" ? "Participants" : "Participants";
	const byLabel = lang === "fr" ? "Par" : "By";

	const participantsHtml =
		note.participants && note.participants.length > 0
			? `<div class="vp-briefing-participants">
      <span class="vp-briefing-label">${esc(participantsLabel)} :</span>
      ${note.participants.map((p) => `<span class="vp-briefing-pill">${esc(p)}</span>`).join(" ")}
    </div>`
			: "";

	const createdByHtml = note.createdBy
		? `<div class="vp-briefing-meta">${esc(byLabel)}: ${esc(note.createdBy)}</div>`
		: "";

	const contentHtml = note.content
		? `<div class="vp-briefing-content">${esc(note.content)}</div>`
		: "";

	return `<article class="vp-briefing-card" aria-label="${esc(note.title)}">
  <header class="vp-briefing-header">
    <span class="vp-briefing-topic">${esc(note.topic)}</span>
    <h3 class="vp-briefing-title">${esc(note.title)}</h3>
  </header>
  ${participantsHtml}
  ${contentHtml}
  ${createdByHtml}
</article>`;
}

export async function renderBriefingNote(
	query: URLSearchParams,
	fetchConvex: (
		functionName: string,
		args: Record<string, unknown>,
	) => Promise<unknown>,
): Promise<string> {
	const noteId = query.get("noteId") ?? undefined;
	const topic = query.get("topic") ?? undefined;
	const limitRaw = query.get("limit");
	const limitParsed =
		limitRaw !== null ? Number.parseInt(limitRaw, 10) : Number.NaN;
	const limit = Number.isNaN(limitParsed)
		? 20
		: Math.min(100, Math.max(1, limitParsed));
	const lang = (query.get("lang") ?? "en").toLowerCase();

	const heading =
		lang === "fr"
			? "Notes de briefing VantagePeers"
			: "VantagePeers Briefing Notes";
	const emptyLabel =
		lang === "fr"
			? "Aucune note de briefing trouvée."
			: "No briefing notes found.";

	let notes: BriefingNoteRow[] = [];

	try {
		if (noteId) {
			const result = (await fetchConvex("briefingNotes:get", {
				noteId,
			})) as BriefingNoteRow | null;
			notes = result ? [result] : [];
		} else {
			const args: Record<string, unknown> = { limit };
			if (topic) args.topic = topic;
			const result = (await fetchConvex(
				"briefingNotes:list",
				args,
			)) as BriefingNoteRow[];
			notes = Array.isArray(result) ? result : [];
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return `<div class="vp-briefing-note-error" role="alert">${esc(msg)}</div>`;
	}

	const style = `<style>
    .vp-briefing-note { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #1f2328; }
    .vp-briefing-card { border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; margin-bottom: 12px; background: #fff; }
    .vp-briefing-header { margin-bottom: 10px; }
    .vp-briefing-topic { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; background: #ddf4ff; color: #0969da; margin-bottom: 6px; }
    .vp-briefing-title { font-size: 14px; font-weight: 600; margin: 0; }
    .vp-briefing-participants { margin-top: 8px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
    .vp-briefing-label { color: #656d76; }
    .vp-briefing-pill { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; background: #f6f8fa; border: 1px solid #d0d7de; }
    .vp-briefing-content { margin-top: 10px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
    .vp-briefing-meta { margin-top: 8px; color: #656d76; font-size: 12px; }
    .vp-briefing-count { color: #656d76; font-size: 12px; margin-top: 8px; }
    .vp-briefing-empty { color: #656d76; padding: 12px 0; }
  </style>`;

	if (notes.length === 0) {
		return `<div class="vp-briefing-note" role="region" aria-label="${esc(heading)}">
  ${style}
  <p class="vp-briefing-empty">${esc(emptyLabel)}</p>
</div>`;
	}

	const cards = notes.map((n) => renderNoteCard(n, lang)).join("\n");
	const countLabel =
		lang === "fr"
			? `${notes.length} note${notes.length === 1 ? "" : "s"}`
			: `${notes.length} note${notes.length === 1 ? "" : "s"}`;

	return `<div class="vp-briefing-note" role="region" aria-label="${esc(heading)}">
  ${style}
  ${cards}
  <div class="vp-briefing-count" aria-live="polite">${esc(countLabel)}</div>
</div>`;
}
