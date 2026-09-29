/// <reference types="vite/client" />
/**
 * convex/__tests__/resourceIdOrgScopeRead.test.ts
 *
 * THE CLASS. A public READ that takes an OPAQUE RESOURCE HANDLE — a document
 * id, or a token that indexes to one row — and returns that row without ever
 * asking whether the row belongs to the caller's organisation. A caller who
 * holds, is given, or guesses a handle reads the row regardless of which tenant
 * owns it. This is a DIFFERENT shape from the caller-supplied-org-argument class
 * closed previously: there is no org string in the arguments to distrust, so the
 * control cannot be "does this caller have an organisation" — it must be "does
 * THIS ROW belong to the caller's organisation".
 *
 * Sites pinned here:
 *   convex/tasks.ts::get                      (v.id("tasks"))
 *   convex/tasks.ts::getById                   (raw string, narrowed by requireId)
 *   convex/missions.ts::get                    (raw string, narrowed by requireId)
 *   convex/iframeEmbedSessions.ts::getSession  (opaque sessionId token)
 *
 * THE CONTROL, and the DECISION ON A ROW THAT CARRIES NO ORGANISATION.
 *
 * `isRowVisibleToScope` (convex/lib/auth.ts) is the single helper. For a
 * non-master caller with a verified org it applies, in order:
 *   (1) no verified organisation at all -> DENY;
 *   (2) the row states an `orgId` that differs from the caller's own resolved
 *       org -> DENY. This is the cross-tenant pole, and it is a hard deny.
 *   (3) the row states NO `orgId` -> it is NOT granted by that absence. It must
 *       still pass `filterByOrgScope`, the orchestrator-roster control that IS
 *       the authority the COLLECTION reads (`tasks.list`, `missions.list`) apply
 *       to these same two tables today.
 *
 * Why (3) is a fall-back to the roster and not a flat denial, stated explicitly
 * because the brief requires this case be decided in writing: `tasks.create`
 * writes NO `orgId` at all (it accepts none — see the args validator — and
 * `insertTask` stamps none), so EVERY task created through the public path
 * carries `orgId === undefined`. A flat denial on absent `orgId` would therefore
 * make every task unreadable by every ordinary org-scoped caller through `get`
 * while remaining visible through `list` — a WITHHELD GRANT across the whole
 * table, which is the direction the previous delivery's reviewer found nobody
 * had asserted. Deferring to the roster makes `get` admit EXACTLY what `list`
 * admits: no new grant, and no lost one.
 *
 * NAMED AND NOT CLOSED HERE: because `tasks.create`/`missions.create` stamp no
 * `orgId`, leg (2) is inert for newly-created rows and leg (3) carries the load
 * for them. Two orgs whose `client_org_mapping` rosters overlap on the same
 * orchestrator name can therefore still reach each other's orgId-less rows
 * through the roster leg — exactly as they already can through `list`. That is a
 * WRITE-PATH gap (the row is never stamped with its tenant), it is pre-existing
 * and unchanged by this delivery, and it stays ACCUSED. Closing it means
 * deriving and stamping `orgId` from the verified scope at create time on both
 * tables, plus a backfill — a write-path change outside this brief.
 *
 * `iframeEmbedSessions.getSession` takes the OPPOSITE decision on the same
 * question, and deliberately: a row with no `tenantId` is MASTER-ONLY there.
 * That is not a new rule — it is exactly what `isTenantAllowedForScope` already
 * enforces for `touchSession`/`revokeSession` in that same module, and a READ
 * that were more permissive than the WRITE on the identical row would be the
 * hole. No second authority is introduced; the read joins the existing one.
 *
 * EVERY POLE RUNS UNDER AN ORDINARY SCOPED IDENTITY, except the poles explicitly
 * labelled master regression. A suite authenticating as
 * `CLERK_SERVICE_ACCOUNT_USER_ID` ("test-service-account-user-id" in
 * vitest.config.ts) passes with the authorization DELETED and proves nothing.
 *
 * BOTH DIRECTIONS ARE ASSERTED AT EVERY SITE — the deny pole AND the allow pole
 * (the withheld grant). A blanket refusal is not a fix.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type OrgScope, isRowVisibleToScope } from "../lib/auth";
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

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const ORDINARY_A = "ordinary-member-of-org-a";
const ORDINARY_A2 = "a-second-ordinary-member-of-org-a";
const ORDINARY_NO_ORG = "ordinary-signed-in-user-with-no-org";

for (const subject of [ORDINARY_A, ORDINARY_A2, ORDINARY_NO_ORG]) {
	if (subject === SERVICE_ACCOUNT_USER_ID) {
		throw new Error(
			`test-integrity: ${subject} must not be the service-account id — ` +
				"these callers must be ORDINARY, never master",
		);
	}
}

/**
 * `allowedOrchestrators: ["sigma"]` — "sigma" is IN the roster, "eta" is OUT.
 * Both legs of the control are therefore reachable from the same fixture.
 */
