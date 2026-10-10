// orgKeyByIdPackage.test.ts - M4: the org-by-ID decisions are @vantageos/cloud-identity's,
// not this repository's (rule one-identity-layer).
//
// This pins the SHAPE of the code, not a behaviour: the local definitions of
// "which org is this credential", "do these two rows name one org", "is this
// stamp the fleet's", "which org is the operator" and "what is this slug's org
// ID" are GONE, and the call sites reach the package. Behaviour is pinned by
// orgKeyById.test.ts and the package's own tests; this test fails the day a
// local copy of any of those decisions comes back.
// Hermetic: reads source text only.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Source text with comments removed, so prose naming a function proves nothing. */
function code(rel: string): string {
	const text = readFileSync(join(CONVEX_DIR, rel), "utf8");
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (
			name === "__tests__" ||
			name === "_generated" ||
			name === "node_modules"
		)
			continue;
		if (statSync(full).isDirectory()) sourceFiles(full, out);
		else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name))
			out.push(relative(CONVEX_DIR, full));
	}
	return out;
}

const LOCAL_DECISIONS = [
	"sameOrgKey",
	"rowInScopeOrg",
	"readCredentialOrgId",
	"sameTenantStamp",
	"isFleetStamp",
	"stampOfScope",
	"audienceForOrgId",
] as const;

const definition = (name: string) =>
	new RegExp(
		`(function\\s+${name}\\b|(const|let|var)\\s+${name}\\b|type\\s+${name}\\b)`,
	);

describe("the org-by-ID decisions live in the package", () => {
	test("no source file in convex/ defines a local copy of a package decision", () => {
		const offenders: string[] = [];
		for (const rel of sourceFiles(CONVEX_DIR)) {
			const text = code(rel);
			for (const name of LOCAL_DECISIONS) {
				if (definition(name).test(text)) offenders.push(`${rel}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("lib/auth.ts no longer defines sameOrgKey / rowInScopeOrg / OrgKey, and calls the package", () => {
		const auth = code("lib/auth.ts");
		for (const name of [
			"sameOrgKey",
			"rowInScopeOrg",
			"readCredentialOrgId",
			"OrgKey",
		]) {
			expect(auth, name).not.toMatch(new RegExp(`\\b${name}\\b`));
		}
		expect(auth).toMatch(/\bresolveOrgFromClaim\(/);
		expect(auth).toMatch(/\bsameOrg\(/);
		expect(auth).toMatch(/from "@vantageos\/cloud-identity"/);
		// the credential's org ID is no longer sniffed here
		expect(auth).not.toMatch(/CLERK_ORG_ID_SHAPE/);
		// the package decides the contradiction; auth.ts only words the refusal
		expect(auth).toMatch(/org-id-contradicts-label/);
	});

	test("lib/operatorOrg.ts finds the operator through the package and defines no stamp comparison", () => {
		const op = code("lib/operatorOrg.ts");
		expect(op).toMatch(/\bfindOperatorOrg\(/);
		expect(op).toMatch(/from "@vantageos\/cloud-identity"/);
		expect(op).not.toMatch(/\.query\(/);
		expect(op).not.toMatch(/orgKind\s*===/);
		expect(op).not.toMatch(/\bsameOrgKey\b/);
	});

	test("lib/repoMappingTenant.ts decides tenant equality through the package", () => {
		const t = code("lib/repoMappingTenant.ts");
		expect(t).toMatch(/\bsameOrg\(/);
		expect(t).toMatch(/\bsameTenantStamp\(/);
		expect(t).not.toMatch(/\bsameOrgKey\b/);
		expect(t).not.toMatch(/orgKind\s*===/);
		expect(t).not.toMatch(/\.query\(/);
	});

	test("lib/orgClerkId.ts derives the ID through the package and reads nothing itself", () => {
		const t = code("lib/orgClerkId.ts");
		expect(t).toMatch(/\bresolveOrgIdForLabel\(/);
		expect(t).not.toMatch(/\.query\(/);
		expect(t).not.toMatch(/\?\?/);
	});

	test("lib/authOrgMapping.ts is storage only: it supplies the adapters and decides nothing", () => {
		const t = code("lib/authOrgMapping.ts");
		expect(t).toMatch(/orgById:/);
		expect(t).toMatch(/orgByLabel:/);
		expect(t).toMatch(/activeOrganisations:/);
		expect(t).not.toMatch(/\bthrow\b/);
		expect(t).not.toMatch(/\bConvexError\b/);
		expect(t).not.toMatch(/\bisMaster\b/);
		expect(t).not.toMatch(/orgKind\s*===/);
	});

	test("the label fallback is switched on in ONE place, and named as transitional", () => {
		const uses: string[] = [];
		for (const rel of sourceFiles(CONVEX_DIR)) {
			if (/labelFallback\s*:\s*true/.test(code(rel))) uses.push(rel);
		}
		expect(uses).toEqual(["lib/authOrgMapping.ts"]);
		const raw = readFileSync(join(CONVEX_DIR, "lib/authOrgMapping.ts"), "utf8");
		expect(raw).toMatch(/TRANSITIONAL/);
	});

	test("every package decision is imported from the package, never from a sibling module", () => {
		const offenders: string[] = [];
		const names = [
			"sameOrg",
			"isFleetStamp",
			"sameTenantStamp",
			"resolveOrgFromClaim",
			"resolveOrgIdForLabel",
		];
		for (const rel of sourceFiles(CONVEX_DIR)) {
			const text = readFileSync(join(CONVEX_DIR, rel), "utf8");
			const imports = text.matchAll(
				/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g,
			);
			for (const m of imports) {
				if (m[2] === "@vantageos/cloud-identity") continue;
				for (const n of names) {
					if (new RegExp(`\\b${n}\\b`).test(m[1]))
						offenders.push(`${rel}: ${n} from ${m[2]}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
