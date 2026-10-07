/// <reference types="vite/client" />
/**
 * VantagePeers Cloud, client portal reply path (task k1792yz3em7hyw84d765hq71j98ft5h4).
 *
 * Measured on prod: three portal messages to channel "hal" carry from="cgt-alsachimie"
 * and nobody can answer that name. This file pins, on the Convex doors themselves:
 *
 * PART 1 (measurement)
 *   1a  what the service-account + seatOrgSlug path (the portal's path) accepts as `from`
 *   1b  the person principal path today: a person is stored "user:<subject>"; can an agent
 *       of the same org reply to it?
 *
 * PART 2 (the reply path)
 *   SERVED     person (verifiedPerson or Clerk member) -> agent; same-org agent -> person;
 *              the person reads and acknowledges the reply
 *   REFUSED    an agent of another org, the fleet master and an unknown person all get
 *              RBAC_DENIED (one code, no oracle between "foreign" and "absent")
 *   ISOLATED   a person of org B (or another person of org A) cannot read org A's person inbox
 *   ABSENT     a person with no replies reads an empty SUCCESS (no `refused` key)
 *   IMPERSONATION  the seat path no longer accepts a `from` naming a person, another
 *              org's orchestrator or a fleet orchestrator it does not belong to
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
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
type Identity = Parameters<T["withIdentity"]>[0];

const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const CGT = "cgt-alsachimie";
const OTHER = "other-client";
const PERSON_TOKEN = "a".repeat(64);
const PERSON = "user_portal1";
const PERSON_ACTOR = `user:${PERSON}`;

let t: T;
const service = () => t.withIdentity({ subject: SERVICE });
const member = (org: string, subject: string) =>
	t.withIdentity({
		subject,
		org_slug: org,
		org_role: "org:editor",
	} as Identity);
const portalPerson = () => member(CGT, PERSON);
const noOrgPerson = () => t.withIdentity({ subject: "user_noorg" } as Identity);

async function expectCode(p: Promise<unknown>, code: string): Promise<string> {
	let caught: unknown;
	try {
		await p;
	} catch (err) {
		caught = err;
	}
	expect(caught, `expected a refusal carrying ${code}`).toBeDefined();
	const data = (caught as { data?: unknown }).data;
	const text = `${(caught as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	expect(text).toContain(code);
	return text;
}

async function writes() {
	return await t.run(async (ctx) => ({
		messages: (await ctx.db.query("messages").collect()).length,
		receipts: (await ctx.db.query("messageReceipts").collect()).length,
	}));
}

beforeEach(async () => {
	t = createT();
	const now = Date.now();
	await t.run(async (ctx) => {
		for (const [slug, roster] of [
			[CGT, ["neo", "hal", "mimir", "bob"]],
			[OTHER, ["themis"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [...roster],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		}
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		for (const o of ["neo", "hal", "mimir", "bob", "themis", "sigma"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: o,
				name: o,
				static: { role: o, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: now, sessionCount: 0 },
			});
		}
		await ctx.db.insert("oauth_access_tokens", {
			clientId: "c",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "person",
			fromAllowList: ["hal"],
			namespaceReadPrefixes: [`team/${CGT}`],
			namespaceWritePrefixes: [`team/${CGT}`],
			expiresAt: now + 3_600_000,
			createdAt: now,
			clerkOrgSlug: CGT,
			tokenHash: PERSON_TOKEN,
			userId: PERSON,
			orgRole: "org:editor",
			principal: "person",
		});
	});
});

/** The portal request: the PERSON writes to an agent of its org. */
async function personAsks(channel = "hal") {
	return await service().mutation(api.messages.sendMessage, {
		channel,
		content: "portal request",
		verifiedPerson: { accessTokenHash: PERSON_TOKEN },
	});
}

