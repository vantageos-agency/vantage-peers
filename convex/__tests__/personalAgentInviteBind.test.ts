/// <reference types="vite/client" />
//
// VantagePeers Cloud — task k178xp66h7p0ds6vg69sqzw2vn8hbfrw. "Bind at first sign-up, automatic":
// an agent carries the EMAIL its person was invited under; when the Clerk membership webhook reports
// a member of that agent's own organisation whose VERIFIED Clerk email matches, personalAgentOf is
// set and the invite is cleared.
//
// Poles:
//   MATCH      a live member of the org with a verified matching email binds the agent.
//   MISMATCH   a different email binds nothing; an UNVERIFIED matching email binds nothing.
//   DENY       a member of org A whose email equals an invite in org B binds nothing in B (and the
//              membership must be live); an agent already bound is never overwritten.
//   TRIGGER    the webhook mutation schedules the bind only when its org holds a pending invite.
//   ACTION     the Clerk read fails closed (no key, HTTP error, wrong user) and counts only verified emails.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const ORG_A = "tenant-a";
const ORG_B = "tenant-b";
const PERSON = "user_2person";
const OTHER = "user_2other";
const EMAIL = "pat@client.test";

beforeEach(() => {
	// scheduled bind jobs are asserted, never run
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function seedAgent(
	t: T,
	slug: string,
	name: string,
	extra: Record<string, unknown> = {},
): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			name,
			normalizedName: name.toLowerCase(),
			isActive: true,
			createdAt: Date.now(),
			...extra,
		}),
	);
}

const invite = (email: string) => ({ email, invitedAt: 1 });

async function seedMember(t: T, slug: string, userId: string, deletedAt?: number): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("orgMembership", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			clerkUserId: userId,
			role: "admin",
			createdAt: 1,
			updatedAt: 1,
			lastEventAt: 1,
			...(deletedAt !== undefined ? { deletedAt } : {}),
		});
	});
}

const bind = (t: T, slug: string, userId: string, verifiedEmails: string[]) =>
	t.mutation(internal.personalAgentBind.applyVerifiedEmails, {
		clerkOrgId: testClerkOrgId(slug),
		clerkUserId: userId,
		verifiedEmails,
	});

const row = (t: T, id: Id<"agents">) => t.run((ctx) => ctx.db.get(id));
const scheduled = (t: T) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

describe("applyVerifiedEmails", () => {
	test("MATCH: a live member with the verified email binds the agent and clears the invite", async () => {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo", { personalAgentInvite: invite(EMAIL) });
		const sacha = await seedAgent(t, ORG_A, "Sacha", { personalAgentInvite: invite(EMAIL) });
		await seedMember(t, ORG_A, PERSON);
		const out = await bind(t, ORG_A, PERSON, ["Pat@Client.Test"]);
		expect([...out.bound].sort()).toEqual([milo, sacha].sort());
		for (const id of [milo, sacha]) {
			const a = await row(t, id);
			expect(a?.personalAgentOf).toBe(PERSON);
			expect(a?.personalAgentInvite).toBeUndefined();
		}
	});

	test("MISMATCH: another email binds nothing and the invite stays", async () => {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo", { personalAgentInvite: invite(EMAIL) });
		await seedMember(t, ORG_A, PERSON);
		expect((await bind(t, ORG_A, PERSON, ["someone.else@client.test"])).bound).toEqual([]);
		const a = await row(t, milo);
		expect(a?.personalAgentOf).toBeUndefined();
		expect(a?.personalAgentInvite?.email).toBe(EMAIL);
	});

	test("MISMATCH: no verified email at all binds nothing", async () => {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo", { personalAgentInvite: invite(EMAIL) });
		await seedMember(t, ORG_A, PERSON);
		expect((await bind(t, ORG_A, PERSON, [])).bound).toEqual([]);
		expect((await row(t, milo))?.personalAgentOf).toBeUndefined();
	});

	test("DENY cross-tenant: a member of org A with the same email binds nothing in org B", async () => {
		const t = createT();
		const inB = await seedAgent(t, ORG_B, "Milo", { personalAgentInvite: invite(EMAIL) });
		const inA = await seedAgent(t, ORG_A, "Sacha", { personalAgentInvite: invite(EMAIL) });
		await seedMember(t, ORG_A, PERSON);
		const out = await bind(t, ORG_A, PERSON, [EMAIL]);
		expect(out.bound).toEqual([inA]);
		const b = await row(t, inB);
		expect(b?.personalAgentOf).toBeUndefined();
		expect(b?.personalAgentInvite?.email).toBe(EMAIL);
	});

	test("DENY: a person who is not a member of the org binds nothing", async () => {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo", { personalAgentInvite: invite(EMAIL) });
		await seedMember(t, ORG_B, PERSON);
		expect((await bind(t, ORG_A, PERSON, [EMAIL])).bound).toEqual([]);
		expect((await row(t, milo))?.personalAgentOf).toBeUndefined();
	});

	test("DENY: a removed member (tombstone) binds nothing", async () => {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo", { personalAgentInvite: invite(EMAIL) });
		await seedMember(t, ORG_A, PERSON, 5);
		expect((await bind(t, ORG_A, PERSON, [EMAIL])).bound).toEqual([]);
		expect((await row(t, milo))?.personalAgentOf).toBeUndefined();
	});

	test("DENY: an agent already bound to someone is never overwritten", async () => {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo", {
			personalAgentOf: OTHER,
			personalAgentInvite: invite(EMAIL),
		});
		await seedMember(t, ORG_A, PERSON);
		expect((await bind(t, ORG_A, PERSON, [EMAIL])).bound).toEqual([]);
		expect((await row(t, milo))?.personalAgentOf).toBe(OTHER);
	});

	test("an agent with no invite is never bound, whatever the email", async () => {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo");
		await seedMember(t, ORG_A, PERSON);
		expect((await bind(t, ORG_A, PERSON, [EMAIL])).bound).toEqual([]);
		expect((await row(t, milo))?.personalAgentOf).toBeUndefined();
	});

	test("a clerkUserId that is not a Clerk user id is refused", async () => {
		const t = createT();
		await expect(bind(t, ORG_A, "not-a-user", [EMAIL])).rejects.toThrow(/PERSONAL_AGENT_PERSON_ID_INVALID/);
	});
});

