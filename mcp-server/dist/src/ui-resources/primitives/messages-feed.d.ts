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
export declare function renderMessagesFeed(query: URLSearchParams, fetchConvex: (functionName: string, args: Record<string, unknown>) => Promise<unknown>): Promise<string>;
