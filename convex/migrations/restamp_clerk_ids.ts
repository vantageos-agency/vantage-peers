// restamp_clerk_ids — the Clerk DEV instance -> Clerk PRODUCTION instance switch
// (task k17233azpt695d23sez93nk65d8g34dm, step P2). After the switch every Clerk org
// ID (org_...) and every Clerk user ID (user_...) changes. Organisations are keyed by
// `clerkOrgId` (M4) and the fleet service row by `agents.authSubject`; this migration
// rewrites the stored IDs old -> new, from an operator-supplied map.
//
// THE MAP IS AN ARGUMENT. `{ orgs: [{from, to}], users: [{from, to}] }` is passed on
// every call. It is never read from the environment or a source literal, and this
// migration resolves nothing externally. A map is REFUSED when an entry is malformed
// (org_ / user_ + alphanumerics), when two entries share a `from` or a `to`, when a `to`
// is also a `from` (chain or swap), when it is empty or over MAX_MAP_ENTRIES, or when a
// `to` is already the live value of ANOTHER entity:
//   org   - a client_org_mapping row carries `to` while a different row still carries
//           `from` (or either value sits on more than one mapping row);
//   user  - a user's `to` and `from` both belong to the same org in orgMembership
//           (the rewrite would create a duplicate membership), or two `agents`
//           service rows hold `from` and `to`.
// A `to` that is live while its `from` is gone is the idempotent second run, not a
// conflict; it cannot be told apart from a foreign holder of the same value, so the
// pre-write `inventory` of the first run is where that is looked at.
//
// NEVER GUESSES. A value that is not in the map is never rewritten. It is counted and
// LISTED (row id, column, value) as `unmapped`.
//
// SHAPE. Caller-walked, cursor-paginated, one page of one table per execution (R-31),
// like backfill_org_clerk_id. DRY RUN BY DEFAULT. Idempotent: a value already on its
// `to` counts `alreadyRestamped` and is not written. Every `run` prints the page's
// pre-state (console.log, one JSON line) and returns it.
//
// COVERED (rewritten by `run`):
//   client_org_mapping.clerkOrgId and the id column of every table that
//   backfill_org_clerk_id stamps (ORG_COLUMNS: clerkOrgId / tenantOrgId);
//   orgMembership.clerkUserId (the one stored column holding a Clerk user ID that is
//   a record of a person, not a credential).
// CORRECTION DOOR (`restampServiceAccount`): agents.authSubject of the row named by the
//   operator mapping's serviceAccountAgentId, only when it equals the map's `from`.
// NOT REWRITTEN (credentials and one audit trail): oauth_access_tokens.userId,
//   oauth_refresh_tokens.userId, oauth_authorization_codes.userId,
//   oauth_person_codes.clerkUserId/orgId, userBearerTokens.clerkUserId,
//   iframeEmbedSessions.userId. They are bound to a dev user and must be REVOKED and
//   re-minted in the switch window: `revokeList` reports them (count + ids); nothing is
//   revoked here. credentialsAuditLog.clerkUserId is an append-only record of who
//   acted under the dev instance and stays as written; credentialsRateLimits keys
//   ("<user>-issueBearer") are one-minute counters.
// NOT COVERED, STATED: the free-text actor values "user:<subject>" embedded in
//   label columns (createdBy, from, to, recipient, updatedBy, ...) and the
//   assignedToId/createdById columns of tasks etc. Those are historical actor labels,
//   not lookup keys the doors compare against a live subject; rewriting them is a
//   separate decision and is not done here.
//
//   npx convex run migrations/restamp_clerk_ids:inventory '{"map":{...},"table":"missions"}'
//   npx convex run migrations/restamp_clerk_ids:run '{"map":{...},"table":"client_org_mapping"}'
//   -> repeat with {"cursor": <nextCursor>} until isDone, continue with `nextTable`
//      until null. Pass "dryRun": false to write. Then:
//   npx convex run migrations/restamp_clerk_ids:restampServiceAccount '{"map":{...}}'
//   npx convex run migrations/restamp_clerk_ids:readBack '{"map":{...},"table":"..."}'
//   npx convex run migrations/restamp_clerk_ids:revokeList '{"map":{...},"table":"..."}'
//
// Internal: reachable only with the deployment admin credential, so no per-caller
// auth check exists here by design.

import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { CLERK_ORG_ID_PATTERN } from "../lib/orgClerkId";
import { ORG_COLUMNS, type OrgIdTable, TABLE_ORDER } from "./backfill_org_clerk_id";

