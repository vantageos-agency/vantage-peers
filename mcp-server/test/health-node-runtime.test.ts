/**
 * /health names the runtime that is actually serving, and the build
 * declaration pins the patched Node line (task k178pdkzk74t7c8zh9c5d502xx8h26g5).
 *
 * Railway serves this app with Bun (`bun run dist/server-http.js`). Under Bun
 * `process.version` is an EMULATED Node version, so `node` alone misreports the
 * runtime; `runtime` and `bun` are authoritative. The build-declaration tests
 * below pin the build image's Node (engines.node / .node-version), not the
 * server runtime. The pin is exact on purpose: a range (">=20") lets the build
 * image choose, and the October 2026 security release is fixed in v26.12.1.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { app } from "../server-http.js";

const PINNED = "26.12.1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("/health serving runtime", () => {
	it("names the serving runtime and the Bun version", async () => {
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.runtime).toBe(process.versions.bun ? "bun" : "node");
		expect(body.bun).toBe(process.versions.bun ?? null);
	});
	it("keeps process.version under `node` for existing readers", async () => {
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.node).toBe(process.version);
		expect(body.node).toMatch(/^v\d+\.\d+\.\d+$/);
	});
});

describe("build declaration pins the patched Node line", () => {
	it("package.json engines.node is the exact patched version", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		expect(pkg.engines.node).toBe(PINNED);
	});
	it(".node-version carries the same exact version", () => {
		expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toBe(
			PINNED,
		);
	});
});
