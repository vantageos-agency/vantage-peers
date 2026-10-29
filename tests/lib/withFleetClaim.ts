import { type FunctionReference, getFunctionName } from "convex/server";
import { seedFleetAgents } from "./seedFleetAgents";

// TEST FIXTURE ONLY. M21 (task k1700vs1d5v3a82cgph88n5jbs8g6p8p): the doors below
// act inside a transport-verified identity, so the fleet service account is
// served only when the call carries the acting operator-organisation agent's
// `verifiedActor` (what the MCP transport forwards for an agent it verified).
// A suite that exercises the door's LOGIC as the fleet wraps its client here so
// each call to one of these doors carries that claim; the claimless refusal and
// the scoped poles live in convex/__tests__/unownedModules.twoPoles.test.ts.
// It forwards a claim only for the doors listed, only on `query`.

const CLAIM_DOORS: ReadonlySet<string> = new Set([
	"stats:orchestratorStats",
	"stats:openTaskCountsByOrchestrator",
	"stats:fleetStats",
	"improvisationDigest:scanWindow",
	"issueStatsQueries:getLatest",
	// R-54 (task k17er5a6yyccvxdh6gjcm5cand8fztkv): task reads no MCP tool calls.
	"tasks:listPaginated",
	"tasks:listUnlinkedBlocked",
	"tasks:listOverdue",
	"tasks:taskDurationDistribution",
]);

type Runner = {
	run: <R>(fn: (ctx: never) => Promise<R>) => Promise<R>;
	query: (ref: never, args: never) => Promise<unknown>;
};

export function withFleetClaim<T>(client: T): T {
	let actor: { agentId: string; orgSlug: string } | undefined;
	const resolveActor = async () => {
		if (actor !== undefined) return actor;
		const runner = client as unknown as Runner;
		const ids = await seedFleetAgents(
			runner as unknown as Parameters<typeof seedFleetAgents>[0],
			["sigma"],
		);
		const orgSlug = await (
			runner as unknown as {
				run: <R>(
					fn: (ctx: {
						db: {
							query: (t: string) => { collect: () => Promise<unknown[]> };
						};
					}) => Promise<R>,
				) => Promise<R>;
			}
		).run(async (ctx) => {
			const rows = (await ctx.db
				.query("client_org_mapping")
				.collect()) as Array<{
				isActive: boolean;
				orgKind?: string;
				clerkOrgSlug: string;
			}>;
			return rows.find((m) => m.isActive && m.orgKind === "operator")
				?.clerkOrgSlug as string;
		});
		actor = { agentId: ids.sigma, orgSlug };
		return actor;
	};
	return new Proxy(client as unknown as object, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target) as unknown;
			if (typeof value !== "function") return value;
			if (prop === "query") {
				return async (
					ref: FunctionReference<"query">,
					args: Record<string, unknown> = {},
				) => {
					const forward = CLAIM_DOORS.has(getFunctionName(ref));
					const callArgs = forward
						? { ...args, verifiedActor: await resolveActor() }
						: args;
					return (value as (...a: unknown[]) => unknown).call(
						target,
						ref,
						callArgs,
					);
				};
			}
			return (value as (...a: unknown[]) => unknown).bind(target);
		},
	}) as T;
}

/**
 * TEST FIXTURE ONLY. The `verifiedActor` claim of the operator-organisation agent
 * `label`, for a mutation the suite sends as the fleet service account (R-54: that
 * account is admitted only with a transport-verified claim). Seeds the fleet agent
 * when it does not exist and reads the operator org slug from the stored mapping.
 */
export async function fleetActorClaim(
	t: unknown,
	label: string,
): Promise<{ verifiedActor: { agentId: never; orgSlug: string } }> {
	const runner = t as {
		run: <R>(
			fn: (ctx: {
				db: {
					get: (id: never) => Promise<{ orgSlug: string } | null>;
				};
			}) => Promise<R>,
		) => Promise<R>;
	};
	const ids = await seedFleetAgents(
		runner as unknown as Parameters<typeof seedFleetAgents>[0],
		[label],
	);
	const agentId = ids[label] as never;
	const orgSlug = await runner.run(async (ctx) => {
		const row = await ctx.db.get(agentId);
		return row?.orgSlug as string;
	});
	return { verifiedActor: { agentId, orgSlug } };
}
