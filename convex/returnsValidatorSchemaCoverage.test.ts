// ─────────────────────────────────────────────────────────────────────────────
// returnsValidatorSchemaCoverage.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// DERIVED class-of-class check (Pi scope order, task k17cap70165sy8ce2snqknm99d8cq15x).
//
// The defect this generalizes: a Convex `returns:` validator that enumerates a
// stored document (has `_id: v.id("<table>")`) but omits a field the table's
// `schema.ts` declares. Any row carrying that field throws ReturnsValidationError
// at runtime. Nothing compares a returns validator to the schema it claims to
// describe — this test IS that comparison, run mechanically over the real files
// on disk (not a hand-copied field list).
//
// Design:
//   1. Parse convex/schema.ts at test time with the TypeScript compiler API to
//      derive, per table, the set of field names declared in `defineTable({...})`.
//      This is re-read every run — add a field to schema.ts and this test picks
//      it up with zero edits here (see the "is derived, not enumerated" test
//      below, which proves it against a scratch copy).
//   2. For every target module, parse the file and walk every `v.object({...})`
//      literal reachable from a `returns:` property of a `query`/`mutation`/
//      `internalQuery`/`internalMutation` call (following v.union/v.array/
//      v.optional wrappers and local `const` aliases). A `v.object({...})` that
//      declares `_id: v.id("<table>")` is a validator describing a stored
//      document of that table.
//   3. For each such validator, diff its declared keys against the table's
//      schema-declared keys. COVERS = superset. MISSING = schema field missing
//      from the validator and not in the allowlist below → this is the live
//      defect class; either fix (declare the field) or allowlist with a reason.
//      PROJECTION = the missing fields are explicitly allowlisted below with a
//      one-line reason, i.e. a declared decision rather than an accident.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = join(__dirname);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Derive table -> declared field names from convex/schema.ts
// ─────────────────────────────────────────────────────────────────────────────

function parseSourceFile(filePath: string): ts.SourceFile {
	const text = readFileSync(filePath, "utf8");
	return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function objectLiteralKeys(obj: ts.ObjectLiteralExpression): string[] {
	const keys: string[] = [];
	for (const prop of obj.properties) {
		if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
			const name = prop.name;
			if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
				keys.push(name.text);
			}
		}
	}
	return keys;
}

