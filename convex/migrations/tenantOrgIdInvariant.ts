// tenantOrgIdInvariant — READ-ONLY coverage of the permanent org ID on EVERY
// tenant-scoped table, derived from convex/schema.ts and never from a typed list.
// Pi ruling, task k1768vhaqbsf7kvtb4z8xhx6818hg19t (deliverable 1; it replaces the
// ORG_COLUMNS-based count of k1778zdhntzk53dyac8hxg71zx8hhzfx).
//
// Why. Under @vantageos/cloud-identity `sameOrg`, a row matches a tenant only when BOTH
// rows carry a `clerkOrgId` and they are equal; a row stamped only with the slug matches
// no tenant. A typed list of tables (ORG_COLUMNS) misses every table nobody added to it,
// which is how a tenant table can hold slug-only rows unseen. This instrument counts
// every table the schema itself declares as org-scoped, so a NEW tenant table is counted
// the day it is declared, with no list to edit.
//
// DERIVATION RULE (applied to the tables object of convex/schema.ts at run time, see
// `deriveTenantTables`). For each table whose top-level validator is an object:
//   idField    the first declared among `clerkOrgId`, `tenantOrgId` whose validator is a
//              string (optional or required), else null;
//   slugField  the first declared among `clerkOrgSlug`, `orgSlug`, `orgId`, `tenantId`
//              whose validator is a string (optional or required), else null. A column of
//              the same name that is a union or an id is skipped, not read as a slug;
//   the table is TENANT-SCOPED iff idField or slugField is not null.
// The set is refused (ConvexError) when it is EMPTY: an instrument that finds no tenant
// table has failed, and an empty answer must not read as "all clean".
// Columns that name an org but follow neither convention (`agentOrgId`, `fromOrgId`,
// `toOrgId`, `orgRole`) are not read: they are not the row's own tenant stamp.
//
// COUNTS PER TABLE. Rows examined; `stamped` (idField present, the same test
// backfill_org_clerk_id:run calls alreadyFilled); `slugOnly` (slug present, no id: the
// rows `sameOrg` cannot match); `unstamped` (neither), split by author kind (below);
// `resolvable` (slugOnly rows whose slug the GUARDED resolver of backfill_org_clerk_id,
// resolveSlugForRow, maps to exactly one active mapping with a clerkOrgId not newer than
// the row: what a backfill would fill); `refusals` (why the others are not, below).
// A table with no idField reports stamped 0 and every slug-bearing row as slugOnly: it has
// nowhere to hold the id, and its idField is reported null so the reader sees that.
// COUNTS ONLY: no row id, no slug, no mapping content leaves it; column names are schema
// facts, not data.
//
// UNSTAMPED, SPLIT BY AUTHOR KIND. An unstamped row (no slug, no id) is the fleet's by the
// historical rule ("absent = fleet"), but the prod count showed client-looking tables full of
// them, so each is attributed to WHO WROTE IT, as `unstamped: {fleet, client, unknown}`:
//   fleet    the author is an agent of the OPERATOR org (the package's `findOperatorOrg`:
//            exactly one active operator mapping);
//   client   the author is an agent of any other org, or a person (`user:<sub>` /
//            `user_<sub>`, a Clerk subject);
//   unknown  no author field, an empty one, one that names no agent, an agent row with no
//            permanent org id, or a label that agents of both sides carry (ambiguous).
//            Unknown is never rounded to fleet or to client.
// How an author value is read: an ID (an `agents._id` string) is looked up in `agents` and
// its permanent org id compared to the operator's (`sameOrg`: by ID only, a slug never
// matches); a LABEL is normalised (`normalizeOrchestratorId`) and looked up among the names of
// the agents that carry an org id. No name list is written here and no roster is read: the
// operator and the agents come from the tables. ID fields are tried before label fields, and
// an ID that resolves wins over a label that disagrees. The lookups are lazy: a row with no
// author column reads no agent. An operator org that is not exactly one active mapping with
// a permanent id REFUSES (ConvexError) rather than guessing "fleet".
//
// AUTHOR FIELD PER TABLE (also returned as `authorFields`, so the reader sees what was read;
// AUTHOR_FIELDS below is the single source, and a test pins that every derived table has an
// entry, so a new tenant table cannot arrive without an author decision):
//   memories              createdBy (label)
//   messages              fromId (id), from (label)
//   messageReceipts       the PARENT message's fromId / from (via messageId): the receipt is
//                         written by the sender; `recipient` is the addressee, not the author
//   missions              createdById (id), createdBy (label)
//   bulk_complete_runs    createdBy (label)
//   tasks                 createdById (id), createdBy (label)
//   diary                 createdBy (label)
//   briefingNotes         createdById (id), createdBy (label)
//   recurringTasks        createdById (id), createdBy (label)
//   businessUnits         ownerId (id), orchestratorId (label)
//   githubOwnerBindings   boundBy (Clerk subject: a person)
//   oauth_person_codes    clerkUserId (Clerk subject: a person)
//   iframeEmbedSessions   userId (Clerk subject: a person)
//   agentLinks            grantedBy (Clerk subject: a person)
//   agent_credentials     agentId (id of the agent the credential belongs to)
//   debateTemplates       updatedBy (label: the caller's actorName)
//   debateSettings        updatedBy (label)
//   debateRooms           createdById (id), createdBy (label)
//   oauth_access_tokens   agentId (id); principal "person"; then the scope profile named by
//                         scopeProfile (its agentId, then its clerkOrgId stamp); then userId
//                         when it is a Clerk subject
//   oauth_refresh_tokens  the same chain
//   oauth_scope_profiles  agentId (id), then the clerkOrgId stamp
//   NO AUTHOR FIELD (every unstamped row is `unknown`): issues (written by the GitHub
//   webhook; fixedBy/verifiedBy are later actors), githubRepoMapping (`orchestrator` is the
//   repo's routing target, not the writer), tool_usage, kbUploads, uploadTickets,
//   memberWriterRoles, client_org_mapping, orgMembership, okfDurableExportProgress,
//   okfDurableExportEntries, agents, agent_relations.
//
// REFUSAL REASONS. For each slug-only row the guarded resolver refuses, `refusals` counts the
// reason `resolveSlugForRow` returns (the same function; nothing is re-derived):
//   orgUnmapped          the slug has no client_org_mapping row;
//   ambiguousMapping     the slug names more than one mapping row;
//   mappingHasNoClerkId  the mapping exists but its clerkOrgId is not filled;
//   mappingRecordInvalid the mapping row is not well formed for the package;
//   inactiveMapping      the slug's single mapping is not active;
//   mappingNewerThanRow  the mapping was created after the row (age check).
// `resolvable + sum(refusals) = slugOnly`.
//
// SHAPE. Internal, deployment-admin only (no per-caller check by design), cursor-paginated
// and bounded: one page of ONE table per call. `table` is REQUIRED: Convex allows one
// `paginate` per query, so a call over every table cannot run (it failed on prod); a call
// without `table` is refused with a typed error that names the rule. `tables` lists the
// derived tables. It writes nothing.
//
//   bash .claude/scripts/convex-prod.sh run migrations/tenantOrgIdInvariant:tables '{}'
//   bash .claude/scripts/convex-prod.sh run migrations/tenantOrgIdInvariant:count '{"table":"missions"}'
//   -> repeat with {"table":..., "cursor": <cursor>} until done is true; sum the pages.

