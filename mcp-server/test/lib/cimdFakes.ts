/**
 * Stand-ins for the network pieces of src/clientMetadataDocument.ts. Nothing
 * here touches the internet: DNS answers and HTTP responses are scripted.
 *
 * The module under test is loaded through `loadCimd()` (a variable import) so
 * that, before the module exists, every test fails on its own assertion
 * rather than the whole file failing to resolve.
 */

import type {
	FetchDeps,
	PinnedRequest,
	PinnedResponse,
} from "../../src/clientMetadataDocument.js";

export type CimdModule = typeof import("../../src/clientMetadataDocument.js");

export async function loadCimd(): Promise<CimdModule> {
	const path = "../../src/clientMetadataDocument.js";
	return (await import(/* @vite-ignore */ path)) as CimdModule;
}

export const DOC_URL = "https://app.example.com/oauth/client-metadata.json";
export const PUBLIC_IP = "93.184.216.34";

export function validDocument(
	over: Record<string, unknown> = {},
	url = DOC_URL,
): Record<string, unknown> {
	return {
		client_id: url,
		client_name: "Example MCP Client",
		redirect_uris: ["https://app.example.com/callback"],
		grant_types: ["authorization_code"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		...over,
	};
}

export function bodyOf(
	...chunks: (string | Uint8Array)[]
): AsyncIterable<Uint8Array> {
	return (async function* () {
		for (const c of chunks)
			yield typeof c === "string" ? new TextEncoder().encode(c) : c;
	})();
}

/** A body that sends a first chunk and then never finishes. */
export function stallingBody(first: string): AsyncIterable<Uint8Array> {
	return (async function* () {
		yield new TextEncoder().encode(first);
		await new Promise(() => undefined);
	})();
}

export type Script = {
	/** hostname -> answers; defaults to one public address. */
	dns?: Record<string, { address: string; family: number }[]>;
	/** the response for the next GET; a function is called per GET. */
	respond?: (
		req: PinnedRequest,
	) => Partial<PinnedResponse> | Promise<Partial<PinnedResponse>>;
	timeoutMs?: number;
	maxBytes?: number;
	now?: () => number;
};

export type Recorder = {
	requests: PinnedRequest[];
	dnsQueries: string[];
	destroyed: number;
	deps: Partial<FetchDeps>;
};

export function scripted(script: Script = {}): Recorder {
	const rec: Recorder = {
		requests: [],
		dnsQueries: [],
		destroyed: 0,
		deps: {},
	};
	rec.deps = {
		resolveHost: async (hostname) => {
			rec.dnsQueries.push(hostname);
			return script.dns?.[hostname] ?? [{ address: PUBLIC_IP, family: 4 }];
		},
		get: async (req) => {
			rec.requests.push(req);
			const r = script.respond
				? await script.respond(req)
				: { body: bodyOf(JSON.stringify(validDocument())) };
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body: bodyOf(""),
				destroy: () => {
					rec.destroyed++;
				},
				...r,
			};
		},
		...(script.timeoutMs !== undefined ? { timeoutMs: script.timeoutMs } : {}),
		...(script.maxBytes !== undefined ? { maxBytes: script.maxBytes } : {}),
		...(script.now ? { now: script.now } : {}),
	};
	return rec;
}