/** Derive { tableName -> Set<fieldName> } by reading defineSchema({ ...defineTable({...}) }) */
function deriveSchemaFields(schemaPath: string): Map<string, Set<string>> {
	const sf = parseSourceFile(schemaPath);
	const result = new Map<string, Set<string>>();

	function visit(node: ts.Node) {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineSchema") {
			const arg = node.arguments[0];
			if (arg && ts.isObjectLiteralExpression(arg)) {
				for (const prop of arg.properties) {
					if (!ts.isPropertyAssignment(prop)) continue;
					const nameNode = prop.name;
					const tableName = ts.isIdentifier(nameNode)
						? nameNode.text
						: ts.isStringLiteral(nameNode)
							? nameNode.text
							: undefined;
					if (!tableName) continue;

					// The value is a `defineTable({...}).index(...).index(...)` chain.
					// Walk down the expression chain to find the defineTable(...) call.
					let expr: ts.Expression = prop.initializer;
					let defineTableCall: ts.CallExpression | undefined;
					while (true) {
						if (
							ts.isCallExpression(expr) &&
							ts.isIdentifier(expr.expression) &&
							expr.expression.text === "defineTable"
						) {
							defineTableCall = expr;
							break;
						}
						if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
							expr = expr.expression.expression;
							continue;
						}
						break;
					}
					if (defineTableCall) {
						const shape = defineTableCall.arguments[0];
						if (shape && ts.isObjectLiteralExpression(shape)) {
							result.set(tableName, new Set(objectLiteralKeys(shape)));
						}
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);
	return result;
}

const SCHEMA_PATH = join(CONVEX_DIR, "schema.ts");
const schemaFields = deriveSchemaFields(SCHEMA_PATH);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Extract document-shaped `returns:` validators from a module file
// ─────────────────────────────────────────────────────────────────────────────

interface DocValidatorMatch {
	/** exported const name of the query/mutation, e.g. "listActive" */
	exportName: string;
	/** local const identifier that held this object literal, if any (disambiguates
	 * multiple document shapes returned from the same export, e.g. a
	 * fields=lite|full union with two named validators). */
	alias: string | undefined;
	table: string;
	declaredKeys: Set<string>;
}

const QUERY_LIKE = new Set(["query", "mutation", "internalQuery", "internalMutation"]);

/** Resolve `v.id("table")` -> "table" if node matches that shape. */
function idTableName(node: ts.Expression): string | undefined {
	if (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === "id"
	) {
		const arg = node.arguments[0];
		if (arg && ts.isStringLiteral(arg)) return arg.text;
	}
	return undefined;
}

function extractDocMatchesFromFile(filePath: string): DocValidatorMatch[] {
	const sf = parseSourceFile(filePath);
	const matches: DocValidatorMatch[] = [];

	// Map of local const name -> its initializer expression, for resolving
	// `returns: someAliasedValidator` and validators nested via aliases.
	const constMap = new Map<string, ts.Expression>();

	function collectConsts(node: ts.Node) {
		if (ts.isVariableStatement(node)) {
			for (const decl of node.declarationList.declarations) {
				if (ts.isIdentifier(decl.name) && decl.initializer) {
					constMap.set(decl.name.text, decl.initializer);
				}
			}
		}
		ts.forEachChild(node, collectConsts);
	}
	collectConsts(sf);

	function resolve(expr: ts.Expression, depth = 0): ts.Expression {
		if (depth > 10) return expr;
		if (ts.isIdentifier(expr) && constMap.has(expr.text)) {
			return resolve(constMap.get(expr.text) as ts.Expression, depth + 1);
		}
		return expr;
	}

	/** Walk a returns-validator expression, collecting every document-shaped v.object({...}) found. */
	function walkForDocObjects(
		expr: ts.Expression,
		out: DocValidatorMatch[],
		exportName: string,
		alias: string | undefined,
		depth = 0,
	) {
		if (depth > 20) return;
		const nextAlias = ts.isIdentifier(expr) ? expr.text : alias;
		const resolved = resolve(expr);

		if (ts.isCallExpression(resolved) && ts.isPropertyAccessExpression(resolved.expression)) {
			const method = resolved.expression.name.text;
			if (method === "object") {
				const objArg = resolved.arguments[0];
				if (objArg && ts.isObjectLiteralExpression(objArg)) {
					let table: string | undefined;
					for (const prop of objArg.properties) {
						if (
							ts.isPropertyAssignment(prop) &&
							ts.isIdentifier(prop.name) &&
							prop.name.text === "_id"
						) {
							table = idTableName(resolve(prop.initializer));
						}
					}
					if (table) {
						out.push({
							exportName,
							alias: nextAlias,
							table,
							declaredKeys: new Set(objectLiteralKeys(objArg)),
						});
					}
					// Recurse into nested property values too — document shapes can
					// nest inside arrays/unions inside a field (rare, but be safe).
					for (const prop of objArg.properties) {
						if (ts.isPropertyAssignment(prop)) {
							walkForDocObjects(prop.initializer, out, exportName, undefined, depth + 1);
						}
					}
				}
				return;
			}
			if (method === "union" || method === "array" || method === "optional") {
				for (const arg of resolved.arguments) {
					walkForDocObjects(arg, out, exportName, nextAlias, depth + 1);
				}
				return;
			}
		}
	}

	function visit(node: ts.Node) {
		if (
			ts.isVariableStatement(node) &&
			node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
		) {
			for (const decl of node.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
				const exportName = decl.name.text;
				const init = decl.initializer;
				if (
					ts.isCallExpression(init) &&
					ts.isIdentifier(init.expression) &&
					QUERY_LIKE.has(init.expression.text)
				) {
					const configArg = init.arguments[0];
					if (configArg && ts.isObjectLiteralExpression(configArg)) {
						for (const prop of configArg.properties) {
							if (
								ts.isPropertyAssignment(prop) &&
								ts.isIdentifier(prop.name) &&
								prop.name.text === "returns"
							) {
								walkForDocObjects(prop.initializer, matches, exportName, undefined);
							}
						}
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);
	return matches;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Intentional projections allowlist — every declared omission needs a reason.
//    Key: "<module>.<exportName>" or, when the same export returns more than
//    one document shape (e.g. a fields=lite|full union), the alias-qualified
//    "<module>.<exportName>#<localConstName>" form. Every entry below was
//    verified against the handler body: the handler explicitly constructs
//    the narrowed object (never `ctx.db.get()`/spreads the raw row), so the
//    omission can never surface a field at runtime — it is a declared
//    decision, not the accidental-omission defect class this test targets.
// ─────────────────────────────────────────────────────────────────────────────

const INTENTIONAL_PROJECTIONS: Record<string, { fields: string[]; reason: string }> = {
	"receiptTenantBackfill._receiptsForCaller": {
		fields: ["messageId", "recipientInstanceId", "readAt"],
		reason:
			"Deliberately narrow both-directions isolation-proof projection (_id/recipient/tenantId) for the #1257 receipt-tenant backfill — the test authenticates as a scoped identity and asserts it reads only its own tenant's rows; the full receipt shape (messageId/recipientInstanceId/readAt) is irrelevant to that proof. Handler maps to this shape explicitly, never spreads the raw row.",
	},
	"receiptTenantBackfill._undefinedTenantReceiptPage": {
		fields: ["messageId", "tenantId", "readAt"],
		reason:
			"Deliberately narrow page-reader projection (_id/recipient/recipientInstanceId) for the #1257 backfill's one-shot scan — the resolver keys ONLY on the recipient; tenantId is undefined by construction on this population (it is what the backfill sets), and messageId/readAt are irrelevant to tenant resolution. Handler maps to this shape explicitly, never spreads the raw row.",
	},
	"episodes.listEpisodes": {
		fields: ["type", "instanceId", "relations", "ttl", "updatedAt", "contentHash"],
		reason:
			"Deliberately narrows the memories row to the episode-relevant subset (namespace/createdBy/content/isLatest/createdAt/episode) for a cross-orchestrator episode feed — type is implied by the presence of `episode`. Handler constructs the object explicitly. contentHash is the OKF-import idempotency hash (R-18) — an internal write-dedup key, never part of an episode feed.",
	},
	"episodes.getCriticalInsights": {
		fields: ["type", "content", "instanceId", "relations", "isLatest", "ttl", "episode", "updatedAt", "contentHash"],
		reason:
			"Cross-namespace critical-insight digest deliberately flattens to namespace/createdBy/insight/context/createdAt — not the full memory row. Handler constructs the object explicitly. contentHash is the OKF-import idempotency hash (R-18) — an internal write-dedup key, never part of an insight digest.",
	},
	"profiles.getProfileWithMemories#memorySnippetValidator": {
		fields: ["namespace", "instanceId", "relations", "isLatest", "ttl", "episode", "updatedAt", "contentHash"],
		reason:
			"`memorySnippetValidator` is a named, deliberately narrow snippet shape (_id/type/content/createdBy/createdAt) for the profile+recent-memories combo query. Handler maps to this shape explicitly, never spreads the raw row. contentHash is the OKF-import idempotency hash (R-18) — an internal write-dedup key, never part of a profile snippet.",
	},
	"businessUnits.list#liteValidator": {
		fields: [
			"description",
			"purpose",
			"domain",
			"businessModel",
			"targetCustomers",
			"services",
			"pricing",
			"revenueProjections",
			"coreTeam",
			"coreProcesses",
			"dependencies",
			"kpis",
			"managementFee",
			"createdAt",
			"updatedAt",
		],
		reason:
			"`fields: \"lite\"|\"full\"` API (documented at the `list` query) — `liteValidator` is the deliberate lite projection; `buObject` (the full shape, in the same union) already COVERS.",
	},
	"components.list#componentLiteObject": {
		fields: ["content", "version", "project", "createdBy", "createdAt", "updatedAt"],
		reason:
			"Same `fields: \"lite\"|\"full\"` API as businessUnits.list — `componentLiteObject` is the deliberate lite projection; `componentFullObject` (in the same union) already COVERS.",
	},
	"githubRepoMapping.list#repoMappingLiteObject": {
		fields: ["active", "lastDeployedSHA", "lastDeployedAt"],
		reason:
			"Same `fields: \"lite\"|\"full\"` API — `repoMappingLiteObject` is the deliberate lite projection; `repoMappingFullObject` (in the same union) already COVERS.",
	},
	"fixPatterns.get": {
		fields: ["patternId"],
		reason:
			"The nested `attempts` array in fixPatterns.get is scoped to one already-known pattern — patternId is self-evidently the parent pattern's own id, so the handler's explicit per-attempt mapping omits it as redundant, not accidental.",
	},
	"fixPatterns.listByStack": {
		fields: ["files", "linkedIssueIds", "createdBy", "updatedAt"],
		reason:
			"Full-text-stack-scan listing deliberately returns a narrower shape than listAll/listByProject (no array index in Convex for `stack`, so this is a display-only fallback). Handler constructs the object explicitly field-by-field, never spreads the raw row.",
	},
	"issueClosedSweepDb.listActiveMissionsForSweep": {
		fields: [
			"description",
			"project",
			"priority",
			"pilot",
			"agents",
			"startDate",
			"targetDate",
			"progress",
			"createdBy",
			"createdAt",
			"updatedAt",
			"orgId",
			"cancelledBy",
			"cancelReason",
		],
		reason:
			"Internal cron-sweep helper (internalMutation) deliberately returns only _id/name/brief/status — the minimum needed to decide which missions to cascade-close. Handler constructs the object explicitly from `OPEN_STATUSES` batches, never spreads the raw row.",
	},
	"issueStatsQueries.getLatest": {
		fields: ["issueDetails"],
		reason:
			"Handler explicitly destructures out `issueDetails` (`({ issueDetails, ...rest }) => rest`) — the per-issue detail array is large and callers of getLatest only need the aggregate stats.",
	},
	"issues.listExternalOpen": {
		fields: [
			"body",
			"htmlUrl",
			"labels",
			"priority",
			"project",
			"fixCommits",
			"fixedBy",
			"fixedAt",
			"verifiedBy",
			"verifiedAt",
			"linkedTaskIds",
			"githubCreatedAt",
			"githubUpdatedAt",
			"externalIssueNumber",
			"forkRepo",
		],
		reason:
			"External PR/issue tracker listing deliberately returns a display-only subset (repo/issueNumber/title/status/externalRepo/externalIssueUrl/prUrl/prStatus/assignedOrchestrator). Handler maps explicitly, never spreads the raw row.",
	},
	"oauth.listClients#clientPublicShape": {
		fields: ["clientSecretHash", "tokenEndpointAuthMethod"],
		reason:
			"`clientPublicShape` is a named, deliberate security projection — clientSecretHash must never leave the server. Handler maps explicitly, never spreads the raw row.",
	},
	"oauthDcr.listClientsInWindow": {
		fields: ["clientSecret", "redirectUris", "createdAt", "scope"],
		reason:
			"Internal backfill/window-audit helper (internalQuery) deliberately returns only _id/_creationTime/clientId/clientName — the minimum needed to identify clients created in a time window. Also excludes the secret. Handler maps explicitly.",
	},
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. Enumerate candidate modules mechanically (every .ts file in convex/ that
//    is not a generated file, not a test file, and exports at least one
//    query/mutation/internalQuery/internalMutation). This makes the module
//    list itself derived, not a hand-picked 12.
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync } from "node:fs";

function listCandidateModules(): string[] {
	return readdirSync(CONVEX_DIR)
		.filter((f) => f.endsWith(".ts"))
		.filter((f) => !f.endsWith(".test.ts"))
		.filter((f) => f !== "schema.ts")
		.filter((f) => !f.startsWith("_generated"))
		.sort();
}

interface ClassificationEntry {
	module: string;
	exportName: string;
	alias: string | undefined;
	table: string;
	status: "COVERS" | "MISSING" | "PROJECTION";
	missing: string[];
	reason?: string;
}

function classifyModule(fileName: string): ClassificationEntry[] {
	const filePath = join(CONVEX_DIR, fileName);
	const moduleName = fileName.replace(/\.ts$/, "");
	const matches = extractDocMatchesFromFile(filePath);
	const entries: ClassificationEntry[] = [];

	for (const m of matches) {
		const declared = schemaFields.get(m.table);
		if (!declared) {
			// Table not found in schema (shouldn't happen for a valid v.id("table"))
			continue;
		}
		const missing = [...declared].filter((f) => !m.declaredKeys.has(f));
		if (missing.length === 0) {
			entries.push({
				module: moduleName,
				exportName: m.exportName,
				alias: m.alias,
				table: m.table,
				status: "COVERS",
				missing: [],
			});
			continue;
		}
		// Allowlist key tries the alias-qualified form first (disambiguates
		// multiple shapes returned from the same export, e.g. fields=lite|full),
		// falling back to the bare export key.
		const allowKeyAliased = m.alias ? `${moduleName}.${m.exportName}#${m.alias}` : undefined;
		const allowKeyBare = `${moduleName}.${m.exportName}`;
		const allow =
			(allowKeyAliased && INTENTIONAL_PROJECTIONS[allowKeyAliased]) ?? INTENTIONAL_PROJECTIONS[allowKeyBare];
		if (allow && missing.every((f) => allow.fields.includes(f))) {
			entries.push({
				module: moduleName,
				exportName: m.exportName,
				alias: m.alias,
				table: m.table,
				status: "PROJECTION",
				missing,
				reason: allow.reason,
			});
		} else {
			entries.push({
				module: moduleName,
				exportName: m.exportName,
				alias: m.alias,
				table: m.table,
				status: "MISSING",
				missing,
			});
		}
	}
	return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run the classification once and print it (VERIFICATION #1).
// ─────────────────────────────────────────────────────────────────────────────

const candidateModules = listCandidateModules();
const allEntries: ClassificationEntry[] = candidateModules.flatMap(classifyModule);

// biome-ignore lint: intentional diagnostic output for the derived classification report
console.log(
	"\n=== returns-validator schema coverage classification ===\n" +
		allEntries
			.map((e) => {
				const label = e.alias ? `${e.module}.${e.exportName}#${e.alias}` : `${e.module}.${e.exportName}`;
				if (e.status === "COVERS") return `COVERS      ${label} -> ${e.table}`;
				if (e.status === "PROJECTION")
					return `PROJECTION  ${label} -> ${e.table} (allowlisted: ${e.missing.join(", ")}) reason: ${e.reason}`;
				return `MISSING     ${label} -> ${e.table} missing: ${e.missing.join(", ")}`;
			})
			.join("\n") +
		"\n=== end classification ===\n",
);

describe("returns validator schema coverage (derived, class-of-class check)", () => {
	test("every document-shaped returns validator covers its table's schema fields, or is an allowlisted projection", () => {
		const offenders = allEntries.filter((e) => e.status === "MISSING");
		expect(
			offenders,
			`The following returns validators enumerate a stored document but omit schema-declared fields (not allowlisted as intentional projections):\n${offenders
				.map((o) => `  - ${o.module}.${o.exportName} -> ${o.table} missing: [${o.missing.join(", ")}]`)
				.join("\n")}`,
		).toEqual([]);
	});

	test("at least one document-shaped validator was found (the check is exercising real files, not vacuously passing)", () => {
		expect(allEntries.length).toBeGreaterThan(0);
	});

	test("schema field derivation covers the known tables (sanity check on the parser, not a hand-copied list)", () => {
		expect(schemaFields.has("tasks")).toBe(true);
		expect(schemaFields.has("memories")).toBe(true);
		expect(schemaFields.get("tasks")?.has("blockedOnTaskId")).toBe(true);
	});

	test("is DERIVED from schema.ts, not enumerated — adding a field to a scratch copy of schema.ts is picked up with zero edits to this test", () => {
		// Prove the parser reads schema.ts at runtime by feeding it a scratch
		// copy with an extra field appended to `businessUnits` and confirming
		// the derived field set includes it — no field list in this test file
		// was touched to make that assertion pass.
		const original = readFileSync(SCHEMA_PATH, "utf8");
		const scratchPath = join(CONVEX_DIR, "__scratch_schema_for_derivation_proof.ts");
		const mutated = original.replace(
			"businessUnits: defineTable({\n\t\tname: v.string(),",
			"businessUnits: defineTable({\n\t\tname: v.string(),\n\t\t__scratchProbeField: v.optional(v.string()),",
		);
		expect(mutated).not.toEqual(original); // sanity: the replace actually matched

		const { writeFileSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(scratchPath, mutated, "utf8");
		try {
			const scratchFields = deriveSchemaFields(scratchPath);
			expect(scratchFields.get("businessUnits")?.has("__scratchProbeField")).toBe(true);
			// The real (untouched) parse must NOT have this field — proves the
			// two reads are independent and nothing was hand-copied.
			expect(schemaFields.get("businessUnits")?.has("__scratchProbeField")).toBe(false);
		} finally {
			unlinkSync(scratchPath);
		}
	});
});
