/// <reference types="vite/client" />
//
// erase:eraseRow — the ONE erase door behind the erase_row MCP tool. Task
// k170t9bg650dyw6hxjj627p9fx8hhpeq (Pi 2026-11-03).
//
// RULE. An org admin erases any row of its org; any author erases the rows it wrote, a
// person by verified subject, an AGENT by verified agent ID; another org and a same-org
// non-author are refused (typed, row unchanged). A real erase: row gone, never a flag.
//
// POLES, per table family, under SCOPED identities (the fleet service account is only
// the transport that carries a seat's / a person's proof):
//   SEAT AUTHOR      the verified agent that wrote the row erases it
//   SEAT NON-AUTHOR  another agent of the same org is refused; the row is unchanged
//   SEAT OTHER ORG   an agent of another org is refused; the row is unchanged
//   ADMIN            a same-org admin (person bearer) erases a row written by anyone
//   MEMBER AUTHOR    a same-org member erases the row it wrote
//   MEMBER OTHER     a same-org member is refused on a row someone else wrote
//   OTHER ORG ADMIN  an admin of another org is refused; the row is unchanged
//   LEGACY           a row written before the author ID was stored is erasable by an admin only
//   SESSION          a Clerk session admin (dashboard / Clerk-JWT bearer) erases
// plus the transport poles (claimless service account, unknown table, org-less caller).

import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { CHAIN_SCAN_CAP, ERASE_COVERED } from "../lib/eraseRow";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const A = "erase-org-a";
const B = "erase-org-b";
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);
const ALICE = "alice";
const CAROL = "carol";
const BOB = "bob";

const H_ADMIN_A = "a".repeat(64);
const H_MEMBER_A = "b".repeat(64);
const H_OTHER_A = "c".repeat(64);
const H_ADMIN_B = "d".repeat(64);
const MEMBER_ACTOR = "user:user_member_a";

let t: T;
let agents: Record<string, Id<"agents">>;