describe("bindFromClerk (the Clerk read)", () => {
	const clerkUser = (emails: Array<{ email: string; status: string }>, id = PERSON) => ({
		ok: true,
		status: 200,
		json: async () => ({
			id,
			email_addresses: emails.map((e) => ({ email_address: e.email, verification: { status: e.status } })),
		}),
	});
	async function seeded(): Promise<{ t: T; milo: Id<"agents"> }> {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo", { personalAgentInvite: invite(EMAIL) });
		await seedMember(t, ORG_A, PERSON);
		return { t, milo };
	}
	const run = (t: T) =>
		t.action(internal.personalAgentBind.bindFromClerk, { clerkOrgId: testClerkOrgId(ORG_A), clerkUserId: PERSON });

	test("MATCH: a VERIFIED address binds", async () => {
		const { t, milo } = await seeded();
		vi.stubEnv("CLERK_SECRET_KEY", "sk_test_x");
		vi.stubGlobal("fetch", vi.fn(async () => clerkUser([{ email: EMAIL, status: "verified" }])));
		expect(await run(t)).toEqual({ bound: 1 });
		expect((await row(t, milo))?.personalAgentOf).toBe(PERSON);
	});

	test("MISMATCH: the same address, UNVERIFIED, binds nothing", async () => {
		const { t, milo } = await seeded();
		vi.stubEnv("CLERK_SECRET_KEY", "sk_test_x");
		vi.stubGlobal("fetch", vi.fn(async () => clerkUser([{ email: EMAIL, status: "unverified" }])));
		expect(await run(t)).toEqual({ bound: 0 });
		expect((await row(t, milo))?.personalAgentOf).toBeUndefined();
	});

	test("fail-closed: no CLERK_SECRET_KEY raises and binds nothing", async () => {
		const { t, milo } = await seeded();
		vi.stubEnv("CLERK_SECRET_KEY", "");
		await expect(run(t)).rejects.toThrow(/CLERK_SECRET_KEY_MISSING/);
		expect((await row(t, milo))?.personalAgentOf).toBeUndefined();
	});

	test("fail-closed: a Clerk HTTP error raises, naming the status and not the key", async () => {
		const { t, milo } = await seeded();
		vi.stubEnv("CLERK_SECRET_KEY", "sk_test_secretvalue");
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
		const err = await run(t).catch((e: Error) => e);
		expect(String(err)).toMatch(/CLERK_USER_READ_FAILED.*500/);
		expect(String(err)).not.toContain("sk_test_secretvalue");
		expect((await row(t, milo))?.personalAgentOf).toBeUndefined();
	});

	test("fail-closed: an answer for a different user raises", async () => {
		const { t, milo } = await seeded();
		vi.stubEnv("CLERK_SECRET_KEY", "sk_test_x");
		vi.stubGlobal("fetch", vi.fn(async () => clerkUser([{ email: EMAIL, status: "verified" }], OTHER)));
		await expect(run(t)).rejects.toThrow(/CLERK_USER_READ_MISMATCH/);
		expect((await row(t, milo))?.personalAgentOf).toBeUndefined();
	});
});

