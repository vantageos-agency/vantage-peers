/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * verifiedActor — the SECOND proof carrier (design note js76m7pxnvkbvgx7d5w7w9me358fgy69,
 * step i; task k17573xwj0g0kf1fsfntrn3h2d8d30y8 item 2).
 *
 * Every door that accepts `agentCredentialSecret` also accepts
 * `verifiedActor: { agentId, orgSlug }` — the MCP's own header verification
 * result. It is trusted ONLY from the fleet service account
 * (`masterSource === "service-account"`); everyone else presenting it is
 * refused RBAC_DENIED `verified-actor-not-trusted`, never ignored. Omission of
 * both proofs still behaves exactly as before (step iii removes that later).
 *
 * POLES (each over EVERY door in DOORS, 14 public functions)
 *   ACCEPTED   service account + verifiedActor of the asserted name's row, same org
 *   OTHER ROW  verifiedActor of one agent, asserted name of another -> AGENT_IDENTITY_MISMATCH
 *   ORG        verifiedActor.orgSlug but the row lives in another org -> ORG_MISMATCH
 *   INACTIVE   verifiedActor naming a deactivated row -> VERIFIED_ACTOR_INACTIVE
 *   UNKNOWN    verifiedActor naming a deleted row -> VERIFIED_ACTOR_UNKNOWN
 *   UNTRUSTED  org member JWT presenting verifiedActor -> RBAC_DENIED verified-actor-not-trusted
 *   BOTH       secret + verifiedActor -> AGENT_PROOF_CONFLICT
 *   NEITHER    today's behaviour pinned (valid secret ACCEPTED; registered name with no
 *              proof REFUSED AGENT_CREDENTIAL_REQUIRED)
 *   R2 RENAME  verifiedActor (agentId) accepted for the NEW name, refused for the OLD
 *   HELPER     masterSource "internal" and "operator-admin" refused; "service-account" admitted
 *
 * MUTANTS (run by hand, recorded in the dispatch report): (1) accept verifiedActor
 * from any caller; (2) compare by name instead of row id; (3) let "internal" through.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { requireAgentCredentialMatch } from "../lib/auth";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

const memberOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `reader-of-${org}`,
		organizationId: org,
		org_id: testClerkOrgId(org),
	} as Parameters<typeof t.withIdentity>[0]);

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seedOrg(t: T, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
			allowedOrchestrators: ["clio", "vera", "calliope"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
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

async function register(t: T, org: string, name: string): Promise<Id<"agents">> {
	return await adminOf(t, org).mutation(api.agents.registerAgent, {
		orgSlug: org,
		name,
	});
}

async function mint(t: T, org: string, agentName: string): Promise<string> {
	const minted = await adminOf(t, org).mutation(
		api.agentCredentials.mintAgentCredential,
		{ orgSlug: org, agentId: await agentIdOf(t, org, agentName) },
	);
	return minted.secret;
}

async function rawRename(t: T, id: Id<"agents">, name: string) {
	await t.run(async (ctx) => {
		await ctx.db.patch(id, { name });
	});
}

async function seedTask(t: T): Promise<Id<"tasks">> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("tasks", {
			title: "seed",
			status: "todo",
			priority: "medium",
			assignedTo: "clio",
			createdBy: "clio",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId: "org-a",
			clerkOrgId: testClerkOrgId("org-a"),
		} as never);
	});
}

type Proof = {
	agentCredentialSecret?: string;
	verifiedActor?: { agentId: Id<"agents">; orgSlug: string };
	tenantId?: string;
};

type Door = {
	name: string;
	call: (t: T, taskId: Id<"tasks">, as: string, proof: Proof) => Promise<unknown>;
};

// Every public function that accepts `agentCredentialSecret` (enumerated with
// `grep -n agentCredentialSecret convex/*.ts`). The lock runs BEFORE any
// task/message lookup, so a seeded task id is enough for the refusal poles.
const DOORS: Door[] = [
	{
		name: "messages:sendMessage",
		call: (t, _id, as, proof) =>
			t.mutation(
				api.messages.sendMessage as never,
				{ from: as, channel: "recipient-role", content: "hello", ...proof } as never,
			),
	},
	{
		name: "tasks:create",
		call: (t, _id, as, proof) =>
			t.mutation(
				api.tasks.create as never,
				{
					title: "t",
					assignedTo: "clio",
					priority: "medium",
					status: "todo",
					createdBy: as,
					...proof,
				} as never,
			),
	},
	...(
		[
			["update", {}],
			["attachReviewArtifact", { artifactRef: "x" }],
			["blockTask", {}],
			["complete", {}],
			["failTask", { failureNote: "n" }],
			["start", {}],
			["pause", {}],
			["resume", {}],
			["correctSegment", { segmentIndex: 0, start: 1, end: 2, reason: "r" }],
			["checkout", {}],
			["deleteTask", {}],
		] as const
	).map(
		([fn, extra]): Door => ({
			name: `tasks:${fn}`,
			call: (t, id, as, proof) =>
				t.mutation(
					(api.tasks as unknown as Record<string, never>)[fn],
					{ taskId: id, callerOrchestrator: as, ...extra, ...proof } as never,
				),
		}),
	),
	{
		name: "tasks:bulkComplete",
		call: (t, _id, as, proof) =>
			t.mutation(
				api.tasks.bulkComplete as never,
				{ filter: {}, dryRun: true, callerOrchestrator: as, ...proof } as never,
			),
	},
];

