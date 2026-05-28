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
export declare function renderMemoryQuote(query: URLSearchParams, fetchConvex: (functionName: string, args: Record<string, unknown>) => Promise<unknown>): Promise<string>;
