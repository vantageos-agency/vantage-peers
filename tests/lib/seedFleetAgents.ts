import { type GenericMutationCtx, getFunctionName } from "convex/server";
import type { DataModel, Id } from "../../convex/_generated/dataModel";
import { normalizeOrchestratorId } from "../../convex/_helpers/normalizeOrchestratorId";
import { testClerkOrgId } from "../fixtures/testClerkOrgId";
import { findAgentId } from "./agentIdOf";
import { syncRosterIdsFromNames } from "./rosterSync";

type Runner = {
	run: <Output>(
		func: (ctx: GenericMutationCtx<DataModel>) => Promise<Output>,
	) => Promise<Output>;
};

/** The orchestrator labels the task suites act as and assign to. */
export const FLEET_LABELS = [
	"sigma",
	"eta",
	"pi",
	"beta",
	"alpha",
	"gamma",
	"zeta",
	"theta",
	"agent-a",
	"agent-b",
	"orchestrator-a",
	"orchestrator-b",
	"worker",
	"reviewer",
] as const;

/**
 * TEST FIXTURE ONLY. Seeds the fleet the task doors resolve actors in (M7: a
 * door decides on agents-row IDs): ONE active operator organisation and one
 * ACTIVE agents row per label in it. Idempotent: an operator org / agent that
 * already exists is reused. Returns label -> agent ID.
 */
export async function seedFleetAgents(
	t: Runner,
	labels: readonly string[] = FLEET_LABELS,
): Promise<Record<string, Id<"agents">>> {
	return await t.run(async (ctx) => {
		const mappings = await ctx.db.query("client_org_mapping").collect();
		let slug = mappings.find((m) => m.isActive && m.orgKind === "operator")
			?.clerkOrgSlug;
		if (slug === undefined) {
			slug = "fleet-operator";
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: 1,
				orgKind: "operator",
			});
		}
		const ids: Record<string, Id<"agents">> = {};
		for (const name of labels) {
			const key = normalizeOrchestratorId(name);
			const existing = await ctx.db
				.query("agents")
				.withIndex("by_org_normalized_name", (q) =>
					q.eq("orgSlug", slug as string).eq("normalizedName", key),
				)
				.first();
			ids[name] =
				existing?._id ??
				(await ctx.db.insert("agents", {
					orgSlug: slug as string,
					name,
					normalizedName: key,
					isActive: true,
					createdAt: 1,
				}));
		}
		return ids;
	});
}

type TaskInsertCtx = GenericMutationCtx<DataModel>;

/**
 * TEST FIXTURE ONLY. Inserts a task row the way the creating door would have
 * stamped it (M7): `createdById` / `assignedToId` / `lastAssignedToId` are the
 * agents-row IDs of the labels, looked up in the row's OWN org (the operator org
 * when the row is unstamped). An ID the test names explicitly is kept; a label
 * that names no agent there leaves the column unset (the legacy row shape).
 */
// One lookup per (org, label) per transaction: suites insert thousands of rows.
const lookupCache = new WeakMap<object, Map<string, string | undefined>>();

export async function insertTaskRow(
	ctx: TaskInsertCtx,
	doc: Record<string, unknown>,
): Promise<Id<"tasks">> {
	const cache = lookupCache.get(ctx) ?? new Map<string, string | undefined>();
	lookupCache.set(ctx, cache);
	let slug = typeof doc.orgId === "string" ? doc.orgId : undefined;
	if (slug === undefined) {
		if (!cache.has("\0operator")) {
			const ops = (await ctx.db.query("client_org_mapping").collect()).filter(
				(m) => m.isActive && m.orgKind === "operator",
			);
			cache.set("\0operator", ops.length === 1 ? ops[0].clerkOrgSlug : undefined);
		}
		slug = cache.get("\0operator");
	}
	const idOf = async (label: unknown): Promise<string | undefined> => {
		if (typeof label !== "string" || slug === undefined) return undefined;
		if (label.startsWith("user:")) return label;
		const key = `${slug}\0${label}`;
		if (cache.has(key)) return cache.get(key);
		const row = await ctx.db
			.query("agents")
			.withIndex("by_org_normalized_name", (q) =>
				q
					.eq("orgSlug", slug as string)
					.eq("normalizedName", normalizeOrchestratorId(label)),
			)
			.first();
		cache.set(key, row?._id);
		return row?._id;
	};
	const stamped: Record<string, unknown> = { ...doc };
	for (const [label, column] of [
		["createdBy", "createdById"],
		["assignedTo", "assignedToId"],
		["lastAssignedTo", "lastAssignedToId"],
	] as const) {
		if (stamped[column] !== undefined) continue;
		const id = await idOf(doc[label]);
		if (id !== undefined) stamped[column] = id;
	}
	return await ctx.db.insert("tasks", stamped as never);
}

