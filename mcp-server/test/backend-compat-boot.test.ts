/**
 * BACKEND-COMPAT BOOT CHECK -- the MCP refuses to serve against a Convex
 * backend that lacks a function it calls.
 *
 * Task k1716jehh2mhy4xah4js2804g58g4nsc (part 3). 2026-10-12: Railway deployed
 * main (calling oauth:rotateRefreshToken and passing new arguments) while
 * Convex prod was an older build; clients failed for hours. The MCP now asks
 * the backend for its contract manifest (convex/meta.ts `backendContract`)
 * before it serves, and exits non-zero when any function it calls is missing,
 * so Railway's healthcheck keeps the previous deployment serving.
 *
 * Poles (each asserted against the REAL ConvexHttpClient over a local HTTP
 * backend, so the error text classified here is the transport's, not a mock's):
 *   (a) a backend missing ONE called function  -> refuses and NAMES it
 *   (b) a backend without the manifest door    -> refuses ("no contract manifest")
 *   (c) the current backend manifest           -> serves
 * Plus: refused / cannot-authenticate / version / malformed / unreachable are
 * each their own message (a refusal is not an absence), the called-function
 * list is pinned to the source, and both entry points are wired before they
 * serve.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import ts from "typescript";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	BACKEND_CONTRACT_VERSION,
	BACKEND_FUNCTIONS,
} from "../../convex/lib/backendManifest";
import {
	MCP_CALLED_FUNCTIONS,
	REQUIRED_CONTRACT_VERSION,
	bootCheckOrExit,
	checkBackendCompat,
} from "../src/backendContract";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(MCP_ROOT, "..");

// ─────────────────────────────────────────────────────────────────────────────
// A local backend that speaks the Convex HTTP query protocol.
// ─────────────────────────────────────────────────────────────────────────────

type Handler = (path: string, body: unknown) => unknown;
const servers: Server[] = [];

async function backend(handler: Handler): Promise<string> {
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			const out = handler(String(req.url), raw ? JSON.parse(raw) : undefined);
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(out));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
	);
	vi.restoreAllMocks();
});

const NOT_FOUND = {
	status: "error",
	errorMessage:
		"[Request ID: abc123] Server Error\nCould not find public function for 'meta:backendContract'. Did you forget to run `npx convex dev` or `npx convex deploy`?",
};

const manifestOf = (functions: readonly string[], contractVersion = 1) => ({
	status: "success",
	value: { contractVersion, functions, functionCount: functions.length },
});

const withoutOne = (name: string) =>
	BACKEND_FUNCTIONS.filter((f) => f !== name);

async function clientFor(handler: Handler) {
	return new ConvexHttpClient(await backend(handler));
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNC -- the MCP's called-function list is pinned to its source
// ─────────────────────────────────────────────────────────────────────────────

function sourceFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (["__tests__", "node_modules", "dist", "convex"].includes(e.name))
					continue;
				walk(p);
			} else if (
				p.endsWith(".ts") &&
				!p.endsWith(".test.ts") &&
				// The list itself is not a call site: scanning it would make this
				// test a tautology.
				p !== join(MCP_ROOT, "src", "backendContract.ts")
			)
				out.push(p);
		}
	};
	walk(join(MCP_ROOT, "src"));
	out.push(join(MCP_ROOT, "server.ts"), join(MCP_ROOT, "server-http.ts"));
	return out;
}

/** Module names published by the backend's api.d.ts. */
function convexModules(): Set<string> {
	const text = readFileSync(
		join(REPO_ROOT, "convex", "_generated", "api.d.ts"),
		"utf8",
	);
	const names = new Set<string>();
	for (const m of text.matchAll(/^import type \* as [\w$]+ from "\.\.\/([^"]+)\.js";/gm))
		names.add(m[1]);
	return names;
}

/**
 * Every string literal in MCP source that names `<convex module>:<export>`, and
 * every `api.<module>.<fn>` reference. Comments are not code: the AST skips them.
 */