async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const asOrgMember = (
	t: ReturnType<typeof createT>,
	subject: string,
	orgSlug: string,
) =>
	t.withIdentity({
		subject,
		organizationId: orgSlug,
		organizationSlug: orgSlug,
	} as Parameters<typeof t.withIdentity>[0]);

const asNoOrg = (t: ReturnType<typeof createT>) =>
	t.withIdentity({ subject: ORDINARY_NO_ORG } as Parameters<
		typeof t.withIdentity
	>[0]);

const asMaster = (t: ReturnType<typeof createT>) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Parameters<
		typeof t.withIdentity
	>[0]);

// `orgId` is written directly here rather than through `tasks.create`, because
// `create` accepts no `orgId` argument and stamps none — see the header note on
// what stays accused. Rows that DO carry an `orgId` reach the table through the
// OKF bundle import path, which is the population the cross-tenant pole below
// is about.
async function seedTask(
	t: ReturnType<typeof createT>,
	opts: { orgId?: string; assignedTo?: string; title?: string },
): Promise<Id<"tasks">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("tasks", {
			title: opts.title ?? "a task",
			assignedTo: opts.assignedTo ?? "sigma",
			createdBy: opts.assignedTo ?? "sigma",
			priority: "low",
			status: "todo",
			...(opts.orgId === undefined ? {} : { orgId: opts.orgId }),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
}

async function seedMission(
	t: ReturnType<typeof createT>,
	opts: { orgId?: string; pilot?: string; name?: string },
): Promise<Id<"missions">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("missions", {
			name: opts.name ?? "a mission",
			project: "p",
			status: "execute",
			priority: "low",
			pilot: opts.pilot ?? "sigma",
			agents: [],
			createdBy: opts.pilot ?? "sigma",
			...(opts.orgId === undefined ? {} : { orgId: opts.orgId }),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
}

async function seedSession(
	t: ReturnType<typeof createT>,
	opts: { sessionId: string; tenantId?: string },
) {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("iframeEmbedSessions", {
			sessionId: opts.sessionId,
			...(opts.tenantId === undefined ? {} : { tenantId: opts.tenantId }),
			origin: "https://example.test",
			createdAt: now,
			lastSeenAt: now,
			expiresAt: now + 60_000,
			revoked: false,
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// convex/tasks.ts::get — v.id("tasks")
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks:get — authorisation derived from the TARGET ROW's organisation", () => {
	test("DENY — org A cannot read a task stamped with org B's orgId", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		const taskId = await seedTask(t, {
			orgId: "org-b",
			title: "org-b private task",
		});

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(api.tasks.get, {
			taskId,
		});

		expect(row).toBeNull();
	});

	test("DENY — a signed-in caller with NO verified organisation reads nothing", async () => {
		const t = createT();
		const taskId = await seedTask(t, { orgId: "org-a" });

		const row = await asNoOrg(t).query(api.tasks.get, { taskId });

		expect(row).toBeNull();
	});

	test("DENY — an anonymous caller (no credential at all) reads nothing", async () => {
		const t = createT();
		const taskId = await seedTask(t, { orgId: "org-a" });

		const row = await t.query(api.tasks.get, { taskId });

		expect(row).toBeNull();
	});

	test("DENY — an orgId-less row whose orchestrator is OUTSIDE the caller's roster is refused", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const taskId = await seedTask(t, { assignedTo: "eta" });

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(api.tasks.get, {
			taskId,
		});

		expect(row).toBeNull();
	});

	test("ALLOW — org A DOES read its own task (the withheld-grant direction)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const taskId = await seedTask(t, {
			orgId: "org-a",
			title: "org-a own task",
		});

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(api.tasks.get, {
			taskId,
		});

		expect(row?.title).toBe("org-a own task");
	});

	// DOCTRINE INVERSION — this test previously asserted the OPPOSITE (an
	// orgId-less row inside the caller's roster "stays readable"). That
	// assertion WAS the multi-tenant hole written down as an expectation: it
	// made an unstamped row readable on the strength of a shared orchestrator
	// NAME, so two orgs whose rosters both carry "sigma" reached each other's
	// rows. The row's absent `orgId` now asserts nothing and grants nothing.
	test("DENY — an orgId-less row is readable by NO org caller, however the roster reads (get and list agree)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		// Seeded under the SERVICE ACCOUNT, i.e. a master write: stamps no
		// tenant. This is the legacy/fleet row shape, reproduced exactly.
		const taskId = await seedTask(t, {
			assignedTo: "sigma",
			title: "legacy unstamped task",
		});

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(api.tasks.get, {
			taskId,
		});

		// "sigma" IS in org-a's roster — the old grant path. It no longer grants.
		expect(row).toBeNull();
		// The same row must also be absent from the COLLECTION read — the two
		// surfaces agreeing is the property, not `get` alone.
		const listed = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.tasks.list,
			{},
		);
		expect(
			(listed as Array<{ _id: string }>).map((r) => r._id),
		).not.toContain(taskId);
	});

	// THE WITHHELD-GRANT DIRECTION, pinned deliberately. The row above is not
	// lost — master still reads it, which is what makes the backfill in
	// convex/migrations/backfillOrgIds.ts able to find and stamp it.
	test("the unstamped row is withheld from orgs, NOT destroyed — master still reads it", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const taskId = await seedTask(t, {
			assignedTo: "sigma",
			title: "legacy unstamped task",
		});

		expect(
			await asMaster(t).query(api.tasks.get, { taskId }),
		).not.toBeNull();
	});

	test("identical inputs, identical outputs — two different subjects in org A read the same row identically", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const taskId = await seedTask(t, { orgId: "org-a" });

		const first = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.tasks.get,
			{ taskId },
		);
		const second = await asOrgMember(t, ORDINARY_A2, "org-a").query(
			api.tasks.get,
			{ taskId },
		);

		expect(second).toEqual(first);
		expect(first).not.toBeNull();
	});

	test("master regression — the fleet's own caller still reads any task", async () => {
		const t = createT();
		const taskId = await seedTask(t, { orgId: "org-b", assignedTo: "eta" });

		const row = await asMaster(t).query(api.tasks.get, { taskId });

		expect(row).not.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// convex/tasks.ts::getById — raw string handle, narrowed by requireId.
// This is the site the inventory script USED TO DROP (its args window was cut
// at the word "handler" inside a comment above the args). Same property.
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks:getById — authorisation derived from the TARGET ROW's organisation", () => {
	test("DENY — org A cannot read a task stamped with org B's orgId", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		const taskId = await seedTask(t, {
			orgId: "org-b",
			title: "org-b private task",
		});

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.tasks.getById,
			{ taskId },
		);

		expect(row).toBeNull();
	});

	test("DENY — an anonymous caller reads nothing", async () => {
		const t = createT();
		const taskId = await seedTask(t, { orgId: "org-a" });

		expect(await t.query(api.tasks.getById, { taskId })).toBeNull();
	});

	test("DENY — a caller with NO verified organisation reads nothing", async () => {
		const t = createT();
		const taskId = await seedTask(t, { orgId: "org-a" });

		expect(await asNoOrg(t).query(api.tasks.getById, { taskId })).toBeNull();
	});

	test("ALLOW — org A DOES read its own task", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const taskId = await seedTask(t, {
			orgId: "org-a",
			title: "org-a own task",
		});

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.tasks.getById,
			{ taskId },
		);

		expect(row?.title).toBe("org-a own task");
	});

	test("master regression — the fleet's own caller still reads any task", async () => {
		const t = createT();
		const taskId = await seedTask(t, { orgId: "org-b", assignedTo: "eta" });

		expect(
			await asMaster(t).query(api.tasks.getById, { taskId }),
		).not.toBeNull();
	});

	test("a malformed handle still throws its typed ConvexError, not a null (pre-existing contract preserved)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");

		await expect(
			asOrgMember(t, ORDINARY_A, "org-a").query(api.tasks.getById, {
				taskId: "not-an-id",
			}),
		).rejects.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// convex/missions.ts::get
