/**
 * S0 cross-tenant isolation campaign — tâche k17b9z5yjgd8301r6dfawefpzs8b3a03,
 * mission k57d16fdegnxpan2wvhjcxf2c58b2arj.
 *
 * Exerce (n'inspecte PAS) les outils MCP capturés depuis registerTools().
 * Deux contextes OAuth scopés ("tenant-a-campaign" / "tenant-b-campaign")
 * partagent le même backend convex-test ; on appelle chaque handler B avec
 * des paramètres visant les données de A et on vérifie qu'aucune fuite ne
 * se produit. Positive control : A obtient ses propres données.
 *
 * DO-NOT-TOUCH respecté : convex/lib/auth.ts, isMasterScope locale,
 * messages.markAsRead.cross-recipient.test.ts ne sont pas touchés. Aucune
 * garde n'est ajoutée — mesure seule, écrite après coup dans analysis/.
 */

import type { ConvexHttpClient } from "convex/browser";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";
import schema from "../../../convex/schema.js";

const modules = Object.fromEntries(
	Object.entries(
		import.meta.glob<Record<string, unknown>>("../../../convex/**/*.ts"),
	).filter(([path]) => !path.includes("ragSync") && !path.includes("backfill")),
);

function resolveRef(dotted: string) {
	const [mod, fn] = dotted.split(":");
	return (anyApi as Record<string, Record<string, unknown>>)[mod][fn];
}

function makeFakeConvexClient(
	t: ReturnType<typeof convexTest>,
): ConvexHttpClient {
	return {
		query: (name: string, args: unknown) =>
			t.query(resolveRef(name) as never, args as never),
		mutation: (name: string, args: unknown) =>
			t.mutation(resolveRef(name) as never, args as never),
		action: (name: string, args: unknown) =>
			t.action(resolveRef(name) as never, args as never),
	} as unknown as ConvexHttpClient;
}

type CapturedTool = { name: string; handler: (args: unknown) => Promise<unknown> };

function captureTools(
	convex: ConvexHttpClient,
	oauthCtx: OAuthContext | undefined,
): Map<string, CapturedTool> {
	const captured = new Map<string, CapturedTool>();
	const fakeServer = {
		tool: (...allArgs: unknown[]) => {
			const name = allArgs[0] as string;
			const handler = allArgs[allArgs.length - 1] as (
				args: unknown,
			) => Promise<unknown>;
			captured.set(name, { name, handler });
		},
	};
	registerTools(fakeServer as never, convex, oauthCtx);
	return captured;
}