// A door is called with an ALREADY identity-bound handle (asService/asMember).
const CODES =
	/^(RBAC_DENIED[^]*verified-actor-not-trusted|AGENT_IDENTITY_MISMATCH|AGENT_CREDENTIAL_REQUIRED|ORG_MISMATCH|AGENT_PROOF_CONFLICT|VERIFIED_ACTOR_INACTIVE|VERIFIED_ACTOR_UNKNOWN)/;

/** The refusal CODE (the leading token of the ConvexError), or a classification. */
async function outcome(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (e instanceof ConvexError) {
			const data = String(e.data).replace(/^"/, "");
			const m = CODES.exec(data);
			if (m) {
				return data.includes("verified-actor-not-trusted")
					? "RBAC_DENIED:verified-actor-not-trusted"
					: (/^[A-Z_]+/.exec(data)?.[0] ?? data);
			}
			return "DOMAIN_ERROR_AFTER_LOCK";
		}
		const msg = String(e);
		if (/ArgumentValidationError|extra field|Validator error/i.test(msg)) {
			return "ARG_REJECTED";
		}
		return `NON_CONVEX_ERROR: ${msg.slice(0, 120)}`;
	}
	return "NO_ERROR";
}

const PASSED_LOCK = ["NO_ERROR", "DOMAIN_ERROR_AFTER_LOCK"];

async function world() {
	const t = createT();
	await seedOrg(t, "org-a");
	await seedOrg(t, "org-b");
	for (const p of ["clio", "vera", "calliope", "recipient-role"]) {
		await seedProfile(t, p);
	}
	const clioA = await register(t, "org-a", "clio");
	const veraA = await register(t, "org-a", "vera");
	const clioB = await register(t, "org-b", "clio");
	const taskId = await seedTask(t);
	return { t, clioA, veraA, clioB, taskId };
}

// Bind a door to an identity: DOORS call `.mutation` on the bound handle.
const asService = (t: T) => asServiceAccount(t) as unknown as T;
const asMember = (t: T) => memberOf(t, "org-a") as unknown as T;

describe.each(DOORS)("verifiedActor at $name", (door) => {
	test("ACCEPTED: service account + verifiedActor of the asserted name's row, same org", async () => {
		const { t, clioA, taskId } = await world();
		const out = await outcome(
			door.call(asService(t), taskId, "clio", {
				verifiedActor: { agentId: clioA, orgSlug: "org-a" },
			}),
		);
		expect(PASSED_LOCK).toContain(out);
	});

	test("OTHER ROW: verifiedActor of clio, asserted name vera -> AGENT_IDENTITY_MISMATCH", async () => {
		const { t, clioA, taskId } = await world();
		const out = await outcome(
			door.call(asService(t), taskId, "vera", {
				verifiedActor: { agentId: clioA, orgSlug: "org-a" },
			}),
		);
		expect(out).toBe("AGENT_IDENTITY_MISMATCH");
	});

	test("ORG: verifiedActor claims org-a but the row lives in org-b -> ORG_MISMATCH", async () => {
		const { t, clioB, taskId } = await world();
		const out = await outcome(
			door.call(asService(t), taskId, "clio", {
				verifiedActor: { agentId: clioB, orgSlug: "org-a" },
			}),
		);
		expect(out).toBe("ORG_MISMATCH");
	});

	test("INACTIVE: verifiedActor naming a deactivated row -> VERIFIED_ACTOR_INACTIVE", async () => {
		const { t, clioA, taskId } = await world();
		await t.run(async (ctx) => {
			await ctx.db.patch(clioA, { isActive: false });
		});
		const out = await outcome(
			door.call(asService(t), taskId, "clio", {
				verifiedActor: { agentId: clioA, orgSlug: "org-a" },
			}),
		);
		expect(out).toBe("VERIFIED_ACTOR_INACTIVE");
	});

	test("UNKNOWN: verifiedActor naming a deleted row -> VERIFIED_ACTOR_UNKNOWN", async () => {
		const { t, clioA, taskId } = await world();
		await t.run(async (ctx) => {
			await ctx.db.delete(clioA);
		});
		const out = await outcome(
			door.call(asService(t), taskId, "clio", {
				verifiedActor: { agentId: clioA, orgSlug: "org-a" },
			}),
		);
		expect(out).toBe("VERIFIED_ACTOR_UNKNOWN");
	});

	test("UNTRUSTED: an org member presenting verifiedActor -> RBAC_DENIED verified-actor-not-trusted", async () => {
		const { t, clioA, taskId } = await world();
		const out = await outcome(
			door.call(asMember(t), taskId, "clio", {
				verifiedActor: { agentId: clioA, orgSlug: "org-a" },
			}),
		);
		expect(out).toBe("RBAC_DENIED:verified-actor-not-trusted");
	});

	test("BOTH: secret + verifiedActor -> AGENT_PROOF_CONFLICT", async () => {
		const { t, clioA, taskId } = await world();
		const secret = await mint(t, "org-a", "clio");
		const out = await outcome(
			door.call(asService(t), taskId, "clio", {
				agentCredentialSecret: secret,
				verifiedActor: { agentId: clioA, orgSlug: "org-a" },
			}),
		);
		expect(out).toBe("AGENT_PROOF_CONFLICT");
	});

	test("NEITHER (unchanged): direct member with its valid secret passes the lock", async () => {
		const { t, taskId } = await world();
		const secret = await mint(t, "org-a", "clio");
		const out = await outcome(
			door.call(asMember(t), taskId, "clio", { agentCredentialSecret: secret }),
		);
		expect(PASSED_LOCK).toContain(out);
	});

	test("NEITHER (unchanged): a registered name with no proof -> AGENT_CREDENTIAL_REQUIRED", async () => {
		const { t, taskId } = await world();
		const out = await outcome(door.call(asMember(t), taskId, "clio", {}));
		expect(out).toBe("AGENT_CREDENTIAL_REQUIRED");
	});
});

