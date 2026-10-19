/**
 * The two backend-doctor baselines cannot diverge silently (task
 * k172gy1ykcbz6drqb4n85q5a1n8gkaf3). `.backend-doctor/ratchet.json` (read by
 * scripts/doctor-ratchet.mjs at merge) and `.claude/config/backend-doctor-baseline.json`
 * (read by the deploy gate) are two copies of one measurement. Measured on #1544:
 * the deploy baseline moved to doctor 0.4.7 / CR-2 264 while ratchet.json still read
 * 0.4.5 / CR-2 200, and the merge ratchet refused 0.4.7 evidence without naming why.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RATCHET = join(REPO, ".backend-doctor", "ratchet.json");
const DEPLOY = join(REPO, ".claude", "config", "backend-doctor-baseline.json");

const ratchet = JSON.parse(readFileSync(RATCHET, "utf8"));
const deploy = JSON.parse(readFileSync(DEPLOY, "utf8"));

describe("the merge ratchet and the deploy gate read the same baseline", () => {
	it("both name the same backend-doctor version", () => {
		expect(typeof ratchet.doctorVersion).toBe("string");
		expect(ratchet.doctorVersion).toBe(deploy.doctor_version);
	});

	it("every rule has the same count in both (a rule absent from one counts 0 there)", () => {
		const rules = [
			...new Set([
				...Object.keys(ratchet.counts ?? {}),
				...Object.keys(deploy.rules ?? {}),
			]),
		].sort();
		const read = (rule) => ({
			rule,
			ratchet: ratchet.counts?.[rule] ?? 0,
			deploy: deploy.rules?.[rule]?.count ?? 0,
		});
		const rows = rules.map(read);
		expect(rows.filter((r) => r.ratchet !== r.deploy)).toEqual([]);
		// The comparison is not vacuous: the six mechanical rules are present.
		for (const rule of ["CR-2", "R-5", "R-53", "R-54", "R-55", "R-56"]) {
			expect(rule in (ratchet.counts ?? {})).toBe(true);
			expect(rule in (deploy.rules ?? {})).toBe(true);
		}
	});
});
