import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EXCLUDED_ROLES,
	assertSecretPathOutsideRepo,
	decideStation,
	envVarNameFor,
	errorCode,
	orgSlugFromClaims,
	parseArgs,
	validateStations,
	writeSecretFile,
} from "../lib/station-agents.mjs";

describe("parseArgs", () => {
	it("parses value and boolean flags, both --k v and --k=v", () => {
		const a = parseArgs(["--stations", "s.json", "--secrets-dir=/x", "--dry-run", "--rotate"]);
		expect(a).toMatchObject({ stations: "s.json", secretsDir: "/x", dryRun: true, rotate: true, phase: "auto" });
	});
	it("rejects unknown flags, missing values and bad phases", () => {
		expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
		expect(() => parseArgs(["--stations"])).toThrow(/requires a value/);
		expect(() => parseArgs(["--stations", "--dry-run"])).toThrow(/requires a value/);
		expect(() => parseArgs(["--dry-run=1"])).toThrow(/takes no value/);
		expect(() => parseArgs(["--phase", "blue"])).toThrow(/auto\|red\|green/);
	});
});

describe("validateStations", () => {
	it("normalises role, defaults instanceId to {role}-vps", () => {
		expect(validateStations([{ role: " Eta " }])).toEqual([{ role: "eta", agentName: "eta", instanceId: "eta-vps" }]);
	});
	it("keeps an explicit instanceId and agentName override", () => {
		expect(validateStations([{ role: "pi", instanceId: "pi-chromebook", agentName: "pi" }])[0].instanceId).toBe("pi-chromebook");
	});
	it("refuses the excluded BU (Marie / Iris RH), as role and as agentName", () => {
		for (const r of EXCLUDED_ROLES) expect(() => validateStations([{ role: r }])).toThrow(/excluded/);
		expect(() => validateStations([{ role: "eta", agentName: "victor" }])).toThrow(/excluded/);
	});
	it("refuses non-arrays, empty arrays, bad names and duplicates", () => {
		expect(() => validateStations({})).toThrow(/non-empty JSON array/);
		expect(() => validateStations([])).toThrow(/non-empty JSON array/);
		expect(() => validateStations([{ role: "Bad Name" }])).toThrow(/not a valid agent name/);
		expect(() => validateStations([{ role: "eta" }, { role: "ETA" }])).toThrow(/duplicate/);
		expect(() => validateStations([{ role: "eta", instanceId: "" }])).toThrow(/instanceId/);
	});
});

describe("decideStation (idempotence)", () => {
	const agent = { _id: "a1", isActive: true };
	it("no row: register + mint", () => {
		expect(decideStation({ agent: null, status: { hasActiveCredential: false } })).toMatchObject({ register: true, mint: true });
	});
	it("row without credential: mint only, never re-register", () => {
		expect(decideStation({ agent, status: { hasActiveCredential: false } })).toMatchObject({ register: false, mint: true });
	});
	it("row with active credential: skip (a mint would rotate the live holder out)", () => {
		expect(decideStation({ agent, status: { hasActiveCredential: true, activeRows: 1 } })).toMatchObject({ register: false, mint: false });
	});
	it("--rotate turns the skip into a mint, still no register", () => {
		expect(decideStation({ agent, status: { hasActiveCredential: true }, rotate: true })).toMatchObject({ register: false, mint: true });
	});
	it("inactive row: blocked, never revived", () => {
		expect(decideStation({ agent: { ...agent, isActive: false }, status: { hasActiveCredential: false } })).toMatchObject({ blocked: true, register: false, mint: false });
	});
	it("a second run after a first run does nothing (idempotent)", () => {
		const first = decideStation({ agent: null, status: { hasActiveCredential: false } });
		expect(first.mint).toBe(true);
		const second = decideStation({ agent, status: { hasActiveCredential: true } });
		expect(second).toMatchObject({ register: false, mint: false });
	});
});

describe("orgSlugFromClaims", () => {
	it("uses the same precedence as withOrgScope and refuses a token with no org claim", () => {
		expect(orgSlugFromClaims({ org_id: "id", org_slug: "slug" })).toBe("slug");
		expect(orgSlugFromClaims({ organizationSlug: "camel", org_slug: "snake" })).toBe("camel");
		expect(() => orgSlugFromClaims({ sub: "u" })).toThrow(/no org-slug claim/);
	});
});

describe("secrets handling", () => {
	it("envVarNameFor names the variable, never a value", () => {
		expect(envVarNameFor("eta")).toBe("ETA_AGENT_SECRET");
		expect(envVarNameFor("pi-grok")).toBe("PI_GROK_AGENT_SECRET");
	});
	it("refuses a secrets dir inside the repository, accepts one outside", () => {
		expect(() => assertSecretPathOutsideRepo("/repo/.secrets", "/repo")).toThrow(/inside the repository/);
		expect(() => assertSecretPathOutsideRepo("/repo", "/repo")).toThrow(/inside the repository/);
		expect(assertSecretPathOutsideRepo("/secure/x", "/repo")).toBe("/secure/x");
		expect(assertSecretPathOutsideRepo("/repo-other/x", "/repo")).toBe("/repo-other/x");
	});
	it("writeSecretFile writes mode 0600 and returns only the path", () => {
		const dir = join(mkdtempSync(join(tmpdir(), "stn-")), "out");
		const p = writeSecretFile(dir, "eta", "s3cr3t-value");
		expect(p).toBe(join(dir, "eta.secret"));
		expect(statSync(p).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(readFileSync(p, "utf-8")).toBe("s3cr3t-value\n");
	});
});

describe("errorCode", () => {
	it("extracts the stable code from a ConvexError payload and from a message", () => {
		expect(errorCode({ data: "AGENT_CREDENTIAL_REQUIRED: sender x" })).toBe("AGENT_CREDENTIAL_REQUIRED");
		expect(errorCode({ message: "Server Error AGENT_IDENTITY_MISMATCH: y" })).toBe("AGENT_IDENTITY_MISMATCH");
		expect(errorCode({ data: 'RBAC_DENIED: x {"reason":"sender-not-on-roster"}' })).toBe("RBAC_DENIED(sender-not-on-roster)");
		expect(errorCode(new Error("boom"))).toBe("UNCLASSIFIED");
	});
});

describe("no secret reaches stdout", () => {
	it("the mint and prove scripts never log a secret-bearing variable", () => {
		for (const f of ["mint-station-agents.mjs", "prove-station-agent-credential.mjs"]) {
			const src = readFileSync(join(import.meta.dirname, "..", f), "utf-8");
			const logged = src.split("\n").filter((l) => /console\.(log|error)/.test(l));
			for (const line of logged) {
				// `secret` may only appear as the NAME of a file/var, never interpolated as a value
				expect(line).not.toMatch(/\$\{\s*(secret|pos\.secret|piSecret)\s*\}/);
				expect(line).not.toMatch(/agentCredentialSecret/);
			}
		}
	});
	it("a minted secret passed through writeSecretFile never appears in the returned path", () => {
		const dir = mkdtempSync(join(tmpdir(), "stn-"));
		const secret = "deadbeef".repeat(8);
		expect(writeSecretFile(dir, "zeta", secret)).not.toContain(secret);
	});
});
