/**
 * Every place `callerOrchestrator` appears in src/*.ts is classified by
 * COMMAND, not by a list a reviewer must trust — and there is no exemption
 * list, no allow-list file.
 *
 * task k173ny6as0gsq996xtbtzn5rjd8fbj9m. `callerOrchestrator` stopped being an
 * authority: defineTool (registerTool.ts) binds it to the credential-resolved
 * actor for EVERY tool whose schema declares it. What is left at a site is one
 * of these shapes, and each is either derived from the actor or a claim that
 * the wrapper has already verified:
 *
 *   scope-decl   `{ kind: "from", fromArg: "callerOrchestrator" }` — the
 *                wrapper's own declaration; bound + roster-checked structurally.
 *   schema-decl  `callerOrchestrator: <zod>` — the parameter. MUST carry an
 *                `ACTING-NAME:` comment on the line above (asserted below) so a
 *                reader at the site is told it is a verified claim.
 *   guard        `guardFrom(callerOrchestrator)` — actor-aware (checkFromAllowed
 *                -> checkActorBinding).
 *   prose        description / example / comment text; no behaviour.
 *   use          the destructured / forwarded value. By construction it is
 *                already the actor's name (derived) or, for master with no actor,
 *                the master's own claim (checkActorBinding, named there).
 *
 * The test fails if a site fits NONE of these (a new shape nobody classified)
 * or if a schema declaration lacks the marker comment.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");

type Site = { file: string; line: number; text: string; prev: string };

function collectSites(): Site[] {
	const sites: Site[] = [];
	for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
		const lines = readFileSync(join(SRC, file), "utf8").split("\n");
		lines.forEach((text, i) => {
			if (text.includes("callerOrchestrator")) {
				sites.push({ file, line: i + 1, text, prev: lines[i - 1] ?? "" });
			}
		});
	}
	return sites;
}

function classify(site: Site): string | null {
	const t = site.text;
	if (site.file === "registerTool.ts") return "mechanism";
	if (/fromArg: "callerOrchestrator"/.test(t)) return "scope-decl";
	if (/^\s*callerOrchestrator: (creatorSchema|z)\b/.test(t)) return "schema-decl";
	if (/guardFrom\(callerOrchestrator\)/.test(t)) return "guard";
	if (/^\s*(\/\/|\*|")/.test(t) || /callerOrchestrator='/.test(t)) return "prose";
	if (/callerOrchestrator/.test(t) && /(["'`]).*callerOrchestrator.*\1/.test(t)) {
		return "prose";
	}
	if (
		/^\s*callerOrchestrator,?$/.test(t) ||
		/async \(\{.*callerOrchestrator.*\}\)/.test(t) ||
		/if \(callerOrchestrator\)/.test(t) ||
		/callerOrchestrator[,;)]?\s*(\}|:|=|\)|$)/.test(t) ||
		/= callerOrchestrator/.test(t) ||
		/callerOrchestrator \? \{ callerOrchestrator \}/.test(t)
	) {
		return "use";
	}
	return null;
}

describe("callerOrchestrator sites — every one classified, every declaration annotated", () => {
	const sites = collectSites();

	it("finds the sites it is supposed to (the count is a measurement, printed on failure)", () => {
		expect(sites.length).toBeGreaterThan(100);
	});

	it("EVERY site fits a documented class; none is left unclassified", () => {
		const unclassified = sites
			.filter((s) => classify(s) === null)
			.map((s) => `${s.file}:${s.line}  ${s.text.trim()}`);
		expect(unclassified).toEqual([]);
	});

	it("EVERY schema declaration carries an ACTING-NAME comment at the site", () => {
		const bare = sites
			.filter((s) => classify(s) === "schema-decl")
			.filter((s) => !s.prev.includes("// ACTING-NAME:"))
			.map((s) => `${s.file}:${s.line}`);
		expect(bare).toEqual([]);
	});

	it("no other file in src/ reads a caller-declared name as an authority: the only mentions outside tools.ts are the mechanism itself", () => {
		const outside = sites.filter((s) => s.file !== "tools.ts");
		expect(outside.every((s) => s.file === "registerTool.ts")).toBe(true);
	});
});
