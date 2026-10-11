// TEST FIXTURE ONLY. Converges the data that makes a subject the fleet service
// account (module M2 part 2): an `agents` row (kind "service", `authSubject` =
// the subject) that an operator org's `client_org_mapping` row names in
// `serviceAccountAgentId`. It is the state the migration
// (convex/migrations/linkServiceAccountAgent.ts) produces in production.
//
// Called by tests/fixtures/convexTestWithServiceAccount.ts (before a test calls
// Convex as the service account; a file opts in by importing that) and directly
// by tests that drive a handler with a hand-built ctx.
//
// Convergence, idempotent and safe to repeat:
//   - an operator row already names a service agent: nothing to do;
//   - active operator rows exist: link the oldest one (insert the agent, set the
//     column);
//   - no operator row: create the minimal one (slug TEST_OPERATOR_SLUG), link it;
//   - the test brought its own operator row after ours: ours is removed first.

import { testClerkOrgId } from "./testClerkOrgId";

const TEST_OPERATOR_SLUG = "test-operator-org";
const AGENT_NAME = "fleet-service-account";

export type RunCtx = {
	db: {
		query: (table: string) => { collect: () => Promise<Record<string, unknown>[]> };
		insert: (table: string, value: Record<string, unknown>) => Promise<string>;
		patch: (id: string, value: Record<string, unknown>) => Promise<void>;
		delete: (id: string) => Promise<void>;
	};
};

// The convex-test client (`t`): its `run` hands the callback a database ctx.
export type Runner = {
	// biome-ignore lint/suspicious/noExplicitAny: structural stand-in for convex-test's generic MutationCtx, narrowed to RunCtx inside
	run: (fn: (ctx: any) => Promise<any>) => Promise<unknown>;
};

export async function seedServiceAccount(
	root: Runner,
	subject: string,
): Promise<void> {
	await root.run(async (ctx: RunCtx) => {
		const rows = await ctx.db.query("client_org_mapping").collect();
		const activeOperators = () =>
			rows.filter((r) => r.orgKind === "operator" && r.isActive === true);
		const ours = rows.find((r) => r.clerkOrgSlug === TEST_OPERATOR_SLUG);
		const others = activeOperators().filter((r) => r !== ours);
		if (ours !== undefined && others.length > 0) {
			const agentId = ours.serviceAccountAgentId;
			await ctx.db.delete(ours._id as string);
			if (typeof agentId === "string") await ctx.db.delete(agentId);
			rows.splice(rows.indexOf(ours), 1);
		}
		let operators = activeOperators();
		if (operators.length === 0) {
			const id = await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: TEST_OPERATOR_SLUG,
				clerkOrgId: testClerkOrgId(TEST_OPERATOR_SLUG),
				allowedOrchestrators: [],
				scopes: [],
				displayName: TEST_OPERATOR_SLUG,
				isActive: true,
				createdAt: Date.now(),
				orgKind: "operator",
			});
			const created = (await ctx.db.query("client_org_mapping").collect()).find(
				(r) => r._id === id,
			);
			operators = created === undefined ? [] : [created];
		}
		if (operators.length === 0) return;
		if (operators.some((o) => o.serviceAccountAgentId !== undefined)) return;
		const operator = operators[0];
		const slug = operator.clerkOrgSlug as string;
		const orgId =
			typeof operator.clerkOrgId === "string"
				? operator.clerkOrgId
				: testClerkOrgId(slug);
		if (operator.clerkOrgId === undefined) {
			await ctx.db.patch(operator._id as string, { clerkOrgId: orgId });
		}
		const agentId = await ctx.db.insert("agents", {
			orgSlug: slug,
			clerkOrgId: orgId,
			name: AGENT_NAME,
			normalizedName: AGENT_NAME,
			kind: "service",
			authSubject: subject,
			isActive: true,
			createdAt: Date.now(),
		});
		await ctx.db.patch(operator._id as string, {
			serviceAccountAgentId: agentId,
		});
	});
}

