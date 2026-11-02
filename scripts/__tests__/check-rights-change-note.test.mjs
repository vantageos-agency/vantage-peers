import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { judge } from "../check-rights-change-note.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../check-rights-change-note.mjs");

const diffOf = (file, added = [], removed = []) =>
	[
		`diff --git a/${file} b/${file}`,
		`--- a/${file}`,
		`+++ b/${file}`,
		"@@ -1,1 +1,1 @@",
		...removed.map((l) => `-${l}`),
		...added.map((l) => `+${l}`),
	].join("\n");

describe("judge", () => {
	it("REFUSES a change to seatNamespace.ts with no note", () => {
		const r = judge({
			diffText: diffOf("convex/lib/seatNamespace.ts", ["roots.push(x);"]),
			messages: "fix: admit a root",
		});
		expect(r.verdict).toBe("refuse");
		expect(r.touched).toEqual(["convex/lib/seatNamespace.ts"]);
	});

	it("PASSES the same change with a rights-derivation note in a commit message", () => {
		const r = judge({
			diffText: diffOf("convex/lib/seatNamespace.ts", ["roots.push(x);"]),
			messages: "fix: admit a root\n\nrights-derivation: the lookup derives from the live profile",
		});
		expect(r.verdict).toBe("pass");
	});

	it("PASSES with a rights-migration note on an added line elsewhere in the diff", () => {
		const diff = `${diffOf("convex/lib/seatNamespace.ts", ["roots.push(x);"])}\n${diffOf(
			"docs/notes.md",
			["rights-migration: tokenRightsDrift:inventory lists the 29 live seat tokens"],
		)}`;
		expect(judge({ diffText: diff, messages: "" }).verdict).toBe("pass");
	});

	it("REFUSES a too-short reason", () => {
		const r = judge({
			diffText: diffOf("convex/lib/seatNamespace.ts", ["x"]),
			messages: "rights-derivation: ok",
		});
		expect(r.verdict).toBe("refuse");
	});

	it("does not accept the note written inside the check, its test or the rule", () => {
		const diff = `${diffOf("convex/lib/seatNamespace.ts", ["x"])}\n${diffOf(
			".claude/rules/rights-change-migrates-live-connections.md",
			["rights-derivation: written in the rule file itself, which proves nothing"],
		)}`;
		expect(judge({ diffText: diff, messages: "" }).verdict).toBe("refuse");
	});

	it("auth.ts: a checkNamespace line is the rights surface, an unrelated line is not", () => {
		expect(
			judge({
				diffText: diffOf("mcp-server/src/auth.ts", ["if (checkNamespacePrefix(a, b)) return null;"]),
				messages: "",
			}).verdict,
		).toBe("refuse");
		expect(
			judge({
				diffText: diffOf("mcp-server/src/auth.ts", ["const x = 1;"]),
				messages: "",
			}).verdict,
		).toBe("pass");
	});

	it("schema/oauth: a grant-field line is the rights surface; a foreign line is not", () => {
		expect(
			judge({
				diffText: diffOf("convex/oauth.ts", ["namespaceReadPrefixes: [`orchestrator/${id}`],"]),
				messages: "",
			}).verdict,
		).toBe("refuse");
		expect(
			judge({ diffText: diffOf("convex/oauth.ts", ["const unrelated = 1;"]), messages: "" })
				.verdict,
		).toBe("pass");
	});

	it("PASSES a diff that touches no rights file", () => {
		expect(
			judge({ diffText: diffOf("README.md", ["hello"]), messages: "" }).verdict,
		).toBe("pass");
	});
});

describe("CLI against a real repository", () => {
	const run = (repo, base) => {
		try {
			execFileSync("node", [script, "--repo", repo, "--base", base], {
				encoding: "utf8",
				stdio: "pipe",
			});
			return 0;
		} catch (e) {
			return e.status;
		}
	};
	const git = (repo, ...a) =>
		execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
			encoding: "utf8",
		});

	it("refused (1) without a note, pass (0) with one, cannot judge (2) on an unknown base", () => {
		const repo = mkdtempSync(join(tmpdir(), "rights-note-"));
		try {
			git(repo, "init", "-q", "-b", "main");
			mkdirSync(join(repo, "convex/lib"), { recursive: true });
			writeFileSync(join(repo, "convex/lib/seatNamespace.ts"), "export const a = 1;\n");
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "base");
			git(repo, "checkout", "-q", "-b", "feature");
			writeFileSync(join(repo, "convex/lib/seatNamespace.ts"), "export const a = 2;\n");
			git(repo, "commit", "-qam", "change a root");
			expect(run(repo, "main")).toBe(1);
			git(repo, "commit", "-q", "--allow-empty", "-m", "note\n\nrights-migration: tokenRightsDrift inventory lists the 29 live tokens");
			expect(run(repo, "main")).toBe(0);
			expect(run(repo, "no-such-ref")).toBe(2);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