describe("PART 1a — what the portal's service-account + seatOrgSlug path accepts as `from`", () => {
	test("the seat label the portal sends today is accepted and stored unanswerable", async () => {
		const id = await service().mutation(api.messages.sendMessage, {
			from: CGT,
			channel: "hal",
			content: "portal request",
			seatOrgSlug: CGT,
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.from).toBe(CGT);
		// An agent cannot answer it: the label is not a recipient.
		await expect(
			service().mutation(api.messages.sendMessage, {
				from: "hal",
				channel: CGT,
				content: "answer",
				seatOrgSlug: CGT,
			}),
		).rejects.toThrow(/recipient error/);
	});

	test("an orchestrator of the seat's own org is accepted at this door (within-org binding is the MCP allow-list's job, declared)", async () => {
		const id = await service().mutation(api.messages.sendMessage, {
			from: "hal",
			channel: "neo",
			content: "x",
			seatOrgSlug: CGT,
		});
		expect(id).toBeDefined();
	});

	test("IMPERSONATION CLOSED: the seat path refuses a `from` that is another org's orchestrator, a fleet orchestrator or a person", async () => {
		for (const from of ["sigma", "themis", PERSON_ACTOR, "USER:forged"]) {
			await expectCode(
				service().mutation(api.messages.sendMessage, {
					from,
					channel: "neo",
					content: "forged",
					seatOrgSlug: CGT,
				}),
				"RBAC_DENIED",
			);
		}
		expect(await writes()).toEqual({ messages: 0, receipts: 0 });
	});

	async function seedAgent(orgSlug: string, name: string) {
		await t.run(async (ctx) => {
			await ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: name.trim().toLowerCase(),
				isActive: true,
				createdAt: Date.now(),
			});
		});
	}

	test("S3 REFUSED: a registered agent of ANOTHER org (on no roster, no profile) cannot be impersonated", async () => {
		await seedAgent(OTHER, "nadia");
		await expectCode(
			service().mutation(api.messages.sendMessage, {
				from: "nadia",
				channel: "neo",
				content: "forged",
				seatOrgSlug: CGT,
			}),
			"seat-sender-foreign-identity",
		);
		expect(await writes()).toEqual({ messages: 0, receipts: 0 });
	});

	test("S4 REFUSED: a case or instance variant of that agent is refused too", async () => {
		await seedAgent(OTHER, "nadia");
		for (const from of ["Nadia", " NADIA ", "nadia-vps", "nadia-vps-1"]) {
			await expectCode(
				service().mutation(api.messages.sendMessage, {
					from,
					channel: "neo",
					content: "forged",
					seatOrgSlug: CGT,
				}),
				"seat-sender-foreign-identity",
			);
		}
		expect(await writes()).toEqual({ messages: 0, receipts: 0 });
	});

	test("PRESENT: an agent registered in the seat's OWN org is accepted, as are its variants", async () => {
		await seedAgent(CGT, "mira");
		for (const from of ["mira", "Mira", "mira-vps"]) {
			const id = await service().mutation(api.messages.sendMessage, {
				from,
				channel: "neo",
				content: "own",
				seatOrgSlug: CGT,
			});
			expect(id).toBeDefined();
		}
	});

	test("the seat path stamps the seat's verified org on the message and its receipts", async () => {
		const id = await service().mutation(api.messages.sendMessage, {
			from: "hal",
			channel: "neo",
			content: "x",
			seatOrgSlug: CGT,
		});
		const { row, receipts } = await t.run(async (ctx) => ({
			row: await ctx.db.get(id),
			receipts: await ctx.db.query("messageReceipts").collect(),
		}));
		expect(row?.tenantId).toBe(CGT);
		expect(receipts.map((r) => r.tenantId)).toEqual([CGT]);
	});
});

describe("PART 1b — the person principal path today", () => {
	test("a person is stored as user:<subject> (Clerk member and verifiedPerson alike)", async () => {
		const viaClerk = await portalPerson().mutation(api.messages.sendMessage, {
			channel: "hal",
			content: "from the dashboard",
		});
		const viaToken = await personAsks();
		const rows = await t.run(async (ctx) => [
			await ctx.db.get(viaClerk),
			await ctx.db.get(viaToken),
		]);
		expect(rows.map((r) => r?.from)).toEqual([PERSON_ACTOR, PERSON_ACTOR]);
		expect(rows.map((r) => r?.tenantId)).toEqual([CGT, CGT]);
	});

	test("an agent of the same org can reply to that person (seat path and Clerk path)", async () => {
		await personAsks();
		const viaSeat = await service().mutation(api.messages.sendMessage, {
			from: "hal",
			channel: PERSON_ACTOR,
			content: "answer",
			seatOrgSlug: CGT,
		});
		const viaClerk = await member(CGT, "user_hal_seat").mutation(
			api.messages.sendMessage,
			{ from: "hal", channel: PERSON_ACTOR, content: "answer 2" },
		);
		const receipts = await t.run(async (ctx) =>
			ctx.db.query("messageReceipts").collect(),
		);
		const mine = receipts.filter((r) => r.recipient === PERSON_ACTOR);
		expect(mine.map((r) => r.messageId).sort()).toEqual(
			[viaSeat, viaClerk].sort(),
		);
		expect(mine.every((r) => r.tenantId === CGT)).toBe(true);
		expect(mine.every((r) => r.recipientInstanceId === undefined)).toBe(true);
	});
});