function calledFunctionsInSource(): Map<string, string> {
	const modules = convexModules();
	const found = new Map<string, string>();
	for (const file of sourceFiles()) {
		const sf = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const visit = (n: ts.Node) => {
			if (ts.isStringLiteralLike(n)) {
				const m = /^([\w/]+):(\w+)$/.exec(n.text);
				if (m && modules.has(m[1]))
					found.set(n.text, relative(REPO_ROOT, file));
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return found;
}

describe("SYNC -- MCP_CALLED_FUNCTIONS is exactly what the source calls", () => {
	test("the source names at least the functions the MCP is known to call", () => {
		const called = calledFunctionsInSource();
		for (const known of [
			"oauth:rotateRefreshToken",
			"tasks:create",
			"search:recall",
			"okfBundleNode:importOkfBundle",
			"kbMutations:claimUpload",
		])
			expect(called.has(known), `${known} not found in source`).toBe(true);
	});

	test("no call site is missing from the list, and no list entry is dead", () => {
		const called = calledFunctionsInSource();
		const listed = new Set<string>(MCP_CALLED_FUNCTIONS);
		const unlisted = [...called.keys()]
			.filter((f) => !listed.has(f))
			.map((f) => `${f} (${called.get(f)})`);
		const dead = [...listed].filter((f) => !called.has(f));
		expect(
			{ unlisted, dead },
			"update MCP_CALLED_FUNCTIONS in mcp-server/src/backendContract.ts",
		).toEqual({ unlisted: [], dead: [] });
	});

	test("the list is sorted, unique, well-formed", () => {
		expect([...MCP_CALLED_FUNCTIONS]).toEqual(
			[...new Set(MCP_CALLED_FUNCTIONS)].sort(),
		);
		for (const f of MCP_CALLED_FUNCTIONS)
			expect(f).toMatch(/^[A-Za-z0-9_/]+:[A-Za-z0-9_]+$/);
	});

	test("every function the MCP calls is in the CURRENT backend manifest", () => {
		const manifest = new Set<string>(BACKEND_FUNCTIONS);
		const absent = MCP_CALLED_FUNCTIONS.filter((f) => !manifest.has(f));
		expect(absent).toEqual([]);
		expect(REQUIRED_CONTRACT_VERSION).toBeLessThanOrEqual(
			BACKEND_CONTRACT_VERSION,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The three poles, over real HTTP through the real client
// ─────────────────────────────────────────────────────────────────────────────

describe("checkBackendCompat -- three poles", () => {
	test("(c) the current backend manifest -> compatible", async () => {
		const seen: unknown[] = [];
		const c = await clientFor((path, body) => {
			seen.push({ path, body });
			return manifestOf(BACKEND_FUNCTIONS, BACKEND_CONTRACT_VERSION);
		});
		const r = await checkBackendCompat(c, { sleep: async () => {} });
		expect(r).toMatchObject({ ok: true, checked: MCP_CALLED_FUNCTIONS.length });
		// The door was asked by name, with no argument at all.
		expect(JSON.stringify(seen)).toContain("meta:backendContract");
		expect(JSON.stringify(seen)).toContain('"args":[{}]');
	});

	test("(a) a backend missing ONE called function -> refuses and names it", async () => {
		const c = await clientFor(() =>
			manifestOf(withoutOne("oauth:rotateRefreshToken")),
		);
		const r = await checkBackendCompat(c, { sleep: async () => {} });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe("missing-functions");
		expect(r.missing).toEqual(["oauth:rotateRefreshToken"]);
		expect(r.message).toContain("oauth:rotateRefreshToken");
	});

	test("(a') several missing functions are all named", async () => {
		const gone = ["tasks:create", "search:recall", "oauth:createClient"];
		const c = await clientFor(() =>
			manifestOf(BACKEND_FUNCTIONS.filter((f) => !gone.includes(f))),
		);
		const r = await checkBackendCompat(c, { sleep: async () => {} });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect([...(r.missing ?? [])].sort()).toEqual([...gone].sort());
		for (const g of gone) expect(r.message).toContain(g);
	});

	test("(b) a backend with no manifest door -> refuses: no contract manifest", async () => {
		const c = await clientFor(() => NOT_FOUND);
		const r = await checkBackendCompat(c, { sleep: async () => {} });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe("no-manifest");
		expect(r.message).toMatch(/backend has no contract manifest/i);
	});
});

describe("checkBackendCompat -- every other failure says what it is", () => {
	test("RBAC_DENIED is a refusal, not 'no manifest'", async () => {
		const c = await clientFor(() => ({
			status: "error",
			errorMessage: "[Request ID: x] Server Error",
			errorData:
				'RBAC_DENIED: "meta:backendContract" admits the MCP-bound fleet service account only',
			errorStatus: "ConvexError",
		}));
		const r = await checkBackendCompat(c, { sleep: async () => {} });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe("refused");
		expect(r.message).toContain("RBAC_DENIED");
		expect(r.message).not.toMatch(/no contract manifest/i);
	});

	test("a missing service-account identity is its own reason", async () => {
		const c = {
			query: async () => {
				throw new Error(
					"[mcp-server] no service-account identity available (CLERK_SECRET_KEY / CLERK_SERVICE_ACCOUNT_USER_ID not configured) — refusing to send an unauthenticated Convex query()",
				);
			},
		};
		const r = await checkBackendCompat(c, { sleep: async () => {} });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe("cannot-authenticate");
	});

	test("a backend older than the required contract version -> refuses", async () => {
		const c = await clientFor(() =>
			manifestOf(BACKEND_FUNCTIONS, REQUIRED_CONTRACT_VERSION - 1),
		);
		const r = await checkBackendCompat(c, { sleep: async () => {} });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe("version-too-old");
	});

	test.each([
		["a non-object", { status: "success", value: "ok" }],
		["no function list", { status: "success", value: { contractVersion: 1 } }],
		[
			"a non-string entry",
			{ status: "success", value: { contractVersion: 1, functions: [1] } },
		],
		[
			"no version",
			{ status: "success", value: { functions: ["a:b"] } },
		],
	])("a malformed manifest (%s) -> refuses, never passes", async (_n, out) => {
		const c = await clientFor(() => out);
		const r = await checkBackendCompat(c, { sleep: async () => {} });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe("malformed");
	});

	test("an unreachable backend is retried 3 times, then refuses as unreachable", async () => {
		const query = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		const sleeps: number[] = [];
		const r = await checkBackendCompat(
			{ query },
			{ sleep: async (ms) => void sleeps.push(ms) },
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe("unreachable");
		expect(query).toHaveBeenCalledTimes(4);
		expect(sleeps).toEqual([1000, 2000, 4000]);
	});

	test("a transient blip that then succeeds passes", async () => {
		let n = 0;
		const query = vi.fn(async () => {
			n += 1;
			if (n === 1) throw new TypeError("fetch failed");
			return {
				contractVersion: BACKEND_CONTRACT_VERSION,
				functions: [...BACKEND_FUNCTIONS],
				functionCount: BACKEND_FUNCTIONS.length,
			};
		});
		const r = await checkBackendCompat({ query }, { sleep: async () => {} });
		expect(r.ok).toBe(true);
	});

	test("deterministic refusals are NOT retried", async () => {
		const query = vi.fn(async () => {
			throw new Error("Could not find public function for 'meta:backendContract'");
		});
		await checkBackendCompat({ query }, { sleep: async () => {} });
		expect(query).toHaveBeenCalledTimes(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// bootCheckOrExit -- loud, names the functions, exits non-zero
// ─────────────────────────────────────────────────────────────────────────────

describe("bootCheckOrExit", () => {
	test("incompatible backend: logs the missing names loudly and exits 1", async () => {
		const c = await clientFor(() =>
			manifestOf(withoutOne("oauth:rotateRefreshToken")),
		);
		const lines: string[] = [];
		const exit = vi.fn();
		await bootCheckOrExit(c, {
			label: "http",
			log: (m) => lines.push(m),
			exit: exit as never,
			sleep: async () => {},
		});
		expect(exit).toHaveBeenCalledWith(1);
		const text = lines.join("\n");
		expect(text).toContain("BACKEND INCOMPATIBLE");
		expect(text).toContain("oauth:rotateRefreshToken");
	});

	test("no manifest: exits 1 with the no-manifest message", async () => {
		const c = await clientFor(() => NOT_FOUND);
		const lines: string[] = [];
		const exit = vi.fn();
		await bootCheckOrExit(c, {
			label: "http",
			log: (m) => lines.push(m),
			exit: exit as never,
			sleep: async () => {},
		});
		expect(exit).toHaveBeenCalledWith(1);
		expect(lines.join("\n")).toMatch(/backend has no contract manifest/i);
	});

	test("compatible backend: does not exit, says so", async () => {
		const c = await clientFor(() =>
			manifestOf(BACKEND_FUNCTIONS, BACKEND_CONTRACT_VERSION),
		);
		const lines: string[] = [];
		const exit = vi.fn();
		await bootCheckOrExit(c, {
			label: "http",
			log: (m) => lines.push(m),
			exit: exit as never,
			sleep: async () => {},
		});
		expect(exit).not.toHaveBeenCalled();
		expect(lines.join("\n")).toMatch(/backend compatible/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring -- both entry points check BEFORE they serve
// ─────────────────────────────────────────────────────────────────────────────

const hasBun = spawnSync("bun", ["--version"]).status === 0;

describe("wiring", () => {
	test("server-http.ts runs the boot check before Bun.serve", () => {
		const src = readFileSync(join(MCP_ROOT, "server-http.ts"), "utf8");
		const check = src.indexOf("bootCheckOrExit(");
		const serve = src.indexOf("Bun.serve(");
		expect(check).toBeGreaterThan(-1);
		expect(serve).toBeGreaterThan(check);
	});

	test("server.ts (stdio) runs the boot check before serveStdio", () => {
		const src = readFileSync(join(MCP_ROOT, "server.ts"), "utf8");
		const check = src.indexOf("bootCheckOrExit(");
		const serve = src.indexOf("serveStdio(buildServer)");
		expect(check).toBeGreaterThan(-1);
		expect(serve).toBeGreaterThan(check);
	});

	test.skipIf(!hasBun)(
		"a REAL server-http.ts process against an unusable backend never listens and exits non-zero",
		async () => {
			const port = 20000 + Math.floor(Math.random() * 20000);
			const child = spawn("bun", ["server-http.ts"], {
				cwd: MCP_ROOT,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					PORT: String(port),
					CONVEX_URL_INTERNAL: "http://127.0.0.1:1",
					BEARER_SECRET_MASTER: "boot-wiring-test-master",
					PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
					NODE_ENV: "production",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			child.stdout.on("data", (c) => {
				out += c;
			});
			child.stderr.on("data", (c) => {
				out += c;
			});
			const code = await new Promise<number | null>((res) => {
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					res(null);
				}, 25_000);
				child.on("exit", (c) => {
					clearTimeout(timer);
					res(c);
				});
			});
			expect(code, out).not.toBeNull();
			expect(code, out).not.toBe(0);
			expect(out).toMatch(/BACKEND INCOMPATIBLE|BOOT CHECK/);
			expect(out).not.toMatch(/HTTP transport listening/);
		},
		40_000,
	);
});

describe("the rule and the code agree", () => {
	test("the redeploy rule no longer claims auto-deploy on merge and names the boot check", () => {
		const rule = readFileSync(
			join(REPO_ROOT, ".claude", "rules", "railway-mcp-redeploy.md"),
			"utf8",
		);
		expect(rule).not.toMatch(/MCP server auto-deploys on merge to `main`/);
		expect(rule).toMatch(/boot check/i);
		expect(rule).toContain("meta:backendContract");
		expect(rule).toMatch(/Convex (first|prod first)/i);
	});
});
