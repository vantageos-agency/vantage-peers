// linkServiceAccountAgent — turn the fleet service account from an environment
// value into DATA (module M2 part 2, step 1 of 2). EXPAND phase: this step
// only WRITES the stored rows; no request path reads them yet and the env var
// still decides every door. The operator org's mapping row now names the
// account, ready for the step that switches the doors to read it.
//
//   CLERK_SERVICE_ACCOUNT_USER_ID (read HERE, once)
//     -> agents row of the operator org  { kind: "service", authSubject, isActive }
//     -> client_org_mapping.serviceAccountAgentId on the operator row
//
// Step 2 (a separate change) makes `withOrgScope` and `requireServiceAccount`
// decide from the stored rows alone; this migration must have run before it.
//
// SHAPE. DRY RUN BY DEFAULT (`dryRun: false` writes). IDEMPOTENT: a mapping row
// whose column already names a service row carrying this subject is left
// untouched ("already-linked"); a column that names something else is NEVER
// overwritten ("blocked"). Every run prints the pre-state (console.log, one JSON
// line) and returns it, so the operator sees exactly what exists before a write.
//
//   npx convex run migrations/linkServiceAccountAgent:linkServiceAccountAgent
//   npx convex run migrations/linkServiceAccountAgent:linkServiceAccountAgent '{"dryRun":false}'
//   npx convex run migrations/linkServiceAccountAgent:linkServiceAccountAgent '{"dryRun":false,"subject":"user_..."}'
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { findOperatorOrg } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { assertAgentNameFree } from "../lib/agentIdentity";
import { lookupOrgMapping, orgMappingLookups } from "../lib/authOrgMapping";

export const SERVICE_ACCOUNT_AGENT_NAME = "fleet-service-account";

const preState = v.object({
	subject: v.union(v.string(), v.null()),
	operatorKind: v.string(),
	operatorSlug: v.union(v.string(), v.null()),
	operatorOrgId: v.union(v.string(), v.null()),
	column: v.union(v.id("agents"), v.null()),
	columnAgentExists: v.boolean(),
	columnAgentKind: v.union(v.string(), v.null()),
	columnAgentAuthSubject: v.union(v.string(), v.null()),
	columnAgentActive: v.union(v.boolean(), v.null()),
	serviceRowsForSubject: v.number(),
	nameTaken: v.boolean(),
});

export const linkServiceAccountAgent = internalMutation({
	args: { dryRun: v.optional(v.boolean()), subject: v.optional(v.string()) },
	returns: v.object({
		dryRun: v.boolean(),
		status: v.union(
			v.literal("already-linked"),
			v.literal("would-link"),
			v.literal("linked"),
			v.literal("blocked"),
		),
		reason: v.union(v.string(), v.null()),
		agentId: v.union(v.id("agents"), v.null()),
		createsAgent: v.boolean(),
		preState,
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		// The backfill source: the old environment value, read once.
		const subjectRaw =
			args.subject ?? process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
		const subject =
			subjectRaw !== undefined && subjectRaw !== "" ? subjectRaw : null;

		const operator = await findOperatorOrg(orgMappingLookups(ctx));
		const operatorOrgId =
			operator.kind === "one" ? (operator.org.id ?? null) : null;
		const mapping =
			operatorOrgId === null
				? null
				: await lookupOrgMapping(ctx, { clerkOrgId: operatorOrgId });
		const column = mapping?.serviceAccountAgentId ?? null;
		const columnAgent = column === null ? null : await ctx.db.get(column);
		const forSubject =
			subject === null
				? []
				: await ctx.db
						.query("agents")
						.withIndex("by_auth_subject_kind", (q) =>
							q.eq("authSubject", subject).eq("kind", "service"),
						)
						.take(8);
		// The org's labels are unique (assertAgentNameFree is the one implementation).
		let nameTaken = false;
		if (mapping !== null) {
			try {
				await assertAgentNameFree(
					ctx,
					mapping.clerkOrgSlug,
					SERVICE_ACCOUNT_AGENT_NAME,
				);
			} catch (err: unknown) {
				if (!(err instanceof ConvexError)) throw err;
				nameTaken = true;
			}
		}
		const pre = {
			subject,
			operatorKind: operator.kind,
			operatorSlug: operator.kind === "one" ? operator.org.label : null,
			operatorOrgId,
			column,
			columnAgentExists: columnAgent !== null,
			columnAgentKind: columnAgent?.kind ?? null,
			columnAgentAuthSubject: columnAgent?.authSubject ?? null,
			columnAgentActive: columnAgent?.isActive ?? null,
			serviceRowsForSubject: forSubject.length,
			nameTaken,
		};
		console.log(`linkServiceAccountAgent pre-state ${JSON.stringify(pre)}`);

		const blocked = (reason: string) => ({
			dryRun,
			status: "blocked" as const,
			reason,
			agentId: null,
			createsAgent: false,
			preState: pre,
		});
		if (subject === null) return blocked("subject-absent");
		if (mapping === null || operatorOrgId === null) {
			return blocked(`operator-org-${operator.kind}`);
		}

		if (column !== null) {
			if (
				columnAgent !== null &&
				columnAgent.kind === "service" &&
				columnAgent.authSubject === subject &&
				columnAgent.clerkOrgId === operatorOrgId
			) {
				return {
					dryRun,
					status: "already-linked" as const,
					reason: null,
					agentId: column,
					createsAgent: false,
					preState: pre,
				};
			}
			// Never overwrite a stored decision.
			return blocked("column-names-another-agent");
		}

		const existing = forSubject.find((r) => r.clerkOrgId === operatorOrgId);
		if (existing === undefined && forSubject.length > 0) {
			return blocked("subject-bound-to-another-org");
		}
		if (existing === undefined && nameTaken) return blocked("agent-name-taken");
		if (existing !== undefined && !existing.isActive) {
			return blocked("existing-service-row-inactive");
		}

		let agentId: Id<"agents"> | null = existing?._id ?? null;
		if (!dryRun) {
			agentId =
				agentId ??
				(await ctx.db.insert("agents", {
					orgSlug: mapping.clerkOrgSlug,
					clerkOrgId: operatorOrgId,
					name: SERVICE_ACCOUNT_AGENT_NAME,
					normalizedName: normalizeOrchestratorId(SERVICE_ACCOUNT_AGENT_NAME),
					description: "Fleet service account (the MCP server's Clerk user)",
					kind: "service",
					authSubject: subject,
					isActive: true,
					createdAt: Date.now(),
				}));
			await ctx.db.patch(mapping._id, { serviceAccountAgentId: agentId });
		}
		return {
			dryRun,
			status: dryRun ? ("would-link" as const) : ("linked" as const),
			reason: null,
			agentId,
			createsAgent: existing === undefined,
			preState: pre,
		};
	},
});