export const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;

export type RestampTable = "client_org_mapping" | OrgIdTable;

type Columns = { orgField: string; userField: string | null };

export const RESTAMP_COLUMNS: Record<RestampTable, Columns> = {
	client_org_mapping: { orgField: "clerkOrgId", userField: null },
	...(Object.fromEntries(
		TABLE_ORDER.map((t) => [
			t,
			{
				orgField: ORG_COLUMNS[t].idField,
				userField: t === "orgMembership" ? "clerkUserId" : null,
			},
		]),
	) as Record<OrgIdTable, Columns>),
};

export const RESTAMP_TABLE_ORDER: RestampTable[] = [
	"client_org_mapping",
	...TABLE_ORDER,
];

// Credential and session tables bound to a dev user: reported, never rewritten.
export const REVOKE_COLUMNS = {
	oauth_access_tokens: "userId",
	oauth_refresh_tokens: "userId",
	oauth_authorization_codes: "userId",
	oauth_person_codes: "clerkUserId",
	userBearerTokens: "clerkUserId",
	iframeEmbedSessions: "userId",
} as const;
export type RevokeTable = keyof typeof REVOKE_COLUMNS;
export const REVOKE_TABLE_ORDER = Object.keys(REVOKE_COLUMNS) as RevokeTable[];

const tableValidator = v.union(
	v.literal("client_org_mapping"),
	v.literal("missions"),
	v.literal("messages"),
	v.literal("tasks"),
	v.literal("messageReceipts"),
	v.literal("briefingNotes"),
	v.literal("recurringTasks"),
	v.literal("diary"),
	v.literal("businessUnits"),
	v.literal("bulk_complete_runs"),
	v.literal("agents"),
	v.literal("agent_relations"),
	v.literal("agent_credentials"),
	v.literal("orgMembership"),
	v.literal("memberWriterRoles"),
	v.literal("oauth_access_tokens"),
	v.literal("oauth_scope_profiles"),
	v.literal("iframeEmbedSessions"),
	v.literal("githubRepoMapping"),
	v.literal("issues"),
);

const revokeTableValidator = v.union(
	v.literal("oauth_access_tokens"),
	v.literal("oauth_refresh_tokens"),
	v.literal("oauth_authorization_codes"),
	v.literal("oauth_person_codes"),
	v.literal("userBearerTokens"),
	v.literal("iframeEmbedSessions"),
);

const pairValidator = v.object({ from: v.string(), to: v.string() });
const mapValidator = v.object({
	orgs: v.array(pairValidator),
	users: v.array(pairValidator),
});

const DEFAULT_PAGE_SIZE = 100;
const SMALL_PAGE_SIZE: Partial<Record<RestampTable, number>> = {
	missions: 50,
	messages: 50,
	tasks: 50,
	briefingNotes: 20,
};
const MAX_PAGE_SIZE = 500;
const MAPPING_READ_CAP = 1000;
const MEMBERSHIP_READ_CAP = 500;
const MAX_MAP_ENTRIES = 200;

type Pair = { from: string; to: string };
type IdMap = { orgs: Pair[]; users: Pair[] };

type CompiledMap = {
	orgFrom: Map<string, string>;
	orgTo: Set<string>;
	userFrom: Map<string, string>;
	userTo: Set<string>;
};

function refuse(message: string): never {
	throw new ConvexError(`restamp_clerk_ids: ${message}`);
}

function compileKind(
	kind: "org" | "user",
	pairs: Pair[],
	pattern: RegExp,
): { from: Map<string, string>; to: Set<string> } {
	if (pairs.length > MAX_MAP_ENTRIES) {
		refuse(
			`${kind}s map has ${pairs.length} entries; the maximum is ${MAX_MAP_ENTRIES}.`,
		);
	}
	const from = new Map<string, string>();
	const to = new Set<string>();
	for (const p of pairs) {
		if (!pattern.test(p.from)) {
			refuse(`${kind} "from" value "${p.from}" is not a valid Clerk ${kind} ID.`);
		}
		if (!pattern.test(p.to)) {
			refuse(`${kind} "to" value "${p.to}" is not a valid Clerk ${kind} ID.`);
		}
		if (p.from === p.to) refuse(`${kind} entry maps "${p.from}" to itself.`);
		if (from.has(p.from)) refuse(`duplicate ${kind} "from" value "${p.from}".`);
		if (to.has(p.to)) refuse(`duplicate ${kind} "to" value "${p.to}".`);
		from.set(p.from, p.to);
		to.add(p.to);
	}
	for (const t of to) {
		if (from.has(t)) {
			refuse(`${kind} value "${t}" is both a "to" and a "from" (chain or swap).`);
		}
	}
	return { from, to };
}

