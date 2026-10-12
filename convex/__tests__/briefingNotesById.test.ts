/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, module M10c: briefing notes are read and written by ID scope.
//
// A note belongs to an organisation by the org's permanent Clerk ID
// (`clerkOrgId`); its author and its participants are agents of THAT org, judged
// by agents-row ID. The slug on the row and the labels `createdBy` /
// `participants` are display text and decide nothing.
//
// The world: organisation A was renamed (its rows still carry the old label
// "acme") and a NEW organisation B then took the freed label "acme". Both hold an
// agent called "seat-x". The same NAME and the same LABEL, two organisations.
//
// REFUSED  B never lists, searches or gets A's note; B cannot update or delete
//          it; a service-account call acting as B's "seat-x" cannot edit a note
//          A's "seat-x" wrote; a member typing the author's name without a proof
//          is refused; an unresolved caller is refused at every door.
// PRESENT  A (renamed) still reads and writes its own notes stamped with the old
//          label; B reads and writes its own; the author (by ID) edits its note;
//          a participant renamed since is still a participant; the fleet service
//          account keeps its grants.
// ABSENT   a scoped caller reading an empty table gets an empty SUCCESS.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const NOW = 1_700_000_000_000;
const SEAT = "seat-x";

const OP_ID = "org_OPERATOR1";
const A_ID = "org_AAAA1";
const B_ID = "org_BBBB1";

// A was renamed: its CURRENT label is "acme-renamed"; its rows still say "acme".
// B took the freed label "acme".
const OP_SLUG = "fleet-op";
const A_SLUG = "acme-renamed";
const OLD_LABEL = "acme";
const B_SLUG = OLD_LABEL;

const asMember = (
	t: T,
	slug: string,
	orgId: string,
	subject: string,
	role = "org:admin",
) =>
	t.withIdentity({
		subject,
		organizationSlug: slug,
		org_id: orgId,
		org_role: role,
	} as Identity);
const asMaster = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asNoOrg = (t: T) =>
	t.withIdentity({ subject: "user-no-org" } as Identity);

type World = { t: T; ids: Record<string, Id<"agents">> };

async function world(): Promise<World> {
	const t = createT();
	const ids: Record<string, Id<"agents">> = {};
	await t.run(async (ctx) => {
		const agent = (orgSlug: string, clerkOrgId: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		ids.opPi = await agent(OP_SLUG, OP_ID, "pi");
		ids.aSeat = await agent(A_SLUG, A_ID, SEAT);
		ids.aOther = await agent(A_SLUG, A_ID, "other");
		ids.bSeat = await agent(B_SLUG, B_ID, SEAT);
		const mapping = (
			clerkOrgSlug: string,
			clerkOrgId: string,
			allowedOrchestrators: string[],
			extra: Partial<Doc<"client_org_mapping">>,
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug,
				clerkOrgId,
				allowedOrchestrators,
				scopes: ["view-own-tasks"],
				displayName: clerkOrgSlug,
				isActive: true,
				createdAt: NOW,
				...extra,
			});
		await mapping(OP_SLUG, OP_ID, ["pi"], {
			orgKind: "operator",
			fleetWide: true,
			allowedAgentIds: [ids.opPi],
		});
		await mapping(A_SLUG, A_ID, [SEAT, "other"], {
			allowedAgentIds: [ids.aSeat, ids.aOther],
		});
		await mapping(B_SLUG, B_ID, [SEAT], { allowedAgentIds: [ids.bSeat] });
		// Fleet-default writer list: only admins write.
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin"],
			updatedAt: NOW,
		});
	});
	return { t, ids };
}

type NoteSeed = Partial<Doc<"briefingNotes">>;