import { findOperatorOrg, sameOrg } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import schema from "../schema";
import {
	indexBySlug,
	loadMappingRows,
	type MappingRow,
	type Reason,
	resolveSlugForRow,
} from "./backfill_org_clerk_id";

export const ID_COLUMN_CANDIDATES = ["clerkOrgId", "tenantOrgId"] as const;
export const SLUG_COLUMN_CANDIDATES = [
	"clerkOrgSlug",
	"orgSlug",
	"orgId",
	"tenantId",
] as const;

export type TenantTable = {
	table: string;
	slugField: string | null;
	idField: string | null;
};

// The part of a TableDefinition the rule reads.
type FieldLike = { kind: string };
type TableLike = {
	validator: { kind: string; fields?: Record<string, FieldLike> };
};

const firstStringColumn = (
	fields: Record<string, FieldLike>,
	candidates: readonly string[],
): string | null =>
	candidates.find(
		(c) => fields[c] !== undefined && fields[c].kind === "string",
	) ?? null;

/** The derivation rule of the module header. Throws on an empty result. */
export function deriveTenantTables(
	tables: Record<string, TableLike>,
): TenantTable[] {
	const out: TenantTable[] = [];
	for (const [table, def] of Object.entries(tables)) {
		const fields =
			def.validator.kind === "object" ? def.validator.fields : null;
		if (!fields) continue;
		const idField = firstStringColumn(fields, ID_COLUMN_CANDIDATES);
		const slugField = firstStringColumn(fields, SLUG_COLUMN_CANDIDATES);
		if (idField !== null || slugField !== null) {
			out.push({ table, slugField, idField });
		}
	}
	if (out.length === 0) {
		throw new ConvexError(
			"tenantOrgIdInvariant: the schema yields no tenant-scoped table; refusing to report an empty set as a clean one.",
		);
	}
	return out;
}