describe("PART 2 — SERVED: the person reads and acknowledges the reply", () => {
	test("reply -> the person reads it through the Clerk path and through verifiedPerson", async () => {
		await personAsks();
		await service().mutation(api.messages.sendMessage, {
			from: "hal",
			channel: PERSON_ACTOR,
			content: "here is the answer",
			seatOrgSlug: CGT,
		});
		const viaClerk = await portalPerson().query(api.messages.listMyInbox, {});
		expect(viaClerk.refused).toBeUndefined();
		expect(viaClerk.items.map((m) => [m.from, m.content])).toEqual([
			["hal", "here is the answer"],
		]);
		const viaToken = await service().query(api.messages.listMyInbox, {
			verifiedPerson: { accessTokenHash: PERSON_TOKEN },
		});
		expect(viaToken.items).toHaveLength(1);
	});

	test("acknowledging the receipt empties the inbox; another person cannot acknowledge it", async () => {
		await personAsks();
		await service().mutation(api.messages.sendMessage, {
			from: "hal",
			channel: PERSON_ACTOR,
			content: "answer",
			seatOrgSlug: CGT,
		});
		const [item] = (await portalPerson().query(api.messages.listMyInbox, {}))
			.items;
		expect(item).toBeDefined();
		await expectCode(
			member(CGT, "user_colleague").mutation(api.messages.markAsRead, {
				receiptIds: [item.receiptId],
			}),
			"RBAC_DENIED",
		);
		const n = await portalPerson().mutation(api.messages.markAsRead, {
			receiptIds: [item.receiptId],
		});
		expect(n).toBe(1);
		expect(
			(await portalPerson().query(api.messages.listMyInbox, {})).items,
		).toEqual([]);
	});

	test("through verifiedPerson the person acknowledges its own receipt, and may not name an agent", async () => {
		await personAsks();
		await service().mutation(api.messages.sendMessage, {
			from: "hal",
			channel: PERSON_ACTOR,
			content: "answer",
			seatOrgSlug: CGT,
		});
		const proof = { accessTokenHash: PERSON_TOKEN };
		const [item] = (
			await service().query(api.messages.listMyInbox, { verifiedPerson: proof })
		).items;
		await expectCode(
			service().mutation(api.messages.markAsRead, {
				receiptIds: [item.receiptId],
				callerOrchestrator: "hal",
				verifiedPerson: proof,
			}),
			"PERSON_ACTS_AS_ITSELF",
		);
		expect(
			await service().mutation(api.messages.markAsRead, {
				receiptIds: [item.receiptId],
				verifiedPerson: proof,
			}),
		).toBe(1);
	});

	test("a comma list mixing an agent and the person is delivered to both", async () => {
		await personAsks();
		const id = await service().mutation(api.messages.sendMessage, {
			from: "hal",
			channel: `neo,${PERSON_ACTOR}`,
			content: "both",
			seatOrgSlug: CGT,
		});
		const receipts = await t.run(async (ctx) =>
			ctx.db.query("messageReceipts").collect(),
		);
		expect(
			receipts
				.filter((r) => r.messageId === id)
				.map((r) => r.recipient)
				.sort(),
		).toEqual(["neo", PERSON_ACTOR]);
	});
});