type AdminRunner = Runner & {
	withIdentity: (identity: never) => {
		mutation: (fn: never, args: never) => Promise<unknown>;
	};
};

/**
 * TEST FIXTURE ONLY. Mints a per-agent credential for the agent an org holds
 * under `label` (the row must exist and the org's mapping must carry its
 * clerkOrgId) and returns the secret. A registered agent acting without a proof
 * is refused AGENT_CREDENTIAL_REQUIRED, so a member that acts as an agent of its
 * org presents this.
 */
export async function mintAgentSecret(
	t: AdminRunner,
	orgSlug: string,
	label: string,
	clerkOrgId: string = testClerkOrgId(orgSlug),
): Promise<string> {
	const { api } = await import("../../convex/_generated/api");
	const agentId = await findAgentId(t, orgSlug, label);
	if (agentId === null) {
		throw new Error(`mintAgentSecret: ${orgSlug} holds no agent "${label}"`);
	}
	// An agent a test acts as, under a label its org's mapping lists by NAME, is
	// on the org's roster by ID (module M7 batch B).
	await t.run(async (ctx) => {
		await syncRosterIdsFromNames(ctx, orgSlug);
	});
	const admin = t.withIdentity({
		subject: `admin-of-${orgSlug}`,
		org_slug: orgSlug,
		org_id: clerkOrgId,
		org_role: "org:admin",
	} as never);
	const minted = (await admin.mutation(
		api.agentCredentials.mintAgentCredential as never,
		{ orgSlug, agentId } as never,
	)) as { secret: string };
	return minted.secret;
}

type Acting = {
	mutation: (fn: never, args: never, ...rest: never[]) => Promise<unknown>;
	query: (fn: never, args: never, ...rest: never[]) => Promise<unknown>;
};

/**
 * TEST FIXTURE ONLY. A caller that presents `secret` as the proof of the agent it
 * acts as: every task-door mutation (`tasks:*`, or the doors `only` matches) that
 * names a `callerOrchestrator` (or a `createdBy`) and carries no proof of its own
 * gets `agentCredentialSecret` added. Other functions pass through untouched
 * (they do not declare the argument).
 */
export function actingWith<A extends Acting>(
	acting: A,
	secret: string | ((name: string) => string | undefined),
	only: RegExp = /^tasks:/,
): A {
	const add = (fn: unknown, args: unknown): unknown => {
		if (typeof args !== "object" || args === null) return args;
		if (!only.test(getFunctionName(fn as never))) return args;
		const a = args as Record<string, unknown>;
		const names = a.callerOrchestrator ?? a.createdBy;
		// "system" is a word, not an agent: it carries no credential.
		if (
			names === undefined ||
			names === "system" ||
			a.agentCredentialSecret !== undefined ||
			a.verifiedActor !== undefined
		) {
			return args;
		}
		const proof = typeof secret === "string" ? secret : secret(String(names));
		if (proof === undefined) return args;
		return { ...a, agentCredentialSecret: proof };
	};
	return new Proxy(acting, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target) as unknown;
			if (prop === "mutation") {
				return (fn: never, args: never, ...rest: never[]) =>
					target.mutation(fn, add(fn, args) as never, ...rest);
			}
			return typeof value === "function"
				? (value as (...a: unknown[]) => unknown).bind(target)
				: value;
		},
	});
}

/**
 * TEST FIXTURE ONLY. Registers the agents of the given [orgSlug, label] pairs and
 * mints a credential for each (the org's mapping row must already exist with its
 * clerkOrgId). Returns `${orgSlug}/${label}` -> secret.
 */
export async function seedOrgAgents(
	t: AdminRunner,
	pairs: ReadonlyArray<readonly [orgSlug: string, label: string]>,
): Promise<Map<string, string>> {
	await t.run(async (ctx) => {
		for (const [orgSlug, name] of pairs) {
			await ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: 1,
			});
		}
		// Module M7 batch B: a member's acting agent and an assignee are held to the
		// org's roster BY AGENT ID. An agent a test registers under a label its org's
		// mapping lists by NAME is listed by ID too, so the legacy name roster a test
		// seeded keeps meaning what it meant.
		for (const orgSlug of new Set(pairs.map(([slug]) => slug))) {
			await syncRosterIdsFromNames(ctx, orgSlug);
		}
	});
	const secrets = new Map<string, string>();
	for (const [orgSlug, label] of pairs) {
		secrets.set(`${orgSlug}/${label}`, await mintAgentSecret(t, orgSlug, label));
	}
	return secrets;
}