const SCHEMA_TABLES = schema.tables as unknown as Record<string, TableLike>;

// ── author kinds ─────────────────────────────────────────────────────────────

export type AuthorKind = "fleet" | "client" | "unknown";

/** `id`: an agents._id string or a person subject; `label`: an orchestrator name. */
type AuthorField = { name: string; as: "id" | "label" };
type AuthorSpec = {
	fields: readonly AuthorField[];
	/** Where the author is not on the row itself. */
	via?: "message" | "token" | "profile";
};

const id = (name: string): AuthorField => ({ name, as: "id" });
const label = (name: string): AuthorField => ({ name, as: "label" });

/** Single source of the author field(s) per tenant table (module header). */
export const AUTHOR_FIELDS: Record<string, AuthorSpec> = {
	memories: { fields: [label("createdBy")] },
	messages: { fields: [id("fromId"), label("from")] },
	messageReceipts: { fields: [id("fromId"), label("from")], via: "message" },
	missions: { fields: [id("createdById"), label("createdBy")] },
	bulk_complete_runs: { fields: [label("createdBy")] },
	tasks: { fields: [id("createdById"), label("createdBy")] },
	diary: { fields: [label("createdBy")] },
	briefingNotes: { fields: [id("createdById"), label("createdBy")] },
	recurringTasks: { fields: [id("createdById"), label("createdBy")] },
	businessUnits: { fields: [id("ownerId"), label("orchestratorId")] },
	githubOwnerBindings: { fields: [id("boundBy")] },
	oauth_person_codes: { fields: [id("clerkUserId")] },
	iframeEmbedSessions: { fields: [id("userId")] },
	agentLinks: { fields: [id("grantedBy")] },
	agent_credentials: { fields: [id("agentId")] },
	debateTemplates: { fields: [label("updatedBy")] },
	debateSettings: { fields: [label("updatedBy")] },
	debateRooms: { fields: [id("createdById"), label("createdBy")] },
	oauth_access_tokens: { fields: [id("agentId"), id("userId")], via: "token" },
	oauth_refresh_tokens: { fields: [id("agentId"), id("userId")], via: "token" },
	oauth_scope_profiles: { fields: [id("agentId")], via: "profile" },
	// No author field: every unstamped row is `unknown`.
	issues: { fields: [] },
	githubRepoMapping: { fields: [] },
	tool_usage: { fields: [] },
	kbUploads: { fields: [] },
	uploadTickets: { fields: [] },
	memberWriterRoles: { fields: [] },
	client_org_mapping: { fields: [] },
	orgMembership: { fields: [] },
	okfDurableExportProgress: { fields: [] },
	okfDurableExportEntries: { fields: [] },
	agents: { fields: [] },
	agent_relations: { fields: [] },
};

/** The author field names read for a table, as the output reports them. */
export function authorFieldNames(table: string): string[] {
	const spec = AUTHOR_FIELDS[table];
	if (spec === undefined) return [];
	const own = spec.fields.map((f) => f.name);
	switch (spec.via) {
		case "message":
			return ["messageId>from", "messageId>fromId"];
		case "token":
			return [
				...own,
				"principal",
				"scopeProfile>agentId",
				"scopeProfile>clerkOrgId",
			];
		case "profile":
			return [...own, "clerkOrgId"];
		default:
			return own;
	}
}