// ─────────────────────────────────────────────────────────────────────────────

describe("missions:get — authorisation derived from the TARGET ROW's organisation", () => {
	test("DENY — org A cannot read a mission stamped with org B's orgId", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		const missionId = await seedMission(t, {
			orgId: "org-b",
			name: "org-b private mission",
		});

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.missions.get,
			{ missionId },
		);

		expect(row).toBeNull();
	});

	test("DENY — an anonymous caller reads nothing", async () => {
		const t = createT();
		const missionId = await seedMission(t, { orgId: "org-a" });

		expect(await t.query(api.missions.get, { missionId })).toBeNull();
	});

	test("DENY — a caller with NO verified organisation reads nothing", async () => {
		const t = createT();
		const missionId = await seedMission(t, { orgId: "org-a" });

		expect(
			await asNoOrg(t).query(api.missions.get, { missionId }),
		).toBeNull();
	});

	test("DENY — an orgId-less mission whose pilot is OUTSIDE the caller's roster is refused", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const missionId = await seedMission(t, { pilot: "eta" });

		expect(
			await asOrgMember(t, ORDINARY_A, "org-a").query(api.missions.get, {
				missionId,
			}),
		).toBeNull();
	});

	test("ALLOW — org A DOES read its own mission (the withheld-grant direction)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const missionId = await seedMission(t, {
			orgId: "org-a",
			name: "org-a own mission",
		});

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.missions.get,
			{ missionId },
		);

		expect(row?.name).toBe("org-a own mission");
	});

	// DOCTRINE INVERSION — see the tasks-side twin above. Previously asserted
	// that an orgId-less mission inside the roster "stays readable"; that was
	// the hole, and the roster's shared orchestrator name was the whole grant.
	test("DENY — an orgId-less mission is readable by NO org caller, however the roster reads", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const missionId = await seedMission(t, {
			pilot: "sigma",
			name: "legacy unstamped mission",
		});

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.missions.get,
			{ missionId },
		);

		// "sigma" IS in org-a's roster. It no longer grants.
		expect(row).toBeNull();
	});

	test("master regression — the fleet's own caller still reads any mission", async () => {
		const t = createT();
		const missionId = await seedMission(t, { orgId: "org-b", pilot: "eta" });

		expect(
			await asMaster(t).query(api.missions.get, { missionId }),
		).not.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// convex/iframeEmbedSessions.ts::getSession — an opaque TOKEN, not a document
// id. Same class: it indexes to exactly one row carrying that row's own tenant.
// ─────────────────────────────────────────────────────────────────────────────

describe("iframeEmbedSessions:getSession — authorisation derived from the TARGET ROW's tenant", () => {
	test("DENY — org A cannot read org B's session by holding its sessionId", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		await seedSession(t, { sessionId: "sess-b", tenantId: "org-b" });

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.iframeEmbedSessions.getSession,
			{ sessionId: "sess-b" },
		);

		expect(row).toBeNull();
	});

	test("DENY — an anonymous caller reads nothing", async () => {
		const t = createT();
		await seedSession(t, { sessionId: "sess-a", tenantId: "org-a" });

		expect(
			await t.query(api.iframeEmbedSessions.getSession, {
				sessionId: "sess-a",
			}),
		).toBeNull();
	});

	test("DENY — a caller with NO verified organisation reads nothing", async () => {
		const t = createT();
		await seedSession(t, { sessionId: "sess-a", tenantId: "org-a" });

		expect(
			await asNoOrg(t).query(api.iframeEmbedSessions.getSession, {
				sessionId: "sess-a",
			}),
		).toBeNull();
	});

	test("DENY — a tenantId-less session is master-only, matching touchSession/revokeSession on the same row", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedSession(t, { sessionId: "sess-none" });

		const read = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.iframeEmbedSessions.getSession,
			{ sessionId: "sess-none" },
		);
		expect(read).toBeNull();

		// The WRITE on the identical row already refuses. The read must not be
		// more permissive than the write it sits beside.
		await expect(
			asOrgMember(t, ORDINARY_A, "org-a").mutation(
				api.iframeEmbedSessions.touchSession,
				{ sessionId: "sess-none" },
			),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("ALLOW — org A DOES read its own session (the withheld-grant direction)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedSession(t, { sessionId: "sess-a", tenantId: "org-a" });

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.iframeEmbedSessions.getSession,
			{ sessionId: "sess-a" },
		);

		expect(row?.sessionId).toBe("sess-a");
		expect(row?.tenantId).toBe("org-a");
	});

	test("master regression — the fleet's own caller still reads any session", async () => {
		const t = createT();
		await seedSession(t, { sessionId: "sess-b", tenantId: "org-b" });

		expect(
			await asMaster(t).query(api.iframeEmbedSessions.getSession, {
				sessionId: "sess-b",
			}),
		).not.toBeNull();
	});

	test("an expired or revoked session stays null for its OWN org (pre-existing contract preserved)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("iframeEmbedSessions", {
				sessionId: "sess-expired",
				tenantId: "org-a",
				origin: "https://example.test",
				createdAt: now - 10_000,
				lastSeenAt: now - 10_000,
				expiresAt: now - 1,
				revoked: false,
			});
		});

		expect(
			await asOrgMember(t, ORDINARY_A, "org-a").query(
				api.iframeEmbedSessions.getSession,
				{ sessionId: "sess-expired" },
			),
		).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// isRowVisibleToScope — the LEGS, observed one at a time.
