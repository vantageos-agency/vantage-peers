/**
 * /health publishes the ACTIVE actor-credential mode AND where it came from.
 *
 * Bare "permissive" is ambiguous: an operator chose it, or nobody set the
 * variable. `source` separates a configuration from an absence. Publication
 * only: the mode decision itself is unchanged (controls 7 and 8 pin that).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../server-http.js";
import {
	ACTOR_CREDENTIAL_MODE_ENV,
	actorCredentialMode,
	_resetUnattributedClaimsForTest,
} from "../src/auth.js";

const SEVEN = [
	"status",
	"service",
	"version",
	"commit",
	"transport",
	"oauth",
	"scopes",
];

let saved: string | undefined;
beforeEach(() => {
	saved = process.env[ACTOR_CREDENTIAL_MODE_ENV];
	_resetUnattributedClaimsForTest(); // clears module-level warnedUnknownMode
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	if (saved === undefined) delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	else process.env[ACTOR_CREDENTIAL_MODE_ENV] = saved;
	vi.restoreAllMocks();
});

async function health(): Promise<{ body: Record<string, unknown>; raw: string }> {
	const res = await app.request("/health");
	expect(res.status).toBe(200);
	const raw = await res.text();
	return { body: JSON.parse(raw), raw };
}
function setEnv(v: string | undefined) {
	if (v === undefined) delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	else process.env[ACTOR_CREDENTIAL_MODE_ENV] = v;
}

describe("/health actor_credential", () => {
	const cases: [string, string | undefined, string, string][] = [
		["1 unset", undefined, "permissive", "unset"],
		["2 strict", "strict", "strict", "configured"],
		["3 permissive (configured, same mode bytes as case 1)", "permissive", "permissive", "configured"],
		["4 whitespace", "  ", "permissive", "empty"],
		["5 banana", "banana", "strict", "coerced"],
	];
	for (const [name, env, mode, source] of cases) {
		it(`${name}: mode=${mode} source=${source}`, async () => {
			setEnv(env);
			const { body } = await health();
			expect(body.actor_credential).toEqual({ mode, source });
		});
	}

	it("3 vs 1: identical mode, different source (the field earns its place)", async () => {
		setEnv(undefined);
		const a = (await health()).body.actor_credential as { mode: string; source: string };
		setEnv("permissive");
		const b = (await health()).body.actor_credential as { mode: string; source: string };
		expect(a.mode).toBe(b.mode);
		expect(a.source).not.toBe(b.source);
	});

	it("6 the raw value never appears in the response body", async () => {
		setEnv("banana");
		const { raw } = await health();
		expect(raw).not.toContain("banana");
	});

	it("7 (control) actorCredentialMode() unchanged across all five cases", () => {
		const table: [string | undefined, string][] = [
			[undefined, "permissive"],
			["strict", "strict"],
			["permissive", "permissive"],
			["  ", "permissive"],
			["banana", "strict"],
		];
		for (const [env, mode] of table) {
			setEnv(env);
			expect(actorCredentialMode()).toBe(mode);
		}
	});

	it("7b unknown value still warns once through actorCredentialMode()", () => {
		const err = vi.mocked(console.error);
		setEnv("banana");
		actorCredentialMode();
		actorCredentialMode();
		expect(err).toHaveBeenCalledTimes(1);
	});

	it("8 (control) the seven existing keys are still present", async () => {
		setEnv(undefined);
		const { body } = await health();
		for (const k of SEVEN) expect(body).toHaveProperty(k);
		expect(body.status).toBe("ok");
		expect(body.service).toBe("vantage-peers-mcp-http");
		expect(body.transport).toBe("streamable-http");
		expect(body.oauth).toBe("supported");
		expect(body.scopes).toEqual(["mcp:full"]);
	});
});