const AGENT_READ_CAP = 2000;
const PROFILE_READ_CAP = 1000;
const MAPPING_ROWS_CAP = 1000;

type Row = Record<string, unknown>;

/** Clerk subjects: `user_...` as Clerk issues them, `user:<sub>` as the stable principal. */
const isPersonSubject = (s: string): boolean =>
	s.startsWith("user:") || s.startsWith("user_");

type Classifier = {
	/** The operator org's permanent id (the package's `findOperatorOrg`). */
	operatorId: string;
	/** agents._id -> true when the agent belongs to the operator org. */
	agentIsOperator: Map<string, boolean>;
	/** Normalised agent names -> the kinds of the agents (with an org id) that carry them. */
	labelKinds: Map<string, Set<"fleet" | "client">>;
	/** profileId -> its row; null when two rows carry the id (undecidable). */
	profiles: Map<string, Row | null>;
};

/** Reads the operator, the agents and the profiles once. Refuses on an unclear operator. */
async function buildClassifier(
	db: DatabaseReader,
	mappings: MappingRow[],
): Promise<Classifier> {
	// The package decides which org is the operator (exactly one ACTIVE mapping of kind
	// "operator"; none, several, over the cap or a malformed row is a non-answer), over the
	// mapping rows this call already read.
	const op = await findOperatorOrg(
		{
			activeOrganisations: (limit: number) =>
				mappings
					.filter((m) => m.isActive)
					.slice(0, limit)
					.map((m) => ({
						...m,
						id: m.clerkOrgId,
						label: m.clerkOrgSlug,
						active: m.isActive,
					})),
		},
		{ cap: MAPPING_ROWS_CAP },
	);
	if (op.kind !== "one") {
		throw new ConvexError(
			`tenantOrgIdInvariant: cannot split unstamped rows by author: the operator org is "${op.kind}", not exactly one active mapping; refusing to guess fleet vs client.`,
		);
	}
	const operatorId = op.org.id;
	if (operatorId === undefined || operatorId === "") {
		throw new ConvexError(
			"tenantOrgIdInvariant: cannot split unstamped rows by author: the operator org has no permanent id; refusing to compare by slug.",
		);
	}
	const agents = await db.query("agents").take(AGENT_READ_CAP + 1);
	if (agents.length > AGENT_READ_CAP) {
		throw new ConvexError(
			`tenantOrgIdInvariant: agents holds more than ${AGENT_READ_CAP} rows; refusing to decide from a truncated read.`,
		);
	}
	const agentIsOperator = new Map<string, boolean>();
	const labelKinds = new Map<string, Set<"fleet" | "client">>();
	for (const a of agents) {
		// An agent row with no permanent org id names no org by ID: it resolves nobody.
		if (a.clerkOrgId === undefined || a.clerkOrgId === "") continue;
		const isOp = sameOrg({ id: a.clerkOrgId }, { id: operatorId });
		agentIsOperator.set(a._id, isOp);
		const n = normalizeOrchestratorId(a.name);
		const kinds = labelKinds.get(n) ?? new Set<"fleet" | "client">();
		kinds.add(isOp ? "fleet" : "client");
		labelKinds.set(n, kinds);
	}
	const profileRows = await db
		.query("oauth_scope_profiles")
		.take(PROFILE_READ_CAP + 1);
	if (profileRows.length > PROFILE_READ_CAP) {
		throw new ConvexError(
			`tenantOrgIdInvariant: oauth_scope_profiles holds more than ${PROFILE_READ_CAP} rows; refusing to decide from a truncated read.`,
		);
	}
	const profiles = new Map<string, Row | null>();
	for (const p of profileRows) {
		profiles.set(p.profileId, profiles.has(p.profileId) ? null : (p as Row));
	}
	return { operatorId, agentIsOperator, labelKinds, profiles };
}

function kindOfId(c: Classifier, value: string): AuthorKind | null {
	if (isPersonSubject(value)) return "client";
	const isOp = c.agentIsOperator.get(value);
	if (isOp === undefined) return null;
	return isOp ? "fleet" : "client";
}

