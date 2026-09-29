/// <reference types="vite/client" />
/**
 * The word "system" carries authority only where the VERIFIED scope justifies
 * it (task k17df9ahgk021pw7z9b0dtjyzh8fap59).
 *
 * `callerOrchestrator` is an ARGUMENT on the public mutations: a
 * caller-supplied string. Nine sites authorised any caller who typed the seven
 * letters "system" past the OWNERSHIP check (`createdBy === caller`). Every one
 * of them already refused a caller with no organisation, so the defect is
 * INTRA-organisation: member A of org-X skipping the ownership check to
 * delete/update the row of member B of the SAME org. The shared predicate
 * `isFleetSystemCaller` (convex/lib/systemCaller.ts) now requires the VERIFIED
 * master scope as well.
 *
 * Every pole runs under an ORDINARY organisation member (org-a, seats
 * seat-a + seat-b). The master identity appears only in the master-regression
 * tests, never as the subject of a leak or withheld pole.
 *
 *   LEAK      member seat-a types "system" on seat-b's row (same org) -> REFUSED
 *   WITHHELD  member seat-a acts on its OWN row                       -> SUCCEEDS
 *   MASTER    the fleet's verified master, typing "system"            -> SUCCEEDS
 *
 * mandates.* sit behind requireFleetMaster, so an ordinary member is refused
 * before the word is reached; those poles pin that ordering (they pass on the
 * pre-fix tree too — there is nothing to turn RED at the member level).
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { analyse as analyseSystemWord } from "./lib/systemWordAst";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedOrgA(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a", "seat-b"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asMemberOfOrgA(t: T) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: T) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

// ── seeds ───────────────────────────────────────────────────────────────────
async function seedNote(t: T, createdBy: string) {
	return await t.run((ctx) =>
		ctx.db.insert("briefingNotes", {
			title: "seed note",
			topic: "handoff",
			participants: [createdBy],
			content: "seed content",
			createdBy,
			createdAt: Date.now(),
			orgId: "org-a",
		}),
	);
}

async function seedMission(t: T, createdBy: string) {
	return await t.run((ctx) =>
		ctx.db.insert("missions", {
			name: "seed mission",
			project: "p",
			status: "plan",
			priority: "medium",
			pilot: createdBy,
			agents: [createdBy],
			createdBy,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId: "org-a",
		}),
	);
}

async function seedBU(t: T, orchestratorId: string) {
	return await t.run((ctx) =>
		ctx.db.insert("businessUnits", {
			name: `bu-${orchestratorId}`,
			description: "d",
			purpose: "p",
			orchestratorId,
			status: "idea",
			businessModel: "m",
			targetCustomers: "c",
			services: [],
			pricing: "0",
			revenueProjections: { y1: 0, y2: 0, y3: 0 },
			coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
			coreProcesses: [],
			dependencies: [],
			kpis: [],
			managementFee: 10,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
}

async function seedDiary(t: T, orchestrator: string) {
	return await t.run((ctx) =>
		ctx.db.insert("diary", {
			date: "2026-09-29",
			orchestrator,
			content: "seed diary",
			createdAt: Date.now(),
		}),
	);
}

async function seedMessage(t: T, from: string) {
	return await t.run((ctx) =>
		ctx.db.insert("messages", {
			from,
			channel: "seat-x",
			content: "seed message",
			createdAt: Date.now(),
		}),
	);
}

async function seedMandate(t: T) {
	return await t.run((ctx) =>
		ctx.db.insert("mandates", {
			requestedBy: "seat-b",
			fulfilledBy: "seat-b",
			service: "svc",
			budget: 100,
			status: "requested",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
}

// ── briefingNotes.deleteBriefingNote ────────────────────────────────────────
describe("briefingNotes.deleteBriefingNote — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' on seat-b's note (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const noteId = await seedNote(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.briefingNotes.deleteBriefingNote, {
				noteId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/Unauthorized: only seat-b \(creator\)/);
		expect(await t.run((ctx) => ctx.db.get(noteId))).not.toBeNull();
	});

	test("WITHHELD: member seat-a deleting its own note succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const noteId = await seedNote(t, "seat-a");
		const result = await asMemberOfOrgA(t).mutation(
			api.briefingNotes.deleteBriefingNote,
			{ noteId, callerOrchestrator: "seat-a" },
		);
		expect(result.deleted).toBe(true);
		expect(await t.run((ctx) => ctx.db.get(noteId))).toBeNull();
	});

	test("MASTER: the verified master typing 'system' still deletes", async () => {
		const t = createT();
		const noteId = await seedNote(t, "seat-b");
		const result = await asMaster(t).mutation(
			api.briefingNotes.deleteBriefingNote,
			{ noteId, callerOrchestrator: "system" },
		);
		expect(result.deleted).toBe(true);
	});
});

// ── briefingNotes.update ────────────────────────────────────────────────────
describe("briefingNotes.update — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' on seat-b's note (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const noteId = await seedNote(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "system",
				title: "hijacked",
			}),
		).rejects.toThrow(/Unauthorized: system is not creator/);
		const row = await t.run((ctx) => ctx.db.get(noteId));
		expect(row?.title).toBe("seed note");
	});

	test("WITHHELD: member seat-a updating its own note succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const noteId = await seedNote(t, "seat-a");
		await asMemberOfOrgA(t).mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "seat-a",
			title: "mine",
		});
		const row = await t.run((ctx) => ctx.db.get(noteId));
		expect(row?.title).toBe("mine");
	});

	test("MASTER: the verified master typing 'system' still updates", async () => {
		const t = createT();
		const noteId = await seedNote(t, "seat-b");
		await asMaster(t).mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "system",
			title: "by fleet",
		});
		const row = await t.run((ctx) => ctx.db.get(noteId));
		expect(row?.title).toBe("by fleet");
	});
});

// ── businessUnits.update ────────────────────────────────────────────────────
describe("businessUnits.update — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' on seat-b's BU (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const buId = await seedBU(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.businessUnits.update, {
				buId,
				callerOrchestrator: "system",
				description: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED: system is not the owning orchestrator \(seat-b\)/);
		const row = await t.run((ctx) => ctx.db.get(buId));
		expect(row?.description).toBe("d");
	});

	test("WITHHELD: member seat-a updating its own BU succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const buId = await seedBU(t, "seat-a");
		await asMemberOfOrgA(t).mutation(api.businessUnits.update, {
			buId,
			callerOrchestrator: "seat-a",
			description: "mine",
		});
		const row = await t.run((ctx) => ctx.db.get(buId));
		expect(row?.description).toBe("mine");
	});

	test("MASTER: the verified master typing 'system' still updates", async () => {
		const t = createT();
		const buId = await seedBU(t, "seat-b");
		await asMaster(t).mutation(api.businessUnits.update, {
			buId,
			callerOrchestrator: "system",
			description: "by fleet",
		});
		const row = await t.run((ctx) => ctx.db.get(buId));
		expect(row?.description).toBe("by fleet");
	});
});

// ── diary.deleteDiary ───────────────────────────────────────────────────────
describe("diary.deleteDiary — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' on seat-b's entry (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const diaryId = await seedDiary(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.diary.deleteDiary, {
				diaryId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/Unauthorized: only seat-b \(owner\)/);
		expect(await t.run((ctx) => ctx.db.get(diaryId))).not.toBeNull();
	});

	test("WITHHELD: member seat-a deleting its own entry succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const diaryId = await seedDiary(t, "seat-a");
		const result = await asMemberOfOrgA(t).mutation(api.diary.deleteDiary, {
			diaryId,
			callerOrchestrator: "seat-a",
		});
		expect(result.deleted).toBe(true);
		expect(await t.run((ctx) => ctx.db.get(diaryId))).toBeNull();
	});

	test("MASTER: the verified master typing 'system' still deletes", async () => {
		const t = createT();
		const diaryId = await seedDiary(t, "seat-b");
		const result = await asMaster(t).mutation(api.diary.deleteDiary, {
			diaryId,
			callerOrchestrator: "system",
		});
		expect(result.deleted).toBe(true);
	});
});

// ── messages.deleteMessage ──────────────────────────────────────────────────
describe("messages.deleteMessage — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' on seat-b's message (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const messageId = await seedMessage(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.messages.deleteMessage, {
				messageId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/Unauthorized: only seat-b \(sender\)/);
		expect(await t.run((ctx) => ctx.db.get(messageId))).not.toBeNull();
	});

	test("WITHHELD: member seat-a deleting its own message succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const messageId = await seedMessage(t, "seat-a");
		const result = await asMemberOfOrgA(t).mutation(api.messages.deleteMessage, {
			messageId,
			callerOrchestrator: "seat-a",
		});
		expect(result.deleted).toBe(true);
		expect(await t.run((ctx) => ctx.db.get(messageId))).toBeNull();
	});

	test("MASTER: the verified master typing 'system' still deletes", async () => {
		const t = createT();
		const messageId = await seedMessage(t, "seat-b");
		const result = await asMaster(t).mutation(api.messages.deleteMessage, {
			messageId,
			callerOrchestrator: "system",
		});
		expect(result.deleted).toBe(true);
	});
});

// ── missions.update (cancel branch — the only place the word is read) ──────
describe("missions.update — the word 'system' is not authority", () => {
	test("LEAK: member seat-a typing 'system' to cancel seat-b's mission (same org) is refused", async () => {
		const t = createT();
		await seedOrgA(t);
		const missionId = await seedMission(t, "seat-b");
		await expect(
			asMemberOfOrgA(t).mutation(api.missions.update, {
				missionId,
				callerOrchestrator: "system",
				status: "cancelled",
				cancelReason: "hijack attempt",
			}),
		).rejects.toThrow(/RBAC_DENIED: Only seat-b \(creator\)/);
		const row = await t.run((ctx) => ctx.db.get(missionId));
		expect(row?.status).toBe("plan");
	});

	test("WITHHELD: member seat-a cancelling its own mission succeeds", async () => {
		const t = createT();
		await seedOrgA(t);
		const missionId = await seedMission(t, "seat-a");
		await asMemberOfOrgA(t).mutation(api.missions.update, {
			missionId,
			callerOrchestrator: "seat-a",
			status: "cancelled",
			cancelReason: "mine to cancel",
		});
		const row = await t.run((ctx) => ctx.db.get(missionId));
		expect(row?.status).toBe("cancelled");
		expect(row?.cancelledBy).toBe("seat-a");
	});

	test("MASTER: the verified master typing 'system' still cancels", async () => {
		const t = createT();
		const missionId = await seedMission(t, "seat-b");
		await asMaster(t).mutation(api.missions.update, {
			missionId,
			callerOrchestrator: "system",
			status: "cancelled",
			cancelReason: "fleet cleanup",
		});
		const row = await t.run((ctx) => ctx.db.get(missionId));
		expect(row?.status).toBe("cancelled");
	});
});

// ── mandates.accept / update / settle ───────────────────────────────────────
// requireFleetMaster runs BEFORE the word: a member never reaches it. These
// poles pin that ordering AND the master-side ownership compare.
describe("mandates.{accept,update,settle} — the word 'system' is not authority", () => {
	test("LEAK: member typing 'system' on accept is refused before the word is read", async () => {
		const t = createT();
		await seedOrgA(t);
		const mandateId = await seedMandate(t);
		await expect(
			asMemberOfOrgA(t).mutation(api.mandates.accept, {
				mandateId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/RBAC_DENIED: caller may not accept mandate/);
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("requested");
	});

	test("LEAK: member typing 'system' on update is refused before the word is read", async () => {
		const t = createT();
		await seedOrgA(t);
		const mandateId = await seedMandate(t);
		await expect(
			asMemberOfOrgA(t).mutation(api.mandates.update, {
				mandateId,
				callerOrchestrator: "system",
				status: "delivered",
			}),
		).rejects.toThrow(/RBAC_DENIED: caller may not update mandate/);
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("requested");
	});

	test("LEAK: member typing 'system' on settle is refused before the word is read", async () => {
		const t = createT();
		await seedOrgA(t);
		const mandateId = await seedMandate(t);
		await expect(
			asMemberOfOrgA(t).mutation(api.mandates.settle, {
				mandateId,
				callerOrchestrator: "system",
				finalCost: 1,
			}),
		).rejects.toThrow(/RBAC_DENIED: caller may not settle mandate/);
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("requested");
	});

	test("MASTER: 'system' still accepts, updates and settles", async () => {
		const t = createT();
		const mandateId = await seedMandate(t);
		const tM = asMaster(t);
		await tM.mutation(api.mandates.accept, { mandateId, callerOrchestrator: "system" });
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("accepted");
		await tM.mutation(api.mandates.update, {
			mandateId,
			callerOrchestrator: "system",
			status: "delivered",
		});
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("delivered");
		await tM.mutation(api.mandates.settle, {
			mandateId,
			callerOrchestrator: "system",
			finalCost: 5,
		});
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("settled");
	});

	test("WITHHELD: master naming the row's own party still succeeds; a stranger name is refused", async () => {
		const t = createT();
		const mandateId = await seedMandate(t);
		const tM = asMaster(t);
		await expect(
			tM.mutation(api.mandates.accept, { mandateId, callerOrchestrator: "seat-a" }),
		).rejects.toThrow(/Unauthorized: only seat-b \(fulfilledBy\)/);
		await tM.mutation(api.mandates.accept, { mandateId, callerOrchestrator: "seat-b" });
		expect((await t.run((ctx) => ctx.db.get(mandateId)))?.status).toBe("accepted");
		await expect(
			tM.mutation(api.mandates.settle, {
				mandateId,
				callerOrchestrator: "seat-a",
				finalCost: 1,
			}),
		).rejects.toThrow(/Unauthorized: only seat-b \(requestedBy\)/);
	});
});

// ── the CLASS, structurally ─────────────────────────────────────────────────
// The mandates.* sites are reachable only by the verified master, for whom the
// typed-word compare and `isFleetSystemCaller` are observationally identical —
// no behavioural pole can tell them apart. This control is the ONLY proof for
// those three sites, so it reads the syntax tree (convex/__tests__/lib/
// systemWordAst.ts), never a text pattern, and it reads EVERY convex module.
// The declared limits (a value built at runtime has no literal node) are in the
// header of that file; the LIMIT fixtures below pin them as limits.
const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.name === "node_modules"
			? []
			: e.isDirectory()
				? walk(`${dir}/${e.name}`)
				: /\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(e.name)
					? [`${dir}/${e.name}`]
					: [],
	);

const CONVEX_DIR = fileURLToPath(new URL("..", import.meta.url));

const allSources = (): Record<string, string> => {
	const raw = import.meta.glob("../**/*.{ts,tsx,js,mjs,cjs,mts,cts}", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>;
	// Vite rewrites a key inside this file's own directory to "./x", so the key
	// is resolved against this file rather than sliced.
	const out = Object.fromEntries(
		Object.entries(raw).map(([p, src]) => [
			`convex/${fileURLToPath(new URL(p, import.meta.url)).slice(CONVEX_DIR.length)}`,
			src,
		]),
	);
	// A module's own glob never lists the module itself. This file is in the
	// tree it scans, so it is read from disk and added: no blind spot at home.
	const self = fileURLToPath(import.meta.url);
	out[`convex/${self.slice(CONVEX_DIR.length)}`] = readFileSync(self, "utf8");
	return out;
};

