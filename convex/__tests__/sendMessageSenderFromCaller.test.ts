/// <reference types="vite/client" />
//
// Task k17fdch7gfak29nyvna9r3qe098fed1d. VantagePeers Cloud (multi-tenant).
//
// DEFECT (measured on production): an ORDINARY member of org B sent a message
// with from="eta" (and "pi"). `from` is a caller-supplied argument and the
// agent-credential lock is a no-op when omitted. The sender must derive from
// the VERIFIED caller: a member may speak only as an orchestrator on its own
// org's roster (normalised, never the "*" short-circuit).
//
// Poles: REFUSED (foreign name, wildcard roster, credential for another
// name), SERVED (own roster, case variant, own credential), MASTER unchanged.
//
// DELETION PROBE (not committed): remove the requireSenderOnRoster call in
// messages:sendMessage and the REFUSED poles go RED.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const DOOR = "messages:sendMessage";

async function seedOrg(t: T, slug: string, roster: string[]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedProfile(t: T, orchestratorId: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			name: orchestratorId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

const memberOf = (t: T, org: string) =>
	t.withIdentity({ subject: `member-of-${org}`, organizationId: org } as Parameters<
		typeof t.withIdentity
	>[0]);

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Parameters<
		typeof t.withIdentity
	>[0]);

async function refusalOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data : String(e);
	}
	throw new Error("expected a refusal, got a success");
}

async function fixture() {
	const t = createT();
	await seedOrg(t, "org-b", ["bob", "bea"]);
	await seedProfile(t, "bob");
	await seedProfile(t, "bea");
	await seedProfile(t, "eta");
	await seedProfile(t, "pi");
	return t;
}

describe("sendMessage — the sender derives from the verified caller", () => {
	test("REFUSED: a member of org B sending from='eta' is RBAC_DENIED sender-not-on-roster, naming the door", async () => {
		const t = await fixture();
		for (const from of ["eta", "pi"]) {
			const refusal = await refusalOf(
				memberOf(t, "org-b").mutation(api.messages.sendMessage, {
					from,
					channel: "bob",
					content: "impersonation",
				}),
			);
			expect(refusal).toContain("RBAC_DENIED");
			expect(refusal).toContain(DOOR);
			expect(refusal).toMatch(/reason\\*":\\*"sender-not-on-roster/);
		}
		const rows = await t.run((ctx) => ctx.db.query("messages").collect());
		expect(rows).toHaveLength(0);
	});

	test("REFUSED: a wildcard roster names nobody — '*' does not admit from='eta'", async () => {
		const t = await fixture();
		await seedOrg(t, "org-open", ["*"]);
		const refusal = await refusalOf(
			memberOf(t, "org-open").mutation(api.messages.sendMessage, {
				from: "eta",
				channel: "bob",
				content: "x",
			}),
		);
		expect(refusal).toMatch(/reason\\*":\\*"sender-not-on-roster/);
	});

	test("SERVED: a member sending as an orchestrator on its own roster; tenant is its org", async () => {
		const t = await fixture();
		const id = await memberOf(t, "org-b").mutation(api.messages.sendMessage, {
			from: "bob",
			channel: "bea",
			content: "legit",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.from).toBe("bob");
		expect(row?.tenantId).toBe("org-b");
	});

	test("SERVED: roster comparison is normalised (case variant of an own name)", async () => {
		const t = await fixture();
		const id = await memberOf(t, "org-b").mutation(api.messages.sendMessage, {
			from: "BOB",
			channel: "bea",
			content: "case variant",
		});
		expect(id).toBeTruthy();
	});

	test("AGENT CREDENTIAL: holder of bob's credential sending as 'bea' (on the roster) is refused; as 'bob' is served", async () => {
		const t = await fixture();
		await adminOf(t, "org-b").mutation(api.agents.registerAgent, {
			orgSlug: "org-b",
			name: "bob",
		});
		const minted = await adminOf(t, "org-b").mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "org-b", agentName: "bob" },
		);
		const refusal = await refusalOf(
			memberOf(t, "org-b").mutation(api.messages.sendMessage, {
				from: "bea",
				channel: "bob",
				content: "x",
				agentCredentialSecret: minted.secret,
			}),
		);
		expect(refusal).toContain("AGENT_IDENTITY_MISMATCH");
		const id = await memberOf(t, "org-b").mutation(api.messages.sendMessage, {
			from: "bob",
			channel: "bea",
			content: "own credential",
			agentCredentialSecret: minted.secret,
		});
		expect(id).toBeTruthy();
	});

	test("MASTER unchanged: the service account may send as any name", async () => {
		const t = await fixture();
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "eta",
			channel: "pi",
			content: "fleet traffic",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.from).toBe("eta");
	});
});