function kindOfLabel(c: Classifier, value: string): AuthorKind | null {
	const kinds = c.labelKinds.get(normalizeOrchestratorId(value));
	if (kinds === undefined || kinds.size !== 1) return null; // unknown, or carried by both
	return kinds.has("fleet") ? "fleet" : "client";
}

/** First field that resolves decides; ID fields come first in every spec. */
function kindOfFields(
	c: Classifier,
	row: Row,
	fields: readonly AuthorField[],
): AuthorKind | null {
	for (const f of fields) {
		const value = row[f.name];
		if (typeof value !== "string" || value === "") continue;
		const k = f.as === "id" ? kindOfId(c, value) : kindOfLabel(c, value);
		if (k !== null) return k;
	}
	return null;
}

/** A scope profile row: its agent, then its own permanent org stamp. */
function kindOfProfile(c: Classifier, p: Row): AuthorKind | null {
	const byAgent = kindOfFields(c, p, [id("agentId")]);
	if (byAgent !== null) return byAgent;
	if (typeof p.clerkOrgId !== "string" || p.clerkOrgId === "") return null;
	return sameOrg({ id: p.clerkOrgId }, { id: c.operatorId })
		? "fleet"
		: "client";
}

function profileOf(c: Classifier, profileId: unknown): Row | null {
	if (typeof profileId !== "string" || profileId === "") return null;
	return c.profiles.get(profileId) ?? null;
}

// The columns whose presence makes an author lookup worth its reads. A row with none of
// them is `unknown` without reading agents or profiles (and without the operator check).
const CANDIDATE_KEYS: Record<string, readonly string[]> = {
	message: ["messageId"],
	token: ["agentId", "principal", "scopeProfile", "userId"],
	profile: ["agentId"],
};

function hasAuthorCandidate(table: string, row: Row): boolean {
	const spec = AUTHOR_FIELDS[table];
	if (spec === undefined) return false;
	const keys =
		spec.via === undefined
			? spec.fields.map((f) => f.name)
			: CANDIDATE_KEYS[spec.via];
	return keys.some((k) => {
		const value = row[k];
		return typeof value === "string" && value !== "";
	});
}

/** Who wrote an UNSTAMPED row of `table`. Pure reads; `unknown` when nothing resolves. */
export async function authorKindOf(
	db: DatabaseReader,
	c: Classifier,
	table: string,
	row: Row,
): Promise<AuthorKind> {
	const spec = AUTHOR_FIELDS[table];
	if (spec === undefined) return "unknown";
	switch (spec.via) {
		case "message": {
			if (typeof row.messageId !== "string") return "unknown";
			const parent = (await db.get(
				row.messageId as Id<"messages">,
			)) as Row | null;
			return parent === null
				? "unknown"
				: (kindOfFields(c, parent, spec.fields) ?? "unknown");
		}
		case "token": {
			const direct = kindOfFields(c, row, [spec.fields[0]]);
			if (direct !== null) return direct;
			if (row.principal === "person") return "client";
			const profile = profileOf(c, row.scopeProfile);
			const byProfile = profile === null ? null : kindOfProfile(c, profile);
			if (byProfile !== null) return byProfile;
			return kindOfFields(c, row, [spec.fields[1]]) ?? "unknown";
		}
		case "profile":
			return kindOfProfile(c, row) ?? "unknown";
		default:
			return kindOfFields(c, row, spec.fields) ?? "unknown";
	}
}

// ── the count ────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 100;
const SMALL_PAGE_SIZE: Record<string, number> = {
	missions: 50,
	messages: 50,
	tasks: 50,
	memories: 50,
	briefingNotes: 20,
};
const MAX_PAGE_SIZE = 500;

const entryValidator = v.object({
	table: v.string(),
	slugField: v.union(v.string(), v.null()),
	idField: v.union(v.string(), v.null()),
	authorFields: v.array(v.string()),
	examined: v.number(),
	stamped: v.number(),
	slugOnly: v.number(),
	unstamped: v.object({
		fleet: v.number(),
		client: v.number(),
		unknown: v.number(),
	}),
	resolvable: v.number(),
	refusals: v.object({
		orgUnmapped: v.number(),
		ambiguousMapping: v.number(),
		mappingHasNoClerkId: v.number(),
		mappingRecordInvalid: v.number(),
		inactiveMapping: v.number(),
		mappingNewerThanRow: v.number(),
	}),
	done: v.boolean(),
	cursor: v.union(v.string(), v.null()),
});