const noteA = (ids: World["ids"], over: NoteSeed = {}) => ({
	title: "note of A",
	topic: "handoff",
	participants: [SEAT],
	content: "a secret of A",
	createdBy: SEAT,
	createdById: ids.aSeat,
	participantIds: [ids.aSeat],
	createdAt: 1,
	orgId: OLD_LABEL,
	clerkOrgId: A_ID,
	...over,
});
const noteB = (ids: World["ids"], over: NoteSeed = {}) => ({
	title: "note of B",
	topic: "handoff",
	participants: [SEAT],
	content: "a secret of B",
	createdBy: SEAT,
	createdById: ids.bSeat,
	participantIds: [ids.bSeat],
	createdAt: 2,
	orgId: B_SLUG,
	clerkOrgId: B_ID,
	...over,
});

async function insertNote(
	t: T,
	doc: ReturnType<typeof noteA>,
): Promise<Id<"briefingNotes">> {
	return await t.run(async (ctx) => {
		const id = await ctx.db.insert("briefingNotes", doc);
		for (const participant of doc.participants) {
			await ctx.db.insert("briefingNoteParticipants", {
				noteId: id,
				participant,
				...(doc.participantIds?.[0] !== undefined
					? { participantId: doc.participantIds[0] }
					: {}),
			});
		}
		return id;
	});
}