describe("ORG on a door that names a target org (sendMessage tenantId)", () => {
	test("service account, tenantId org-b, verifiedActor org-a -> ORG_MISMATCH; tenantId org-a -> accepted", async () => {
		const { t, clioA } = await world();
		const refused = await outcome(
			DOORS[0].call(asService(t), "" as Id<"tasks">, "clio", {
				verifiedActor: { agentId: clioA, orgSlug: "org-a" },
				tenantId: "org-b",
			}),
		);
		expect(refused).toBe("ORG_MISMATCH");
		const accepted = await outcome(
			DOORS[0].call(asService(t), "" as Id<"tasks">, "clio", {
				verifiedActor: { agentId: clioA, orgSlug: "org-a" },
				tenantId: "org-a",
			}),
		);
		expect(PASSED_LOCK).toContain(accepted);
	});
});

describe("R2 — the proof is the row id, never the name string", () => {
	test("rename after the MCP verified: accepted for the NEW name, refused for the OLD", async () => {
		const { t, clioA, taskId } = await world();
		await rawRename(t, clioA, "calliope");
		const proof = { verifiedActor: { agentId: clioA, orgSlug: "org-a" } };
		for (const door of [DOORS[0], DOORS.find((d) => d.name === "tasks:start")!]) {
			expect(PASSED_LOCK).toContain(
				await outcome(door.call(asService(t), taskId, "calliope", proof)),
			);
			expect(await outcome(door.call(asService(t), taskId, "clio", proof))).toBe(
				"AGENT_IDENTITY_MISMATCH",
			);
		}
	});
});

describe("R2 — the comparison is by row, so a label variant of the same row is the same actor", () => {
	test("asserted \"CLIO\" (case variant of the verified row's label) -> accepted; a name string compare would refuse it", async () => {
		const { t, clioA, taskId } = await world();
		const proof = { verifiedActor: { agentId: clioA, orgSlug: "org-a" } };
		for (const door of [DOORS[0], DOORS.find((d) => d.name === "tasks:start")!]) {
			expect(PASSED_LOCK).toContain(
				await outcome(door.call(asService(t), taskId, "CLIO", proof)),
			);
		}
	});
});

describe("HELPER — which masters are trusted for verifiedActor (R3 ruling)", () => {
	const run = async (
		masterSource: "internal" | "operator-admin" | "service-account",
	) => {
		const { t, clioA } = await world();
		return await t.run(async (ctx) =>
			outcome(
				requireAgentCredentialMatch(ctx, undefined, "clio", null, {
					scope: { isMaster: true, masterSource },
					verifiedActor: { agentId: clioA, orgSlug: "org-a" },
				}),
			),
		);
	};
	test("service-account is admitted", async () => {
		expect(await run("service-account")).toBe("NO_ERROR");
	});
	test("internal (the no-identity opt-in) is refused", async () => {
		expect(await run("internal")).toBe("RBAC_DENIED:verified-actor-not-trusted");
	});
	test("operator-admin is refused", async () => {
		expect(await run("operator-admin")).toBe("RBAC_DENIED:verified-actor-not-trusted");
	});
});
