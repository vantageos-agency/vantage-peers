/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * The messages write doors after an org-slug takeover (task
 * k1783fk8r6p795x9fxrzyt9evd8hcxm7, PR (2b), sweep sites A-6 and A-7).
 *
 * A-7: an agent may address a person ("user:<subject>") only when that person has
 * already written in the sender's OWN tenant. The proof was `m.tenantId === slug`;
 * after a takeover the new holder of the slug "proved" the former holder's persons
 * as its own. The proof is now the row's permanent `tenantOrgId` against the
 * sender's org ID.
 *
 * A-6: the seat scope's foreign-identity screen skipped mapping rows by label
 * (`m.clerkOrgSlug === seat.orgSlug`). It now skips by permanent ID. A takeover
 * cannot make that difference visible through this door (a label held by two rows
 * resolves to NO seat, `lookupOrgMapping` answering null, so the seat is refused
 * before the screen runs); the screen is pinned here by the poles that ARE
 * reachable (own-org agent accepted, another org's agent refused).
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import {
	ORG_A,
	ORG_B,
	RENAMED,
	seedTakeoverOrgs,
	SLUG,
} from "../../tests/lib/slugTakeoverMessagesWorld";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const asService = (t: T) => t.withIdentity({ subject: SERVICE });

const PERSON_OF_A = "user:user_of_a";
const PERSON_OF_B = "user:user_of_b";
const PERSON_ID_LESS = "user:user_id_less";

async function world(): Promise<T> {
	const t = createT();
	await t.run(async (ctx) => {
		await seedTakeoverOrgs(ctx.db);
		const base = Date.now();
		await ctx.db.insert("profiles", {
			orchestratorId: "sigma",
			name: "sigma",
			static: { role: "sigma", workspace: "w", capabilities: [] },
			dynamic: { lastSeen: base, sessionCount: 0 },
		});
		const wrote = async (
			from: string,
			stamp: { tenantId?: string; tenantOrgId?: string },
			i: number,
		) =>
			await ctx.db.insert("messages", {
				from,
				channel: "sigma",
				content: `${from} wrote`,
				createdAt: base + i,
				...stamp,
			});
		await wrote(PERSON_OF_A, { tenantId: SLUG, tenantOrgId: ORG_A }, 0);
		await wrote(PERSON_OF_B, { tenantId: SLUG, tenantOrgId: ORG_B }, 1);
		await wrote(PERSON_ID_LESS, { tenantId: SLUG }, 2);
	});
	return t;
}

async function outcome(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SENT";
	} catch (e) {
		return e instanceof ConvexError ? String(e.data) : String(e);
	}
}

const replyAsB = (t: T, person: string) =>
	asService(t).mutation(api.messages.sendMessage, {
		from: "bruno-b",
		channel: person,
		content: "reply",
		seatOrgSlug: SLUG,
	});
const replyAsA = (t: T, person: string) =>
	asService(t).mutation(api.messages.sendMessage, {
		from: "nadia-a",
		channel: person,
		content: "reply",
		seatOrgSlug: RENAMED,
	});

describe("A-7 messages:sendMessage person proof", () => {
	test("TAKEOVER: B (new holder of the slug) cannot address A's person, nor a person whose only row has no org id", async () => {
		const t = await world();
		for (const person of [PERSON_OF_A, PERSON_ID_LESS]) {
			expect(await outcome(replyAsB(t, person))).toContain(
				"person-recipient-not-in-org",
			);
		}
	});

	test("PRESENT: B addresses its own person; A, renamed, addresses its own person", async () => {
		const t = await world();
		expect(await outcome(replyAsB(t, PERSON_OF_B))).toBe("SENT");
		expect(await outcome(replyAsA(t, PERSON_OF_A))).toBe("SENT");
	});

	test("REFUSED: A, renamed, cannot address B's person or the id-less one", async () => {
		const t = await world();
		for (const person of [PERSON_OF_B, PERSON_ID_LESS]) {
			expect(await outcome(replyAsA(t, person))).toContain(
				"person-recipient-not-in-org",
			);
		}
	});
});

describe("A-6 seat foreign-identity screen", () => {
	test("REFUSED + PRESENT: the seat of B sends as its own agent, and is refused another org's agent", async () => {
		const t = await world();
		await t.run(async (ctx) => {
			await ctx.db.insert("agents", {
				orgSlug: RENAMED,
				clerkOrgId: ORG_A,
				name: "mira",
				normalizedName: "mira",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		expect(
			await outcome(
				asService(t).mutation(api.messages.sendMessage, {
					from: "mira",
					channel: "sigma",
					content: "forged",
					seatOrgSlug: SLUG,
				}),
			),
		).toContain("seat-sender-foreign-identity");
		expect(
			await outcome(
				asService(t).mutation(api.messages.sendMessage, {
					from: "bruno-b",
					channel: "sigma",
					content: "own",
					seatOrgSlug: SLUG,
				}),
			),
		).toBe("SENT");
	});
});
