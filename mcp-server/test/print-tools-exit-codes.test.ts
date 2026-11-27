import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/print-tools.mjs exit codes: 0 clean, 1 README drifted,
 * 2 could not judge (server did not boot, no tools/list answer,
 * registerTools import failed, markers missing, unknown option).
 *
 * Every pole runs on fixtures in a temp dir through the script's documented
 * env seams (PRINT_TOOLS_SERVER_ENTRY, PRINT_TOOLS_README,
 * PRINT_TOOLS_REGISTER_MODULE); no real build is needed.
 * Applies to VantagePeers Cloud and Self-host alike.
 */
const script = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"scripts",
	"print-tools.mjs",
);
const START = "<!-- tools:start -->";
const END = "<!-- tools:end -->";

let dir: string;
const f = (name: string) => join(dir, name);

function run(args: string[], env: Record<string, string>) {
	return spawnSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, ...env },
	});
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "print-tools-exit-"));
	// A server that dies before answering.
	writeFileSync(f("dead-server.mjs"), "process.exit(1);\n");
	// A server that answers initialize + tools/list with one tool.
	writeFileSync(
		f("fake-server.mjs"),
		`import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.id === undefined) return;
	const result =
		msg.method === "tools/list"
			? { tools: [{ name: "fake_task_tool", description: "Does a fake thing. More.", annotations: { readOnlyHint: true } }] }
			: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`,
	);
	writeFileSync(
		f("register.mjs"),
		`export function registerTools(server) {
	server.tool("fake_task_tool");
	server.tool("fake_hidden_tool");
}
`,
	);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("print-tools.mjs exit codes", () => {
	const fake = () => ({
		PRINT_TOOLS_SERVER_ENTRY: f("fake-server.mjs"),
		PRINT_TOOLS_REGISTER_MODULE: f("register.mjs"),
	});

	it("exit 2 and 'could not judge' when the server dies at boot (--check)", () => {
		writeFileSync(f("r-boot.md"), `${START}\n${END}\n`);
		const r = run(["--check"], {
			...fake(),
			PRINT_TOOLS_SERVER_ENTRY: f("dead-server.mjs"),
			PRINT_TOOLS_README: f("r-boot.md"),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("could not judge");
	});

	it("exit 2 on a boot failure in print mode too", () => {
		const r = run([], {
			...fake(),
			PRINT_TOOLS_SERVER_ENTRY: f("dead-server.mjs"),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("could not judge");
	});

	it("exit 2 when the registerTools module cannot be imported", () => {
		writeFileSync(f("r-imp.md"), `${START}\n${END}\n`);
		const r = run(["--check"], {
			...fake(),
			PRINT_TOOLS_REGISTER_MODULE: f("missing.mjs"),
			PRINT_TOOLS_README: f("r-imp.md"),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("could not judge");
	});

	it("exit 2 on an unknown option and on missing markers", () => {
		writeFileSync(f("r-nomark.md"), "no markers here\n");
		const unknown = run(["--bogus"], fake());
		expect(unknown.status).toBe(2);
		const nomark = run(["--check"], {
			...fake(),
			PRINT_TOOLS_README: f("r-nomark.md"),
		});
		expect(nomark.status).toBe(2);
	});

	it("exit 0 when the README block matches, exit 1 when it differs", () => {
		const printed = run([], fake());
		expect(printed.status).toBe(0);
		const block = printed.stdout.trimEnd();
		expect(block).toContain("fake_task_tool");
		writeFileSync(f("r-ok.md"), `# x\n${START}\n${block}\n${END}\n`);
		const ok = run(["--check"], {
			...fake(),
			PRINT_TOOLS_README: f("r-ok.md"),
		});
		expect(ok.status).toBe(0);
		writeFileSync(f("r-drift.md"), `# x\n${START}\nsomething else\n${END}\n`);
		const drift = run(["--check"], {
			...fake(),
			PRINT_TOOLS_README: f("r-drift.md"),
		});
		expect(drift.status).toBe(1);
		expect(drift.stderr).toContain("stale");
	});
});
