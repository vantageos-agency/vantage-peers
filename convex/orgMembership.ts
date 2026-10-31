import {
	clerkMembershipEvent,
	decideMembershipEvent,
	hasFleetRead,
	planMembershipReconcile,
	sameOrg,
} from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
	internalAction,
	internalMutation,
	type MutationCtx,
	query,
} from "./_generated/server";
import {
	lookupOrgMapping,
	requireResolvedCaller,
	withOrgScope,
} from "./lib/auth";
import { orgRefOfScope } from "./lib/authOrgMapping";
import { clerkOrgIdForSlug } from "./lib/orgClerkId";

// ─────────────────────────────────────────────────────────────────────────────
// orgMembership — who belongs to which organisation, kept live from Clerk.
// Task k17a7t4a9d4hx11sgj2tcdf7kx8et4cp (audit record), then
// k1778c2hvae8e8vz9f5bbbbbb98g62hw item 4a (live source).
//
// The decisions (signature, event parsing, ordering, reconcile plan) are the
// package's (`@vantageos/cloud-identity` 0.21.6); this file reads and writes rows.
//
// Written by: provisioning (`upsertAdminMembership`), the Clerk webhook
// `POST /clerk/webhook` (`applyClerkMembershipEvent`, convex/http.ts) and the
// one-time `backfillFromClerk`. Read as an authorisation source by exactly one
// consumer: `ownerMembershipLookups` (convex/lib/actingPrincipal.ts), the
// "is the agent's owner an active member of the agent's org" lookup.
//
// STILL NEVER the source of org-admin status: `requireOrgAdmin`
// (convex/lib/auth.ts) keeps deciding admin status from the verified
// `org_role` JWT claim. See the table comment in convex/schema.ts.
// ─────────────────────────────────────────────────────────────────────────────

const membershipShape = v.object({
	clerkOrgSlug: v.string(),
	clerkUserId: v.string(),
	role: v.union(v.literal("admin"), v.literal("member")),
	createdAt: v.number(),
	updatedAt: v.number(),
});

/** A tombstoned row (deletedAt set) is a removed member, not a member. */
function isLive(row: { deletedAt?: number }): boolean {
	return row.deletedAt === undefined;
}

