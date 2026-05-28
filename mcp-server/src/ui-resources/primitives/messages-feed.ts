/**
 * messages-feed primitive — SEP-1865 ui:// resource.
 * Renders a chronological feed of VantagePeers messages.
 *
 * Query params :
 *   from       : sender name filter (optional)
 *   channel    : channel filter (optional)
 *   limit      : 1-200 (default 20)
 *   lang       : "en" (default) | "fr"
 *
 * Backend : messages:listMessages (args: from?, limit?)
 *
 * Output : HTML feed wrapped in <div class="vp-messages-feed"> with embedded CSS.
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

type MessageRow = {
	_id: string;
	from: string;
	channel?: string;
	content: string;
	createdAt: number;
	_creationTime?: number;
};

export async function renderMessagesFeed(
	query: URLSearchParams,
	fetchConvex: (
		functionName: string,
		args: Record<string, unknown>,
	) => Promise<unknown>,
): Promise<string> {
	const from = query.get("from") ?? undefined;
	const channel = query.get("channel") ?? undefined;
	const limitRaw = query.get("limit");
	const limitParsed =
		limitRaw !== null ? Number.parseInt(limitRaw, 10) : Number.NaN;
	const limit = Number.isNaN(limitParsed)
		? 20
		: Math.min(200, Math.max(1, limitParsed));
	const lang = (query.get("lang") ?? "en").toLowerCase();

	const args: Record<string, unknown> = { limit };
	if (from) args.from = from;

	let messages: MessageRow[] = [];
	try {
		const result = (await fetchConvex(
			"messages:listMessages",
			args,
		)) as MessageRow[];
		const allMessages = Array.isArray(result) ? result : [];
		// Apply channel filter client-side — backend does not support it natively
		messages = channel
			? allMessages.filter((m) => m.channel === channel)
			: allMessages;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return `<div class="vp-messages-feed-error" role="alert">${esc(msg)}</div>`;
	}

	const labels =
		lang === "fr"
			? {
					heading: "Flux de messages VantagePeers",
					from: "De",
					channel: "Canal",
					content: "Message",
					empty: "Aucun message trouvé.",
					count: (n: number) => `${n} message${n === 1 ? "" : "s"}`,
				}
			: {
					heading: "VantagePeers Messages Feed",
					from: "From",
					channel: "Channel",
					content: "Message",
					empty: "No messages found.",
					count: (n: number) => `${n} message${n === 1 ? "" : "s"}`,
				};

	if (messages.length === 0) {
		return `<div class="vp-messages-feed" role="region" aria-label="${esc(labels.heading)}">
  <style>
    .vp-messages-feed { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #1f2328; }
    .vp-messages-feed-empty { color: #656d76; padding: 12px 0; }
  </style>
  <p class="vp-messages-feed-empty">${esc(labels.empty)}</p>
</div>`;
	}

	const rows = messages
		.map(
			(m) => `<tr>
  <td>${esc(m.from || "")}</td>
  <td>${esc(m.channel ?? "")}</td>
  <td>${esc(m.content || "")}</td>
</tr>`,
		)
		.join("\n");

	const countLabel = labels.count(messages.length);

	return `<div class="vp-messages-feed" role="region" aria-label="${esc(labels.heading)}">
  <style>
    .vp-messages-feed { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #1f2328; }
    .vp-messages-feed table { width: 100%; border-collapse: collapse; }
    .vp-messages-feed th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #d0d7de; font-weight: 600; background: #f6f8fa; }
    .vp-messages-feed td { padding: 8px 12px; border-bottom: 1px solid #eaeef2; vertical-align: top; }
    .vp-messages-feed td:nth-child(3) { max-width: 480px; word-break: break-word; }
    .vp-messages-feed-count { color: #656d76; font-size: 12px; margin-top: 8px; }
  </style>
  <table>
    <thead>
      <tr>
        <th scope="col">${esc(labels.from)}</th>
        <th scope="col">${esc(labels.channel)}</th>
        <th scope="col">${esc(labels.content)}</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <div class="vp-messages-feed-count" aria-live="polite">${esc(countLabel)}</div>
</div>`;
}