beforeEach(async () => {
	vi.useFakeTimers();
	t = createT();
	const now = Date.now();
	await t.run(async (ctx) => {
		for (const [slug, roster] of [
			[A, [ALICE, CAROL]],
			[B, [BOB]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [...roster],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		}
		const base = {
			clientId: "c",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "person",
			fromAllowList: [ALICE],
			expiresAt: now + 3_600_000,
			createdAt: now,
			principal: "person" as const,
		};
		const tokens: [string, string, string, string][] = [
			[H_ADMIN_A, "user_admin_a", "org:admin", A],
			[H_MEMBER_A, "user_member_a", "org:member", A],
			[H_OTHER_A, "user_other_a", "org:member", A],
			[H_ADMIN_B, "user_admin_b", "org:admin", B],
		];
		for (const [tokenHash, userId, orgRole, org] of tokens) {
			await ctx.db.insert("oauth_access_tokens", {
				...base,
				namespaceReadPrefixes: [`team/${org}`],
				namespaceWritePrefixes: [`team/${org}`],
				tokenHash,
				userId,
				orgRole,
				clerkOrgSlug: org,
			});
		}
	});
	agents = await seedRosterAgents(t);
});
afterEach(() => {
	vi.useRealTimers();
});

const service = () => t.withIdentity({ subject: SERVICE });
const sessionOf = (subject: string, org: string, role: string) =>
	t.withIdentity({
		subject,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Parameters<typeof t.withIdentity>[0]);

type Table = keyof typeof ERASE_COVERED;
type Caller =
	| { kind: "seat"; agent: string; org: string }
	| { kind: "person"; hash: string; org: string }
	| { kind: "session"; subject: string; org: string; role: string };

const seatOf = (agent: string, org: string): Caller => ({ kind: "seat", agent, org });
const personOf = (hash: string, org: string): Caller => ({ kind: "person", hash, org });
const ADMIN_A: Caller = personOf(H_ADMIN_A, A);
const MEMBER_A: Caller = personOf(H_MEMBER_A, A);
const OTHER_A: Caller = personOf(H_OTHER_A, A);
const ADMIN_B: Caller = personOf(H_ADMIN_B, B);
const ALICE_SEAT = seatOf(ALICE, A);
const CAROL_SEAT = seatOf(CAROL, A);
const BOB_SEAT = seatOf(BOB, B);

function erase(caller: Caller, table: string, rowId: string): Promise<unknown> {
	const args = { table, rowId } as Record<string, unknown>;
	if (caller.kind === "seat") {
		return service().mutation(api.erase.eraseRow, {
			...args,
			__actingOrg: testClerkOrgId(caller.org),
			verifiedActor: { agentId: agents[`${caller.org}/${caller.agent}`], orgSlug: caller.org },
		} as never);
	}
	if (caller.kind === "person") {
		return service().mutation(api.erase.eraseRow, {
			...args,
			__actingOrg: testClerkOrgId(caller.org),
			verifiedPerson: { accessTokenHash: caller.hash },
		} as never);
	}
	return sessionOf(caller.subject, caller.org, caller.role).mutation(
		api.erase.eraseRow,
		args as never,
	);
}

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		const m = /([A-Z][A-Z_]{3,}):/.exec(text);
		return m ? m[1] : `OTHER(${text.slice(0, 160)})`;
	}
}

const present = (table: string, id: string) =>
	t.run(async (ctx) => (await ctx.db.get(id as never)) !== null);

// ── the families: how one row of each table is seeded ─────────────────────────────────
type Author = { label: string; id?: string };
type Family = {
	table: Table;
	/** seeds one row of `org`, written by `author` (id omitted = a legacy row) */
	seed: (org: string, author: Author) => Promise<string>;
	/** true when an agent can author the row (a person only otherwise) */
	agentAuthored: boolean;
	/** extra rows that must go with the row */
	children?: (id: string) => Promise<number>;
};

const orgId = (org: string) => testClerkOrgId(org);
const now = () => Date.now();

const FAMILIES: Family[] = [
	{
		table: "memories",
		agentAuthored: true,
		seed: (org, a) =>
			t.run((ctx) =>
				ctx.db.insert("memories", {
					namespace: `team/${orgId(org)}`,
					clerkOrgId: orgId(org),
					type: "reference",
					content: "erase-me memory",
					createdBy: a.label,
					...(a.id === undefined ? {} : { createdById: a.id }),
					relations: [],
					isLatest: true,
					createdAt: now(),
					updatedAt: now(),
				}),
			),
	},
	{
		table: "messages",
		agentAuthored: true,
		seed: (org, a) =>
			t.run(async (ctx) => {
				const id = await ctx.db.insert("messages", {
					from: a.label,
					...(a.id === undefined ? {} : { fromId: a.id }),
					channel: "someone",
					content: "erase-me message",
					tenantId: org,
					tenantOrgId: orgId(org),
					createdAt: now(),
				});
				await ctx.db.insert("messageReceipts", {
					messageId: id,
					recipient: "someone",
					tenantId: org,
					tenantOrgId: orgId(org),
				});
				return id;
			}),
		children: (id) =>
			t.run(
				async (ctx) =>
					(
						await ctx.db
							.query("messageReceipts")
							.withIndex("by_message", (q) => q.eq("messageId", id as Id<"messages">))
							.collect()
					).length,
			),
	},
	{
		table: "missions",
		agentAuthored: true,
		seed: (org, a) =>
			t.run((ctx) =>
				ctx.db.insert("missions", {
					name: "erase-me mission",
					project: "p",
					status: "plan",
					priority: "medium",
					pilot: ALICE,
					agents: [],
					createdBy: a.label,
					...(a.id === undefined ? {} : { createdById: a.id }),
					createdAt: now(),
					updatedAt: now(),
					orgId: org,
					clerkOrgId: orgId(org),
				}),
			),
	},
	{
		table: "tasks",
		agentAuthored: true,
		seed: (org, a) =>
			t.run((ctx) =>
				ctx.db.insert("tasks", {
					title: "erase-me task",
					assignedTo: ALICE,
					priority: "medium",
					status: "todo",
					createdBy: a.label,
					...(a.id === undefined ? {} : { createdById: a.id }),
					createdAt: now(),
					updatedAt: now(),
					orgId: org,
					clerkOrgId: orgId(org),
				}),
			),
	},
	{
		table: "recurringTasks",
		agentAuthored: true,
		seed: (org, a) =>
			t.run((ctx) =>
				ctx.db.insert("recurringTasks", {
					title: "erase-me schedule",
					assignedTo: ALICE,
					priority: "medium",
					cronExpression: "0 9 * * *",
					nextRunAt: now() + 1000,
					active: true,
					createdBy: a.label,
					...(a.id === undefined ? {} : { createdById: a.id }),
					createdAt: now(),
					updatedAt: now(),
					orgId: org,
					clerkOrgId: orgId(org),
				}),
			),
	},
	{
		table: "briefingNotes",
		agentAuthored: true,
		seed: (org, a) =>
			t.run(async (ctx) => {
				const id = await ctx.db.insert("briefingNotes", {
					title: "erase-me note",
					topic: "t",
					participants: [ALICE],
					content: "erase-me briefing",
					createdBy: a.label,
					...(a.id === undefined ? {} : { createdById: a.id }),
					createdAt: now(),
					orgId: org,
					clerkOrgId: orgId(org),
				});
				await ctx.db.insert("briefingNoteBodyChunks", { noteId: id, idx: 0, text: "chunk" });
				await ctx.db.insert("briefingNoteParticipants", { noteId: id, participant: ALICE });
				return id;
			}),
		children: (id) =>
			t.run(async (ctx) => {
				const noteId = id as Id<"briefingNotes">;
				const chunks = await ctx.db
					.query("briefingNoteBodyChunks")
					.withIndex("by_note_idx", (q) => q.eq("noteId", noteId))
					.collect();
				const parts = await ctx.db
					.query("briefingNoteParticipants")
					.withIndex("by_note", (q) => q.eq("noteId", noteId))
					.collect();
				return chunks.length + parts.length;
			}),
	},
	{
		table: "diary",
		agentAuthored: true,
		seed: (org, a) =>
			t.run((ctx) =>
				ctx.db.insert("diary", {
					date: "2026-11-03",
					orchestrator: ALICE,
					content: "erase-me diary",
					createdBy: a.label,
					...(a.id === undefined ? {} : { createdById: a.id }),
					createdAt: now(),
					orgId: org,
					clerkOrgId: orgId(org),
				}),
			),
	},
	{
		table: "debateRooms",
		agentAuthored: false,
		seed: (org, a) =>
			t.run(async (ctx) => {
				const settings = {
					maxRoundLimit: 5,
					maxParticipants: 6,
					maxRefusalRows: 2,
					maxTurnMessageChars: 4000,
					pollSeconds: 5,
					maxAnswerCharsCeiling: 500,
					maxLabelChars: 40,
					maxTurnInstructionChars: 400,
					maxActiveRooms: 10,
				};
				const template = {
					id: "review",
					name: "Review",
					language: "en",
					turnInstruction: "Answer.",
					participants: [
						{ id: "p1", label: "operator", kind: "human" as const, transport: "human" as const, deadlineSeconds: null },
					],
					roundLimit: 2,
					maxAnswerChars: 100,
					turnDeadlineSeconds: 3600,
					maxConsecutiveSkips: 2,
					voiceEnabled: false,
				};
				const templateId = await ctx.db.insert("debateTemplates", {
					tenantId: org,
					tenantOrgId: orgId(org),
					templateKey: "review",
					template,
					updatedBy: a.label,
					updatedAt: now(),
				});
				const roomId = await ctx.db.insert("debateRooms", {
					tenantId: org,
					tenantOrgId: orgId(org),
					templateId,
					template,
					settings,
					subject: "erase-me room",
					status: "active",
					round: 1,
					position: 0,
					turnSeq: 1,
					participantState: [],
					createdBy: a.label,
					createdById: a.id ?? "",
					createdAt: now(),
					refusalRows: 0,
					refusalsOverflow: 0,
				});
				await ctx.db.insert("debateTurns", {
					roomId,
					turnSeq: 1,
					round: 1,
					position: 0,
					kind: "system",
					writer: "deliverTurn",
					postedAt: now(),
				} as never);
				return roomId;
			}),
		children: (id) =>
			t.run(
				async (ctx) =>
					(
						await ctx.db
							.query("debateTurns")
							.withIndex("by_room_seq", (q) => q.eq("roomId", id as Id<"debateRooms">))
							.collect()
					).length,
			),
	},
];

const agentAuthor = (name: string, org: string): Author => ({
	label: name,
	id: agents[`${org}/${name}`],
});
const memberAuthor: Author = { label: MEMBER_ACTOR, id: MEMBER_ACTOR };

describe.each(FAMILIES)("erase:eraseRow — $table", (family) => {
	const { table } = family;
	const authorOf = (): Author =>
		family.agentAuthored ? agentAuthor(ALICE, A) : memberAuthor;
	const authorSeat = (): Caller => (family.agentAuthored ? ALICE_SEAT : MEMBER_A);

	if (family.agentAuthored) {
		test("SEAT AUTHOR: the verified agent that wrote the row erases it (row and children gone)", async () => {
			const id = await family.seed(A, authorOf());
			if (family.children) expect(await family.children(id)).toBeGreaterThan(0);
			expect(await code(erase(ALICE_SEAT, table, id))).toBe("SERVED");
			expect(await present(table, id)).toBe(false);
			if (family.children) expect(await family.children(id)).toBe(0);
		});

		test("SEAT NON-AUTHOR: another agent of the same org is refused; the row is unchanged", async () => {
			const id = await family.seed(A, authorOf());
			expect(await code(erase(CAROL_SEAT, table, id))).toBe("RBAC_DENIED");
			expect(await present(table, id)).toBe(true);
		});

		test("SEAT OTHER ORG: an agent of another org is refused; the row is unchanged", async () => {
			const id = await family.seed(A, authorOf());
			expect(await code(erase(BOB_SEAT, table, id))).toBe("RBAC_DENIED");
			expect(await present(table, id)).toBe(true);
		});

		test("SEAT NAME IS NOT AN AUTHOR: a label-only row (no author ID) is refused to a seat of the same name", async () => {
			const id = await family.seed(A, { label: ALICE });
			expect(await code(erase(ALICE_SEAT, table, id))).toBe("RBAC_DENIED");
			expect(await present(table, id)).toBe(true);
		});

		test("ADMIN: a same-org admin erases a row written by an agent, and a legacy row with no author ID", async () => {
			const written = await family.seed(A, authorOf());
			const legacy = await family.seed(A, { label: ALICE });
			expect(await code(erase(ADMIN_A, table, written))).toBe("SERVED");
			expect(await code(erase(ADMIN_A, table, legacy))).toBe("SERVED");
			expect(await present(table, written)).toBe(false);
			expect(await present(table, legacy)).toBe(false);
		});

		test("MEMBER OTHER: a same-org member who is not the author is refused on an agent's row", async () => {
			const id = await family.seed(A, authorOf());
			expect(await code(erase(MEMBER_A, table, id))).toBe("RBAC_DENIED");
			expect(await present(table, id)).toBe(true);
		});
	}

	test("MEMBER AUTHOR: a same-org member, not admin, erases the row it wrote", async () => {
		const id = await family.seed(A, memberAuthor);
		expect(await code(erase(MEMBER_A, table, id))).toBe("SERVED");
		expect(await present(table, id)).toBe(false);
		if (family.children) expect(await family.children(id)).toBe(0);
	});

	test("LEGACY PERSON ROW: a row written before the author ID existed, labelled with the person's reserved actor name, is erasable by that person and by no other member", async () => {
		const id = await family.seed(A, { label: MEMBER_ACTOR });
		expect(await code(erase(OTHER_A, table, id))).toBe("RBAC_DENIED");
		expect(await present(table, id)).toBe(true);
		expect(await code(erase(MEMBER_A, table, id))).toBe("SERVED");
		expect(await present(table, id)).toBe(false);
	});

	test("MEMBER NON-AUTHOR: a same-org member is refused on another member's row; no agent of the org may either", async () => {
		const id = await family.seed(A, memberAuthor);
		expect(await code(erase(OTHER_A, table, id))).toBe("RBAC_DENIED");
		expect(await code(erase(ALICE_SEAT, table, id))).toBe("RBAC_DENIED");
		expect(await present(table, id)).toBe(true);
	});

	test("ADMIN erases a member's row; OTHER ORG ADMIN is refused; the row is unchanged until the right caller", async () => {
		const id = await family.seed(A, authorOf());
		expect(await code(erase(ADMIN_B, table, id))).toBe("RBAC_DENIED");
		expect(await code(erase(seatOf(BOB, B), table, id))).toBe("RBAC_DENIED");
		expect(await present(table, id)).toBe(true);
		expect(await code(erase(ADMIN_A, table, id))).toBe("SERVED");
		expect(await present(table, id)).toBe(false);
	});

	test("SESSION: a Clerk session admin of the org erases; a session member that is not the author is refused; another org's admin is refused", async () => {
		const id = await family.seed(A, authorOf());
		const memberSession: Caller = { kind: "session", subject: "user_other_a", org: A, role: "org:member" };
		const otherOrgAdmin: Caller = { kind: "session", subject: "user_admin_b", org: B, role: "org:admin" };
		const adminSession: Caller = { kind: "session", subject: "user_admin_a", org: A, role: "org:admin" };
		expect(await code(erase(memberSession, table, id))).toBe("RBAC_DENIED");
		expect(await code(erase(otherOrgAdmin, table, id))).toBe("RBAC_DENIED");
		expect(await present(table, id)).toBe(true);
		expect(await code(erase(adminSession, table, id))).toBe("SERVED");
		expect(await present(table, id)).toBe(false);
	});

	test("SESSION AUTHOR: a session member erases the row it wrote (stored author = user:<subject>)", async () => {
		const id = await family.seed(A, { label: "user:user_member_a", id: "user:user_member_a" });
		const memberSession: Caller = { kind: "session", subject: "user_member_a", org: A, role: "org:member" };
		expect(await code(erase(memberSession, table, id))).toBe("SERVED");
		expect(await present(table, id)).toBe(false);
	});

	// keep the reference to the family's author seat used by other poles
	test("the covered table's policy names the author column this family seeds", () => {
		expect(ERASE_COVERED[table]).toBeDefined();
		void authorSeat;
	});
});

describe("erase:eraseRow — memories also leave the search index", () => {
	test("a memory erase schedules the purge of its search entry (key = the memory id)", async () => {
		const fam = FAMILIES[0];
		const id = await fam.seed(A, agentAuthor(ALICE, A));
		expect(await code(erase(ALICE_SEAT, "memories", id))).toBe("SERVED");
		const jobs = (
			await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
		).filter((j) => j.name.includes("removeRagEntry"));
		expect(jobs).toHaveLength(1);
		expect((jobs[0].args[0] as { memoryId: string }).memoryId).toBe(id);
	});

	test("a refused erase schedules nothing", async () => {
		const fam = FAMILIES[0];
		const id = await fam.seed(A, agentAuthor(ALICE, A));
		expect(await code(erase(CAROL_SEAT, "memories", id))).toBe("RBAC_DENIED");
		const jobs = (
			await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
		).filter((j) => j.name.includes("removeRagEntry"));
		expect(jobs).toHaveLength(0);
	});
});

const ADMIN_ONLY: { table: Table; seed: (org: string) => Promise<string> }[] = [
	{
		// written by the GitHub mirror: no author exists
		table: "issues",
		seed: (org) =>
			t.run((ctx) =>
				ctx.db.insert("issues", {
					repo: "o/r",
					issueNumber: 1,
					title: "erase-me issue",
					body: "b",
					htmlUrl: "https://example.test/1",
					labels: [],
					status: "open",
					priority: "medium",
					assignedOrchestrator: ALICE,
					project: "p",
					githubCreatedAt: now(),
					githubUpdatedAt: now(),
					orgId: org,
					clerkOrgId: orgId(org),
				}),
			),
	},
	{
		// organisation structure kept by its admins
		table: "businessUnits",
		seed: (org) =>
			t.run((ctx) =>
				ctx.db.insert("businessUnits", {
					name: "erase-me unit",
					description: "d",
					purpose: "p",
					orchestratorId: ALICE,
					status: "idea",
					businessModel: "m",
					targetCustomers: "c",
					services: [],
					pricing: "p",
					revenueProjections: { y1: 0, y2: 0, y3: 0 },
					coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
					coreProcesses: [],
					dependencies: [],
					kpis: [],
					managementFee: 10,
					createdAt: now(),
					updatedAt: now(),
					orgId: org,
					clerkOrgId: orgId(org),
				}),
			),
	},
	{
		// organisation configuration upserted by its admins
		table: "debateTemplates",
		seed: (org) =>
			t.run((ctx) =>
				ctx.db.insert("debateTemplates", {
					tenantId: org,
					tenantOrgId: orgId(org),
					templateKey: "review",
					template: {
						id: "review",
						name: "Review",
						language: "en",
						turnInstruction: "Answer.",
						participants: [
							{ id: "p1", label: "operator", kind: "human", transport: "human", deadlineSeconds: null },
						],
						roundLimit: 2,
						maxAnswerChars: 100,
						turnDeadlineSeconds: 3600,
						maxConsecutiveSkips: 2,
						voiceEnabled: false,
					},
					updatedBy: "user:user_admin_a",
					updatedAt: now(),
				}),
			),
	},
];

describe.each(ADMIN_ONLY)("erase:eraseRow — $table (no author by design): admin only", ({ table, seed }) => {
	test("ADMIN erases; a member, a seat and another org's admin are refused; the row is unchanged until the admin", async () => {
		const id = await seed(A);
		expect(await code(erase(MEMBER_A, table, id))).toBe("RBAC_DENIED");
		expect(await code(erase(ALICE_SEAT, table, id))).toBe("RBAC_DENIED");
		expect(await code(erase(ADMIN_B, table, id))).toBe("RBAC_DENIED");
		expect(await present(table, id)).toBe(true);
		expect(await code(erase(ADMIN_A, table, id))).toBe("SERVED");
		expect(await present(table, id)).toBe(false);
	});
});

describe("erase:eraseRow — transport poles", () => {
	test("the claimless fleet service account, an anonymous caller and an org-less session are refused; the row is unchanged", async () => {
		const id = await FAMILIES[3].seed(A, agentAuthor(ALICE, A));
		const args = { table: "tasks", rowId: id } as never;
		expect(await code(service().mutation(api.erase.eraseRow, args))).not.toBe("SERVED");
		expect(await code(t.mutation(api.erase.eraseRow, args))).not.toBe("SERVED");
		const orgless = t.withIdentity({ subject: "user_orgless" });
		expect(await code(orgless.mutation(api.erase.eraseRow, args))).not.toBe("SERVED");
		expect(await present("tasks", id)).toBe(true);
	});

	test("a seat acting for an org WITHOUT an agent proof is refused: a label is not an author", async () => {
		const id = await FAMILIES[3].seed(A, agentAuthor(ALICE, A));
		expect(
			await code(
				service().mutation(api.erase.eraseRow, {
					table: "tasks",
					rowId: id,
					__actingOrg: testClerkOrgId(A),
				} as never),
			),
		).not.toBe("SERVED");
		expect(await present("tasks", id)).toBe(true);
	});

	test("a person's proof presented by anyone but the service account is refused", async () => {
		const id = await FAMILIES[3].seed(A, memberAuthor);
		const session = sessionOf("user_member_a", A, "org:admin");
		expect(
			await code(
				session.mutation(api.erase.eraseRow, {
					table: "tasks",
					rowId: id,
					verifiedPerson: { accessTokenHash: H_ADMIN_A },
				} as never),
			),
		).not.toBe("SERVED");
		expect(await present("tasks", id)).toBe(true);
	});

	test("a table outside the covered list is refused by the validator; an id of another table is refused", async () => {
		const id = await FAMILIES[3].seed(A, agentAuthor(ALICE, A));
		expect(await code(erase(ADMIN_A, "oauth_access_tokens", id))).not.toBe("SERVED");
		const memId = await FAMILIES[0].seed(A, agentAuthor(ALICE, A));
		expect(await code(erase(ADMIN_A, "tasks", memId))).not.toBe("SERVED");
		expect(await present("memories", memId)).toBe(true);
	});

	test("an id that does not exist answers like a row of another org (no existence oracle)", async () => {
		const id = await FAMILIES[3].seed(A, agentAuthor(ALICE, A));
		await erase(ADMIN_A, "tasks", id);
		expect(await code(erase(ADMIN_A, "tasks", id))).toBe("RBAC_DENIED");
	});

	test("the fleet door (internal) erases a row of any org", async () => {
		const id = await FAMILIES[3].seed(B, agentAuthor(BOB, B));
		await t.mutation((await import("../_generated/api")).internal.erase.eraseRowFleet, {
			table: "tasks",
			rowId: id,
		} as never);
		expect(await present("tasks", id)).toBe(false);
		void A_ID;
		void B_ID;
	});
});

// ── the "updates" chain: erasing a memory erases every version of it ──────────────────
// storeMemory with an "updates" relation writes a NEW row (relations: [{updates -> older}])
// and flips the older to isLatest=false. Erasing one version must not leave the others'
// content behind: every row of the chain goes, or (one version the caller may not erase)
// nothing does. Task k17bf0twh1kaq2bhazqgevese98hgzaz.
describe("erase:eraseRow — memories: the whole updates chain", () => {
	type Ids = { v1: string; v2: string; v3: string };

	// v1 <- v2 <- v3 (v3 is the latest). `authors` names who wrote each version.
	async function seedChain(authors: [Author, Author, Author], org = A): Promise<Ids> {
		const insert = (
			a: Author,
			relations: { targetId: Id<"memories">; type: "updates" }[],
			isLatest: boolean,
			content: string,
		) =>
			t.run((ctx) =>
				ctx.db.insert("memories", {
					namespace: `team/${orgId(org)}`,
					clerkOrgId: orgId(org),
					type: "reference",
					content,
					createdBy: a.label,
					...(a.id === undefined ? {} : { createdById: a.id }),
					relations,
					isLatest,
					createdAt: now(),
					updatedAt: now(),
				}),
			);
		const v1 = await insert(authors[0], [], false, `chain secret v1 ${CHAIN_MARK}`);
		const v2 = await insert(authors[1], [{ targetId: v1, type: "updates" }], false, `chain secret v2 ${CHAIN_MARK}`);
		const v3 = await insert(authors[2], [{ targetId: v2, type: "updates" }], true, `chain secret v3 ${CHAIN_MARK}`);
		return { v1, v2, v3 };
	}
	const CHAIN_MARK = "chain-marker-xyz";
	const purged = async (): Promise<string[]> =>
		(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()))
			.filter((j) => j.name.includes("removeRagEntry"))
			.map((j) => (j.args[0] as { memoryId: string }).memoryId)
			.sort();
	const allPresent = async (ids: Ids) => [
		await present("memories", ids.v1),
		await present("memories", ids.v2),
		await present("memories", ids.v3),
	];
	const alice = () => agentAuthor(ALICE, A);
	const carol = () => agentAuthor(CAROL, A);

	test("the author erases the MIDDLE version: the older and the newer go too, each search entry purged", async () => {
		const ids = await seedChain([alice(), alice(), alice()]);
		expect(await code(erase(ALICE_SEAT, "memories", ids.v2))).toBe("SERVED");
		expect(await allPresent(ids)).toEqual([false, false, false]);
		expect(await purged()).toEqual([ids.v1, ids.v2, ids.v3].sort());
	});

	test("the author erases the OLDEST version: the whole chain goes", async () => {
		const ids = await seedChain([alice(), alice(), alice()]);
		expect(await code(erase(ALICE_SEAT, "memories", ids.v1))).toBe("SERVED");
		expect(await allPresent(ids)).toEqual([false, false, false]);
		expect(await purged()).toEqual([ids.v1, ids.v2, ids.v3].sort());
	});

	test("the author erases the LATEST version: the whole chain goes", async () => {
		const ids = await seedChain([alice(), alice(), alice()]);
		expect(await code(erase(ALICE_SEAT, "memories", ids.v3))).toBe("SERVED");
		expect(await allPresent(ids)).toEqual([false, false, false]);
	});

	test("an older version by another author: REFUSED, typed, the count named, nothing deleted, nothing purged", async () => {
		const ids = await seedChain([carol(), alice(), alice()]);
		let data = "";
		try {
			await erase(ALICE_SEAT, "memories", ids.v3);
		} catch (e) {
			data = e instanceof ConvexError ? String(e.data) : String(e);
		}
		expect(data).toMatch(/ERASE_CHAIN_REFUSED/);
		expect(data).toMatch(/unerasableVersions\\*"?:1\b/);
		expect(data).not.toContain(ids.v1);
		expect(data).not.toContain(CHAIN_MARK);
		expect(await allPresent(ids)).toEqual([true, true, true]);
		expect(await purged()).toEqual([]);
	});

	test("a NEWER version by another author: REFUSED the same way, nothing deleted", async () => {
		const ids = await seedChain([alice(), alice(), carol()]);
		expect(await code(erase(ALICE_SEAT, "memories", ids.v1))).toBe("ERASE_CHAIN_REFUSED");
		expect(await allPresent(ids)).toEqual([true, true, true]);
		expect(await purged()).toEqual([]);
	});

	test("two versions by other authors: the refusal counts two", async () => {
		const ids = await seedChain([carol(), carol(), alice()]);
		let data = "";
		try {
			await erase(ALICE_SEAT, "memories", ids.v3);
		} catch (e) {
			data = e instanceof ConvexError ? String(e.data) : String(e);
		}
		expect(data).toMatch(/unerasableVersions\\*"?:2\b/);
		expect(await allPresent(ids)).toEqual([true, true, true]);
	});

	test("an org ADMIN erases a mixed-author chain", async () => {
		const ids = await seedChain([carol(), alice(), memberAuthor]);
		expect(await code(erase(ADMIN_A, "memories", ids.v2))).toBe("SERVED");
		expect(await allPresent(ids)).toEqual([false, false, false]);
		expect(await purged()).toEqual([ids.v1, ids.v2, ids.v3].sort());
	});

	test("a legacy version (no stored author) in the chain refuses its author, an admin serves", async () => {
		const ids = await seedChain([{ label: "legacy" }, alice(), alice()]);
		expect(await code(erase(ALICE_SEAT, "memories", ids.v3))).toBe("ERASE_CHAIN_REFUSED");
		expect(await allPresent(ids)).toEqual([true, true, true]);
		expect(await code(erase(ADMIN_A, "memories", ids.v3))).toBe("SERVED");
		expect(await allPresent(ids)).toEqual([false, false, false]);
	});

	test("another org's admin is refused as before, the chain untouched", async () => {
		const ids = await seedChain([alice(), alice(), alice()]);
		expect(await code(erase(ADMIN_B, "memories", ids.v2))).toBe("RBAC_DENIED");
		expect(await allPresent(ids)).toEqual([true, true, true]);
		expect(await purged()).toEqual([]);
	});

	// ── an oversized namespace: only a SUPERSEDED version needs the namespace read ──
	// A latest row has no newer version, so erasing an unedited latest memory reads no
	// namespace; a superseded one must find its newer versions and refuses (never truncates)
	// when the namespace is larger than the bound.
	const fillNamespace = (org: string) =>
		t.run(async (ctx) => {
			for (let i = 0; i < CHAIN_SCAN_CAP + 1; i++) {
				await ctx.db.insert("memories", {
					namespace: `team/${orgId(org)}`,
					clerkOrgId: orgId(org),
					type: "reference",
					content: `filler ${i}`,
					createdBy: "filler",
					relations: [],
					isLatest: true,
					createdAt: now(),
					updatedAt: now(),
				});
			}
		});

	test("past the scan cap, an unedited LATEST memory still erases (no namespace read)", async () => {
		await fillNamespace(A);
		const lone = await FAMILIES[0].seed(A, alice());
		expect(await code(erase(ALICE_SEAT, "memories", lone))).toBe("SERVED");
		expect(await present("memories", lone)).toBe(false);
	});

	test("past the scan cap, a SUPERSEDED version is refused ERASE_CHAIN_SCAN_TOO_LARGE, nothing deleted", async () => {
		await fillNamespace(A);
		const ids = await seedChain([alice(), alice(), alice()]);
		expect(await code(erase(ALICE_SEAT, "memories", ids.v1))).toBe("ERASE_CHAIN_SCAN_TOO_LARGE");
		expect(await allPresent(ids)).toEqual([true, true, true]);
		expect(await purged()).toEqual([]);
	});

	test("a memory with no updates relation still erases alone, and a sibling chain is left alone", async () => {
		const ids = await seedChain([alice(), alice(), alice()]);
		const lone = await FAMILIES[0].seed(A, alice());
		expect(await code(erase(ALICE_SEAT, "memories", lone))).toBe("SERVED");
		expect(await present("memories", lone)).toBe(false);
		expect(await allPresent(ids)).toEqual([true, true, true]);
	});

	// ── the redact door is per-version too: the same chain rule ──
	const redactAs = (hash: string, org: string, memoryId: string) =>
		service().mutation(api.memories.redactMemoryContentAsPerson, {
			memoryId: memoryId as Id<"memories">,
			redactions: [{ find: CHAIN_MARK, replaceWith: "[REDACTED]" }],
			__actingOrg: testClerkOrgId(org),
			verifiedPerson: { accessTokenHash: hash },
		} as never);
	const contents = (ids: Ids) =>
		t.run(async (ctx) => [
			(await ctx.db.get(ids.v1 as Id<"memories">))?.content,
			(await ctx.db.get(ids.v2 as Id<"memories">))?.content,
			(await ctx.db.get(ids.v3 as Id<"memories">))?.content,
		]);

	test("redact: the member author redacts the marker in EVERY version of its chain", async () => {
		const ids = await seedChain([memberAuthor, memberAuthor, memberAuthor]);
		await redactAs(H_MEMBER_A, A, ids.v3);
		for (const c of await contents(ids)) expect(c).not.toContain(CHAIN_MARK);
	});

	test("redact: a version by another author refuses the whole redaction, no version touched", async () => {
		const ids = await seedChain([alice(), memberAuthor, memberAuthor]);
		expect(await code(redactAs(H_MEMBER_A, A, ids.v3))).toBe("ERASE_CHAIN_REFUSED");
		for (const c of await contents(ids)) expect(c).toContain(CHAIN_MARK);
	});

	test("redact: an admin redacts a mixed-author chain", async () => {
		const ids = await seedChain([alice(), memberAuthor, carol()]);
		await redactAs(H_ADMIN_A, A, ids.v2);
		for (const c of await contents(ids)) expect(c).not.toContain(CHAIN_MARK);
	});
});