function toShape(row: {
	clerkOrgSlug: string;
	clerkUserId: string;
	role: "admin" | "member";
	createdAt: number;
	updatedAt: number;
}) {
	return {
		clerkOrgSlug: row.clerkOrgSlug,
		clerkUserId: row.clerkUserId,
		role: row.role,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// upsertAdminMembership — the ONE write path onto orgMembership. Called
// exclusively from convex/oauth.ts's `provisionOrganization`, org-admin
// path (a verified human subject exists there; the master/callerToken path
// records nothing — see that mutation's comment and the PR body "Why").
//
// Idempotent: provisioning the same org twice (the mutation's replay
// branch) must leave exactly one row for (clerkOrgSlug, clerkUserId), never
// a duplicate — looked up by the `by_org_user` index with `.unique()`.
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertAdminMembership(
	ctx: MutationCtx,
	clerkOrgSlug: string,
	clerkUserId: string,
): Promise<void> {
	const now = Date.now();
	const existing = await ctx.db
		.query("orgMembership")
		.withIndex("by_org_user", (q) =>
			q.eq("clerkOrgSlug", clerkOrgSlug).eq("clerkUserId", clerkUserId),
		)
		.unique();

	if (existing) {
		// A tombstoned row is revived: provisioning is driven by a verified
		// org-admin session, a present fact. The event time stays as it was.
		if (existing.role !== "admin" || existing.deletedAt !== undefined) {
			await ctx.db.patch(existing._id, {
				role: "admin",
				deletedAt: undefined,
				updatedAt: now,
			});
		}
		return;
	}

	await ctx.db.insert("orgMembership", {
		clerkOrgSlug,
		clerkOrgId: await clerkOrgIdForSlug(ctx, clerkOrgSlug),
		clerkUserId,
		role: "admin",
		createdAt: now,
		updatedAt: now,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// getMembership — answers BOTH directions, authorised from the VERIFIED
// identity only (withOrgScope), never from a caller-supplied argument
// naming who is asking.
//
//   args.clerkOrgSlug present  → "who administers/belongs to org X". X is a
//     LABEL: it is resolved to its mapping row and read BY THE ORG'S
//     PERMANENT ID (`by_org_clerk_id`); the caller's own org is compared by
//     ID too. A row stamped with a label only (no org ID yet) is not served
//     until `backfill_org_clerk_id` fills it.
//     Master / service-account (scope.isMaster) may ask about ANY
//     organisation. An org-scoped caller may ask ONLY about its OWN
//     organisation (same org ID) — asking about any
//     other org is refused with RBAC_DENIED, not an empty list, so there is
//     no existence oracle.
//
//   args.clerkOrgSlug absent   → "which orgs does the CALLER belong to",
//     keyed on the caller's own verified subject (scope.userId) — never a
//     caller-supplied clerkUserId.
//
// An anonymous caller (no verified identity at all — withOrgScope's
// fail-closed default) is refused with RBAC_DENIED BEFORE any db read, so
// there is no existence oracle on that path either.
//
// BOUND — both reads below are catalog-scale (one row per org-admin per
// org — the same scale as `client_org_mapping`/`oauth_scope_profiles`,
// never per-memory or per-message volume), so a bounded read at this
// rare, admin/audit-only surface is the correct tool, mirroring
// `findSeatNameCollision`'s `SEAT_NAME_COLLISION_SCAN_LIMIT` discipline in
// convex/oauth.ts. `.take(MEMBERSHIP_QUERY_LIMIT)` replaces `.collect()`;
// hitting the limit exactly means rows beyond it were never read —
// silently returning a partial membership list in that case would
// misinform an admin/audit caller about who actually holds an org, so
// this throws `MEMBERSHIP_QUERY_INCOMPLETE` instead of resolving a
// truncated array.
// ─────────────────────────────────────────────────────────────────────────────
// Exported so the test suite seeds exactly this many rows to prove the
// MEMBERSHIP_QUERY_INCOMPLETE refusal fires, rather than hard-coding 1000
// in two places that could silently drift apart.
export const MEMBERSHIP_QUERY_LIMIT = 1000;

function assertNotTruncated(rowCount: number, describe: string): void {
	if (rowCount === MEMBERSHIP_QUERY_LIMIT) {
		throw new ConvexError(
			`MEMBERSHIP_QUERY_INCOMPLETE: orgMembership read for ${describe} hit its ${MEMBERSHIP_QUERY_LIMIT}-row bound before finishing — refusing to return a truncated membership list`,
		);
	}
}

export const getMembership = query({
	args: { clerkOrgSlug: v.optional(v.string()) },
	returns: v.array(membershipShape),
	handler: async (ctx, args) => {
		// isolation-contract: no reactive subscriber exists — enumerated at /root/coding/vantage-peers-dashboard@71da625 with `grep -rn 'api\.orgMembership\.getMembership' --include=*.tsx --include=*.ts app components hooks lib contexts providers` -> 0 matches. Only the dashboard was enumerated; other callers were not individually traced. R-50 declared divergence (a claim, verified against that enumeration).
		// R-50: reactively-subscribed public query — refuseWithoutThrow
		// narrows the signed-in-no-org branch to a typed refused scope
		// instead of a throw. The pre-existing anonymous-caller throw below
		// is UNCHANGED (out of this brief's scope, a distinct caller class).
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });

		// A caller presenting no credential at all is refused by RAISING, before
		// any db.query call (`requireResolvedCaller`: the one refusal helper).
		requireResolvedCaller(scope, "orgMembership:getMembership");

		// A signed-in caller with no organisation yet (scope.refused) has no
		// "own org" to compare against — a typed empty result, not a throw,
		// regardless of which org (if any) was requested.
		if (scope.refused) {
			return [];
		}

		if (args.clerkOrgSlug !== undefined) {
			// The argument is a LABEL naming the org to read. It is resolved to its
			// mapping row and the two organisations are compared by their permanent
			// IDs (`sameOrg`): a member of a NEW org that took a freed slug is not a
			// member of the org the stale label used to name, and a renamed org keeps
			// its members. The service account and the operator admin (master) may
			// read any org.
			const target = await lookupOrgMapping(ctx, args.clerkOrgSlug);
			if (
				!hasFleetRead(scope) &&
				!(
					target?.isActive === true &&
					sameOrg({ id: target.clerkOrgId }, orgRefOfScope(scope))
				)
			) {
				throw new ConvexError(
					`RBAC_DENIED: caller may only read membership for its own organisation — ${JSON.stringify(
						{ requested: args.clerkOrgSlug, reason: "not-own-organisation" },
					)}`,
				);
			}
			// An org no mapping holds, or one with no ID yet, has no members to name.
			const targetOrgId = target?.clerkOrgId;
			if (targetOrgId === undefined) return [];
			// Narrow before bound: the read is keyed on the org ID.
			const rows = await ctx.db
				.query("orgMembership")
				.withIndex("by_org_clerk_id", (q) => q.eq("clerkOrgId", targetOrgId))
				.take(MEMBERSHIP_QUERY_LIMIT);
			assertNotTruncated(rows.length, `org "${args.clerkOrgSlug}"`);
			return rows.filter(isLive).map(toShape);
		}

		const rows = await ctx.db
			.query("orgMembership")
			.withIndex("by_user", (q) => q.eq("clerkUserId", scope.userId))
			.take(MEMBERSHIP_QUERY_LIMIT);
		assertNotTruncated(rows.length, `subject "${scope.userId}"`);
		return rows.filter(isLive).map(toShape);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Clerk-driven sync. Keyed by (clerkOrgId, clerkUserId) — the permanent Clerk
// ids — through `by_org_user_clerk_id`. The slug is a renamable label, stored
// from the payload and refreshed when it changes.
//
// A replayed state is refused as stale by the package's decision
// (`decideMembershipEvent`), so the writers below patch what it decided and
// compare nothing locally. A row is found by org id and person id only: a row
// written at provisioning with no `clerkOrgId` is not adopted by slug.
// ─────────────────────────────────────────────────────────────────────────────

export type UpsertOutcome = "inserted" | "updated";

type MembershipArgs = {
	clerkOrgId: string;
	clerkUserId: string;
};

/**
 * The row for (org id, user id), tombstoned or not. A miss is a miss: there is
 * no lookup by slug. A plain indexed read: no decision is made here.
 */
async function findMembershipRow(
	ctx: Pick<MutationCtx, "db">,
	args: { clerkOrgId: string; clerkUserId: string },
) {
	return await ctx.db
		.query("orgMembership")
		.withIndex("by_org_user_clerk_id", (q) =>
			q.eq("clerkOrgId", args.clerkOrgId).eq("clerkUserId", args.clerkUserId),
		)
		.unique();
}

type MembershipDoc = NonNullable<Awaited<ReturnType<typeof findMembershipRow>>>;

/**
 * WRITE an upsert the package already decided to apply (`decideMembershipEvent`
 * or `planMembershipReconcile`). Revives a tombstone. The decided state is
 * patched as it is; `lastEventAt` advances so the ordering guard stays exact.
 */
async function writeMembershipUpsert(
	ctx: MutationCtx,
	existing: MembershipDoc | null,
	args: MembershipArgs & { clerkOrgSlug: string; role: "admin" | "member" },
	opts: { eventAt: number; dryRun?: boolean },
): Promise<UpsertOutcome> {
	const now = Date.now();
	if (existing === null) {
		if (!opts.dryRun) {
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: args.clerkOrgSlug,
				clerkOrgId: args.clerkOrgId,
				clerkUserId: args.clerkUserId,
				role: args.role,
				createdAt: now,
				updatedAt: now,
				lastEventAt: opts.eventAt,
			});
		}
		return "inserted";
	}
	if (!opts.dryRun) {
		await ctx.db.patch(existing._id, {
			role: args.role,
			clerkOrgSlug: args.clerkOrgSlug,
			deletedAt: undefined,
			lastEventAt: opts.eventAt,
			updatedAt: now,
		});
	}
	return "updated";
}

/**
 * WRITE a tombstone the package already decided to apply: the row is kept (role
 * included) with `deletedAt` set. With no row at all a tombstone is inserted, so
 * a `created` that arrives after its own `deleted` is still refused as stale.
 * The label is the payload's slug, else the existing row's, else "" (never a
 * real slug).
 */
async function writeMembershipTombstone(
	ctx: MutationCtx,
	existing: MembershipDoc | null,
	args: MembershipArgs & { clerkOrgSlug?: string },
	opts: { eventAt: number; dryRun?: boolean },
): Promise<"removed" | "absent"> {
	const now = Date.now();
	if (!opts.dryRun) {
		// Half A (task k17fxe8feeq1k2rb1ggj76e97s8h7m7k): the removal reaches the
		// member's tokens in the same transaction. Idempotent, so a replayed or
		// pre-recorded tombstone revokes again harmlessly.
		await ctx.runMutation(internal.oauth.revokeMemberTokens, {
			userId: args.clerkUserId,
			clerkOrgId: args.clerkOrgId,
		});
	}
	if (existing === null) {
		if (!opts.dryRun) {
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: args.clerkOrgSlug ?? "",
				clerkOrgId: args.clerkOrgId,
				clerkUserId: args.clerkUserId,
				role: "member",
				createdAt: now,
				updatedAt: now,
				lastEventAt: opts.eventAt,
				deletedAt: opts.eventAt,
			});
		}
		return "absent";
	}
	if (!opts.dryRun) {
		await ctx.db.patch(existing._id, {
			deletedAt: opts.eventAt,
			lastEventAt: opts.eventAt,
			updatedAt: now,
		});
	}
	return "removed";
}

/**
 * One Clerk `organizationMembership.*` event, already signature-verified and
 * parsed (`verifySvixWebhook`, `clerkMembershipEvent`) by the HTTP route. This
 * mutation reads the row, asks the package whether the event applies
 * (`decideMembershipEvent`) and writes what it answered.
 */
export const applyClerkMembershipEvent = internalMutation({
	args: {
		kind: v.union(v.literal("upsert"), v.literal("delete")),
		clerkOrgId: v.string(),
		clerkOrgSlug: v.optional(v.string()),
		clerkUserId: v.string(),
		// Already mapped by `clerkMembershipEvent` (`org:admin` is admin).
		role: v.union(v.literal("admin"), v.literal("member")),
		// Event time in ms, as `clerkMembershipEvent` timed it.
		eventAt: v.number(),
	},
	returns: v.union(
		v.literal("inserted"),
		v.literal("updated"),
		v.literal("removed"),
		v.literal("absent"),
		v.literal("stale"),
	),
	handler: async (ctx, args) => {
		const existing = await findMembershipRow(ctx, args);
		const { apply } = decideMembershipEvent(existing, {
			kind: args.kind,
			eventAt: args.eventAt,
		});
		if (!apply) return "stale";
		if (args.kind === "delete") {
			return await writeMembershipTombstone(ctx, existing, args, {
				eventAt: args.eventAt,
			});
		}
		if (args.clerkOrgSlug === undefined) {
			throw new ConvexError(
				"CLERK_MEMBERSHIP_SLUG_REQUIRED: an upsert needs the organisation slug from the payload",
			);
		}
		return await writeMembershipUpsert(
			ctx,
			existing,
			{
				clerkOrgId: args.clerkOrgId,
				clerkOrgSlug: args.clerkOrgSlug,
				clerkUserId: args.clerkUserId,
				role: args.role,
			},
			{ eventAt: args.eventAt },
		);
	},
});

// Bounds for the backfill. A page is Clerk's maximum; an organisation larger
// than MAX_MEMBERS_PER_ORG is reported as failed (not read in full), never
// partially reconciled.
const CLERK_PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const MAX_MEMBERS_PER_ORG = 4000;

/**
 * Apply the plan `planMembershipReconcile` made for ONE organisation whose full
 * member list the action read to the end. The stored rows are read here, the
 * decision (upsert, tombstone, leave alone) is the package's, the writes are
 * this table's.
 */
export const reconcileOrgFromClerk = internalMutation({
	args: {
		clerkOrgId: v.string(),
		clerkOrgSlug: v.string(),
		members: v.array(
			v.object({
				userId: v.string(),
				role: v.union(v.literal("admin"), v.literal("member")),
			}),
		),
		dryRun: v.boolean(),
		// The backfill's own time (ms): the event time of everything it applies.
		eventAt: v.number(),
	},
	returns: v.object({ upserted: v.number(), removed: v.number() }),
	handler: async (ctx, args) => {
		const stored = await ctx.db
			.query("orgMembership")
			.withIndex("by_org_clerk_id", (q) => q.eq("clerkOrgId", args.clerkOrgId))
			.take(MAX_MEMBERS_PER_ORG + 1);
		if (stored.length > MAX_MEMBERS_PER_ORG) {
			throw new ConvexError(
				`MEMBERSHIP_QUERY_INCOMPLETE: org ${args.clerkOrgId} holds more than ${MAX_MEMBERS_PER_ORG} stored rows — refusing to reconcile a partial read`,
			);
		}
		const plan = planMembershipReconcile(
			stored.map((r) => ({
				orgId: args.clerkOrgId,
				personId: r.clerkUserId,
				role: r.role,
				lastEventAt: r.lastEventAt,
				deletedAt: r.deletedAt,
			})),
			args.members.map((m) => ({
				orgId: args.clerkOrgId,
				personId: m.userId,
				role: m.role,
				orgSlug: args.clerkOrgSlug,
			})),
			{ at: args.eventAt, fullyReadOrgIds: [args.clerkOrgId] },
		);
		let upserted = 0;
		for (const u of plan.upserts) {
			await writeMembershipUpsert(
				ctx,
				await findMembershipRow(ctx, {
					clerkOrgId: u.orgId,
					clerkUserId: u.personId,
				}),
				{
					clerkOrgId: u.orgId,
					clerkOrgSlug: args.clerkOrgSlug,
					clerkUserId: u.personId,
					role: u.role,
				},
				{ eventAt: u.eventAt, dryRun: args.dryRun },
			);
			upserted++;
		}
		for (const t of plan.tombstones) {
			await writeMembershipTombstone(
				ctx,
				await findMembershipRow(ctx, {
					clerkOrgId: t.orgId,
					clerkUserId: t.personId,
				}),
				{ clerkOrgId: t.orgId, clerkUserId: t.personId },
				{ eventAt: t.eventAt, dryRun: args.dryRun },
			);
		}
		return { upserted, removed: plan.tombstones.length };
	},
});

type ClerkPage = { data?: unknown[]; total_count?: number };

async function clerkGet(
	path: string,
	params: Record<string, string>,
	secretKey: string,
): Promise<unknown[]> {
	const url = new URL(`https://api.clerk.com${path}`);
	for (const [k, val] of Object.entries(params)) url.searchParams.set(k, val);
	const res = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${secretKey}` },
	});
	// The status is named, the key and the response body never are.
	if (!res.ok) throw new Error(`Clerk API ${path} answered HTTP ${res.status}`);
	const json = (await res.json()) as ClerkPage | unknown[];
	return Array.isArray(json) ? json : (json.data ?? []);
}

async function clerkReadAll(
	path: string,
	secretKey: string,
	limit: number,
): Promise<unknown[]> {
	const all: unknown[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const items = await clerkGet(
			path,
			{
				limit: String(CLERK_PAGE_SIZE),
				offset: String(page * CLERK_PAGE_SIZE),
			},
			secretKey,
		);
		all.push(...items);
		if (items.length < CLERK_PAGE_SIZE) return all;
		if (all.length > limit) {
			throw new Error(`${path} returned more than ${limit} items`);
		}
	}
	throw new Error(`${path} did not end within ${MAX_PAGES} pages`);
}

/**
 * One-time backfill of orgMembership from the Clerk Backend API. DRY RUN BY
 * DEFAULT: pass `{ dryRun: false }` to write. Removal happens only for an
 * organisation whose full member list was read (a member Clerk no longer
 * reports becomes a tombstone, never a hard delete); an organisation whose read
 * failed is left untouched and named in `failedOrgs`.
 */
export const backfillFromClerk = internalAction({
	args: { dryRun: v.optional(v.boolean()) },
	returns: v.object({
		dryRun: v.boolean(),
		orgs: v.number(),
		memberships: v.number(),
		upserted: v.number(),
		removed: v.number(),
		failedOrgs: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const secretKey = process.env.CLERK_SECRET_KEY;
		if (!secretKey) {
			throw new ConvexError(
				"CLERK_SECRET_KEY is not set — refusing to read Clerk memberships",
			);
		}
		// One time for the whole run, taken before the first read: a webhook event
		// stamped after it is newer than what this run saw and wins.
		const eventAt = Date.now();
		const orgs = (await clerkReadAll("/v1/organizations", secretKey, 100000))
			.map((o) => o as { id?: unknown; slug?: unknown })
			.filter(
				(o): o is { id: string; slug: string } =>
					typeof o.id === "string" && typeof o.slug === "string",
			);

		let memberships = 0;
		let upserted = 0;
		let removed = 0;
		const failedOrgs: string[] = [];
		for (const org of orgs) {
			try {
				const raw = await clerkReadAll(
					`/v1/organizations/${encodeURIComponent(org.id)}/memberships`,
					secretKey,
					MAX_MEMBERS_PER_ORG,
				);
				// Each item is a Clerk membership object, the same shape as a webhook's
				// `data`: the package parses it (person id, role mapping), no local rule.
				const members = raw.flatMap((m) => {
					const parsed = clerkMembershipEvent(
						{
							type: "organizationMembership.updated",
							data: {
								...(m as object),
								organization: { id: org.id, slug: org.slug },
							},
						},
						{ svixTimestampSeconds: eventAt / 1000 },
					);
					return parsed.ok && parsed.kind !== "ignore"
						? [{ userId: parsed.personId, role: parsed.role }]
						: [];
				});
				const r: { upserted: number; removed: number } = await ctx.runMutation(
					internal.orgMembership.reconcileOrgFromClerk,
					{
						clerkOrgId: org.id,
						clerkOrgSlug: org.slug,
						members,
						dryRun,
						eventAt,
					},
				);
				memberships += members.length;
				upserted += r.upserted;
				removed += r.removed;
			} catch (err) {
				failedOrgs.push(org.id);
				console.error(
					`[clerkBackfill] org ${org.id} not reconciled: ${err instanceof Error ? err.message : "unknown error"}`,
				);
			}
		}
		return {
			dryRun,
			orgs: orgs.length,
			memberships,
			upserted,
			removed,
			failedOrgs,
		};
	},
});