describe("the word 'system' is compared in exactly one place — on the AST", () => {
	test("the scan reads every convex module, migrations/ included (glob === filesystem walk)", () => {
		const fromGlob = Object.keys(allSources()).sort();
		const base = CONVEX_DIR.replace(/\/$/, "");
		const fromFs = walk(base)
			.map((p) => `convex/${p.slice(base.length + 1)}`)
			.sort();
		expect(fromGlob).toEqual(fromFs);
		expect(
			fromGlob.filter((p) => p.startsWith("convex/migrations/")).length,
		).toBeGreaterThanOrEqual(10);
		expect(fromGlob.length).toBeGreaterThan(300);
	});

	test("no convex module compares a value to the word outside the shared predicate", () => {
		const sites = analyseSystemWord(allSources());
		const blocked = sites.filter((s) => s.cls === null);
		expect(
			blocked.map(
				(s) => `${s.file}:${s.line}:${s.column} [${s.form}] ${s.reason} :: ${s.text}`,
			),
		).toEqual([]);
		const predicate = sites.filter((s) => s.cls === "predicate");
		expect(predicate.map((s) => s.file)).toEqual(["convex/lib/systemCaller.ts"]);
	}, 120_000);

	// ── BLOCK fixtures: every hostile spelling must be seen ─────────────────
	const HOSTILE: Record<string, string> = {
		"P0 direct": `export const f = (callerOrchestrator: string) => callerOrchestrator !== "system";`,
		"M1 Yoda order": `export const f = (callerOrchestrator: string) => "system" === callerOrchestrator;`,
		"M2 template literal":
			"export const f = (callerOrchestrator: string) => callerOrchestrator === `system`;",
		"M3 alias": `const WHO = "system"; export const f = (callerOrchestrator: string) => callerOrchestrator === WHO;`,
		"alias, chain": `const A = "system"; const B = A; export const f = (c: string) => c === B;`,
		"alias, let": `let A = "system"; export const f = (c: string) => c === A;`,
		"alias, parameter default": `export const f = (c: string, w = "system") => c === w;`,
		"alias, as const property": `const K = { who: "system" } as const; export const f = (c: string) => c === K.who;`,
		"N1 ternary": `export const f = (c: string, k: boolean) => c === (k ? "system" : "");`,
		"N1 ternary, word in the false branch": `export const f = (c: string, k: boolean) => c === (k ? "" : "system");`,
		"N2 destructuring default": `export const f = (c: string, o: { w?: string }) => { const { w = "system" } = o; return c === w; };`,
		"N3 nullish coalescing": `export const f = (c: string) => c === (undefined ?? "system");`,
		"nullish, word on the left": `export const f = (c: string, a?: string) => c === ("system" ?? a);`,
		"logical or": `export const f = (c: string, a?: string) => c === (a || "system");`,
		"logical and": `export const f = (c: string, a: boolean) => c === (a && "system");`,
		"comma tail": `export const f = (c: string) => c === (0, "system");`,
		"ternary through an alias": `const W = "system"; export const f = (c: string, k: boolean) => c === (k ? W : "");`,
		"ternary in a switch case": `export const f = (c: string, k: boolean) => { switch (c) { case k ? "system" : "": return 1; default: return 0; } };`,
		"ternary in .includes": `export const f = (c: string, k: boolean) => ["a"].includes(k ? "system" : c);`,
		"loose equality": `export const f = (c: string) => c == "system";`,
		"loose inequality, Yoda": `export const f = (c: string) => "system" != c;`,
		"case variant": `export const f = (c: string) => c === "System";`,
		padded: `export const f = (c: string) => c === " system ";`,
		"parenthesised + cast": `export const f = (c: string) => c === (("system" as string));`,
		"angle-bracket cast": `export const f = (c: string) => c === (<string>"system");`,
		satisfies: `export const f = (c: string) => c === ("system" satisfies string);`,
		"String.raw": "export const f = (c: string) => c === String.raw`system`;",
		"switch case": `export const f = (c: string) => { switch (c) { case "system": return 1; default: return 0; } };`,
		"switch on the literal": `export const f = (c: string) => { switch ("system") { case c: return 1; default: return 0; } };`,
		"array includes": `export const f = (c: string) => ["system", "x"].includes(c);`,
		"array indexOf": `export const f = (c: string) => ["system"].indexOf(c) !== -1;`,
		"Set membership": `export const f = (c: string) => new Set(["system"]).has(c);`,
		"receiver includes": `export const f = (c: string) => "system".includes(c);`,
		startsWith: `export const f = (c: string) => c.startsWith("system");`,
		localeCompare: `export const f = (c: string) => c.localeCompare("system") === 0;`,
		"Object.is": `export const f = (c: string) => Object.is(c, "system");`,
		"regex literal": `export const f = (c: string) => /^system$/.test(c);`,
		"new RegExp": `export const f = (c: string) => new RegExp("^system$").test(c);`,
		// ── a mutable binding's ASSIGNMENTS are value flow (REVISE 2 of #1357) ──
		"assigned later: let w; w = word": `export const f = (c: string) => { let w: string; w = "system"; return c === w; };`,
		"assigned later over a harmless initializer": `export const f = (c: string) => { let w = "other"; w = "system"; return c === w; };`,
		"compound ||=": `export const f = (c: string) => { let w: string | undefined; w ||= "system"; return c === w; };`,
		"compound ??=": `export const f = (c: string) => { let w: string | undefined; w ??= "system"; return c === w; };`,
		"compound &&=": `export const f = (c: string) => { let w: string | undefined = "x"; w &&= "system"; return c === w; };`,
		"compound +=": `export const f = (c: string) => { let w = ""; w += "system"; return c === w; };`,
		"assigned through a ternary": `export const f = (c: string, k: boolean) => { let w = "other"; w = k ? "system" : "x"; return c === w; };`,
		"assigned from another alias": `export const f = (c: string) => { const A = "system"; let w = "other"; w = A; return c === w; };`,
		"assigned inside a closure": `export const f = (c: string) => { let w = "other"; const set = () => { w = "system"; }; set(); return c === w; };`,
		"parameter reassigned": `export const f = (c: string, w = "other") => { w = "system"; return c === w; };`,
		"array destructuring assignment": `export const f = (c: string) => { let w = "other"; [w] = ["system"]; return c === w; };`,
		"object destructuring assignment": `export const f = (c: string) => { let w = "other"; ({ w } = { w: "system" }); return c === w; };`,
		"for-of into an existing binding": `export const f = (c: string) => { let w = "other"; for (w of ["system"]) { break; } return c === w; };`,
		"for-of declaration": `export const f = (c: string) => { for (const w of ["system"]) { return c === w; } return false; };`,
		// ── container writes / reads, a bounded setter, destructuring from a binding ──
		"container property write": `const o = { w: "other" }; o.w = "system"; export const f = (c: string) => c === o.w;`,
		"container element write": `const a = ["other"]; a[0] = "system"; export const f = (c: string) => c === a[0];`,
		"container bracket-string write": `const o: Record<string, string> = {}; o["w"] = "system"; export const f = (c: string) => c === o.w;`,
		"container property compound write": `const o: { w?: string } = {}; o.w ||= "system"; export const f = (c: string) => c === o.w;`,
		"container literal, read by property": `const cfg = { who: "system" }; export const f = (c: string) => c === cfg.who;`,
		"container literal, read by element": `const cfg = ["system"]; export const f = (c: string) => c === cfg[0];`,
		"container written through an alias": `const o = { w: "other" }; const p = o; p.w = "system"; export const f = (c: string) => c === o.w;`,
		"container written, read through an alias": `const o = { w: "other" }; const p = o; o.w = "system"; export const f = (c: string) => c === p.w;`,
		"setter reaching its binding through a second function": `let w = "other"; const inner = (v: string) => { w = v; }; const set = (v: string) => { inner(v); }; set("system"); export const f = (c: string) => c === w;`,
		"setter arrow assigns its parameter": `let w = "other"; const set = (v: string) => { w = v; }; set("system"); export const f = (c: string) => c === w;`,
		"setter declaration assigns its parameter": `let w = "other"; function set(v: string) { w = v; } set("system"); export const f = (c: string) => c === w;`,
		"setter, the word in the SECOND parameter": `let w = "other"; const set = (k: number, v: string) => { w = v; }; set(1, "system"); export const f = (c: string) => c === w;`,
		"destructure from a binding, object": `const cfg = { w: "system" }; const { w } = cfg; export const f = (c: string) => c === w;`,
		"destructure from a binding, array": `const cfg = ["system"]; const [w] = cfg; export const f = (c: string) => c === w;`,
		"destructure from a chain of bindings": `const a = { w: "system" }; const b = a; const { w } = b; export const f = (c: string) => c === w;`,
		"destructuring declaration, object literal": `const { w } = { w: "system" }; export const f = (c: string) => c === w;`,
		"destructuring declaration, array literal": `const [w] = ["system"]; export const f = (c: string) => c === w;`,
		"destructuring declaration, renamed and nested": `const { a: { b: w } } = { a: { b: "system" } }; export const f = (c: string) => c === w;`,
		"destructuring declaration in a parameter": `export const f = (c: string, { w }: { w: string } = { w: "system" }) => c === w;`,
		"assigned in a switch, compared in a switch": `export const f = (c: string) => { let w = "other"; w = "system"; switch (c) { case w: return 1; default: return 0; } };`,
	};

	test.each(Object.entries(HOSTILE))("BLOCK: %s", (_name, src) => {
		const sites = analyseSystemWord({ "convex/x.ts": src });
		expect(sites.filter((s) => s.cls === null).length).toBeGreaterThanOrEqual(1);
	});

	test("BLOCK: an alias imported from another convex module", () => {
		const sites = analyseSystemWord({
			"convex/lib/word.ts": `export const WHO = "system";`,
			"convex/x.ts": `import { WHO } from "./lib/word"; export const f = (c: string) => c === WHO;`,
		});
		expect(sites.filter((s) => s.cls === null).map((s) => s.file)).toEqual([
			"convex/x.ts",
		]);
	});

	test("BLOCK: a `let` exported from one module, assigned by that module, compared in another", () => {
		const sites = analyseSystemWord({
			"convex/lib/word.ts": `export let who = "other"; export function arm(): void { who = "system"; }`,
			"convex/x.ts": `import { who } from "./lib/word"; export const f = (c: string) => c === who;`,
		});
		expect(sites.filter((s) => s.cls === null).map((s) => s.file)).toEqual(["convex/x.ts"]);
	});

	test("BLOCK: an enum member holding the word", () => {
		const sites = analyseSystemWord({
			"convex/x.ts": `enum W { S = "system" } export const f = (c: string) => c === W.S;`,
		});
		expect(sites.filter((s) => s.cls === null).length).toBe(1);
	});

	test("BLOCK: the same comparison inside convex/migrations/", () => {
		const sites = analyseSystemWord({
			"convex/migrations/m.ts": `export const f = (c: string) => "system" === c;`,
		});
		expect(sites.map((s) => `${s.file}:${s.line}`)).toEqual([
			"convex/migrations/m.ts:1",
		]);
	});

	test("BLOCK: the predicate's own shape, moved to another file, another function or another shape", () => {
		const blocked = (file: string, fn: string, expr: string) =>
			analyseSystemWord({
				[file]: `export function ${fn}(callerScope: { isMaster: boolean }, c: string | undefined): boolean { return ${expr}; }`,
			}).filter((s) => s.cls === null).length;
		const shape = `callerScope.isMaster && c === "system"`;
		expect(blocked("convex/lib/systemCaller.ts", "isFleetSystemCaller", shape)).toBe(0);
		expect(blocked("convex/other.ts", "isFleetSystemCaller", shape)).toBe(1);
		expect(blocked("convex/lib/systemCaller.ts", "isSomethingElse", shape)).toBe(1);
		expect(blocked("convex/lib/systemCaller.ts", "isFleetSystemCaller", `c === "system"`)).toBe(1);
		expect(
			blocked("convex/lib/systemCaller.ts", "isFleetSystemCaller", `callerScope.isMaster || c === "system"`),
		).toBe(1);
		expect(
			blocked("convex/lib/systemCaller.ts", "isFleetSystemCaller", `c === "system" && callerScope.isMaster`),
		).toBe(1);
		expect(
			blocked("convex/lib/systemCaller.ts", "isFleetSystemCaller", `callerScope.isMaster && "system" === c`),
		).toBe(1);
	});

	test("BLOCK: mutants of the REAL convex/mandates.ts source", () => {
		const real = allSources()["convex/mandates.ts"] as string;
		const needle = "!isFleetSystemCaller(scope, args.callerOrchestrator) &&";
		expect(real.split(needle).length - 1).toBe(3);
		const blockedFiles = (repl: string, pre = "") =>
			analyseSystemWord({ "convex/mandates.ts": pre + real.replace(needle, repl) })
				.filter((s) => s.cls === null)
				.map((s) => s.file);
		expect(blockedFiles(`args.callerOrchestrator !== "system" &&`)).toEqual(["convex/mandates.ts"]);
		expect(blockedFiles(`"system" !== args.callerOrchestrator &&`)).toEqual(["convex/mandates.ts"]);
		expect(blockedFiles("args.callerOrchestrator !== `system` &&")).toEqual(["convex/mandates.ts"]);
		expect(blockedFiles(`args.callerOrchestrator !== SYS &&`, `const SYS = "system";\n`)).toEqual([
			"convex/mandates.ts",
		]);
		// the reviewer's N1..N3, on the REAL source
		expect(blockedFiles(`args.callerOrchestrator !== (args.callerOrchestrator ? "system" : "") &&`)).toEqual([
			"convex/mandates.ts",
		]);
		expect(blockedFiles(`args.callerOrchestrator !== W &&`, `const { w: W = "system" } = { w: undefined as string | undefined };\n`)).toEqual([
			"convex/mandates.ts",
		]);
		expect(blockedFiles(`args.callerOrchestrator !== (undefined ?? "system") &&`)).toEqual([
			"convex/mandates.ts",
		]);
		// REVISE 2: the reviewer's splice, on the REAL source. `etaWho = "system"`
		// added as a STATEMENT beside the predicate (tsc: 0 errors, the old control:
		// GREEN). The declaration is harmless; only the later assignment carries the word.
		const ifHead = "\t\tif (\n\t\t\t!isFleetSystemCaller(scope, args.callerOrchestrator) &&";
		expect(real.includes(ifHead)).toBe(true);
		const spliced = (stmt: string) =>
			analyseSystemWord({
				"convex/mandates.ts": real.replace(
					ifHead,
					`\t\tlet etaWho: string | undefined = "other";\n\t\t${stmt}\n\t\tif (\n\t\t\targs.callerOrchestrator !== etaWho &&`,
				),
			})
				.filter((s) => s.cls === null)
				.map((s) => s.file);
		expect(spliced(`etaWho = "system";`)).toEqual(["convex/mandates.ts"]);
		expect(spliced(`etaWho ||= "system";`)).toEqual(["convex/mandates.ts"]);
		expect(spliced(`etaWho ??= "system";`)).toEqual(["convex/mandates.ts"]);
		expect(spliced(`etaWho &&= "system";`)).toEqual(["convex/mandates.ts"]);
		// the same splice with a harmless assignment is NOT a site
		expect(spliced(`etaWho = "other";`)).toEqual([]);
		// and the pristine source is clean
		expect(blockedFiles(needle)).toEqual([]);
	});

	// ── PASS fixtures: the word may exist; only a COMPARISON is a site ──────
	const BENIGN: Record<string, string> = {
		"writes the word": `export const r = { createdBy: "system", from: "system" };`,
		"defaults to the word": `export const f = (a?: string) => a ?? "system";`,
		"type position": `export type Who = "system" | "user";`,
		prose: `export const doc = "the system decides";`,
		"a longer word": `export const f = (c: string) => c === "systematic";`,
		"a database filter (not a caller compare)": `declare const q: { eq: (a: unknown, b: unknown) => unknown; field: (n: string) => unknown }; export const f = () => q.eq(q.field("createdBy"), "system");`,
		"another literal": `export const f = (c: string) => c === "master";`,
		comment: `// c === "system"\nexport const f = 1;`,
		"a reassigned binding that never holds the word": `export const f = (c: string) => { let w = "x"; w = "y"; w ||= "z"; return c === w; };`,
		"a counter": `export const f = (c: number) => { let n = 0; n += 1; n++; return c === n; };`,
		"a destructure of a CALL's result is not the word": `declare const run: (o: { who: string }) => { id: string }; const { id } = run({ who: "system" }); export const f = (c: string) => c === id;`,
		"a destructuring declaration of harmless literals": `const { w } = { w: "x" }; const [v] = ["y"]; export const f = (c: string) => c === w || c === v;`,
		"a container written with a harmless value": `const o = { w: "other" }; o.w = "y"; export const f = (c: string) => c === o.w;`,
		"a container written with a harmless value through an alias": `const o = { w: "other" }; const p = o; p.w = "y"; export const f = (c: string) => c === o.w;`,
		"a setter called with a harmless value": `let w = "other"; const set = (v: string) => { w = v; }; set("y"); export const f = (c: string) => c === w;`,
		"a destructure from a harmless binding": `const cfg = { w: "x" }; const { w } = cfg; export const f = (c: string) => c === w;`,
		"assignments that only cycle": `export const f = (c: string) => { let a = "x"; let b = "y"; a = b; b = a; return c === a; };`,
		"the word is written to a binding that is never compared": `export const f = () => { let w = "other"; w = "system"; return w; };`,
	};
	test.each(Object.entries(BENIGN))("PASS: %s", (_n, src) => {
		expect(analyseSystemWord({ "convex/x.ts": src })).toEqual([]);
	});

	// ── DECLARED LIMITS: pinned as limits so nobody reads them as coverage ───
	const LIMIT: Record<string, string> = {
		"M4 computed string": `export const f = (c: string) => c === "sys" + "tem";`,
		"template with substitution":
			'const a = "sys"; export const f = (c: string) => c === `${a}tem`;',
		"array join": `export const f = (c: string) => c === ["sys", "tem"].join("");`,
		fromCharCode: `export const f = (c: string) => c === String.fromCharCode(115, 121, 115, 116, 101, 109);`,
		"compare hidden in a helper": `const eq = (a: string, b: string) => a === b; export const f = (c: string) => eq(c, "system");`,
		"value derived from a call that was passed the word": `declare const run: (o: { who: string }) => { ids: string[] }; const r = run({ who: "system" }); const id = r.ids[0]; export const f = () => id !== undefined;`,
		"key membership": `export const f = (c: string) => c in { system: 1 };`,
		"an alias of an alias (one hop only)": `const o = { w: "other" }; const p = o; const q = p; q.w = "system"; export const f = (c: string) => c === o.w;`,
	};
	test.each(Object.entries(LIMIT))("DECLARED LIMIT (not seen): %s", (_n, src) => {
		expect(analyseSystemWord({ "convex/x.ts": src })).toEqual([]);
	});

	test("BLOCK: a setter defined in one module and called with the word from another", () => {
		const sites = analyseSystemWord({
			"convex/lib/word.ts": `let w = "other"; export const set = (v: string) => { w = v; }; export const f = (c: string) => c === w;`,
			"convex/x.ts": `import { set } from "./lib/word"; set("system");`,
		});
		expect(sites.filter((s) => s.cls === null).map((s) => s.file)).toEqual(["convex/lib/word.ts"]);
	});
});