/** Shape check of the whole map. Throws ConvexError on any refusal. */
export function compileMap(map: IdMap): CompiledMap {
	if (map.orgs.length === 0 && map.users.length === 0) {
		refuse("the map is empty.");
	}
	const orgs = compileKind("org", map.orgs, CLERK_ORG_ID_PATTERN);
	const users = compileKind("user", map.users, CLERK_USER_ID_PATTERN);
	return {
		orgFrom: orgs.from,
		orgTo: orgs.to,
		userFrom: users.from,
		userTo: users.to,
	};
}

async function loadMappingRows(
	db: DatabaseReader,
): Promise<Doc<"client_org_mapping">[]> {
	const rows = await db.query("client_org_mapping").take(MAPPING_READ_CAP + 1);
	if (rows.length > MAPPING_READ_CAP) {
		refuse(
			`client_org_mapping holds more than ${MAPPING_READ_CAP} rows; refusing to decide from a truncated read.`,
		);
	}
	return rows;
}

/**
 * Data-dependent conflicts: a `to` that is already the live value of ANOTHER entity.
 * Returns one line per conflict; empty means none found.
 */
export async function findConflicts(
	db: DatabaseReader,
	map: IdMap,
	options: { includeUsers: boolean },
): Promise<string[]> {
	const conflicts: string[] = [];
	const compiled = compileMap(map);

	if (map.orgs.length > 0) {
		const rows = await loadMappingRows(db);
		for (const p of map.orgs) {
			const onFrom = rows.filter((r) => r.clerkOrgId === p.from).length;
			const onTo = rows.filter((r) => r.clerkOrgId === p.to).length;
			if (onFrom > 0 && onTo > 0) {
				conflicts.push(
					`org "${p.to}" is already the live value of another mapping row while "${p.from}" is still held`,
				);
			}
			if (onFrom > 1) {
				conflicts.push(`org "${p.from}" is held by ${onFrom} mapping rows`);
			}
			if (onTo > 1) {
				conflicts.push(`org "${p.to}" is held by ${onTo} mapping rows`);
			}
		}
	}

	if (options.includeUsers) {
		const orgKey = (r: Doc<"orgMembership">): string =>
			r.clerkOrgId !== undefined
				? (compiled.orgFrom.get(r.clerkOrgId) ?? r.clerkOrgId)
				: `slug:${r.clerkOrgSlug}`;
		for (const p of map.users) {
			const fromRows = await db
				.query("orgMembership")
				.withIndex("by_user", (q) => q.eq("clerkUserId", p.from))
				.take(MEMBERSHIP_READ_CAP + 1);
			const toRows = await db
				.query("orgMembership")
				.withIndex("by_user", (q) => q.eq("clerkUserId", p.to))
				.take(MEMBERSHIP_READ_CAP + 1);
			if (
				fromRows.length > MEMBERSHIP_READ_CAP ||
				toRows.length > MEMBERSHIP_READ_CAP
			) {
				refuse(
					`user "${p.from}" or "${p.to}" holds more than ${MEMBERSHIP_READ_CAP} memberships; refusing to decide from a truncated read.`,
				);
			}
			const fromOrgs = new Set(fromRows.map(orgKey));
			if (toRows.some((r) => fromOrgs.has(orgKey(r)))) {
				conflicts.push(
					`user "${p.to}" already has a membership in an org where "${p.from}" is a member`,
				);
			}
			const svcFrom = await db
				.query("agents")
				.withIndex("by_auth_subject_kind", (q) =>
					q.eq("authSubject", p.from).eq("kind", "service"),
				)
				.take(2);
			const svcTo = await db
				.query("agents")
				.withIndex("by_auth_subject_kind", (q) =>
					q.eq("authSubject", p.to).eq("kind", "service"),
				)
				.take(2);
			if (svcFrom.length > 0 && svcTo.length > 0) {
				conflicts.push(
					`user "${p.to}" is already the authSubject of another service row while "${p.from}" is still held`,
				);
			}
		}
	}
	return conflicts;
}

type PageRow = { _id: string } & Record<string, unknown>;

