/// <reference types="vite/client" />
/**
 * Task k179y0wpsd6fv7055f4p2w6b358hdrxe — every PUBLIC function inherits the
 * acting-org transport.
 *
 * The organisation a non-master MCP bearer acts for travels as the reserved
 * `__actingOrg` argument and is consumed by the identity layer, never by a door.
 * That only holds if EVERY public query/mutation/action is built by
 * convex/lib/functions.ts, which declares the argument and strips it. A module
 * that imports the bare builder from `_generated/server` would reject the
 * argument (an unknown field fails validation, so the MCP call breaks) or, worse,
 * a later door would be written without it. Two poles:
 *   1. source: no module imports `query`, `mutation` or `action` from
 *      `_generated/server` except convex/lib/functions.ts;
 *   2. runtime: every exported public function's argument validator declares
 *      `__actingOrg` (optional).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name === "_generated" || name === "__tests__") continue;
			out.push(...sourceFiles(full));
		} else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

const BARE_IMPORT =
	/import\s*\{([^}]*)\}\s*from\s*"(?:\.\.?\/)+_generated\/server"/g;

describe("public builders carry the acting-org transport", () => {
	test("pole 1: no module imports a bare public builder from _generated/server", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(CONVEX_DIR)) {
			const rel = relative(CONVEX_DIR, file);
			if (rel === join("lib", "functions.ts")) continue;
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(BARE_IMPORT)) {
				const names = m[1]
					.split(",")
					.map((x) => x.trim())
					.filter((x) => x !== "" && !x.startsWith("type "));
				for (const n of names) {
					const bare = n.split(/\s+as\s+/)[0];
					if (bare === "query" || bare === "mutation" || bare === "action") {
						offenders.push(`${rel}: ${n}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("pole 2: every exported public function declares __actingOrg", async () => {
		const modules = import.meta.glob("../**/*.ts");
		const missing: string[] = [];
		let publicCount = 0;
		for (const [path, load] of Object.entries(modules)) {
			if (
				path.includes("/_generated/") ||
				path.includes("/__tests__/") ||
				path.endsWith(".test.ts") ||
				// The component config only loads inside the Convex runtime; it
				// registers no function.
				path.endsWith("/convex.config.ts")
			) {
				continue;
			}
			const mod = (await load()) as Record<string, unknown>;
			for (const [name, value] of Object.entries(mod)) {
				const fn = value as {
					isPublic?: boolean;
					isQuery?: boolean;
					isMutation?: boolean;
					isAction?: boolean;
					exportArgs?: () => string;
				};
				if (value === null) continue;
				if (typeof value !== "function" && typeof value !== "object") continue;
				if (fn.isPublic !== true) continue;
				if (!(fn.isQuery || fn.isMutation || fn.isAction)) continue;
				publicCount++;
				const exported = JSON.parse(fn.exportArgs?.() ?? "{}") as {
					type?: string;
					value?: Record<string, { optional?: boolean }>;
				};
				const field = exported.value?.__actingOrg;
				if (exported.type !== "object" || field?.optional !== true) {
					missing.push(`${path}:${name}`);
				}
			}
		}
		expect(publicCount).toBeGreaterThan(150);
		expect(missing).toEqual([]);
	}, 120_000);
});
