/**
 * Module M8 (VantagePeers Cloud): the agent registry selects no agent by name.
 *
 * Source-level pins, read from the files that execute:
 *   1. no source remembers a former label (`formerNames`): a rename writes the
 *      display label only, and a roster that names agents by label resolves to
 *      the agent that carries the label NOW;
 *   2. the three registry files never call the by-name lookup;
 *   3. the by-name lookup has exactly the callers listed below, each owned by
 *      the module whose door still carries a name. A new caller fails here; a
 *      module that moves its door to an ID removes its row (and the lookup is
 *      deleted with the last one).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = resolve(__dirname, "..");

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "__tests__" || entry === "_generated" || entry === "node_modules") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sources(full));
		else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

const read = (file: string) => readFileSync(file, "utf8");

describe("M8 the agent registry selects no agent by name", () => {
	test("no source remembers a former label", () => {
		const holders = sources(CONVEX_DIR).filter((f) => /formerNames/.test(read(f)));
		expect(holders.map((f) => relative(CONVEX_DIR, f))).toEqual([]);
	});

	test("agents.ts, agentCredentials.ts and agentRelations.ts never call the by-name lookup", () => {
		for (const file of ["agents.ts", "agentCredentials.ts", "agentRelations.ts"]) {
			expect(read(join(CONVEX_DIR, file)), file).not.toMatch(/findAgentByName/);
		}
	});

	test("the by-name lookup has exactly the owned callers, nobody else", () => {
		const callers = new Map<string, number>();
		for (const file of sources(CONVEX_DIR)) {
			const rel = relative(CONVEX_DIR, file);
			if (rel === join("lib", "agentIdentity.ts")) continue; // its own definition
			const calls = (read(file).match(/findAgentByName\(/g) ?? []).length;
			if (calls > 0) callers.set(rel, calls);
		}
		expect(Object.fromEntries(callers)).toEqual({
			// M5 messaging: declared sender must hold a credential once it is a known agent
			[join("lib", "auth.ts")]: 3,
			// M5 messaging: seat sender screened against registered labels
			"messages.ts": 2,
			// M6 inbox, two owned sites, neither selects the reader:
			//  - recipient named by a verified organisation (the org-level token door);
			//  - a `recipient` label sent beside a verified agent may only NARROW: it
			//    must resolve, in that agent's own org, to the very agent the verified
			//    claim already fixed (compared by _id). The reader is never chosen by it.
			[join("lib", "inboxReader.ts")]: 2,
			// tasks doors: createdBy / assignedTo labels stamped as IDs
			[join("lib", "actorIds.ts")]: 1,
			// M11 mandates: a legacy row stores only the party's LABEL; fleetPartyId
			// resolves that STORED label once, in the operator org, to the agent ID it
			// is then compared on. The label is read from the row, never from the
			// caller (the caller's acting agent arrives as a verified ID), and a row
			// stamped with an ID never reaches the lookup.
			[join("lib", "fleetActors.ts")]: 1,
		});
	});
});