describe("webhook trigger (applyClerkMembershipEvent)", () => {
	const upsert = (t: T, slug: string, userId: string, eventAt: number) =>
		t.mutation(internal.orgMembership.applyClerkMembershipEvent, {
			kind: "upsert",
			clerkOrgId: testClerkOrgId(slug),
			clerkOrgSlug: slug,
			clerkUserId: userId,
			role: "admin",
			eventAt,
		});
	const bindJobs = async (t: T) =>
		(await scheduled(t)).filter((j) => j.name.includes("personalAgentBind"));

	test("a member joining an org that holds a pending invite schedules the bind for THAT user", async () => {
		const t = createT();
		await seedAgent(t, ORG_A, "Milo", { personalAgentInvite: invite(EMAIL) });
		await upsert(t, ORG_A, PERSON, 10);
		const jobs = await bindJobs(t);
		expect(jobs).toHaveLength(1);
		expect(jobs[0].args).toEqual([{ clerkOrgId: testClerkOrgId(ORG_A), clerkUserId: PERSON }]);
	});

	test("no pending invite in the org: nothing is scheduled", async () => {
		const t = createT();
		await seedAgent(t, ORG_A, "Milo");
		await upsert(t, ORG_A, PERSON, 10);
		expect(await bindJobs(t)).toHaveLength(0);
	});

	test("DENY: a pending invite in ANOTHER org does not make this org's join schedule anything", async () => {
		const t = createT();
		await seedAgent(t, ORG_B, "Milo", { personalAgentInvite: invite(EMAIL) });
		await upsert(t, ORG_A, PERSON, 10);
		expect(await bindJobs(t)).toHaveLength(0);
	});
});

describe("recordPersonalAgentInvite", () => {
	const record = (t: T, agentId: Id<"agents">, extra: Record<string, unknown> = {}) =>
		t.mutation(internal.agents.recordPersonalAgentInvite, { agentId, email: " Pat@Client.Test ", lang: "fr", aiClient: "claude", ...extra });

	test("stores the normalised email, language and client; a replay changes nothing", async () => {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo");
		expect(await record(t, milo)).toEqual({ agentId: milo, changed: true, previousEmail: null });
		const first = (await row(t, milo))?.personalAgentInvite;
		expect(first).toMatchObject({ email: EMAIL, lang: "fr", aiClient: "claude" });
		expect(await record(t, milo)).toEqual({ agentId: milo, changed: false, previousEmail: EMAIL });
		expect((await row(t, milo))?.personalAgentInvite).toEqual(first);
	});

	test("refuses a second, different email unless replace is true", async () => {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo", { personalAgentInvite: invite(EMAIL) });
		await expect(record(t, milo, { email: "other@client.test" })).rejects.toThrow(/PERSONAL_AGENT_INVITE_CONFLICT/);
		await record(t, milo, { email: "other@client.test", replace: true });
		expect((await row(t, milo))?.personalAgentInvite?.email).toBe("other@client.test");
	});

	test("refuses an agent already bound, an agent without an org id, a service account and a bad email", async () => {
		const t = createT();
		const bound = await seedAgent(t, ORG_A, "Bound", { personalAgentOf: PERSON });
		const noOrg = await t.run((ctx) =>
			ctx.db.insert("agents", { orgSlug: ORG_A, name: "Legacy", isActive: true, createdAt: 1 }),
		);
		const svc = await seedAgent(t, ORG_A, "Svc", { kind: "service" });
		const ok = await seedAgent(t, ORG_A, "Ok");
		await expect(record(t, bound)).rejects.toThrow(/PERSONAL_AGENT_ALREADY_BOUND/);
		await expect(record(t, noOrg)).rejects.toThrow(/PERSONAL_AGENT_NO_CLERK_ORG_ID/);
		await expect(record(t, svc)).rejects.toThrow(/PERSONAL_AGENT_SERVICE_ACCOUNT/);
		await expect(record(t, ok, { email: "not-an-email" })).rejects.toThrow(/PERSONAL_AGENT_INVITE_EMAIL_INVALID/);
	});

	test("an org that already has a live member schedules the bind (signed up before the invite); a tombstoned one does not", async () => {
		const t = createT();
		const milo = await seedAgent(t, ORG_A, "Milo");
		await seedMember(t, ORG_A, PERSON);
		await seedMember(t, ORG_A, OTHER, 5);
		await record(t, milo);
		const jobs = (await scheduled(t)).filter((j) => j.name.includes("personalAgentBind"));
		expect(jobs.map((j) => (j.args[0] as { clerkUserId: string }).clerkUserId)).toEqual([PERSON]);
	});
});

describe("readOrgState", () => {
	test("reports the mapping and the org's agents, and writes nothing", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: ORG_A,
				clerkOrgId: testClerkOrgId(ORG_A),
				allowedOrchestrators: ["milo"],
				scopes: ["view-own-tasks"],
				displayName: ORG_A,
				isActive: true,
				createdAt: 1,
			});
		});
		const milo = await seedAgent(t, ORG_A, "Milo", { personalAgentInvite: invite(EMAIL) });
		await seedAgent(t, ORG_B, "Elsewhere");
		const state = await t.query(internal.onboardPerson.readOrgState, { clerkOrgSlug: ORG_A });
		expect(state.mapping?.clerkOrgId).toBe(testClerkOrgId(ORG_A));
		expect(state.agents).toEqual([
			{ id: milo, name: "Milo", isActive: true, clerkOrgId: testClerkOrgId(ORG_A), personalAgentOf: null, invite: { email: EMAIL } },
		]);
		const none = await t.query(internal.onboardPerson.readOrgState, { clerkOrgSlug: "absent-org" });
		expect(none).toEqual({ mapping: null, agents: [] });
	});
});
