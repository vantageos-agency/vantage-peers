/**
 * HTTP startup logs name the port and paths, never the bound hostname.
 * VantagePeers Cloud and Self-host. mcp-doctor DServer6 (C-6: never log
 * internal system detail). Task k170z6dkshhs6kycqtjdjxkmd98jwb6g.
 *
 * Class: any console.* call in server-http.ts whose arguments interpolate
 * server.hostname or HOSTNAME (the bind address is internal infrastructure).
 * Source of the call forms: the console.* call expressions in the file itself,
 * scanned by paren matching, so a multi-line template literal is covered.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../server-http.ts"), "utf8");

function consoleCalls(src: string): string[] {
	const calls: string[] = [];
	const re = /console\.(log|info|warn|error|debug)\(/g;
	let m: RegExpExecArray | null = re.exec(src);
	while (m !== null) {
		let depth = 1;
		let i = m.index + m[0].length;
		while (i < src.length && depth > 0) {
			if (src[i] === "(") depth++;
			else if (src[i] === ")") depth--;
			i++;
		}
		if (depth !== 0)
			throw new Error(`unbalanced console call at offset ${m.index}`);
		calls.push(src.slice(m.index, i));
		m = re.exec(src);
	}
	return calls;
}

describe("server-http startup logs", () => {
	const calls = consoleCalls(source);

	it("positive control: the scanner finds the startup log calls", () => {
		expect(calls.some((c) => c.includes("HTTP transport listening"))).toBe(
			true,
		);
	});

	it("no console call interpolates server.hostname or HOSTNAME", () => {
		const offenders = calls.filter((c) =>
			/server\.hostname|\bHOSTNAME\b/.test(c),
		);
		expect(offenders).toEqual([]);
	});

	it("still tells the operator the port and the paths", () => {
		const start = calls
			.filter((c) => c.includes("[vantage-peers-mcp]"))
			.join("\n");
		expect(start).toMatch(/server\.port/);
		expect(start).toMatch(/\/health/);
		expect(start).toMatch(/\/mcp/);
	});
});
