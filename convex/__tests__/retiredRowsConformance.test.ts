/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// CONFORMANCE for the retired-row class (see convex/lib/retired.ts).
//
//  1. DERIVATION. Every schema field named like a retirement marker is
//     CLASSIFIED below. A new one fails this test until someone decides what it
//     means. Tables classified "erasure" must be keys of RETIREMENT with the same
//     field.
//  2. READ SITES. Every `.query("<erasure table>")` outside migrations/tests is
//     either (a) filtered on the marker within the next WINDOW lines (an
//     `.eq("isLatest", true)` index range, or the helper from lib/retired), or
//     (b) annotated `retirement-read: <reason>` within the 6 lines above. This is
//     a static floor: it sees `.query("t")` sites, not `db.get(id)`; the by-ID
//     reads are pinned by behaviour in retiredRowsNeverReturned.test.ts.
//  3. RAG. `getRag().search(` and `components.rag.search.search` occur only inside
//     the two wrappers of convex/search.ts, and both apply `liveEntriesOnly`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import schema from "../schema";

const CONVEX = join(__dirname, "..");

const FLAG_FIELD =
	/^(isLatest|deleted\w*|isDeleted|softDeleted\w*|retired\w*|superseded\w*|archived\w*|erased\w*|removed\w*|revoked\w*|isActive|active|expired\w*|cancelled\w*|canceledAt|tombstone\w*)$/i;

type Kind = "erasure" | "revocation" | "switch" | "attribution";
// table.field -> [kind, reason]
const CLASSIFIED: Record<string, [Kind, string]> = {
	"memories.isLatest": ["erasure", "superseded or soft-deleted memory/episode/KB chunk"],
	"missionTemplates.deletedAt": ["erasure", "soft-deleted template"],
	"orgMembership.deletedAt": ["erasure", "tombstoned (removed) member"],
	"missions.cancelledBy": ["attribution", "who cancelled; the row's status carries the state and the row stays listed"],
	"missions.cancelledById": ["attribution", "who cancelled; the row stays listed"],
	"tasks.cancelledBy": ["attribution", "who cancelled; the row's status carries the state"],
	"tasks.cancelledById": ["attribution", "who cancelled; the row's status carries the state"],
	"githubRepoMapping.active": ["switch", "mapping enabled/disabled by an admin; still listed to admins"],
	"githubOwnerBindings.active": ["switch", "binding enabled/disabled"],
	"recurringTasks.active": ["switch", "paused/resumed recurring task; deleted ones are db.delete'd"],
	"monitoredDeployments.active": ["switch", "monitor on/off"],
	"errorMonitorFilterRules.active": ["switch", "rule on/off"],
	"oauth_clients.revokedAt": ["revocation", "credential revocation, enforced where the credential is verified (oauth.ts)"],
	"oauth_access_tokens.revokedAt": ["revocation", "credential revocation, enforced at verification"],
	"oauth_refresh_tokens.revokedAt": ["revocation", "credential revocation, enforced at verification"],
	"iframeEmbedSessions.revoked": ["revocation", "session revocation, enforced at verification"],
	"userBearerTokens.revoked": ["revocation", "credential revocation, enforced at verification"],
	"agentLinks.revokedAt": ["revocation", "link revocation, enforced by the package resolver"],
	"agent_credentials.isActive": ["revocation", "credential disabled, enforced at verification"],
	"client_org_mapping.isActive": ["revocation", "tenant switched off: withOrgScope refuses an inactive org"],
	"oauth_denied_document_clients.active": ["switch", "listing on/off; the row stays with its history and every reader asks lib/documentClientDenial"],
	"agents.isActive": ["switch", "seat enabled/disabled; listed to its org's admins"],
};

function flaggedFields(): string[] {
	const out: string[] = [];
	for (const [table, def] of Object.entries(
		(schema as unknown as { tables: Record<string, { validator: { fields?: Record<string, unknown> } }> }).tables,
	)) {
		for (const f of Object.keys(def.validator.fields ?? {})) {
			if (FLAG_FIELD.test(f)) out.push(`${table}.${f}`);
		}
	}
	return out.sort();
}

function sources(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) {
				if (["__tests__", "_generated", "migrations", "node_modules"].includes(name)) continue;
				walk(p);
			} else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("schema.ts")) {
				out.push(p);
			}
		}
	};
	walk(CONVEX);
	return out;
}

describe("1. derivation: every retirement-shaped schema field is classified", () => {
	test("no unclassified field, no stale classification", () => {
		const found = flaggedFields();
		const unclassified = found.filter((f) => !(f in CLASSIFIED));
		const stale = Object.keys(CLASSIFIED).filter((f) => !found.includes(f));
		expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
	});

	test("every erasure table is a RETIREMENT key with the same field, and vice versa", async () => {
		const { RETIREMENT } = await import("../lib/retired");
		const erasure = Object.entries(CLASSIFIED)
			.filter(([, [k]]) => k === "erasure")
			.map(([tf]) => tf)
			.sort();
		const registered = Object.entries(RETIREMENT)
			.map(([t, r]) => `${t}.${r.field}`)
			.sort();
		expect(registered).toEqual(erasure);
	});
});

const ERASURE_TABLES: Record<string, string> = {
	memories: "isLatest",
	missionTemplates: "deletedAt",
	orgMembership: "deletedAt",
};
const WINDOW = 40;

describe("2. read sites of an erasure table filter on the marker or say why not", () => {
	test("every .query(<erasure table>) site is filtered or annotated", () => {
		const bad: string[] = [];
		for (const file of sources()) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				for (const [table, field] of Object.entries(ERASURE_TABLES)) {
					if (!new RegExp(`\\.query\\(\\s*"${table}"\\s*\\)`).test(line)) continue;
					const before = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
					if (before.includes("retirement-read:")) continue;
					const after = lines.slice(Math.max(0, i - 3), i + WINDOW).join("\n");
					const filtered =
						after.includes(`.eq("${field}"`) ||
						after.includes(`RETIREMENT.${table}.field`) ||
						/\b(liveOnly|liveOrNull|isRetired)\(/.test(after);
					if (!filtered) bad.push(`${relative(CONVEX, file)}:${i + 1} ${table}`);
				}
			});
		}
		expect(bad).toEqual([]);
	});
});

describe("3. RAG: one entry point per search, each dropping retired entries", () => {
	const search = readFileSync(join(CONVEX, "search.ts"), "utf8");

	test("getRag().search( and components.rag.search.search occur once each, only in convex/search.ts", () => {
		const hits: string[] = [];
		for (const file of sources()) {
			const text = readFileSync(file, "utf8")
				.split("\n")
				.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
				.join("\n");
			const n =
				(text.match(/getRag\(\)\.search\(/g) ?? []).length +
				(text.match(/components\.rag\.search\.search/g) ?? []).length;
			if (n > 0) hits.push(`${relative(CONVEX, file)}:${n}`);
		}
		expect(hits).toEqual(["search.ts:2"]);
	});

	test("both wrappers apply liveEntriesOnly, and the memory paths apply the row check", () => {
		expect(search).toMatch(/liveEntriesOnly\(await ragSearchEmbeddedRaw\(/);
		expect(search).toMatch(/return liveEntriesOnly\(raw, args\)/);
		expect(search).toMatch(/internal\.kbMutations\.latestMemoryIds/);
	});
});
