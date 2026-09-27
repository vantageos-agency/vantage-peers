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

	test("ALLOW — an orgId-less row inside the caller's roster stays readable (get is exactly as permissive as list)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const taskId = await seedTask(t, {
			assignedTo: "sigma",
			title: "legacy unstamped task",
		});

		const row = await asOrgMember(t, ORDINARY_A, "org-a").query(api.tasks.get, {
			taskId,
		});

		expect(row?.title).toBe("legacy unstamped task");
		// The same row must also be reachable through the COLLECTION read — the
		// two surfaces agreeing is the property, not `get` alone.
		const listed = await asOrgMember(t, ORDINARY_A, "org-a").query(
			api.tasks.list,
			{},
		);
		expect(
			(listed as Array<{ _id: string }>).map((r) => r._id),
		).toContain(taskId);
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

	test("ALLOW — an orgId-less mission inside the caller's roster stays readable", async () => {
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

		expect(row?.name).toBe("legacy unstamped mission");
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