async function readPage(
	db: DatabaseReader,
	table: string,
	cursor: string | null,
	numItems: number,
): Promise<{ rows: PageRow[]; isDone: boolean; continueCursor: string }> {
	const page = await db
		.query(table as RestampTable)
		.paginate({ cursor, numItems });
	return {
		rows: page.page as unknown as PageRow[],
		isDone: page.isDone,
		continueCursor: page.continueCursor,
	};
}

function pageSizeOf(table: RestampTable, requested: number | undefined): number {
	const size = requested ?? SMALL_PAGE_SIZE[table] ?? DEFAULT_PAGE_SIZE;
	if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
		refuse(`pageSize = ${size} is out of expected range 1-${MAX_PAGE_SIZE}.`);
	}
	return size;
}

type Unmapped = { id: string; field: string; value: string };

type PageScan = {
	examined: number;
	orgOnFrom: Map<string, number>;
	userOnFrom: Map<string, number>;
	alreadyRestamped: number;
	unmapped: Unmapped[];
	// row id -> the column values to write
	patches: { id: string; set: Record<string, string> }[];
};

function scanRows(
	rows: PageRow[],
	columns: Columns,
	compiled: CompiledMap,
): PageScan {
	const scan: PageScan = {
		examined: 0,
		orgOnFrom: new Map(),
		userOnFrom: new Map(),
		alreadyRestamped: 0,
		unmapped: [],
		patches: [],
	};
	const fields: {
		field: string;
		from: Map<string, string>;
		to: Set<string>;
		hits: Map<string, number>;
	}[] = [
		{
			field: columns.orgField,
			from: compiled.orgFrom,
			to: compiled.orgTo,
			hits: scan.orgOnFrom,
		},
	];
	if (columns.userField !== null) {
		fields.push({
			field: columns.userField,
			from: compiled.userFrom,
			to: compiled.userTo,
			hits: scan.userOnFrom,
		});
	}
	for (const row of rows) {
		scan.examined++;
		const set: Record<string, string> = {};
		for (const f of fields) {
			const value = row[f.field];
			if (typeof value !== "string" || value === "") continue;
			const target = f.from.get(value);
			if (target !== undefined) {
				set[f.field] = target;
				f.hits.set(value, (f.hits.get(value) ?? 0) + 1);
			} else if (f.to.has(value)) {
				scan.alreadyRestamped++;
			} else {
				scan.unmapped.push({ id: row._id, field: f.field, value });
			}
		}
		if (Object.keys(set).length > 0) scan.patches.push({ id: row._id, set });
	}
	return scan;
}

const countsOf = (hits: Map<string, number>, pairs: Pair[]) =>
	pairs.map((p) => ({ from: p.from, to: p.to, rows: hits.get(p.from) ?? 0 }));

const countValidator = v.array(
	v.object({ from: v.string(), to: v.string(), rows: v.number() }),
);
const unmappedValidator = v.array(
	v.object({ id: v.string(), field: v.string(), value: v.string() }),
);

const nextTableOf = (
	table: RestampTable,
	isDone: boolean,
): RestampTable | null =>
	isDone
		? (RESTAMP_TABLE_ORDER[RESTAMP_TABLE_ORDER.indexOf(table) + 1] ?? null)
		: table;

// Dry-run-first inventory, one page of one table per call (a table can be larger than
// one query may read): how many rows carry each `from` ID, how many carry an ID that is
// not in the map (listed, never touched), and the data-dependent conflicts of the map.
export const inventory = internalQuery({
	args: {
		map: mapValidator,
		table: tableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		table: tableValidator,
		orgField: v.string(),
		userField: v.union(v.string(), v.null()),
		examined: v.number(),
		orgsOnFrom: countValidator,
		usersOnFrom: countValidator,
		alreadyRestamped: v.number(),
		unmappedCount: v.number(),
		unmappedRows: unmappedValidator,
		conflicts: v.array(v.string()),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
		nextTable: v.union(tableValidator, v.null()),
	}),
	handler: async (ctx, args) => {
		const compiled = compileMap(args.map);
		const columns = RESTAMP_COLUMNS[args.table];
		const page = await readPage(
			ctx.db,
			args.table,
			args.cursor ?? null,
			pageSizeOf(args.table, args.pageSize),
		);
		const scan = scanRows(page.rows, columns, compiled);
		const conflicts = await findConflicts(ctx.db, args.map, {
			includeUsers: args.table === "orgMembership",
		});
		return {
			table: args.table,
			orgField: columns.orgField,
			userField: columns.userField,
			examined: scan.examined,
			orgsOnFrom: countsOf(scan.orgOnFrom, args.map.orgs),
			usersOnFrom: countsOf(scan.userOnFrom, args.map.users),
			alreadyRestamped: scan.alreadyRestamped,
			unmappedCount: scan.unmapped.length,
			unmappedRows: scan.unmapped,
			conflicts,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
			nextTable: nextTableOf(args.table, page.isDone),
		};
	},
});