export const tables = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			table: v.string(),
			slugField: v.union(v.string(), v.null()),
			idField: v.union(v.string(), v.null()),
			authorFields: v.array(v.string()),
		}),
	),
	handler: async () =>
		deriveTenantTables(SCHEMA_TABLES).map((d) => ({
			...d,
			authorFields: authorFieldNames(d.table),
		})),
});

export const count = internalQuery({
	args: {
		table: v.optional(v.string()),
		cursor: v.optional(v.union(v.string(), v.null())),
		limit: v.optional(v.number()),
	},
	returns: v.object({ tables: v.array(entryValidator) }),
	handler: async (ctx, args) => {
		const derived = deriveTenantTables(SCHEMA_TABLES);
		if (args.table === undefined) {
			throw new ConvexError(
				`tenantOrgIdInvariant:count: \`table\` is required: Convex allows one paginate per query, so one call reads one page of ONE table (${derived.length} derived; list them with tenantOrgIdInvariant:tables).`,
			);
		}
		if (
			args.limit !== undefined &&
			(!Number.isInteger(args.limit) ||
				args.limit < 1 ||
				args.limit > MAX_PAGE_SIZE)
		) {
			throw new ConvexError(
				`tenantOrgIdInvariant:count: limit = ${args.limit} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const target = derived.find((d) => d.table === args.table);
		if (target === undefined) {
			throw new ConvexError(
				`tenantOrgIdInvariant:count: table = ${args.table} is not a tenant-scoped table of the schema (${derived.length} derived; list them with tenantOrgIdInvariant:tables).`,
			);
		}
		const { table, slugField, idField } = target;
		const mappingRows = await loadMappingRows(ctx.db);
		const mappings = indexBySlug(mappingRows);
		const limit = args.limit ?? SMALL_PAGE_SIZE[table] ?? DEFAULT_PAGE_SIZE;
		const page = await ctx.db
			.query(table as never)
			.paginate({ cursor: args.cursor ?? null, numItems: limit });
		let classifier: Classifier | undefined;
		let stamped = 0;
		let slugOnly = 0;
		let resolvable = 0;
		const unstamped = { fleet: 0, client: 0, unknown: 0 };
		// Record<Reason, number>: a new resolver reason is a compile error until counted here.
		const refusals: Record<Reason, number> = {
			orgUnmapped: 0,
			ambiguousMapping: 0,
			mappingHasNoClerkId: 0,
			mappingRecordInvalid: 0,
			inactiveMapping: 0,
			mappingNewerThanRow: 0,
		};
		for (const row of page.page as unknown as ({
			_creationTime: number;
		} & Row)[]) {
			if (idField !== null && row[idField] !== undefined) {
				stamped++;
				continue;
			}
			const slug = slugField === null ? undefined : row[slugField];
			if (typeof slug !== "string" || slug === "") {
				if (!hasAuthorCandidate(table, row)) {
					unstamped.unknown++;
					continue;
				}
				classifier ??= await buildClassifier(ctx.db, mappingRows);
				unstamped[await authorKindOf(ctx.db, classifier, table, row)]++;
				continue;
			}
			slugOnly++;
			const resolution = await resolveSlugForRow(
				mappings,
				slug,
				row._creationTime,
			);
			if (resolution.kind === "id") resolvable++;
			else refusals[resolution.reason]++;
		}
		const unstampedTotal =
			unstamped.fleet + unstamped.client + unstamped.unknown;
		return {
			tables: [
				{
					table,
					slugField,
					idField,
					authorFields: authorFieldNames(table),
					examined: stamped + slugOnly + unstampedTotal,
					stamped,
					slugOnly,
					unstamped,
					resolvable,
					refusals,
					done: page.isDone,
					cursor: page.isDone ? null : page.continueCursor,
				},
			],
		};
	},
});