const titles = (rows: unknown): string[] =>
	(rows as { title: string }[]).map((r) => r.title).sort();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("briefingNotes by ID — REFUSED", () => {
	test("B (took A's old label) never lists, searches or gets A's note", async () => {
		const { t, ids } = await world();
		const a = await insertNote(t, noteA(ids));
		await insertNote(t, noteB(ids));
		const b = asMember(t, B_SLUG, B_ID, "user-b");

		const listed = await b.query(api.briefingNotes.list, { limit: 50 });
		expect(titles(listed)).toEqual(["note of B"]);

		const found = await b.query(api.briefingNotes.searchBriefingNotesByKeyword, {
			query: "secret",
		});
		expect(titles(found)).toEqual(["note of B"]);

		expect(await b.query(api.briefingNotes.get, { noteId: a })).toBeNull();
	});

	test("B cannot update or delete A's note", async () => {
		const { t, ids } = await world();
		const a = await insertNote(t, noteA(ids));
		const b = asMember(t, B_SLUG, B_ID, "user-b");
		await expect(
			b.mutation(api.briefingNotes.update, { noteId: a, content: "owned" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			b.mutation(api.briefingNotes.deleteBriefingNote, { noteId: a }),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await t.run((ctx) => ctx.db.get(a));
		expect(row?.content).toBe("a secret of A");
	});

	test("a service-account call acting as B's seat-x cannot edit or delete the note A's seat-x wrote", async () => {
		const { t, ids } = await world();
		const a = await insertNote(t, noteA(ids));
		const m = asMaster(t);
		const asBSeat = { agentId: ids.bSeat, orgSlug: B_SLUG };
		await expect(
			m.mutation(api.briefingNotes.update, {
				noteId: a,
				callerOrchestrator: SEAT,
				verifiedActor: asBSeat,
				content: "owned",
			}),
		).rejects.toThrow(/RBAC_DENIED.*not-creator/);
		await expect(
			m.mutation(api.briefingNotes.deleteBriefingNote, {
				noteId: a,
				callerOrchestrator: SEAT,
				verifiedActor: asBSeat,
			}),
		).rejects.toThrow(/RBAC_DENIED.*not-creator/);
		const row = await t.run((ctx) => ctx.db.get(a));
		expect(row?.content).toBe("a secret of A");
	});

	test("a member typing the author's name without a proof is refused, at every agent-path write", async () => {
		const { t, ids } = await world();
		const a = await insertNote(t, noteA(ids));
		const member = asMember(t, A_SLUG, A_ID, "user-a", "org:admin");
		await expect(
			member.mutation(api.briefingNotes.update, {
				noteId: a,
				callerOrchestrator: SEAT,
				content: "forged",
			}),
		).rejects.toThrow(/AGENT_CREDENTIAL_REQUIRED/);
		await expect(
			member.mutation(api.briefingNotes.deleteBriefingNote, {
				noteId: a,
				callerOrchestrator: SEAT,
			}),
		).rejects.toThrow(/AGENT_CREDENTIAL_REQUIRED/);
		await expect(
			member.mutation(api.briefingNotes.create, {
				title: "t",
				topic: "handoff",
				participants: [],
				content: "c",
				createdBy: SEAT,
			}),
		).rejects.toThrow(/AGENT_CREDENTIAL_REQUIRED/);
		expect((await t.run((ctx) => ctx.db.get(a)))?.content).toBe("a secret of A");
	});

	test("a member naming a label that is no agent of its org cannot author under it", async () => {
		const { t } = await world();
		await t.run(async (ctx) => {
			const mapping = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", B_SLUG))
				.unique();
			if (mapping === null) throw new Error("fixture");
			await ctx.db.patch(mapping._id, {
				allowedOrchestrators: [SEAT, "ghost"],
			});
		});
		await expect(
			asMember(t, B_SLUG, B_ID, "user-b").mutation(api.briefingNotes.create, {
				title: "t",
				topic: "handoff",
				participants: [],
				content: "c",
				createdBy: "ghost",
			}),
		).rejects.toThrow(/actor-not-an-agent-of-org/);
	});

	test("an unresolved caller is refused at every door", async () => {
		const { t, ids } = await world();
		const a = await insertNote(t, noteA(ids));
		await expect(t.query(api.briefingNotes.list, {})).rejects.toThrow(/RBAC_DENIED/);
		await expect(t.query(api.briefingNotes.get, { noteId: a })).rejects.toThrow(
			/RBAC_DENIED/,
		);
		await expect(
			t.mutation(api.briefingNotes.update, { noteId: a, content: "x" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			t.mutation(api.briefingNotes.deleteBriefingNote, { noteId: a }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			t.mutation(api.briefingNotes.create, {
				title: "t",
				topic: "x",
				participants: [],
				content: "c",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		// A signed-in caller with no organisation is told it was refused, in a
		// shape that is not the bytes of an absence.
		const refused = await asNoOrg(t).query(api.briefingNotes.list, {});
		expect(refused).toEqual({ refused: true, items: [] });
	});

	test("a service-account call carrying B's verified org never reads A's note (get, list, search)", async () => {
		const { t, ids } = await world();
		const a = await insertNote(t, noteA(ids));
		await insertNote(t, noteB(ids));
		const m = asMaster(t);
		const verifiedOrg = { orgSlug: B_SLUG };
		expect(
			await m.query(api.briefingNotes.get, {
				noteId: a,
				master: false,
				callerIdentities: [SEAT],
				verifiedOrg,
			}),
		).toBeNull();
		expect(
			titles(await m.query(api.briefingNotes.list, { limit: 50, verifiedOrg })),
		).toEqual(["note of B"]);
		expect(
			titles(
				await m.query(api.briefingNotes.searchBriefingNotesByKeyword, {
					query: "secret",
					verifiedOrg,
				}),
			),
		).toEqual(["note of B"]);
	});

	test("a seat label that names no agent in the note's org is not a participant", async () => {
		const { t, ids } = await world();
		// The note lists A's "other" only; the caller's seat is "seat-x".
		const a = await insertNote(
			t,
			noteA(ids, {
				participants: ["other"],
				participantIds: [ids.aOther],
				createdBy: "other",
				createdById: ids.aOther,
			}),
		);
		const member = asMember(t, A_SLUG, A_ID, "user-a");
		expect(
			await member.query(api.briefingNotes.get, {
				noteId: a,
				callerIdentities: [SEAT],
			}),
		).toBeNull();
		expect(
			await member.query(api.briefingNotes.get, {
				noteId: a,
				callerIdentities: ["nobody-here"],
			}),
		).toBeNull();
	});
});

describe("briefingNotes by ID — PRESENT", () => {
	test("A (renamed) reads its own note stamped with the old label, by list, search and get", async () => {
		const { t, ids } = await world();
		const a = await insertNote(t, noteA(ids));
		await insertNote(t, noteB(ids));
		const member = asMember(t, A_SLUG, A_ID, "user-a");
		expect(titles(await member.query(api.briefingNotes.list, { limit: 50 }))).toEqual([
			"note of A",
		]);
		expect(
			titles(
				await member.query(api.briefingNotes.searchBriefingNotesByKeyword, {
					query: "secret",
				}),
			),
		).toEqual(["note of A"]);
		expect((await member.query(api.briefingNotes.get, { noteId: a }))?._id).toBe(a);
	});

	test("A (renamed) human admin updates and deletes its own note", async () => {
		const { t, ids } = await world();
		const a = await insertNote(t, noteA(ids));
		const member = asMember(t, A_SLUG, A_ID, "user-a");
		await member.mutation(api.briefingNotes.update, { noteId: a, content: "edited" });
		const row = await t.run((ctx) => ctx.db.get(a));
		expect(row?.content).toBe("edited");
		expect(row?.updatedBy).toBe("user:user-a");
		expect(
			await member.mutation(api.briefingNotes.deleteBriefingNote, { noteId: a }),
		).toEqual({ deleted: true });
	});

	test("a human member writes under its verified subject, and the author's ID is stored", async () => {
		const { t } = await world();
		const b = asMember(t, B_SLUG, B_ID, "user-b");
		const id = await b.mutation(api.briefingNotes.create, {
			title: "mine",
			topic: "handoff",
			participants: [SEAT, "laurent"],
			content: "c",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.createdBy).toBe("user:user-b");
		expect(row?.createdById).toBe("user:user-b");
		expect(row?.clerkOrgId).toBe(B_ID);
		// "seat-x" names B's agent; "laurent" names nobody and keeps a label only.
		expect(row?.participantIds).toHaveLength(1);
		const titlesB = titles(await b.query(api.briefingNotes.list, { limit: 50 }));
		expect(titlesB).toEqual(["mine"]);
	});

	test("the author, proved by ID through the service account, edits and deletes its note", async () => {
		const { t, ids } = await world();
		const a = await insertNote(t, noteA(ids));
		const m = asMaster(t);
		const asASeat = { agentId: ids.aSeat, orgSlug: A_SLUG };
		await m.mutation(api.briefingNotes.update, {
			noteId: a,
			callerOrchestrator: SEAT,
			verifiedActor: asASeat,
			content: "by the author",
		});
		expect((await t.run((ctx) => ctx.db.get(a)))?.updatedBy).toBe(SEAT);
		expect(
			await m.mutation(api.briefingNotes.deleteBriefingNote, {
				noteId: a,
				callerOrchestrator: SEAT,
				verifiedActor: asASeat,
			}),
		).toEqual({ deleted: true });
	});

	test("a note written before M10c (no IDs stored) is still edited by its author, resolved in the note's own org", async () => {
		const { t, ids } = await world();
		const legacy = await insertNote(
			t,
			noteA(ids, { createdById: undefined, participantIds: undefined }),
		);
		const m = asMaster(t);
		await m.mutation(api.briefingNotes.update, {
			noteId: legacy,
			callerOrchestrator: SEAT,
			verifiedActor: { agentId: ids.aSeat, orgSlug: A_SLUG },
			content: "legacy edit",
		});
		expect((await t.run((ctx) => ctx.db.get(legacy)))?.content).toBe("legacy edit");
		// B's seat-x carries the same label and is still refused.
		await expect(
			m.mutation(api.briefingNotes.update, {
				noteId: legacy,
				callerOrchestrator: SEAT,
				verifiedActor: { agentId: ids.bSeat, orgSlug: B_SLUG },
				content: "forged",
			}),
		).rejects.toThrow(/RBAC_DENIED.*not-creator/);
	});

	test("a participant renamed since stays a participant (by agent ID), the old label names nobody", async () => {
		const { t, ids } = await world();
		// "other" authored; "seat-x" is the participant. Then A's seat-x is renamed.
		const a = await insertNote(
			t,
			noteA(ids, {
				participants: [SEAT],
				participantIds: [ids.aSeat],
				createdBy: "other",
				createdById: ids.aOther,
			}),
		);
		await t.run(async (ctx) => {
			await ctx.db.patch(ids.aSeat, {
				name: "seat-renamed",
				normalizedName: normalizeOrchestratorId("seat-renamed"),
			});
		});
		const member = asMember(t, A_SLUG, A_ID, "user-a");
		expect(
			(
				await member.query(api.briefingNotes.get, {
					noteId: a,
					callerIdentities: ["seat-renamed"],
				})
			)?._id,
		).toBe(a);
		expect(
			await member.query(api.briefingNotes.get, {
				noteId: a,
				callerIdentities: [SEAT],
			}),
		).toBeNull();
		const listed = await member.query(api.briefingNotes.list, {
			limit: 50,
			callerIdentities: ["seat-renamed"],
		});
		expect(titles(listed)).toEqual(["note of A"]);
	});

	test("the fleet service account keeps its grants: it reads every org, and acts as the fleet system caller", async () => {
		const { t, ids } = await world();
		const a = await insertNote(t, noteA(ids));
		await insertNote(t, noteB(ids));
		const m = asMaster(t);
		expect(titles(await m.query(api.briefingNotes.list, { limit: 50 }))).toEqual([
			"note of A",
			"note of B",
		]);
		expect((await m.query(api.briefingNotes.get, { noteId: a, master: true }))?._id).toBe(a);
		await m.mutation(api.briefingNotes.update, {
			noteId: a,
			callerOrchestrator: "system",
			content: "by system",
		});
		expect((await t.run((ctx) => ctx.db.get(a)))?.content).toBe("by system");
		const created = await m.mutation(api.briefingNotes.create, {
			title: "fleet note",
			topic: "handoff",
			participants: ["pi"],
			content: "c",
			createdBy: "pi",
			verifiedActor: { agentId: ids.opPi, orgSlug: OP_SLUG },
		});
		const row = await t.run((ctx) => ctx.db.get(created));
		expect(row?.createdById).toBe(ids.opPi);
		expect(row?.participantIds).toEqual([ids.opPi]);
	});

	test("cursor paging reaches the page past the first (createdBefore is part of the read)", async () => {
		const { t, ids } = await world();
		const n1 = await insertNote(t, noteA(ids, { title: "n1" }));
		const n2 = await insertNote(t, noteA(ids, { title: "n2" }));
		const n3 = await insertNote(t, noteA(ids, { title: "n3" }));
		const member = asMember(t, A_SLUG, A_ID, "user-a");
		const page1 = (await member.query(api.briefingNotes.list, { limit: 2 })) as {
			_id: Id<"briefingNotes">;
		}[];
		expect(page1.map((r) => r._id)).toEqual([n3, n2]);
		const n2doc = await t.run((ctx) => ctx.db.get(n2));
		const page2 = (await member.query(api.briefingNotes.list, {
			limit: 2,
			createdBefore: (n2doc as { _creationTime: number })._creationTime,
		})) as { _id: Id<"briefingNotes"> }[];
		expect(page2.map((r) => r._id)).toEqual([n1]);
	});
});

describe("briefingNotes by ID — ABSENT", () => {
	test("a scoped caller reading an empty table gets an empty success, not a refusal", async () => {
		const { t } = await world();
		const b = asMember(t, B_SLUG, B_ID, "user-b");
		expect(await b.query(api.briefingNotes.list, { limit: 50 })).toEqual([]);
		expect(
			await b.query(api.briefingNotes.searchBriefingNotesByKeyword, { query: "secret" }),
		).toEqual([]);
	});
});
