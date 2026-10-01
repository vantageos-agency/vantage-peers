/**
 * anonymousReadRefused — `issues:listByStatus` and `messages:listBroadcastStatus`
 * served rows to a caller presenting NO CREDENTIAL AT ALL (measured twice, on
 * the serving deployment, with valid arguments: 50 issue rows with bodies and
 * repo names; a message's sender, channel and 41 read receipts).
 *
 * POSITIVE CONTROL: `missions:list` refuses the same caller with a typed
 * RBAC_DENIED, so the probe can see a refusal. These two did not.
 *
 * A refusal-only corpus is satisfied by an endpoint that refuses EVERYONE, so
 * every door below pins its ALLOW pole too:
 *
 *   messages:listBroadcastStatus (gate: membership of the message's own channel)
 *     - anonymous                                  -> RAISES RBAC_DENIED
 *     - signed in, no organisation                 -> RAISES RBAC_DENIED
 *     - org-b member, message of org-a             -> RAISES (cross-tenant)
 *     - org-a member, NOT on the message's channel -> RAISES (not-on-channel)
 *     - org-a member ON the channel                -> receives the receipts
 *     - fleet master                               -> receives the receipts
 *
 *   issues:listByStatus (gate: fleet master only — see the endpoint's comment)
 *     - anonymous / no org / ordinary member of ANY org -> RAISES RBAC_DENIED
 *     - fleet master over seeded rows -> rows; over an empty table -> a genuine
 *       empty success (an absence stays an absence)
 *
 * Every DENY pole is an ORDINARY caller. `asMaster` appears only in ALLOW poles.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const MEMBER_A = "ordinary-member-of-org-a";
const MEMBER_B = "ordinary-member-of-org-b";
const NO_ORG = "ordinary-signed-in-user-with-no-org";

for (const subject of [MEMBER_A, MEMBER_B, NO_ORG]) {
	if (subject === SERVICE_ACCOUNT_USER_ID) {
		throw new Error(`test-integrity: ${subject} must not be the service account`);
	}
}

const asMember = (t: T, orgSlug: string, subject: string) =>
	t.withIdentity({
		subject,
		organizationId: orgSlug,
		organizationSlug: orgSlug,
	} as Identity);
const asNoOrg = (t: T) => t.withIdentity({ subject: NO_ORG } as Identity);
const asMaster = (t: T) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Identity);

async function expectRefusal(
	read: () => Promise<unknown>,
	registration: string,
	reason: string,
): Promise<void> {
	let caught: unknown;
	let returned: unknown;
	let didThrow = false;
	try {
		returned = await read();
	} catch (e) {
		didThrow = true;
		caught = e;
	}
	if (!didThrow) {
		throw new Error(
			`${registration} returned a SUCCESS to a caller it must refuse (${reason}). Got: ${JSON.stringify(returned)}`,
		);
	}
	expect(caught, `${registration}: refusal must be a ConvexError`).toBeInstanceOf(
		ConvexError,
	);
	const data = String((caught as ConvexError<string>).data);
	expect(data, `${registration}: must carry its CODE`).toContain("RBAC_DENIED");
	expect(data, `${registration}: must name its DOOR`).toContain(registration);
	// The structured payload is the contract: parse the JSON tail after " — ".
	// convex-test may hand `data` back JSON-quoted; unquote before slicing.
	const text = data.startsWith('"') ? (JSON.parse(data) as string) : data;
	const payload = JSON.parse(text.slice(text.lastIndexOf(" — ") + 3)) as {
		registration: string;
		reason: string;
	};
	expect(payload.registration).toBe(registration);
	expect(payload.reason, `${registration}: wrong refusal reason`).toBe(reason);
}

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

async function seedMessage(
	t: T,
	tenantId: string,
	channel: string,
	recipients: string[],
): Promise<Id<"messages">> {
	return await t.run(async (ctx) => {
		const id = await ctx.db.insert("messages", {
			from: "pi",
			tenantId,
			channel,
			content: "x",
			createdAt: Date.now(),
		});
		for (const recipient of recipients) {
			await ctx.db.insert("messageReceipts", {
				messageId: id,
				recipient,
				tenantId,
				readAt: recipient === recipients[0] ? Date.now() : undefined,
			});
		}
		return id;
	});
}

const seedIssue = (t: T) =>
	t.run(async (ctx) => {
		await ctx.db.insert("issues", {
			repo: "acme/secret-repo",
			issueNumber: 1,
			title: "private title",
			body: "private body",
			htmlUrl: "https://example.invalid/1",
			labels: [],
			status: "open",
			priority: "high",
			assignedOrchestrator: "sigma",
			project: "secret-project",
			githubCreatedAt: Date.now(),
			githubUpdatedAt: Date.now(),
		});
	});

// ─────────────────────────────────────────────────────────────────────────────
describe("messages:listBroadcastStatus", () => {
	const REG = "messages:listBroadcastStatus";

	async function world() {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		await seedOrg(t, "org-b", ["tau"]);
		// org-a message on a channel org-a's roster contains
		const onChannel = await seedMessage(t, "org-a", "sigma", ["sigma", "pi"]);
		// org-a message on a channel org-a's roster does NOT contain
		const offChannel = await seedMessage(t, "org-a", "tau", ["tau", "pi"]);
		return { t, onChannel, offChannel };
	}

	test("anonymous + valid arguments is REFUSED with RBAC_DENIED naming its door", async () => {
		const { t, onChannel } = await world();
		await expectRefusal(
			() => t.query(api.messages.listBroadcastStatus, { messageId: onChannel }),
			REG,
			"no-credential",
		);
	});

	test("a signed-in caller with no organisation is REFUSED", async () => {
		const { t, onChannel } = await world();
		await expectRefusal(
			() =>
				asNoOrg(t).query(api.messages.listBroadcastStatus, {
					messageId: onChannel,
				}),
			REG,
			"no-verified-organisation",
		);
	});

	test("a member of a DIFFERENT organisation (org-b) is REFUSED with the cross-tenant code", async () => {
		const { t, onChannel } = await world();
		await expectRefusal(
			() =>
				asMember(t, "org-b", MEMBER_B).query(api.messages.listBroadcastStatus, {
					messageId: onChannel,
				}),
			REG,
			"cross-tenant",
		);
	});

	test("an org-a member who is NOT on the message's channel is REFUSED — authenticated is not enough", async () => {
		const { t, offChannel } = await world();
		await expectRefusal(
			() =>
				asMember(t, "org-a", MEMBER_A).query(api.messages.listBroadcastStatus, {
					messageId: offChannel,
				}),
			REG,
			"not-on-channel",
		);
	});

	test("an org-a member ON the message's channel RECEIVES the receipts", async () => {
		const { t, onChannel } = await world();
		const r = await asMember(t, "org-a", MEMBER_A).query(
			api.messages.listBroadcastStatus,
			{ messageId: onChannel },
		);
		expect(r.channel).toBe("sigma");
		expect(r.receipts.map((x) => x.recipient).sort()).toEqual(["pi", "sigma"]);
		expect(r.receipts.find((x) => x.recipient === "sigma")?.read).toBe(true);
	});

	test("the fleet master RECEIVES the receipts (allow pole only)", async () => {
		const { t, offChannel } = await world();
		const r = await asMaster(t).query(api.messages.listBroadcastStatus, {
			messageId: offChannel,
		});
		expect(r.receipts).toHaveLength(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("issues:listByStatus", () => {
	const REG = "issues:listByStatus";

	test("anonymous + valid arguments is REFUSED with RBAC_DENIED naming its door", async () => {
		const t = createT();
		await seedIssue(t);
		await expectRefusal(
			() => t.query(api.issues.listByStatus, { status: "open" }),
			REG,
			"no-credential",
		);
	});

	test("a signed-in caller with no organisation is REFUSED", async () => {
		const t = createT();
		await seedIssue(t);
		await expectRefusal(
			() => asNoOrg(t).query(api.issues.listByStatus, { status: "open" }),
			REG,
			"no-verified-organisation",
		);
	});

	test("ordinary members of org-a AND org-b are REFUSED — the table has no org column, so no org is entitled", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		await seedOrg(t, "org-b", ["tau"]);
		await seedIssue(t);
		for (const [org, who] of [
			["org-a", MEMBER_A],
			["org-b", MEMBER_B],
		] as const) {
			await expectRefusal(
				() =>
					asMember(t, org, who).query(api.issues.listByStatus, {
						status: "open",
					}),
				REG,
				"not-fleet-master",
			);
		}
	});

	test("the fleet master RECEIVES the rows (PRESENT)", async () => {
		const t = createT();
		await seedIssue(t);
		const rows = await asMaster(t).query(api.issues.listByStatus, {
			status: "open",
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].repo).toBe("acme/secret-repo");
	});

	test("the fleet master over an EMPTY table gets an empty SUCCESS (ABSENT stays an absence)", async () => {
		const t = createT();
		const rows = await asMaster(t).query(api.issues.listByStatus, {
			status: "open",
		});
		expect(rows).toEqual([]);
	});
});