//
// WHY THIS BLOCK EXISTS, stated plainly because it was added in response to a
// SURVIVING MUTANT. Deleting leg 2 ("no verified organisation -> not visible")
// left every end-to-end pole above GREEN. The reason is that no scope reachable
// through the public surface has `orgSlug === null` together with a NON-EMPTY
// `allowedOrchestrators`: withOrgScope's anonymous branch and its
// `refuseWithoutThrow` refused branch both return an EMPTY roster, so leg 4
// (`filterByOrgScope`) denied the row anyway and leg 2 was unobservable from
// outside. Leg 2 is therefore genuine defence-in-depth rather than dead code —
// a future synthesised non-master scope carrying a roster and no org (the exact
// shape `listForWebhook` builds, saved there only by `isMaster: true`) would
// otherwise be granted — and it is kept, with a pole that observes IT and
// nothing else. Reported as survived before being tightened; it no longer
// survives.
// ─────────────────────────────────────────────────────────────────────────────

const scopeOf = (over: Partial<OrgScope>): OrgScope => ({
	userId: "u",
	orgSlug: "org-a",
	allowedOrchestrators: ["sigma"],
	scopes: [],
	isMaster: false,
	...over,
});

describe("isRowVisibleToScope — each leg observed alone", () => {
	test("leg 2 alone — no verified organisation is refused even with a POPULATED roster", () => {
		const scope = scopeOf({ orgSlug: null, allowedOrchestrators: ["sigma"] });
		expect(isRowVisibleToScope(scope, { assignedTo: "sigma" })).toBe(false);
		expect(
			isRowVisibleToScope(scope, { orgId: "org-a", assignedTo: "sigma" }),
		).toBe(false);
	});

	test("leg 3 alone — a row stating a DIFFERENT org is refused even when the roster admits it", () => {
		const scope = scopeOf({});
		expect(
			isRowVisibleToScope(scope, { orgId: "org-b", assignedTo: "sigma" }),
		).toBe(false);
	});

	test("leg 4 alone — a row stating the caller's OWN org is refused when the roster does not admit it", () => {
		const scope = scopeOf({});
		expect(
			isRowVisibleToScope(scope, { orgId: "org-a", assignedTo: "eta" }),
		).toBe(false);
	});

	// DOCTRINE INVERSION — previously "a row stating NO org is admitted only by
	// the roster", asserting `{ assignedTo: "sigma" }` was VISIBLE. The absence
	// of a tenant stamp is now a refusal on its own, and no roster entry can
	// convert it into a grant. Both poles of the roster are exercised so the
	// result is shown to be independent of it.
	test("absence alone — a row stating NO org is refused whatever the roster says", () => {
		const scope = scopeOf({});
		// "sigma" IS in the roster — the old grant path — and is still refused.
		expect(isRowVisibleToScope(scope, { assignedTo: "sigma" })).toBe(false);
		// "eta" is NOT in the roster: refused for both reasons at once.
		expect(isRowVisibleToScope(scope, { assignedTo: "eta" })).toBe(false);
		// No orchestrator at all.
		expect(isRowVisibleToScope(scope, {})).toBe(false);
	});

	// THE ROSTER SURVIVES AS A NARROWING INTERSECT, never as a grant. A row
	// that DOES state the caller's org still has to clear the intra-org
	// delegation control; dropping it here would have widened `get` relative to
	// the pre-change behaviour, which is the unearned-grant direction of the
	// very defect this file pins.
	test("tenant gate and roster are BOTH required — same org, roster refuses, row denied", () => {
		const scope = scopeOf({});
		// Same tenant + roster admits -> visible.
		expect(
			isRowVisibleToScope(scope, { orgId: "org-a", assignedTo: "sigma" }),
		).toBe(true);
		// Same tenant + roster refuses -> denied. The roster still narrows.
		expect(
			isRowVisibleToScope(scope, { orgId: "org-a", assignedTo: "eta" }),
		).toBe(false);
	});

	test("leg 1 alone — master is admitted regardless of every other leg", () => {
		const scope = scopeOf({
			isMaster: true,
			orgSlug: null,
			allowedOrchestrators: [],
		});
		expect(
			isRowVisibleToScope(scope, { orgId: "org-b", assignedTo: "eta" }),
		).toBe(true);
	});

	test("ALLOW — the ordinary case: own org, own roster", () => {
		expect(
			isRowVisibleToScope(scopeOf({}), { orgId: "org-a", assignedTo: "sigma" }),
		).toBe(true);
	});
});