export const run = internalMutation({
	args: {
		map: mapValidator,
		table: tableValidator,
		dryRun: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		table: tableValidator,
		orgField: v.string(),
		userField: v.union(v.string(), v.null()),
		dryRun: v.boolean(),
		examined: v.number(),
		toRewrite: v.number(),
		alreadyRestamped: v.number(),
		unmappedCount: v.number(),
		unmappedRows: unmappedValidator,
		rewritten: v.number(),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
		nextTable: v.union(tableValidator, v.null()),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const compiled = compileMap(args.map);
		const conflicts = await findConflicts(ctx.db, args.map, {
			includeUsers: args.table === "orgMembership",
		});
		if (conflicts.length > 0) {
			refuse(`the map conflicts with live data: ${conflicts.join("; ")}.`);
		}
		const columns = RESTAMP_COLUMNS[args.table];
		const page = await readPage(
			ctx.db,
			args.table,
			args.cursor ?? null,
			pageSizeOf(args.table, args.pageSize),
		);
		const scan = scanRows(page.rows, columns, compiled);

		console.log(
			`restamp_clerk_ids pre-state ${JSON.stringify({
				table: args.table,
				dryRun,
				cursor: args.cursor ?? null,
				examined: scan.examined,
				orgsOnFrom: countsOf(scan.orgOnFrom, args.map.orgs).filter(
					(c) => c.rows > 0,
				),
				usersOnFrom: countsOf(scan.userOnFrom, args.map.users).filter(
					(c) => c.rows > 0,
				),
				alreadyRestamped: scan.alreadyRestamped,
				unmapped: scan.unmapped.length,
			})}`,
		);

		let rewritten = 0;
		if (!dryRun) {
			for (const p of scan.patches) {
				await ctx.db.patch(args.table, p.id as never, p.set as never);
				rewritten++;
			}
		}
		return {
			table: args.table,
			orgField: columns.orgField,
			userField: columns.userField,
			dryRun,
			examined: scan.examined,
			toRewrite: scan.patches.length,
			alreadyRestamped: scan.alreadyRestamped,
			unmappedCount: scan.unmapped.length,
			unmappedRows: scan.unmapped,
			rewritten,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
			nextTable: nextTableOf(args.table, page.isDone),
		};
	},
});

// readBack: after the write, no row may carry a `from` value. One page of one table per
// call; the sum of `remaining` over all tables must be 0.
export const readBack = internalQuery({
	args: {
		map: mapValidator,
		table: tableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		table: tableValidator,
		examined: v.number(),
		remaining: v.number(),
		remainingRowIds: v.array(v.string()),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
		nextTable: v.union(tableValidator, v.null()),
	}),
	handler: async (ctx, args) => {
		const compiled = compileMap(args.map);
		const columns = RESTAMP_COLUMNS[args.table];
		const page = await readPage(
			ctx.db,
			args.table,
			args.cursor ?? null,
			pageSizeOf(args.table, args.pageSize),
		);
		const scan = scanRows(page.rows, columns, compiled);
		return {
			table: args.table,
			examined: scan.examined,
			remaining: scan.patches.length,
			remainingRowIds: scan.patches.map((p) => p.id),
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
			nextTable: nextTableOf(args.table, page.isDone),
		};
	},
});

const serviceStatus = v.union(
	v.literal("would-restamp"),
	v.literal("restamped"),
	v.literal("already-restamped"),
	v.literal("blocked"),
);