describe("PART 2 — REFUSED: a person of another org stays unreachable", () => {
	test("an agent of ANOTHER org replying to the person: RBAC_DENIED, nothing written", async () => {
		await personAsks();
		const before = await writes();
		const text = await expectCode(
			service().mutation(api.messages.sendMessage, {
				from: "themis",
				channel: PERSON_ACTOR,
				content: "cross-org",
				seatOrgSlug: OTHER,
			}),
			"RBAC_DENIED",
		);
		expect(text).toContain("person-recipient-not-in-org");
		expect(await writes()).toEqual(before);
	});

	test("the same through a Clerk member of the other org", async () => {
		await personAsks();
		await expectCode(
			member(OTHER, "user_themis_seat").mutation(api.messages.sendMessage, {
				from: "themis",
				channel: PERSON_ACTOR,
				content: "cross-org",
			}),
			"RBAC_DENIED",
		);
	});

	test("the fleet master (no org) is refused as well; an unknown person is refused with the same code", async () => {
		await personAsks();
		await expectCode(
			service().mutation(api.messages.sendMessage, {
				from: "sigma",
				channel: PERSON_ACTOR,
				content: "fleet",
			}),
			"RBAC_DENIED",
		);
		await expectCode(
			service().mutation(api.messages.sendMessage, {
				from: "hal",
				channel: "user:nobody",
				content: "who",
				seatOrgSlug: CGT,
			}),
			"RBAC_DENIED",
		);
	});

	test("one foreign person in a list refuses the whole send", async () => {
		await personAsks();
		await portalPerson(); // no-op, keeps the pole order readable
		await t.run(async (ctx) => {
			await ctx.db.insert("messages", {
				from: "user:user_other_person",
				channel: "themis",
				content: "hi",
				tenantId: OTHER,
				createdAt: Date.now(),
			});
		});
		const before = await writes();
		await expectCode(
			service().mutation(api.messages.sendMessage, {
				from: "hal",
				channel: `${PERSON_ACTOR},user:user_other_person`,
				content: "mixed",
				seatOrgSlug: CGT,
			}),
			"RBAC_DENIED",
		);
		expect(await writes()).toEqual(before);
	});
});

describe("PART 2 — ISOLATED: a person inbox is private", () => {
	async function replied() {
		await personAsks();
		await service().mutation(api.messages.sendMessage, {
			from: "hal",
			channel: PERSON_ACTOR,
			content: "private answer",
			seatOrgSlug: CGT,
		});
	}

	test("a person of org B cannot read org A's person inbox, by the list read or by the generic read", async () => {
		await replied();
		const other = member(OTHER, "user_other_person");
		expect((await other.query(api.messages.listMyInbox, {})).items).toEqual([]);
		await expectCode(
			other.query(api.messages.checkNewMessages, { recipient: PERSON_ACTOR }),
			"RBAC_DENIED",
		);
		await expectCode(
			other.query(api.messages.checkNewMessagesEnvelope, {
				recipient: PERSON_ACTOR,
			}),
			"RBAC_DENIED",
		);
	});

	test("a colleague of the same org cannot read it either; the owner can", async () => {
		await replied();
		const colleague = member(CGT, "user_colleague");
		await expectCode(
			colleague.query(api.messages.checkNewMessages, {
				recipient: PERSON_ACTOR,
			}),
			"RBAC_DENIED",
		);
		expect(
			(await colleague.query(api.messages.listMyInbox, {})).items,
		).toEqual([]);
		const own = await portalPerson().query(api.messages.checkNewMessages, {
			recipient: PERSON_ACTOR,
		});
		expect(own.map((m) => m.content)).toEqual(["private answer"]);
	});
});

describe("PART 2 — the inbox read says refusal and absence differently", () => {
	test("ABSENT: a person with no replies reads an empty SUCCESS, with no `refused` key", async () => {
		const r = await portalPerson().query(api.messages.listMyInbox, {});
		expect(r).toEqual({ items: [] });
		expect("refused" in r).toBe(false);
	});

	test("REFUSED: anonymous and the bare service account RAISE; a signed-in person with no org gets the envelope", async () => {
		await expectCode(t.query(api.messages.listMyInbox, {}), "RBAC_DENIED");
		await expectCode(service().query(api.messages.listMyInbox, {}), "RBAC_DENIED");
		expect(await noOrgPerson().query(api.messages.listMyInbox, {})).toEqual({
			refused: true,
			items: [],
		});
	});

	test("REFUSED: a verifiedPerson from anyone but the service account is rejected", async () => {
		await expectCode(
			portalPerson().query(api.messages.listMyInbox, {
				verifiedPerson: { accessTokenHash: PERSON_TOKEN },
			}),
			"RBAC_DENIED",
		);
	});
});
