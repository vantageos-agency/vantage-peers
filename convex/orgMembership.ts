import { hasFleetRead, sameOrg } from "@vantageos/cloud-identity";
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
		if (existing.role !== "admin") {
			await ctx.db.patch(existing._id, { role: "admin", updatedAt: now });
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
			return rows.map(toShape);
		}

		const rows = await ctx.db
			.query("orgMembership")
			.withIndex("by_user", (q) => q.eq("clerkUserId", scope.userId))
			.take(MEMBERSHIP_QUERY_LIMIT);
		assertNotTruncated(rows.length, `subject "${scope.userId}"`);
		return rows.map(toShape);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Clerk-driven sync. Keyed by (clerkOrgId, clerkUserId) — the permanent Clerk
// ids — through `by_org_user_clerk_id`. The slug is a renamable label, stored
// from the payload and refreshed when it changes.
//
// Idempotent by construction: the same state delivered twice writes nothing.
// A row written at provisioning (slug only, no `clerkOrgId` yet) is adopted by
// the first Clerk event for the same (slug, user) instead of duplicated.
// ─────────────────────────────────────────────────────────────────────────────

/** Clerk `org:admin` is the one role mapped to "admin"; every other role is "member". */
export function mapClerkRole(
	clerkRole: string | undefined,
): "admin" | "member" {
	return clerkRole === "org:admin" ? "admin" : "member";
}

export type UpsertOutcome = "inserted" | "updated" | "unchanged";

export async function upsertClerkMembership(
	ctx: MutationCtx,
	args: {
		clerkOrgId: string;
		clerkOrgSlug: string;
		clerkUserId: string;
		role: "admin" | "member";
	},
	opts: { dryRun?: boolean } = {},
): Promise<UpsertOutcome> {
	const byId = await ctx.db
		.query("orgMembership")
		.withIndex("by_org_user_clerk_id", (q) =>
			q.eq("clerkOrgId", args.clerkOrgId).eq("clerkUserId", args.clerkUserId),
		)
		.unique();
	const legacy =
		byId !== null
			? null
			: await ctx.db
					.query("orgMembership")
					.withIndex("by_org_user", (q) =>
						q
							.eq("clerkOrgSlug", args.clerkOrgSlug)
							.eq("clerkUserId", args.clerkUserId),
					)
					.filter((q) => q.eq(q.field("clerkOrgId"), undefined))
					.first();
	const existing = byId ?? legacy;
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
			});
		}
		return "inserted";
	}
	if (
		existing.role === args.role &&
		existing.clerkOrgSlug === args.clerkOrgSlug &&
		existing.clerkOrgId === args.clerkOrgId
	) {
		return "unchanged";
	}
	if (!opts.dryRun) {
		await ctx.db.patch(existing._id, {
			role: args.role,
			clerkOrgSlug: args.clerkOrgSlug,
			clerkOrgId: args.clerkOrgId,
			updatedAt: now,
		});
	}
	return "updated";
}

export async function removeClerkMembership(
	ctx: MutationCtx,
	args: { clerkOrgId: string; clerkUserId: string },
): Promise<number> {
	const rows = await ctx.db
		.query("orgMembership")
		.withIndex("by_org_user_clerk_id", (q) =>
			q.eq("clerkOrgId", args.clerkOrgId).eq("clerkUserId", args.clerkUserId),
		)
		.take(10);
	for (const row of rows) await ctx.db.delete(row._id);
	return rows.length;
}

/**
 * One Clerk `organizationMembership.*` event, already signature-verified by the
 * HTTP route. `created` and `updated` upsert, `deleted` removes.
 */
export const applyClerkMembershipEvent = internalMutation({
	args: {
		kind: v.union(v.literal("upsert"), v.literal("delete")),
		clerkOrgId: v.string(),
		clerkOrgSlug: v.optional(v.string()),
		clerkUserId: v.string(),
		clerkRole: v.optional(v.string()),
	},
	returns: v.union(
		v.literal("inserted"),
		v.literal("updated"),
		v.literal("unchanged"),
		v.literal("removed"),
		v.literal("absent"),
	),
	handler: async (ctx, args) => {
		if (args.kind === "delete") {
			const n = await removeClerkMembership(ctx, args);
			return n > 0 ? "removed" : "absent";
		}
		if (args.clerkOrgSlug === undefined) {
			throw new ConvexError(
				"CLERK_MEMBERSHIP_SLUG_REQUIRED: an upsert needs the organisation slug from the payload",
			);
		}
		return await upsertClerkMembership(ctx, {
			clerkOrgId: args.clerkOrgId,
			clerkOrgSlug: args.clerkOrgSlug,
			clerkUserId: args.clerkUserId,
			role: mapClerkRole(args.clerkRole),
		});
	},
});

// Bounds for the backfill. A page is Clerk's maximum; an organisation larger
// than MAX_MEMBERS_PER_ORG is reported as failed (not read in full), never
// partially reconciled.
const CLERK_PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const MAX_MEMBERS_PER_ORG = 4000;

/**
 * Reconcile ONE organisation with the full member list read from Clerk: upsert
 * every member, remove every stored row of that org not in the list. Callable
 * only with a list the action read to the end.
 */
export const reconcileOrgFromClerk = internalMutation({
	args: {
		clerkOrgId: v.string(),
		clerkOrgSlug: v.string(),
		members: v.array(v.object({ userId: v.string(), role: v.string() })),
		dryRun: v.boolean(),
	},
	returns: v.object({ upserted: v.number(), removed: v.number() }),
	handler: async (ctx, args) => {
		let upserted = 0;
		const present = new Set<string>();
		for (const m of args.members) {
			present.add(m.userId);
			const outcome = await upsertClerkMembership(
				ctx,
				{
					clerkOrgId: args.clerkOrgId,
					clerkOrgSlug: args.clerkOrgSlug,
					clerkUserId: m.userId,
					role: mapClerkRole(m.role),
				},
				{ dryRun: args.dryRun },
			);
			if (outcome !== "unchanged") upserted++;
		}
		const stored = await ctx.db
			.query("orgMembership")
			.withIndex("by_org_clerk_id", (q) => q.eq("clerkOrgId", args.clerkOrgId))
			.take(MAX_MEMBERS_PER_ORG + 1);
		if (stored.length > MAX_MEMBERS_PER_ORG) {
			throw new ConvexError(
				`MEMBERSHIP_QUERY_INCOMPLETE: org ${args.clerkOrgId} holds more than ${MAX_MEMBERS_PER_ORG} stored rows — refusing to reconcile a partial read`,
			);
		}
		let removed = 0;
		for (const row of stored) {
			if (present.has(row.clerkUserId)) continue;
			removed++;
			if (!args.dryRun) await ctx.db.delete(row._id);
		}
		return { upserted, removed };
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
 * organisation whose full member list was read; an organisation whose read
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
				const members = raw.flatMap((m) => {
					const mm = m as {
						role?: unknown;
						public_user_data?: { user_id?: unknown };
					};
					const userId = mm.public_user_data?.user_id;
					return typeof userId === "string"
						? [{ userId, role: typeof mm.role === "string" ? mm.role : "" }]
						: [];
				});
				const r: { upserted: number; removed: number } = await ctx.runMutation(
					internal.orgMembership.reconcileOrgFromClerk,
					{
						clerkOrgId: org.id,
						clerkOrgSlug: org.slug,
						members,
						dryRun,
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