// The explicit correction for the fleet service row. linkServiceAccountAgent never
// overwrites a stored subject by design; this door does, for ONE row (the one the
// operator mapping's serviceAccountAgentId names) and ONLY when its current
// authSubject is a `from` of the map. Anything else is "blocked" and reported.
export const restampServiceAccount = internalMutation({
	args: { map: mapValidator, dryRun: v.optional(v.boolean()) },
	returns: v.object({
		dryRun: v.boolean(),
		status: serviceStatus,
		reason: v.union(v.string(), v.null()),
		agentId: v.union(v.id("agents"), v.null()),
		currentAuthSubject: v.union(v.string(), v.null()),
		newAuthSubject: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const compiled = compileMap(args.map);
		const mappings = await loadMappingRows(ctx.db);
		const operators = mappings.filter(
			(m) => m.orgKind === "operator" && m.isActive,
		);
		const blocked = (
			reason: string,
			agentId: Doc<"agents">["_id"] | null,
			current: string | null,
		) => ({
			dryRun,
			status: "blocked" as const,
			reason,
			agentId,
			currentAuthSubject: current,
			newAuthSubject: null,
		});
		const operator = operators[0];
		if (operators.length !== 1 || operator === undefined) {
			return blocked(
				`operator-org-${operators.length === 0 ? "none" : "many"}`,
				null,
				null,
			);
		}
		const agentId = operator.serviceAccountAgentId;
		if (agentId === undefined) {
			return blocked("no-service-account-linked", null, null);
		}
		const agent = await ctx.db.get(agentId);
		if (agent === null) return blocked("service-agent-row-missing", agentId, null);
		if (agent.kind !== "service") {
			return blocked("linked-row-is-not-a-service-row", agentId, agent.authSubject ?? null);
		}
		const current = agent.authSubject ?? null;
		if (current === null) return blocked("authSubject-absent", agentId, null);
		if (compiled.userTo.has(current)) {
			return {
				dryRun,
				status: "already-restamped" as const,
				reason: null,
				agentId,
				currentAuthSubject: current,
				newAuthSubject: current,
			};
		}
		const target = compiled.userFrom.get(current);
		if (target === undefined) {
			return blocked("authSubject-is-not-a-from-value-of-the-map", agentId, current);
		}
		const holders = await ctx.db
			.query("agents")
			.withIndex("by_auth_subject_kind", (q) =>
				q.eq("authSubject", target).eq("kind", "service"),
			)
			.take(2);
		if (holders.some((h) => h._id !== agentId)) {
			return blocked("target-subject-held-by-another-service-row", agentId, current);
		}
		console.log(
			`restamp_clerk_ids service pre-state ${JSON.stringify({ agentId, current, target, dryRun })}`,
		);
		if (!dryRun) await ctx.db.patch(agentId, { authSubject: target });
		return {
			dryRun,
			status: dryRun ? ("would-restamp" as const) : ("restamped" as const),
			reason: null,
			agentId,
			currentAuthSubject: current,
			newAuthSubject: target,
		};
	},
});

// revokeList: the credentials and sessions bound to a dev user. NOT rewritten and NOT
// revoked here; the operator revokes and re-mints them in the switch window. A row is
// listed when its user column holds a `from` user of the map (count + ids); rows bound
// to any other value are counted only (`otherUser`), since that value may not be a
// Clerk ID at all. One page of one table per call.
export const revokeList = internalQuery({
	args: {
		map: mapValidator,
		table: revokeTableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		table: revokeTableValidator,
		userField: v.string(),
		examined: v.number(),
		boundToFromUser: v.number(),
		ids: v.array(v.string()),
		otherUser: v.number(),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
		nextTable: v.union(revokeTableValidator, v.null()),
	}),
	handler: async (ctx, args) => {
		const compiled = compileMap(args.map);
		const userField = REVOKE_COLUMNS[args.table];
		const size = args.pageSize ?? DEFAULT_PAGE_SIZE;
		if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
			refuse(`pageSize = ${size} is out of expected range 1-${MAX_PAGE_SIZE}.`);
		}
		const page = await ctx.db
			.query(args.table)
			.paginate({ cursor: args.cursor ?? null, numItems: size });
		const rows = page.page as unknown as PageRow[];
		const ids: string[] = [];
		let otherUser = 0;
		for (const row of rows) {
			const value = row[userField];
			if (typeof value === "string" && compiled.userFrom.has(value)) {
				ids.push(row._id);
			} else if (typeof value === "string") {
				otherUser++;
			}
		}
		const next = page.isDone
			? (REVOKE_TABLE_ORDER[REVOKE_TABLE_ORDER.indexOf(args.table) + 1] ?? null)
			: args.table;
		return {
			table: args.table,
			userField,
			examined: rows.length,
			boundToFromUser: ids.length,
			ids,
			otherUser,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
			nextTable: next,
		};
	},
});