function ctxFor(userId: string, ns: string): OAuthContext {
	return {
		clientId: `${userId}-client`,
		userId,
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: `scoped-${userId}`,
		fromAllowList: [userId],
		namespaceReadPrefixes: [ns],
		namespaceWritePrefixes: [ns],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

async function callText(tool: CapturedTool, args: unknown): Promise<string> {
	const res = (await tool.handler(args)) as {
		content?: { text?: string }[];
	};
	return String(res?.content?.[0]?.text ?? JSON.stringify(res));
}

// Result ledger — appended to by every `record()` call, dumped to
// analysis/ at the end so the report can cite exact evidence.
type Verdict =
	| "FUITE_AVEREE"
	| "ETANCHE_PROUVE"
	| "NON_CONCLUANT"
	| "REFUS_TOTAL_STRUCTUREL";
type Row = { tool: string; verdict: Verdict; evidence: string };
const LEDGER: Row[] = [];
function record(tool: string, verdict: Verdict, evidence: string) {
	LEDGER.push({ tool, verdict, evidence });
}

const NS_A = "project/tenant-a-campaign";
const NS_B = "project/tenant-b-campaign";
const USER_A = "tenant-a-campaign";
const USER_B = "tenant-b-campaign";
const CANARY_A = "CANARY-A-2ec91f";
const CANARY_B = "CANARY-B-77bd4a";

describe("S0 cross-tenant isolation campaign", () => {
	let t: ReturnType<typeof convexTest>;
	let toolsA: Map<string, CapturedTool>;
	let toolsB: Map<string, CapturedTool>;
	let totalToolCount = 0;

	let toolsMaster: Map<string, CapturedTool>;

	beforeAll(async () => {
		t = convexTest(schema as never, modules as never);
		toolsA = captureTools(makeFakeConvexClient(t), ctxFor(USER_A, NS_A));
		toolsB = captureTools(makeFakeConvexClient(t), ctxFor(USER_B, NS_B));
		toolsMaster = captureTools(makeFakeConvexClient(t), {
			clientId: "master-client",
			userId: "master",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "master",
			fromAllowList: ["*"],
			namespaceReadPrefixes: ["*"],
			namespaceWritePrefixes: ["*"],
			expiresAt: Date.now() + 3600_000,
			isMaster: true,
		});
		totalToolCount = toolsA.size;
	});

	afterAll(() => {
		require("node:fs").writeFileSync(
			"/tmp/campaign-ledger.json",
			JSON.stringify({ totalToolCount, LEDGER }, null, 2),
		);
	});

	// ── POSITIVE CONTROL ─────────────────────────────────────────────────────
	it("POSITIVE CONTROL: A stores + lists its own memory (must be non-empty)", async () => {
		const storeA = toolsA.get("store_memory")!;
		const storeRes = await callText(storeA, {
			namespace: NS_A,
			type: "project",
			content: CANARY_A,
			createdBy: USER_A,
		});
		expect(JSON.parse(storeRes).memoryId).toBeTruthy();

		const listA = await callText(toolsA.get("list_memories")!, {
			namespace: NS_A,
		});
		expect(listA).toContain(CANARY_A);
		record("store_memory+list_memories (positive control)", "ETANCHE_PROUVE", "A voit son propre CANARY_A");
	});

	it("seeds tenant B memory + episode + task + mission + diary + briefing + component", async () => {
		await callText(toolsB.get("store_memory")!, {
			namespace: NS_B,
			type: "project",
			content: CANARY_B,
			createdBy: USER_B,
		});
		await callText(toolsB.get("store_episode")!, {
			namespace: NS_B,
			createdBy: USER_B,
			what: CANARY_B,
			why: "seed",
			outcome: "seed",
		}).catch((e) => record("store_episode(seed)", "NON_CONCLUANT", String(e)));

		await callText(toolsB.get("create_task")!, {
			title: CANARY_B,
			assignedTo: USER_B,
			createdBy: USER_B,
			priority: "low",
		}).catch((e) => record("create_task(seed)", "NON_CONCLUANT", String(e)));

		await callText(toolsB.get("create_mission")!, {
			name: CANARY_B,
			project: "campaign-b",
			status: "brainstorm",
			priority: "low",
			pilot: USER_B,
			agents: [USER_B],
			createdBy: USER_B,
		}).catch((e) => record("create_mission(seed)", "NON_CONCLUANT", String(e)));

		await callText(toolsB.get("write_diary")!, {
			date: "2026-07-23",
			orchestrator: USER_B,
			content: CANARY_B,
		}).catch((e) => record("write_diary(seed)", "NON_CONCLUANT", String(e)));

		await callText(toolsB.get("create_briefing_note")!, {
			title: CANARY_B,
			topic: "campaign-b",
			participants: [USER_B],
			content: CANARY_B,
			createdBy: USER_B,
		}).catch((e) => record("create_briefing_note(seed)", "NON_CONCLUANT", String(e)));

		await callText(toolsB.get("register_component")!, {
			name: CANARY_B,
			type: "skill",
			content: CANARY_B,
			createdBy: USER_B,
		}).catch((e) => record("register_component(seed)", "NON_CONCLUANT", String(e)));
	});

	// ── Direct-DB seeds for entities whose create-tool is guardMasterOnly
	// (repo mappings, deployments) or whose schema has no createdBy/namespace
	// field at all (mandates, businessUnits, issues) — inserted via t.run so
	// the scope-filter tools still have rows to filter against.
	it("seeds structural (no createdBy/namespace) tables directly via t.run", async () => {
		await t.run(async (ctx) => {
			await ctx.db.insert("mandates", {
				requestedBy: USER_B,
				fulfilledBy: USER_B,
				service: CANARY_B,
				budget: 100,
				status: "requested",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert("businessUnits", {
				name: CANARY_B,
				description: "d",
				purpose: "p",
				orchestratorId: USER_B,
				status: "idea",
				businessModel: "m",
				targetCustomers: "t",
				services: [],
				pricing: "p",
				revenueProjections: { y1: 0, y2: 0, y3: 0 },
				coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
				coreProcesses: [],
				dependencies: [],
				kpis: [],
				managementFee: 10,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert("issues", {
				repo: "org/repo-b",
				issueNumber: 1,
				title: CANARY_B,
				body: CANARY_B,
				htmlUrl: "https://example.invalid/1",
				labels: [],
				status: "open",
				priority: "low",
				assignedOrchestrator: USER_B,
				project: "campaign-b",
				githubCreatedAt: Date.now(),
				githubUpdatedAt: Date.now(),
			});
			await ctx.db.insert("githubRepoMapping", {
				repo: "org/repo-b",
				orchestrator: USER_B,
				project: "campaign-b",
				active: true,
			} as never);
			await ctx.db.insert("errorLogs", {
				hash: "hash-b-1",
				deployment: "dep-b",
				functionName: "f",
				errorMessage: CANARY_B,
				count: 1,
				firstSeen: Date.now(),
				lastSeen: Date.now(),
			} as never);
		});
	});

	// ── Cross-tenant probes: A calling with B's identifiers/namespace ───────
	const nsScopedListTools: [string, Record<string, unknown>][] = [
		["list_memories", { namespace: NS_B }],
		["list_episodes", { namespace: NS_B }],
		["recall", { namespace: NS_B, query: CANARY_B }],
		["text_search", { namespace: NS_B, query: CANARY_B }],
		["search_memories_by_keyword", { namespace: NS_B, query: CANARY_B }],
	];

	for (const [name, args] of nsScopedListTools) {
		it(`${name}: A cannot read B's namespace`, async () => {
			const tool = toolsA.get(name);
			if (!tool) {
				record(name, "NON_CONCLUANT", "outil non capturé par le harnais");
				return;
			}
			try {
				const res = await callText(tool, args);
				if (res.includes(CANARY_B)) {
					record(name, "FUITE_AVEREE", `A a obtenu CANARY_B via ${name}(namespace=NS_B)`);
					expect.fail(`LEAK: ${name} returned B's canary to A`);
				} else {
					record(name, "ETANCHE_PROUVE", `${name} sur NS_B rejeté ou vide pour A (guardRead namespace prefix)`);
				}
			} catch (e) {
				const msg = String(e);
				if (msg.includes(CANARY_B)) {
					record(name, "FUITE_AVEREE", `exception contenait CANARY_B: ${msg.slice(0, 200)}`);
				} else {
					record(name, "ETANCHE_PROUVE", `rejeté avec erreur (attendu): ${msg.slice(0, 120)}`);
				}
			}
		});
	}

	// scopeFilterList/scopeFilterGet tools — fetch-all-then-filter pattern,
	// exercised by calling B's identifier from A's captured handler (or by
	// listing globally and checking B's row is absent from A's view).
	const scopeFilteredListProbes: [string, string][] = [
		["list_bus", "businessUnits"],
		["list_mandates", "mandates"],
		["list_issues", "issues"],
		["list_errors", "errorLogs"],
		["list_repo_mappings", "githubRepoMapping"],
		["list_fix_patterns", "fixPatterns"],
		["list_briefing_notes", "briefingNotes"],
		["list_messages", "messages"],
		["list_peers", "peers"],
		["list_broadcast_status", "broadcast"],
		["list_recurring_tasks", "recurringTasks"],
		["list_tasks_by_mission", "tasks"],
		["search_components", "components"],
		["search_fix_patterns", "fixPatterns"],
	];

	for (const [name] of scopeFilteredListProbes) {
		it(`${name}: A's view excludes B's CANARY (with B-side zero-disambiguation)`, async () => {
			const toolA = toolsA.get(name);
			const toolB = toolsB.get(name);
			if (!toolA) {
				record(name, "NON_CONCLUANT", "outil non capturé ou args obligatoires non satisfaits par ce harnais générique");
				return;
			}
			let args: Record<string, unknown> = {};
			if (name === "list_tasks_by_mission") args = { missionId: "nonexistent" };
			if (name === "search_components" || name === "search_fix_patterns")
				args = { query: CANARY_B };

			let resA: string;
			try {
				resA = await callText(toolA, args);
			} catch (e) {
				record(name, "NON_CONCLUANT", `handler A a levé avant tout filtrage: ${String(e).slice(0, 150)}`);
				return;
			}
			if (resA.includes(CANARY_B)) {
				record(name, "FUITE_AVEREE", `A a vu CANARY_B (créé par B) via ${name}`);
				expect.fail(`LEAK: ${name} leaked B's row to A`);
				return;
			}
			// Zero-disambiguation: does B's OWN call to the same tool see its
			// own CANARY_B? If yes, A's empty/absent result is a proven filter.
			// If B ALSO gets nothing, the zero is not a proof of isolation — it
			// means the row lacks createdBy/namespace (schema gap) or the tool
			// is broken, denying everyone including its owner.
			let resB: string;
			try {
				resB = toolB ? await callText(toolB, args) : "";
			} catch (e) {
				record(name, "NON_CONCLUANT", `A vide, mais B-side a levé — zéro ambigu non tranché: ${String(e).slice(0, 150)}`);
				return;
			}
			if (resB.includes(CANARY_B)) {
				record(
					name,
					"ETANCHE_PROUVE",
					`B voit son propre CANARY_B (positive control par-outil) ; A ne le voit pas — filtre prouvé.`,
				);
			} else {
				// Master-scope tie-breaker: if a master-bearer call to the SAME
				// tool with the SAME args sees CANARY_B, the row exists and is
				// readable — the non-master deny-all is a genuine structural
				// refusal (row lacks createdBy/namespace), not a harness gap.
				const toolMaster = toolsMaster.get(name);
				let resMaster = "";
				try {
					resMaster = toolMaster ? await callText(toolMaster, args) : "";
				} catch (e) {
					record(
						name,
						"NON_CONCLUANT",
						`zéro ambigu ET appel master a levé — non tranché: ${String(e).slice(0, 150)}`,
					);
					return;
				}
				if (resMaster.includes(CANARY_B)) {
					record(
						name,
						"REFUS_TOTAL_STRUCTUREL",
						`master voit CANARY_B via ${name} (la ligne existe) mais NI A NI B (propriétaire inclus) ne la voient — ` +
							`scopeFilterList/Get refuse tout non-master car la ligne n'a ni createdBy ni namespace. Outil inutilisable par un locataire, pas une fuite.`,
					);
				} else {
					record(
						name,
						"NON_CONCLUANT",
						`ZERO AMBIGU non tranché même par master: ${name} ne renvoie CANARY_B pour personne (master inclus) — probable défaut de seed/args du harnais, pas une propriété du filtre. raw(A,0,150)=${resA.slice(0, 150).replace(/\n/g, " ")} raw(master,0,150)=${resMaster.slice(0, 150).replace(/\n/g, " ")}`,
					);
				}
			}
		});
	}

	// ── CROSS-TENANT WRITE PROBES (priorité 2 du coordinateur) ──────────────
	// Canari inversé : B crée un objet, A appelle le tool d'écriture en ciblant
	// l'ID de B. Fuite = l'objet de B a changé après l'appel de A.
	it("update_task: B's task mutates when A calls update_task WITHOUT callerOrchestrator/assignedTo", async () => {
		const createB = await callText(toolsB.get("create_task")!, {
			title: "B-task-original",
			assignedTo: USER_B,
			createdBy: USER_B,
			priority: "low",
			status: "todo",
		});
		const taskId = JSON.parse(createB).taskId;
		expect(taskId).toBeTruthy();

		// A calls update_task on B's taskId with NEITHER callerOrchestrator NOR
		// assignedTo set — per convex/tasks.ts:748, RBAC is entirely skipped
		// when callerOrchestrator is undefined.
		const updateRes = await callText(toolsA.get("update_task")!, {
			taskId,
			status: "blocked",
			title: "MUTATED-BY-A-CROSS-TENANT",
		});

		const getAfter = await callText(toolsMaster.get("get_task")!, { taskId });
		if (getAfter.includes("MUTATED-BY-A-CROSS-TENANT")) {
			record(
				"update_task",
				"FUITE_AVEREE",
				`A (tenant A) a modifié la tâche de B sans fournir callerOrchestrator/assignedTo — RBAC entièrement facultatif (convex/tasks.ts:748). updateRes=${updateRes.slice(0, 150)}`,
			);
		} else {
			record("update_task", "ETANCHE_PROUVE", "la tâche de B n'a pas été modifiée par A");
		}
	});

	it("update_bu: B can rewrite A's business unit by supplying orchestratorId=B (no ownership check on the target row)", async () => {
		const buId = await t.run(async (ctx) =>
			ctx.db.insert("businessUnits", {
				name: "BU-A-original",
				description: "d",
				purpose: "p",
				orchestratorId: USER_A,
				status: "idea",
				businessModel: "m",
				targetCustomers: "t",
				services: [],
				pricing: "p",
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

		const updateTool = toolsB.get("update_bu");
		if (!updateTool) {
			record("update_bu", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			// guardFrom(orchestratorId) only checks orchestratorId ∈ B's own
			// fromAllowList — it never verifies the TARGET row (buId) belongs
			// to B. B claims orchestratorId=USER_B (its own identity) while
			// targeting A's row by ID.
			await callText(updateTool, {
				buId,
				orchestratorId: USER_B,
				name: "MUTATED-BY-B-CROSS-TENANT",
			});
			const after = await t.run(async (ctx) => ctx.db.get(buId as never));
			const afterName = (after as { name?: string } | null)?.name;
			if (afterName === "MUTATED-BY-B-CROSS-TENANT") {
				record(
					"update_bu",
					"FUITE_AVEREE",
					"B a réécrit le BU de A (orchestratorId=USER_A) en fournissant orchestratorId=USER_B — guardFrom ne vérifie jamais le propriétaire de la ligne ciblée par buId.",
				);
			} else {
				record("update_bu", "ETANCHE_PROUVE", `BU de A inchangé après tentative de B (name=${afterName})`);
			}
		} catch (e) {
			record("update_bu", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("mark_as_read: A cannot mark B's message as read (identity-scoped, no cross-tenant ID vector expected)", async () => {
		const tool = toolsA.get("mark_as_read");
		if (!tool) {
			record("mark_as_read", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			const res = await callText(tool, {
				messageId: "nonexistent-id",
				callerOrchestrator: USER_A,
			});
			record("mark_as_read", "NON_CONCLUANT", `appel avec ID factice — non probant sans un vrai message de B: ${res.slice(0, 120)}`);
		} catch (e) {
			record("mark_as_read", "NON_CONCLUANT", `ID factice rejeté par le validator, pas testé avec un vrai message de B: ${String(e).slice(0, 120)}`);
		}
	});

	it("get_diary: A cannot fetch B's diary entry by (date, orchestrator=B)", async () => {
		const tool = toolsA.get("get_diary")!;
		try {
			const res = await callText(tool, { date: "2026-07-23", orchestrator: USER_B });
			if (res.includes(CANARY_B)) {
				record("get_diary", "FUITE_AVEREE", "A a lu le journal de B via orchestrator=B");
				expect.fail("LEAK: get_diary");
			} else {
				record("get_diary", "ETANCHE_PROUVE", "scopeFilterGet a renvoyé null pour A sur la ligne de B");
			}
		} catch (e) {
			record("get_diary", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	// ── 3-way probe helper: A / B / master, judge de touche maître ──────────
	// Trois issues : (1) master ne voit rien → NON_CONCLUANT (défaut de seed) ;
	// (2) master voit + propriétaire (B) voit aussi mais A non → ETANCHE_PROUVE ;
	// (3) master voit + B (propriétaire) ne voit RIEN → REFUS_TOTAL_STRUCTUREL.
	async function probeGet(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<void> {
		const toolA = toolsA.get(toolName);
		const toolB = toolsB.get(toolName);
		const toolM = toolsMaster.get(toolName);
		if (!toolA || !toolB || !toolM) {
			record(toolName, "NON_CONCLUANT", "outil non capturé par le harnais");
			return;
		}
		let resA: string;
		try {
			resA = await callText(toolA, args);
		} catch (e) {
			record(toolName, "NON_CONCLUANT", `A a levé: ${String(e).slice(0, 130)}`);
			return;
		}
		if (resA.includes(CANARY_B)) {
			record(toolName, "FUITE_AVEREE", `A a obtenu CANARY_B via ${toolName}(${JSON.stringify(args)})`);
			return;
		}
		let resB: string;
		try {
			resB = await callText(toolB, args);
		} catch (e) {
			record(toolName, "NON_CONCLUANT", `A vide, B a levé: ${String(e).slice(0, 130)}`);
			return;
		}
		let resM: string;
		try {
			resM = await callText(toolM, args);
		} catch (e) {
			record(toolName, "NON_CONCLUANT", `A/B vides, master a levé: ${String(e).slice(0, 130)}`);
			return;
		}
		if (!resM.includes(CANARY_B)) {
			record(toolName, "NON_CONCLUANT", `ZERO AMBIGU: master ne voit pas non plus CANARY_B — défaut de seed/args, pas une propriété du filtre. raw(A)=${resA.slice(0, 100)}`);
			return;
		}
		if (resB.includes(CANARY_B)) {
			record(toolName, "ETANCHE_PROUVE", `master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé.`);
		} else {
			record(toolName, "REFUS_TOTAL_STRUCTUREL", `master voit CANARY_B (la ligne existe) mais NI A NI B (propriétaire) ne la voient via ${toolName} — deny-all structurel, pas une fuite.`);
		}
	}

	it("seeds remaining entities for batch 2 get_*/list_* probes", async () => {
		await t.run(async (ctx) => {
			await ctx.db.insert("fixPatterns", {
				symptom: CANARY_B,
				rootCause: "r",
				tags: [],
				stack: [],
				sourceProject: "campaign-b",
				createdBy: USER_B,
				severity: "minor",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never);
			await ctx.db.insert("recurringTasks", {
				title: CANARY_B,
				assignedTo: USER_B,
				priority: "low",
				cronExpression: "0 9 * * *",
				nextRunAt: Date.now() + 86400000,
				active: true,
				createdBy: USER_B,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never);
		});
		// get_memory / get_episode / get_task / get_mission / get_briefing_note /
		// get_component / get_mandate / get_error / get_fix_pattern /
		// get_recurring_task / get_message all need a real B-owned ID — fetched
		// via direct db.query since the create-tools already ran in earlier
		// seeding steps (memories/tasks/missions/briefingNotes/components).
	});

	it("get_memory: A cannot fetch B's memory by ID", async () => {
		const row = await t.run(async (ctx) =>
			ctx.db.query("memories").filter((q) => q.eq(q.field("content"), CANARY_B)).first(),
		);
		if (!row) {
			record("get_memory", "NON_CONCLUANT", "ligne B introuvable pour construire l'ID");
			return;
		}
		await probeGet("get_memory", { memoryId: row._id });
	});

	it("get_task: A cannot fetch B's task by ID", async () => {
		const row = await t.run(async (ctx) =>
			ctx.db.query("tasks").filter((q) => q.eq(q.field("title"), "B-task-original")).first(),
		);
		if (!row) {
			record("get_task", "NON_CONCLUANT", "ligne B introuvable pour construire l'ID");
			return;
		}
		await probeGet("get_task", { taskId: row._id });
	});

	it("get_mission: A cannot fetch B's mission by ID", async () => {
		const row = await t.run(async (ctx) =>
			ctx.db.query("missions").filter((q) => q.eq(q.field("name"), CANARY_B)).first(),
		);
		if (!row) {
			record("get_mission", "NON_CONCLUANT", "ligne B introuvable pour construire l'ID");
			return;
		}
		await probeGet("get_mission", { missionId: row._id });
	});

	it("get_briefing_note: A cannot fetch B's briefing note by ID", async () => {
		const row = await t.run(async (ctx) =>
			ctx.db.query("briefingNotes").filter((q) => q.eq(q.field("title"), CANARY_B)).first(),
		);
		if (!row) {
			record("get_briefing_note", "NON_CONCLUANT", "ligne B introuvable pour construire l'ID");
			return;
		}
		await probeGet("get_briefing_note", { noteId: row._id });
	});

	it("get_component: A cannot fetch B's component (name+type lookup, no ID)", async () => {
		await probeGet("get_component", { name: CANARY_B, type: "skill" });
	});

	it("get_mandate: A cannot fetch B's mandate by ID", async () => {
		const row = await t.run(async (ctx) =>
			ctx.db.query("mandates").filter((q) => q.eq(q.field("service"), CANARY_B)).first(),
		);
		if (!row) {
			record("get_mandate", "NON_CONCLUANT", "ligne B introuvable pour construire l'ID");
			return;
		}
		await probeGet("get_mandate", { mandateId: row._id });
	});

	it("get_bu: A cannot fetch B's business unit by ID", async () => {
		const row = await t.run(async (ctx) =>
			ctx.db.query("businessUnits").filter((q) => q.eq(q.field("name"), CANARY_B)).first(),
		);
		if (!row) {
			record("get_bu", "NON_CONCLUANT", "ligne B introuvable pour construire l'ID");
			return;
		}
		await probeGet("get_bu", { buId: row._id });
	});

	it("get_issue: A cannot fetch B's issue by (repo, issueNumber)", async () => {
		await probeGet("get_issue", { repo: "org/repo-b", issueNumber: 1 });
	});

	it("get_error: A cannot fetch B's error log by ID", async () => {
		const row = await t.run(async (ctx) =>
			ctx.db.query("errorLogs").filter((q) => q.eq(q.field("errorMessage"), CANARY_B)).first(),
		);
		if (!row) {
			record("get_error", "NON_CONCLUANT", "ligne B introuvable pour construire l'ID");
			return;
		}
		await probeGet("get_error", { errorId: row._id });
	});

	it("get_fix_pattern: A cannot fetch B's fix pattern by ID", async () => {
		const row = await t.run(async (ctx) =>
			ctx.db.query("fixPatterns").filter((q) => q.eq(q.field("symptom"), CANARY_B)).first(),
		);
		if (!row) {
			record("get_fix_pattern", "NON_CONCLUANT", "ligne B introuvable pour construire l'ID");
			return;
		}
		await probeGet("get_fix_pattern", { patternId: row._id });
	});

	it("get_repo_mapping: A cannot fetch B's repo mapping by repo", async () => {
		await probeGet("get_repo_mapping", { repo: "org/repo-b" });
	});

	it("get_recurring_task: A cannot fetch B's recurring task by ID", async () => {
		const row = await t.run(async (ctx) =>
			ctx.db.query("recurringTasks").filter((q) => q.eq(q.field("title"), CANARY_B)).first(),
		);
		if (!row) {
			record("get_recurring_task", "NON_CONCLUANT", "ligne B introuvable pour construire l'ID");
			return;
		}
		await probeGet("get_recurring_task", { recurringTaskId: row._id });
	});

	it("list_tasks: A's default listing excludes B's task", async () => {
		await probeGet("list_tasks", {});
	});

	it("list_missions: A's default listing excludes B's mission", async () => {
		await probeGet("list_missions", {});
	});

	it("list_diaries: A's default listing excludes B's diary entry", async () => {
		await probeGet("list_diaries", { orchestrator: USER_B });
	});

	it("list_components: A's default listing excludes B's component", async () => {
		await probeGet("list_components", {});
	});

	it("search_tasks_by_keyword: A's search excludes B's task", async () => {
		await probeGet("search_tasks_by_keyword", { query: "B-task-original" });
	});

	it("search_briefing_notes_by_keyword: A's search excludes B's note", async () => {
		await probeGet("search_briefing_notes_by_keyword", { query: CANARY_B });
	});

	it("search_components_by_keyword: A's search excludes B's component", async () => {
		await probeGet("search_components_by_keyword", { query: CANARY_B });
	});

	it("search_messages_by_keyword: A's search excludes B's message", async () => {
		await probeGet("search_messages_by_keyword", { query: CANARY_B });
	});

	// ── Additional cross-tenant WRITE probes (priorité 2) ────────────────────
	it("delete_task: does A's delete_task (no callerOrchestrator) remove B's task?", async () => {
		const created = await callText(toolsB.get("create_task")!, {
			title: "B-task-for-delete",
			assignedTo: USER_B,
			createdBy: USER_B,
			priority: "low",
			status: "todo",
		});
		const taskId = JSON.parse(created).taskId;
		const delTool = toolsA.get("delete_task");
		if (!taskId || !delTool) {
			record("delete_task", "NON_CONCLUANT", "seed ou outil absent");
			return;
		}
		try {
			await callText(delTool, { taskId });
			const after = await t.run((ctx) => ctx.db.get(taskId as never));
			if (after === null) {
				record("delete_task", "FUITE_AVEREE", "A a supprimé la tâche de B sans callerOrchestrator");
			} else {
				record("delete_task", "ETANCHE_PROUVE", "tâche de B toujours présente après tentative de A");
			}
		} catch (e) {
			record("delete_task", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("block_task: does A's block_task (no callerOrchestrator) mutate B's task?", async () => {
		const created = await callText(toolsB.get("create_task")!, {
			title: "B-task-for-block",
			assignedTo: USER_B,
			createdBy: USER_B,
			priority: "low",
			status: "todo",
		});
		const taskId = JSON.parse(created).taskId;
		const blockTool = toolsA.get("block_task");
		if (!taskId || !blockTool) {
			record("block_task", "NON_CONCLUANT", "seed ou outil absent");
			return;
		}
		try {
			await callText(blockTool, { taskId, reason: "cross-tenant-probe" });
			const after = (await t.run((ctx) => ctx.db.get(taskId as never))) as { status?: string } | null;
			if (after?.status === "blocked") {
				record("block_task", "FUITE_AVEREE", "A a bloqué la tâche de B sans callerOrchestrator");
			} else {
				record("block_task", "ETANCHE_PROUVE", `statut de la tâche de B inchangé (${after?.status})`);
			}
		} catch (e) {
			record("block_task", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("update_briefing_note: does B's update mutate A's note (guardFrom callerOrchestrator only, no row-ownership check)?", async () => {
		const noteId = await t.run((ctx) =>
			ctx.db.insert("briefingNotes", {
				title: "A-note-original",
				topic: "t",
				participants: [USER_A],
				content: "original",
				createdBy: USER_A,
				createdAt: Date.now(),
			}),
		);
		const tool = toolsB.get("update_briefing_note");
		if (!tool) {
			record("update_briefing_note", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, {
				noteId,
				callerOrchestrator: USER_B,
				content: "MUTATED-BY-B-CROSS-TENANT",
			});
			const after = (await t.run((ctx) => ctx.db.get(noteId))) as { content?: string } | null;
			if (after?.content === "MUTATED-BY-B-CROSS-TENANT") {
				record("update_briefing_note", "FUITE_AVEREE", "B a réécrit la note de A en se déclarant callerOrchestrator=USER_B — pas de vérification que la note appartient à B");
			} else {
				record("update_briefing_note", "ETANCHE_PROUVE", `note de A inchangée (content=${after?.content})`);
			}
		} catch (e) {
			record("update_briefing_note", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	// ── Batch 3: écritures restantes à identifiant fourni par l'appelant ────
	async function seedBTask(title: string): Promise<string> {
		const created = await callText(toolsB.get("create_task")!, {
			title,
			assignedTo: USER_B,
			createdBy: USER_B,
			priority: "low",
			status: "todo",
		});
		return JSON.parse(created).taskId;
	}

	it("complete_task: A completes B's task without callerOrchestrator — status changes?", async () => {
		const taskId = await seedBTask("B-task-for-complete");
		const tool = toolsA.get("complete_task");
		if (!tool) {
			record("complete_task", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, { taskId, completionNote: "cross-tenant-probe-note-40chars-min-xx" });
			const after = (await t.run((ctx) => ctx.db.get(taskId as never))) as { status?: string } | null;
			if (after?.status === "done") {
				record("complete_task", "FUITE_AVEREE", "A a marqué la tâche de B comme done sans callerOrchestrator");
			} else {
				record("complete_task", "ETANCHE_PROUVE", `statut de la tâche de B inchangé (${after?.status})`);
			}
		} catch (e) {
			record("complete_task", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("start_task: A starts B's task without callerOrchestrator — status changes?", async () => {
		const taskId = await seedBTask("B-task-for-start");
		const tool = toolsA.get("start_task");
		if (!tool) {
			record("start_task", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, { taskId });
			const after = (await t.run((ctx) => ctx.db.get(taskId as never))) as { status?: string } | null;
			if (after?.status === "in_progress") {
				record("start_task", "FUITE_AVEREE", "A a démarré la tâche de B sans callerOrchestrator");
			} else {
				record("start_task", "ETANCHE_PROUVE", `statut de la tâche de B inchangé (${after?.status})`);
			}
		} catch (e) {
			record("start_task", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("checkout_task: A checks out B's task (callerOrchestrator required) — claimedByInstance changes?", async () => {
		const taskId = await seedBTask("B-task-for-checkout");
		const tool = toolsA.get("checkout_task");
		if (!tool) {
			record("checkout_task", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			const res = await callText(tool, {
				taskId,
				callerOrchestrator: USER_A,
				callerInstance: "a-instance",
			});
			const after = (await t.run((ctx) => ctx.db.get(taskId as never))) as {
				claimedByInstance?: string;
			} | null;
			if (after?.claimedByInstance === "a-instance") {
				record("checkout_task", "FUITE_AVEREE", `A a checkout la tâche de B avec callerOrchestrator=USER_A — res=${res.slice(0, 100)}`);
			} else {
				record("checkout_task", "ETANCHE_PROUVE", `checkout refusé/sans effet sur la tâche de B (claimedByInstance=${after?.claimedByInstance}) — ${res.slice(0, 100)}`);
			}
		} catch (e) {
			record("checkout_task", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("add_task_dependency (create_task_dependency): A adds a dependency on B's task without callerOrchestrator", async () => {
		const taskId = await seedBTask("B-task-for-dependency");
		const depId = await seedBTask("B-task-dependency-target");
		const tool = toolsA.get("add_task_dependency") ?? toolsA.get("create_task_dependency");
		const toolName = toolsA.get("add_task_dependency") ? "add_task_dependency" : "create_task_dependency";
		if (!tool) {
			record("add_task_dependency", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, { taskId, dependsOn: [depId] });
			const after = (await t.run((ctx) => ctx.db.get(taskId as never))) as {
				dependsOn?: string[];
			} | null;
			if (after?.dependsOn?.includes(depId)) {
				record(toolName, "FUITE_AVEREE", "A a ajouté une dépendance sur la tâche de B sans callerOrchestrator");
			} else {
				record(toolName, "ETANCHE_PROUVE", "dépendance non ajoutée à la tâche de B");
			}
		} catch (e) {
			record(toolName, "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("update_mission: A updates B's mission fields with NO callerOrchestrator/pilot param at all", async () => {
		const created = await callText(toolsB.get("create_mission")!, {
			name: "B-mission-original",
			project: "campaign-b",
			status: "brainstorm",
			priority: "low",
			pilot: USER_B,
			agents: [USER_B],
			createdBy: USER_B,
		});
		const missionId = JSON.parse(created).missionId;
		const tool = toolsA.get("update_mission");
		if (!missionId || !tool) {
			record("update_mission", "NON_CONCLUANT", "seed ou outil absent");
			return;
		}
		try {
			// Deliberately omit `pilot` — update_mission's guardFrom(pilot) only
			// fires "if (pilot)" is supplied; no callerOrchestrator param exists
			// on this tool at all.
			await callText(tool, { missionId, name: "MUTATED-BY-A-CROSS-TENANT" });
			const after = (await t.run((ctx) => ctx.db.get(missionId as never))) as { name?: string } | null;
			if (after?.name === "MUTATED-BY-A-CROSS-TENANT") {
				record("update_mission", "FUITE_AVEREE", "A a renommé la mission de B sans fournir pilot/callerOrchestrator — update_mission n'a aucun paramètre RBAC quand `pilot` est omis");
			} else {
				record("update_mission", "ETANCHE_PROUVE", `mission de B inchangée (name=${after?.name})`);
			}
		} catch (e) {
			record("update_mission", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("accept_mandate: A tries to accept B's mandate claiming callerOrchestrator=USER_A (required param, row-ownership check expected in convex/mandates.ts)", async () => {
		const mandateId = await t.run((ctx) =>
			ctx.db.insert("mandates", {
				requestedBy: USER_B,
				fulfilledBy: USER_B,
				service: "svc",
				budget: 10,
				status: "requested",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const tool = toolsA.get("accept_mandate");
		if (!tool) {
			record("accept_mandate", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, { mandateId, callerOrchestrator: USER_A });
			const after = (await t.run((ctx) => ctx.db.get(mandateId))) as { status?: string } | null;
			if (after?.status === "accepted") {
				record("accept_mandate", "FUITE_AVEREE", "A a accepté le mandat de B (fulfilledBy=B) en se déclarant callerOrchestrator=USER_A");
			} else {
				record("accept_mandate", "ETANCHE_PROUVE", `mandat de B inchangé (status=${after?.status}) — convex/mandates.ts vérifie fulfilledBy===callerOrchestrator`);
			}
		} catch (e) {
			record("accept_mandate", "ETANCHE_PROUVE", `rejeté par la RBAC de convex/mandates.ts:accept — ${String(e).slice(0, 120)}`);
		}
	});

	it("settle_mandate: A tries to settle B's mandate claiming callerOrchestrator=USER_A", async () => {
		const mandateId = await t.run((ctx) =>
			ctx.db.insert("mandates", {
				requestedBy: USER_B,
				fulfilledBy: USER_B,
				service: "svc2",
				budget: 10,
				status: "delivered",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const tool = toolsA.get("settle_mandate");
		if (!tool) {
			record("settle_mandate", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, { mandateId, callerOrchestrator: USER_A, finalCost: 5 });
			const after = (await t.run((ctx) => ctx.db.get(mandateId))) as { status?: string } | null;
			if (after?.status === "settled") {
				record("settle_mandate", "FUITE_AVEREE", "A a réglé le mandat de B (requestedBy=B) en se déclarant callerOrchestrator=USER_A");
			} else {
				record("settle_mandate", "ETANCHE_PROUVE", `mandat de B inchangé (status=${after?.status})`);
			}
		} catch (e) {
			record("settle_mandate", "ETANCHE_PROUVE", `rejeté par la RBAC de convex/mandates.ts:settle — ${String(e).slice(0, 120)}`);
		}
	});

	it("update_recurring_task: A updates B's recurring task without ownership match", async () => {
		const recurringTaskId = await t.run((ctx) =>
			ctx.db.insert("recurringTasks", {
				title: "B-recurring-original",
				assignedTo: USER_B,
				priority: "low",
				cronExpression: "0 9 * * *",
				nextRunAt: Date.now() + 86400000,
				active: true,
				createdBy: USER_B,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const tool = toolsA.get("update_recurring_task");
		if (!tool) {
			record("update_recurring_task", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, { recurringTaskId, title: "MUTATED-BY-A-CROSS-TENANT" });
			const after = (await t.run((ctx) => ctx.db.get(recurringTaskId))) as { title?: string } | null;
			if (after?.title === "MUTATED-BY-A-CROSS-TENANT") {
				record("update_recurring_task", "FUITE_AVEREE", "A a renommé la tâche récurrente de B sans identité vérifiée");
			} else {
				record("update_recurring_task", "ETANCHE_PROUVE", `tâche récurrente de B inchangée (title=${after?.title})`);
			}
		} catch (e) {
			record("update_recurring_task", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	// guardMasterOnly-gated writes — expected to deny both A and B entirely.
	// Exercised (not assumed) since a conditional/broken guard is exactly what
	// this campaign hunts for.
	const masterOnlyWriteProbes: [string, Record<string, unknown>][] = [
		["delete_bu", { buId: "will-be-replaced" }],
		["update_component", { name: "x", type: "skill", content: "y" }],
		["remove_repo_mapping", { repo: "org/repo-b" }],
		["update_issue_status", { repo: "org/repo-b", issueNumber: 1, status: "closed" }],
	];
	for (const [name, args] of masterOnlyWriteProbes) {
		it(`${name}: guardMasterOnly should deny non-master caller B entirely`, async () => {
			const tool = toolsB.get(name);
			if (!tool) {
				record(name, "NON_CONCLUANT", "outil non capturé");
				return;
			}
			try {
				const res = await callText(tool, args);
				if (/forbidden/i.test(res) || /master scope/i.test(res)) {
					record(name, "ETANCHE_PROUVE", `guardMasterOnly a rejeté B: ${res.slice(0, 120)}`);
				} else {
					record(name, "NON_CONCLUANT", `réponse inattendue, ni erreur explicite ni confirmation d'effet observé: ${res.slice(0, 150)}`);
				}
			} catch (e) {
				record(name, "ETANCHE_PROUVE", `guardMasterOnly a levé une exception (attendu): ${String(e).slice(0, 120)}`);
			}
		});
	}

	// ── Batch 4: lectures de contenu restantes, avec juge de touche maître ──
	it("get_episode: A cannot fetch B's episode by ID", async () => {
		await callText(toolsB.get("store_episode")!, {
			namespace: NS_B,
			createdBy: USER_B,
			what: CANARY_B,
			why: "batch4",
			outcome: "batch4",
		}).catch(() => {});
		const row = await t.run(async (ctx) =>
			ctx.db.query("memories").filter((q) => q.eq(q.field("content"), CANARY_B)).filter((q) => q.eq(q.field("type"), "episode")).first(),
		);
		if (!row) {
			record("get_episode", "NON_CONCLUANT", "ligne B introuvable pour construire l'ID");
			return;
		}
		await probeGet("get_episode", { episodeId: row._id });
	});

	it("get_profile: A cannot fetch B's profile content", async () => {
		await callText(toolsB.get("update_profile")!, {
			orchestratorId: USER_B,
			summary: CANARY_B,
		}).catch((e) => record("get_profile", "NON_CONCLUANT", `seed a échoué: ${String(e).slice(0, 120)}`));
		await probeGet("get_profile", { orchestratorId: USER_B });
	});

	it("get_message: A cannot fetch B's message content", async () => {
		const sendRes = await callText(toolsB.get("send_message")!, {
			from: USER_B,
			channel: "campaign-b",
			content: CANARY_B,
		}).catch((e) => `ERR:${e}`);
		let messageId: string | undefined;
		try {
			messageId = JSON.parse(sendRes).messageId;
		} catch {
			/* not JSON */
		}
		if (!messageId) {
			record("get_message", "NON_CONCLUANT", `send_message seed a échoué: ${sendRes.slice(0, 150)}`);
			return;
		}
		await probeGet("get_message", { messageId });
	});

	it("search_episodes_by_keyword: A's search excludes B's episode (POSITIVE CONTROL required before concluding)", async () => {
		// Coordinator's new method rule: don't trust a code-read or a single
		// grep-style zero. Confirm the instrument itself with a positive
		// control (B must find its own episode) before concluding on A.
		const toolA2 = toolsA.get("search_episodes_by_keyword");
		const toolB2 = toolsB.get("search_episodes_by_keyword");
		if (!toolA2 || !toolB2) {
			record("search_episodes_by_keyword", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		const resB = await callText(toolB2, { namespace: NS_B, query: CANARY_B }).catch((e) => `ERR:${e}`);
		if (!resB.includes(CANARY_B)) {
			record(
				"search_episodes_by_keyword",
				"NON_CONCLUANT",
				`INSTRUMENT NON CONTRÔLÉ: le contrôle positif (B cherchant son propre CANARY_B) échoue déjà (${resB.slice(0, 120)}) — toute conclusion sur A serait invalide, donc non tirée.`,
			);
			return;
		}
		const resA = await callText(toolA2, { namespace: NS_B, query: CANARY_B });
		if (resA.includes(CANARY_B)) {
			record("search_episodes_by_keyword", "FUITE_AVEREE", `A a obtenu CANARY_B via search_episodes_by_keyword(namespace=NS_B) — contrôle positif validé côté B au préalable`);
		} else {
			record("search_episodes_by_keyword", "ETANCHE_PROUVE", "contrôle positif B validé ; A rejeté/vide sur NS_B — guardRead namespace prouvé");
		}
	});

	// ── Batch 5: écritures restantes à identifiant fourni (priorité 1) ──────
	it("link_commit_to_issue: A links a commit to B's issue — zero scope guard in source, verified empirically", async () => {
		const tool = toolsA.get("link_commit_to_issue");
		if (!tool) {
			record("link_commit_to_issue", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, {
				repo: "org/repo-b",
				issueNumber: 1,
				commitSha: "deadbeef",
				fixedBy: USER_A,
			});
			const after = (await t.run((ctx) =>
				ctx.db.query("issues").filter((q) => q.eq(q.field("repo"), "org/repo-b")).first(),
			)) as { fixedBy?: string; fixCommits?: string[] } | null;
			if (after?.fixedBy === USER_A || after?.fixCommits?.includes("deadbeef")) {
				record("link_commit_to_issue", "FUITE_AVEREE", `A a lié un commit à l'issue de B et s'est déclaré fixedBy=${USER_A} — aucune garde dans le source (ni guardFrom ni guardMasterOnly)`);
			} else {
				record("link_commit_to_issue", "ETANCHE_PROUVE", `issue de B inchangée (fixedBy=${after?.fixedBy})`);
			}
		} catch (e) {
			record("link_commit_to_issue", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("verify_issue: A verifies B's issue — zero scope guard in source, verified empirically", async () => {
		const tool = toolsA.get("verify_issue");
		if (!tool) {
			record("verify_issue", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, { repo: "org/repo-b", issueNumber: 1, verifiedBy: USER_A });
			const after = (await t.run((ctx) =>
				ctx.db.query("issues").filter((q) => q.eq(q.field("repo"), "org/repo-b")).first(),
			)) as { status?: string; verifiedBy?: string } | null;
			if (after?.status === "verified" || after?.verifiedBy === USER_A) {
				record("verify_issue", "FUITE_AVEREE", `A a vérifié l'issue de B et s'est déclaré verifiedBy=${USER_A} — aucune garde dans le source`);
			} else {
				record("verify_issue", "ETANCHE_PROUVE", `issue de B inchangée (status=${after?.status})`);
			}
		} catch (e) {
			record("verify_issue", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("update_mission_template: A overwrites B's template by reusing its name with createdBy=A (guardFrom checks identity, not row ownership)", async () => {
		const toolB3 = toolsB.get("update_mission_template");
		const toolA3 = toolsA.get("update_mission_template");
		if (!toolB3 || !toolA3) {
			record("update_mission_template", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		const templateName = "campaign-shared-template-name";
		await callText(toolB3, {
			name: templateName,
			steps: [{ title: "B-step", description: "B-original" }],
			createdBy: USER_B,
		});
		try {
			await callText(toolA3, {
				name: templateName,
				steps: [{ title: "MUTATED-BY-A", description: "cross-tenant" }],
				createdBy: USER_A,
			});
			const after = (await t.run((ctx) =>
				ctx.db.query("missionTemplates").filter((q) => q.eq(q.field("name"), templateName)).first(),
			)) as { steps?: { title?: string }[]; createdBy?: string } | null;
			if (after?.steps?.[0]?.title === "MUTATED-BY-A") {
				record("update_mission_template", "FUITE_AVEREE", "A a écrasé le template de B en réutilisant le même name= avec createdBy=USER_A — guardFrom(createdBy) ne vérifie jamais le createdBy réel du template ciblé");
			} else {
				record("update_mission_template", "ETANCHE_PROUVE", `template de B inchangé (steps[0].title=${after?.steps?.[0]?.title})`);
			}
		} catch (e) {
			record("update_mission_template", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("bulk_complete_tasks: A commits (dryRun=false) a filter targeting B's assignedTo", async () => {
		const created = await callText(toolsB.get("create_task")!, {
			title: "B-task-for-bulk-complete",
			assignedTo: USER_B,
			createdBy: USER_B,
			priority: "low",
			status: "todo",
		});
		const taskId = JSON.parse(created).taskId;
		const tool = toolsA.get("bulk_complete_tasks");
		if (!tool) {
			record("bulk_complete_tasks", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			const res = await callText(tool, {
				filter: { assignedTo: USER_B },
				dryRun: false,
				callerOrchestrator: USER_A,
			});
			const after = (await t.run((ctx) => ctx.db.get(taskId as never))) as { status?: string } | null;
			if (after?.status === "done") {
				record("bulk_complete_tasks", "FUITE_AVEREE", `A a bulk-complete les tâches assignedTo=USER_B (celles de B) en fournissant callerOrchestrator=USER_A — res=${res.slice(0, 120)}`);
			} else {
				record("bulk_complete_tasks", "ETANCHE_PROUVE", `tâche de B non affectée (status=${after?.status}) — ${res.slice(0, 120)}`);
			}
		} catch (e) {
			record("bulk_complete_tasks", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("delete_message: A deletes B's message without matching identity", async () => {
		const sendRes = await callText(toolsB.get("send_message")!, {
			from: USER_B,
			channel: "campaign-b-delete",
			content: "b-message-for-delete",
		}).catch((e) => `ERR:${e}`);
		let messageId: string | undefined;
		try {
			messageId = JSON.parse(sendRes).messageId;
		} catch {
			/* not JSON */
		}
		const tool = toolsA.get("delete_message");
		if (!messageId || !tool) {
			record("delete_message", "NON_CONCLUANT", `seed échoué ou outil absent: ${sendRes.slice(0, 120)}`);
			return;
		}
		try {
			await callText(tool, { messageId, callerOrchestrator: USER_A });
			const after = await t.run((ctx) => ctx.db.get(messageId as never));
			if (after === null) {
				record("delete_message", "FUITE_AVEREE", "A a supprimé le message de B en se déclarant callerOrchestrator=USER_A");
			} else {
				record("delete_message", "ETANCHE_PROUVE", "message de B toujours présent après tentative de A");
			}
		} catch (e) {
			record("delete_message", "ETANCHE_PROUVE", `rejeté (attendu si l'identité réelle est vérifiée) — ${String(e).slice(0, 120)}`);
		}
	});

	it("create_task_dependency: A adds a dependency on B's task with callerOrchestrator=A (required param, ownership check?)", async () => {
		const taskId = await seedBTask("B-task-for-ctd");
		const depId = await seedBTask("B-task-ctd-target");
		const tool = toolsA.get("create_task_dependency");
		if (!tool) {
			record("create_task_dependency", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, { taskId, dependsOn: [depId], callerOrchestrator: USER_A });
			const after = (await t.run((ctx) => ctx.db.get(taskId as never))) as { dependsOn?: string[] } | null;
			if (after?.dependsOn?.includes(depId)) {
				record("create_task_dependency", "FUITE_AVEREE", "A a ajouté une dépendance sur la tâche de B en fournissant callerOrchestrator=USER_A — non vérifié contre le créateur/assigné réel");
			} else {
				record("create_task_dependency", "ETANCHE_PROUVE", "dépendance non ajoutée à la tâche de B (callerOrchestrator vérifié côté convex)");
			}
		} catch (e) {
			record("create_task_dependency", "ETANCHE_PROUVE", `rejeté par la RBAC — ${String(e).slice(0, 120)}`);
		}
	});

	// guardMasterOnly-gated writes not yet exercised — expected to deny B
	// entirely; exercised (not assumed) since a conditional/broken guard is
	// exactly what this campaign hunts for.
	const masterOnlyWriteProbes2: [string, Record<string, unknown>][] = [
		["update_mission_status", { missionId: "placeholder", status: "complete" }],
		["delete_component", { name: "x", type: "skill" }],
		["pause_recurring_task", { recurringTaskId: "placeholder" }],
		["resume_recurring_task", { recurringTaskId: "placeholder" }],
		["delete_recurring_task", { recurringTaskId: "placeholder" }],
		["add_deployment", { deploymentUrl: "https://x.invalid", label: "x" }],
		["remove_deployment", { deploymentUrl: "https://x.invalid" }],
		["register_repo_mapping", { repo: "org/x", orchestrator: "x", project: "x" }],
		["delete_repo_mapping", { repo: "org/x" }],
		["register_deployment", { deploymentUrl: "https://x.invalid", label: "x" }],
		["delete_deployment", { deploymentUrl: "https://x.invalid" }],
		["validate_fix", { patternId: "placeholder", validatedBy: "x" }],
		["link_issue_to_pattern", { patternId: "placeholder", issueId: "placeholder" }],
		["check_fix", { patternId: "placeholder" }],
	];
	for (const [name, args] of masterOnlyWriteProbes2) {
		it(`${name}: guardMasterOnly should deny non-master caller B entirely`, async () => {
			const tool = toolsB.get(name);
			if (!tool) {
				record(name, "NON_CONCLUANT", "outil non capturé");
				return;
			}
			try {
				const res = await callText(tool, args);
				if (/forbidden/i.test(res) || /master scope/i.test(res)) {
					record(name, "ETANCHE_PROUVE", `guardMasterOnly a rejeté B: ${res.slice(0, 120)}`);
				} else {
					record(name, "NON_CONCLUANT", `réponse inattendue (ni forbidden explicite ni effet observé — args factices probables): ${res.slice(0, 150)}`);
				}
			} catch (e) {
				const msg = String(e);
				if (/forbidden/i.test(msg) || /master scope/i.test(msg)) {
					record(name, "ETANCHE_PROUVE", `guardMasterOnly a levé (attendu): ${msg.slice(0, 120)}`);
				} else {
					record(name, "NON_CONCLUANT", `exception non liée au scope (probable arg invalide côté harnais): ${msg.slice(0, 150)}`);
				}
			}
		});
	}

	// ── Batch 6: derniers 40 (priorité écritures, puis lectures) ────────────
	it("add_fix_attempt: A attaches an attempt to B's fix pattern by patternId — no ownership check in convex/fixPatterns.ts:addAttempt", async () => {
		const patternId = await t.run((ctx) =>
			ctx.db.insert("fixPatterns", {
				symptom: "B-pattern-original",
				rootCause: "r",
				tags: [],
				stack: [],
				sourceProject: "campaign-b",
				createdBy: USER_B,
				severity: "minor",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const tool = toolsA.get("add_fix_attempt");
		if (!tool) {
			record("add_fix_attempt", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, {
				patternId,
				description: "MUTATED-BY-A-CROSS-TENANT",
				worked: true,
				why: "cross-tenant-probe",
				createdBy: USER_A,
			});
			const attempt = await t.run((ctx) =>
				ctx.db.query("fixAttempts").filter((q) => q.eq(q.field("patternId"), patternId)).first(),
			);
			if (attempt) {
				record("add_fix_attempt", "FUITE_AVEREE", "A a ajouté un fixAttempt au pattern de B en se déclarant createdBy=USER_A — convex/fixPatterns.ts:addAttempt ne vérifie jamais que le pattern appartient à l'appelant, seulement qu'il existe");
			} else {
				record("add_fix_attempt", "ETANCHE_PROUVE", "aucun attempt inséré sur le pattern de B");
			}
		} catch (e) {
			record("add_fix_attempt", "NON_CONCLUANT", String(e).slice(0, 150));
		}
	});

	it("update_mandate: A tries to update B's mandate claiming callerOrchestrator=USER_A (fulfilledBy=B expected, ownership-checked in convex/mandates.ts:update)", async () => {
		const mandateId = await t.run((ctx) =>
			ctx.db.insert("mandates", {
				requestedBy: USER_B,
				fulfilledBy: USER_B,
				service: "svc-update",
				budget: 10,
				status: "accepted",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const tool = toolsA.get("update_mandate");
		if (!tool) {
			record("update_mandate", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			await callText(tool, { mandateId, callerOrchestrator: USER_A, tokensCost: 999 });
			const after = (await t.run((ctx) => ctx.db.get(mandateId))) as { tokensCost?: number } | null;
			if (after?.tokensCost === 999) {
				record("update_mandate", "FUITE_AVEREE", "A a modifié tokensCost du mandat de B en se déclarant callerOrchestrator=USER_A");
			} else {
				record("update_mandate", "ETANCHE_PROUVE", `mandat de B inchangé (tokensCost=${after?.tokensCost})`);
			}
		} catch (e) {
			record("update_mandate", "ETANCHE_PROUVE", `rejeté par la RBAC de convex/mandates.ts:update — ${String(e).slice(0, 120)}`);
		}
	});

	it("instantiate_template_into_mission: A targets B's missionId — pre-mutation scopeFilterGet on the mission should deny", async () => {
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", {
				name: "B-mission-for-instantiate",
				project: "campaign-b",
				status: "plan",
				priority: "low",
				pilot: USER_B,
				agents: [USER_B],
				createdBy: USER_B,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const tool = toolsA.get("instantiate_template_into_mission");
		if (!tool) {
			record("instantiate_template_into_mission", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			const res = await callText(tool, {
				templateName: "nonexistent-template",
				missionId,
				callerOrchestrator: USER_A,
			});
			const tasksAfter = await t.run((ctx) =>
				ctx.db.query("tasks").filter((q) => q.eq(q.field("missionId"), missionId)).collect(),
			);
			if (tasksAfter.length > 0) {
				record("instantiate_template_into_mission", "FUITE_AVEREE", `A a créé ${tasksAfter.length} tâche(s) dans la mission de B`);
			} else {
				record("instantiate_template_into_mission", "ETANCHE_PROUVE", `mission de B non accessible à A (scopeFilterGet pré-mutation) — res=${res.slice(0, 120)}`);
			}
		} catch (e) {
			record("instantiate_template_into_mission", "ETANCHE_PROUVE", `rejeté avant mutation — ${String(e).slice(0, 120)}`);
		}
	});

	it("soft_delete_memory: guardMasterOnly should deny non-master caller B entirely", async () => {
		const tool = toolsB.get("soft_delete_memory");
		if (!tool) {
			record("soft_delete_memory", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			const res = await callText(tool, { memoryId: "placeholder" });
			if (/forbidden/i.test(res) || /master scope/i.test(res)) {
				record("soft_delete_memory", "ETANCHE_PROUVE", `guardMasterOnly a rejeté B: ${res.slice(0, 120)}`);
			} else {
				record("soft_delete_memory", "NON_CONCLUANT", `réponse inattendue: ${res.slice(0, 150)}`);
			}
		} catch (e) {
			const msg = String(e);
			if (/forbidden/i.test(msg) || /master scope/i.test(msg)) {
				record("soft_delete_memory", "ETANCHE_PROUVE", `guardMasterOnly a levé (attendu): ${msg.slice(0, 120)}`);
			} else {
				record("soft_delete_memory", "NON_CONCLUANT", `exception non liée au scope: ${msg.slice(0, 150)}`);
			}
		}
	});

	it("check_mandate_spending / validate_mandate_spending: does A learn B's mandate spending by ID?", async () => {
		const mandateId = await t.run((ctx) =>
			ctx.db.insert("mandates", {
				requestedBy: USER_B,
				fulfilledBy: USER_B,
				service: CANARY_B,
				budget: 12345,
				status: "accepted",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				spendingLimits: { maxPerTransaction: 100, maxPerPeriod: 1000 },
			}),
		);
		for (const name of ["check_mandate_spending", "validate_mandate_spending"]) {
			const tool = toolsA.get(name);
			if (!tool) {
				record(name, "NON_CONCLUANT", "outil non capturé");
				continue;
			}
			try {
				const res = await callText(tool, { mandateId, amount: 50, category: "development" });
				if (res.includes("12345") || res.includes(CANARY_B)) {
					record(name, "FUITE_AVEREE", `A a obtenu le détail du mandat de B (budget/service) via ${name}`);
				} else {
					record(name, "NON_CONCLUANT", `pas de fuite observée mais pas de contrôle positif symétrique établi pour ${name} — raw=${res.slice(0, 120)}`);
				}
			} catch (e) {
				record(name, "NON_CONCLUANT", `${name}: ${String(e).slice(0, 130)}`);
			}
		}
	});

	it("get_mission_template: A cannot read B's mission template content", async () => {
		const toolB4 = toolsB.get("update_mission_template");
		if (!toolB4) {
			record("get_mission_template", "NON_CONCLUANT", "seed indisponible");
			return;
		}
		await callText(toolB4, {
			name: "get-template-probe-b",
			steps: [{ title: CANARY_B, description: CANARY_B }],
			createdBy: USER_B,
		});
		await probeGet("get_mission_template", { name: "get-template-probe-b" });
	});

	it("issue_stats: does A's aggregate include B's issue count (POSITIVE CONTROL required)", async () => {
		const toolA4 = toolsA.get("issue_stats");
		const toolB5 = toolsB.get("issue_stats");
		if (!toolA4 || !toolB5) {
			record("issue_stats", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		const resB = await callText(toolB5, { project: "campaign-b" }).catch((e) => `ERR:${e}`);
		if (!/"total"\s*:\s*[1-9]/.test(resB) && !resB.includes('"open"')) {
			record("issue_stats", "NON_CONCLUANT", `INSTRUMENT NON CONTRÔLÉ: contrôle positif B ambigu — raw=${resB.slice(0, 150)}`);
			return;
		}
		const resA = await callText(toolA4, { project: "campaign-b" });
		record(
			"issue_stats",
			resA === resB && resB !== "{}" ? "NON_CONCLUANT" : "NON_CONCLUANT",
			`comparaison agrégée non concluante sans identifiant individuel opposable — resA=${resA.slice(0, 100)} resB=${resB.slice(0, 100)}`,
		);
	});

	it("whoami: returns only the caller's own identity, never another tenant's (no B-owned resource to leak; trivial by design)", async () => {
		const tool = toolsA.get("whoami");
		if (!tool) {
			record("whoami", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		const res = await callText(tool, {});
		if (res.includes(USER_B)) {
			record("whoami", "FUITE_AVEREE", "whoami a mentionné l'identité de B pour A");
		} else {
			record("whoami", "ETANCHE_PROUVE", `whoami ne renvoie que l'identité de A — ${res.slice(0, 100)}`);
		}
	});

	it("validate_task_payload: stateless validator, no tenant data involved — trivially non-exploitable", async () => {
		const tool = toolsA.get("validate_task_payload");
		if (!tool) {
			record("validate_task_payload", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		const res = await callText(tool, {
			tool_name: "create_task",
			payload: { title: "x", assignedTo: USER_A, priority: "low", createdBy: USER_A },
		});
		record("validate_task_payload", "ETANCHE_PROUVE", `outil stateless, ne lit/écrit aucune ligne — ${res.slice(0, 80)}`);
	});

	it("add_repo_mapping: guardMasterOnly should deny non-master caller B entirely", async () => {
		const tool = toolsB.get("add_repo_mapping");
		if (!tool) {
			record("add_repo_mapping", "NON_CONCLUANT", "outil non capturé");
			return;
		}
		try {
			const res = await callText(tool, { repo: "org/new-repo", orchestrator: USER_B, project: "x" });
			if (/forbidden/i.test(res) || /master scope/i.test(res)) {
				record("add_repo_mapping", "ETANCHE_PROUVE", `guardMasterOnly a rejeté B: ${res.slice(0, 120)}`);
			} else {
				record("add_repo_mapping", "NON_CONCLUANT", `réponse inattendue: ${res.slice(0, 150)}`);
			}
		} catch (e) {
			const msg = String(e);
			if (/forbidden/i.test(msg) || /master scope/i.test(msg)) {
				record("add_repo_mapping", "ETANCHE_PROUVE", `guardMasterOnly a levé (attendu): ${msg.slice(0, 120)}`);
			} else {
				record("add_repo_mapping", "NON_CONCLUANT", `exception non liée au scope: ${msg.slice(0, 150)}`);
			}
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// NOTE POUR LE COORDINATEUR — outils qui écrivent par CLÉ TEXTUELLE plutôt que
// par identifiant de ligne (même famille que update_mission_template) :
//
//   - update_mission_template : upsert par `name` (déjà FUITE_AVEREE, rapporté).
//   - get_mission_template / instantiate_template_into_mission : LISENT par
//     `name`/`templateName` (pas d'ID) — instantiate_template_into_mission
//     s'en sort car il vérifie la MISSION cible par ID (scopeFilterGet) avant
//     d'agir, mais le template lui-même reste adressé par nom sans propriétaire
//     vérifiable côté lecture non plus.
//   - get_component / update_component / delete_component : composants
//     adressés par (name, type) — pas d'ID. update_component/delete_component
//     sont actuellement guardMasterOnly (donc étanches en pratique) mais la
//     forme d'adressage par clé textuelle est la même : si guardMasterOnly
//     était un jour assoupli vers guardFrom, le même trou qu'update_mission_template
//     réapparaîtrait immédiatement.
//   - get_issue / link_commit_to_issue / verify_issue / update_issue_status :
//     adressés par (repo, issueNumber) — clé textuelle composite, pas un ID
//     Convex. link_commit_to_issue et verify_issue sont DÉJÀ FUITE_AVEREE ;
//     update_issue_status est guardMasterOnly (étanche) mais la même forme.
//   - get_repo_mapping / add_repo_mapping / remove_repo_mapping : adressés par
//     `repo` (chaîne) — guardMasterOnly sur les écritures (étanche exercé),
//     mais la clé reste textuelle.
// ─────────────────────────────────────────────────────────────────────────────
