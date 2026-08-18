import { ConvexError, v } from "convex/values";
// convex-strict-mode-doc-type-import-needed-when-refactoring-list-query-from-early-return-to-accumulator-post-filter
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireScope, withOrgScope } from "./lib/auth";
import { requireId } from "./lib/ids";
import { creatorValidator } from "./schema";
import { computeStaleInProgress } from "./lib/taskClosureGate";

const staleInProgressValidator = v.array(
	v.object({
		taskId: v.id("tasks"),
		title: v.string(),
		age: v.number(),
	}),
);

// ─────────────────────────────────────────────────────────────────────────────
// sendMessage — send a message to one, many, or all orchestrators
// channel: "broadcast" | "tau" | "pi,phi" (comma-separated for multi)
// Creates one message row + one receipt per recipient.
// ─────────────────────────────────────────────────────────────────────────────

// Broadcast resolves dynamically from the profiles table.
// Any orchestrator with a profile receives broadcasts.
// No hardcoded list — new orchestrators are included automatically after calling update_profile.

export const sendMessage = mutation({
	args: {
		from: creatorValidator,
		fromInstanceId: v.optional(v.string()),
		channel: v.string(),
		content: v.string(),
		sessionDay: v.optional(v.number()),
		tenantId: v.optional(v.string()),
	},
	returns: v.id("messages"),
	handler: async (ctx, args) => {
		const messageId = await ctx.db.insert("messages", {
			from: args.from,
			fromInstanceId: args.fromInstanceId,
			channel: args.channel,
			content: args.content,
			sessionDay: args.sessionDay,
			tenantId: args.tenantId,
			createdAt: Date.now(),
		});

		// Resolve recipients — channel can be a role or instanceId
		// If channel contains "-" (e.g. "pi-vps"), treat as instance-level
		//
		// Bounce contract (task k17dr97dwpe07n9zfgzzypkfm18bv6ws): a channel that
		// resolves to ZERO real recipients — unknown role, non-existent instance,
		// reserved non-target word, empty string, or an unknown comma-list part
		// — is refused with an actionable ConvexError instead of silently
		// succeeding with no receipts written. The recipient set is DERIVED from
		// the org (the `profiles` table), never a hardcoded denylist — mirrors
		// the broadcast branch below.
		let recipients: string[];
		if (args.channel === "broadcast") {
			// Dynamic: get all registered orchestrators from profiles
			const profiles = await ctx.db.query("profiles").collect();
			const orchestratorIds = [
				...new Set(profiles.map((p) => p.orchestratorId)),
			];

			// Cross-tenant leak fix (mission fix-broadcast-org-scoped-v1, T1):
			// bound the broadcast fan-out to the EMITTER's own tenant, derived
			// from withOrgScope(ctx) — never from the client-supplied
			// args.tenantId (unauthenticated/self-declared, see T0 audit
			// analysis/broadcast-org-scope-audit-t0-day157.md). Resolved
			// FAIL-CLOSED (no allowNoIdentityMaster) — consistent with the
			// Day-156 SEC-AUDIT doctrine. The MCP server forwards its
			// service-account identity, which resolves to master via the
			// CLERK_SERVICE_ACCOUNT_USER_ID carve-out (lib/auth.ts:111-121),
			// so legitimate internal broadcasts still resolve to master. An
			// anonymous/no-identity caller resolves to isMaster=false with an
			// empty allowedOrchestrators, so it falls into the client branch
			// below and yields zero recipients — the existing zero-recipient
			// bounce fires (no fail-open path to the internal fleet).
			const scope = await withOrgScope(ctx);

			// convex-reviewer CRITICAL (mission fix-broadcast-org-scoped-v1, T1
			// REVISE): scope.isMaster is OVERLOADED — it is also true for a
			// CLIENT org whose client_org_mapping row carries the ["*"] read
			// sentinel (lib/auth.ts:182: isMaster =
			// allowedOrchestrators.includes("*")). Gating the fleet-wide
			// master branch on isMaster alone would let a client
			// (mis)configured with ["*"] fan out to the entire internal
			// fleet + other tenants. The true internal master (service
			// account / Laurent, lib/auth.ts:77-89 and :123-135) is the ONLY
			// case with orgSlug === null — a client's isMaster=true always
			// carries a set orgSlug (lib/auth.ts:177-183). So the
			// fleet-wide branch is gated on BOTH isMaster AND orgSlug===null;
			// this discriminant is applied locally here, not in lib/auth.ts
			// (shared type, out of scope for this fix).
			if (scope.isMaster && scope.orgSlug === null) {
				// True internal/master emitter: exclude every orchestrator bound
				// to any client tenant — active OR inactive — so an internal
				// broadcast never reaches a client orchestrator, the exact leak
				// reported in the T0 audit. Inactive mappings are included in
				// the exclusion set deliberately: an inactive client_org_mapping
				// row still identifies that orchestratorId as CLIENT-bound, not
				// internal — dropping the isActive filter here would let a
				// merely-disabled client's orchestrator silently rejoin the
				// internal broadcast pool, which is itself a leak class. This
				// is independent of whether that inactive org could ever
				// authenticate (it can't — withOrgScope throws Forbidden on
				// inactive orgs); the exclusion is about the identity of the
				// orchestratorId, not the org's ability to log in.
				const mappings = await ctx.db.query("client_org_mapping").collect();
				const clientBound = new Set<string>();
				for (const mapping of mappings) {
					for (const orchestratorId of mapping.allowedOrchestrators) {
						if (orchestratorId !== "*") clientBound.add(orchestratorId);
					}
				}
				recipients = orchestratorIds.filter(
					(o) => o !== args.from && !clientBound.has(o),
				);
			} else {
				// Client-scoped emitter (including a client-org isMaster=true
				// with orgSlug set — the ["*"] read-sentinel case): recipients
				// bounded to this org's own allowedOrchestrators — never
				// another tenant, never the internal fleet. A ["*"]
				// allowedOrchestrators list never matches a real
				// orchestratorId (the literal string "*" is not a
				// registered orchestrator), so this yields zero recipients
				// and the bounce below fires — fail-closed, not a leak.
				const allowed = new Set(scope.allowedOrchestrators);
				recipients = orchestratorIds.filter(
					(o) => o !== args.from && allowed.has(o),
				);
			}

			// Zero-recipient bounce contract (task k17dr97dwpe07n9zfgzzypkfm18bv6ws)
			// extends to the tenant-scoped broadcast: an anonymous/no-identity
			// caller resolves to isMaster=false with allowedOrchestrators=[],
			// so it would otherwise silently "succeed" with zero receipts
			// written. Fail-closed here means an explicit refusal, never a
			// fall-through to the internal fleet.
			if (recipients.length === 0) {
				throw new ConvexError(
					`recipient error / message non livré : "broadcast" ne correspond à aucun destinataire de l'organisation pour cet émetteur.`,
				);
			}
		} else {
			const profiles = await ctx.db.query("profiles").collect();
			const knownRoles = new Set(profiles.map((p) => p.orchestratorId));
			const knownInstances = new Set(
				profiles
					.map((p) => p.instanceId)
					.filter((id): id is string => id !== undefined),
			);

			const rawParts = args.channel
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);

			const bounce = () => {
				throw new ConvexError(
					`recipient error / message non livré : "${args.channel}" ne correspond à aucun destinataire de l'organisation. Formes valides : <role existant> | <instance> | broadcast | liste "eta,pi".`,
				);
			};

			if (rawParts.length === 0) {
				bounce();
			}
			for (const part of rawParts) {
				if (part === args.from) continue; // sender excluding itself never needs to resolve
				const isKnown = knownRoles.has(part) || knownInstances.has(part);
				if (!isKnown) {
					bounce();
				}
			}

			recipients = rawParts.filter((s) => s !== args.from);
			if (recipients.length === 0) {
				bounce();
			}
		}

		for (const recipient of recipients) {
			// Determine if this is an instance target or role target
			const isInstance = recipient.includes("-");
			const role = isInstance ? recipient.split("-")[0] : recipient;

			await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: role,
				recipientInstanceId: isInstance ? recipient : undefined,
				tenantId: args.tenantId,
				readAt: undefined,
			});
		}

		return messageId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// checkNewMessages — get unread messages for a recipient
// Returns messages with their receipt IDs (for marking as read).
// ─────────────────────────────────────────────────────────────────────────────

export const checkNewMessages = query({
	args: {
		recipient: creatorValidator,
		recipientInstanceId: v.optional(v.string()),
		tenantId: v.optional(v.string()),
		since: v.optional(v.number()), // Unix ms — only return receipts with _creationTime > since
	},
	returns: v.array(
		v.object({
			receiptId: v.id("messageReceipts"),
			messageId: v.id("messages"),
			from: creatorValidator,
			fromInstanceId: v.optional(v.string()),
			channel: v.optional(v.string()),
			content: v.string(),
			createdAt: v.number(),
		}),
	),
	// FROZEN CONTRACT — do not change this return shape. checkNewMessages is
	// intentionally left as a bare array for vp-mcp <2.12.0 callers ("no
	// break" — see mcp-server/CHANGELOG.md:40). The MCP server only calls
	// checkNewMessagesEnvelope in practice (mcp-server/src/tools.ts:2776);
	// staleInProgress (Day 130) is delivered there, not here. Protected by
	// convex/__tests__/staleInProgress.test.ts
	// "checkNewMessages frozen contract — returns a bare array".
	// tenantId filtering: when provided, only returns messages for that tenant.
	// When omitted, returns all messages (backward-compatible single-tenant mode).
	// This is intentional — omitting tenantId = admin/legacy access, not a bypass.
	handler: async (ctx, args) => {
		let receipts;

		if (args.recipientInstanceId !== undefined) {
			// Instance-level: get messages targeted at this specific instance
			// PLUS role-level messages (recipientInstanceId === undefined)
			const instanceReceipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_instance_unread", (q) =>
					q.eq("recipientInstanceId", args.recipientInstanceId!),
				)
				.filter((q) => {
					const base = q.eq(q.field("readAt"), undefined);
					return args.since !== undefined
						? q.and(base, q.gt(q.field("_creationTime"), args.since))
						: base;
				})
				.take(100);

			const roleReceipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_recipient_unread", (q) =>
					q.eq("recipient", args.recipient),
				)
				.filter((q) => {
					const base = q.and(
						q.eq(q.field("readAt"), undefined),
						q.eq(q.field("recipientInstanceId"), undefined),
					);
					return args.since !== undefined
						? q.and(base, q.gt(q.field("_creationTime"), args.since))
						: base;
				})
				.take(100);

			// Merge and deduplicate by receiptId
			const seen = new Set<string>();
			receipts = [];
			for (const r of [...instanceReceipts, ...roleReceipts]) {
				if (!seen.has(r._id)) {
					seen.add(r._id);
					receipts.push(r);
				}
			}

			// No tenant+instance index — JS filter is acceptable for instance-targeted messages (low volume)
			if (args.tenantId !== undefined) {
				receipts = receipts.filter((r) => r.tenantId === args.tenantId);
			}
		} else {
			// Role-level: get all unread for this role
			if (args.tenantId !== undefined) {
				receipts = await ctx.db
					.query("messageReceipts")
					.withIndex("by_tenant_recipient_unread", (q) =>
						q
							.eq("tenantId", args.tenantId)
							.eq("recipient", args.recipient)
							.eq("readAt", undefined),
					)
					.filter((q) =>
						args.since !== undefined
							? q.gt(q.field("_creationTime"), args.since)
							: true,
					)
					.take(100);
			} else {
				receipts = await ctx.db
					.query("messageReceipts")
					.withIndex("by_recipient_unread", (q) =>
						q.eq("recipient", args.recipient),
					)
					.filter((q) => {
						const base = q.eq(q.field("readAt"), undefined);
						return args.since !== undefined
							? q.and(base, q.gt(q.field("_creationTime"), args.since))
							: base;
					})
					.take(100);
			}
		}

		const results = [];
		for (const receipt of receipts) {
			const message = await ctx.db.get(receipt.messageId);
			if (message !== null) {
				results.push({
					receiptId: receipt._id,
					messageId: receipt.messageId,
					from: message.from,
					fromInstanceId: message.fromInstanceId,
					channel: message.channel,
					content: message.content,
					createdAt: message.createdAt,
				});
			}
		}

		return results;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// checkNewMessagesEnvelope — envelope-guarded variant of checkNewMessages.
//
// Day 102 — Pi BLOCKER task k1702xaahb: 36 unread messages = 53 KB of content
// exceeded the Claude Code tool-response cap and crashed the cron. This variant
// adds (a) a `limit` arg (default 20, clamp [1,50]), (b) a `maxBytes` arg
// (default 40_000, clamp [1_000, 60_000]) summing JSON.stringify(projected)
// per included row, (c) returns `{messages, truncated, nextSince}` so callers
// can resume via `since=nextSince` on the next tick.
//
// The legacy `checkNewMessages` is intentionally left intact for vp-mcp
// <2.12.0 consumers. New mcp-server >=2.12.0 calls THIS variant.
// ─────────────────────────────────────────────────────────────────────────────

export const checkNewMessagesEnvelope = query({
	args: {
		recipient: creatorValidator,
		recipientInstanceId: v.optional(v.string()),
		tenantId: v.optional(v.string()),
		since: v.optional(v.number()),
		limit: v.optional(v.number()),
		maxBytes: v.optional(v.number()),
	},
	returns: v.object({
		messages: v.array(
			v.object({
				receiptId: v.id("messageReceipts"),
				messageId: v.id("messages"),
				from: creatorValidator,
				fromInstanceId: v.optional(v.string()),
				channel: v.optional(v.string()),
				content: v.string(),
				createdAt: v.number(),
			}),
		),
		truncated: v.boolean(),
		nextSince: v.union(v.number(), v.null()),
		staleInProgress: staleInProgressValidator,
	}),
	handler: async (ctx, args) => {
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
		const maxBytes = Math.min(Math.max(args.maxBytes ?? 40_000, 1_000), 60_000);
		const takeBudget = limit + 1;

		let receipts: Doc<"messageReceipts">[];

		if (args.recipientInstanceId !== undefined) {
			const instanceReceipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_instance_unread", (q) =>
					q.eq("recipientInstanceId", args.recipientInstanceId!),
				)
				.filter((q) => {
					const base = q.eq(q.field("readAt"), undefined);
					return args.since !== undefined
						? q.and(base, q.gt(q.field("_creationTime"), args.since))
						: base;
				})
				.take(takeBudget);

			const roleReceipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_recipient_unread", (q) =>
					q.eq("recipient", args.recipient),
				)
				.filter((q) => {
					const base = q.and(
						q.eq(q.field("readAt"), undefined),
						q.eq(q.field("recipientInstanceId"), undefined),
					);
					return args.since !== undefined
						? q.and(base, q.gt(q.field("_creationTime"), args.since))
						: base;
				})
				.take(takeBudget);

			const seen = new Set<string>();
			receipts = [];
			for (const r of [...instanceReceipts, ...roleReceipts]) {
				if (!seen.has(r._id)) {
					seen.add(r._id);
					receipts.push(r);
				}
			}
			if (args.tenantId !== undefined) {
				receipts = receipts.filter((r) => r.tenantId === args.tenantId);
			}
		} else if (args.tenantId !== undefined) {
			receipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_tenant_recipient_unread", (q) =>
					q
						.eq("tenantId", args.tenantId!)
						.eq("recipient", args.recipient)
						.eq("readAt", undefined),
				)
				.filter((q) =>
					args.since !== undefined
						? q.gt(q.field("_creationTime"), args.since)
						: true,
				)
				.take(takeBudget);
		} else {
			receipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_recipient_unread", (q) =>
					q.eq("recipient", args.recipient),
				)
				.filter((q) => {
					const base = q.eq(q.field("readAt"), undefined);
					return args.since !== undefined
						? q.and(base, q.gt(q.field("_creationTime"), args.since))
						: base;
				})
				.take(takeBudget);
		}

		receipts.sort((a, b) => a._creationTime - b._creationTime);

		const messages: Array<{
			receiptId: Doc<"messageReceipts">["_id"];
			messageId: Doc<"messages">["_id"];
			from: Doc<"messages">["from"];
			fromInstanceId?: string;
			channel?: string;
			content: string;
			createdAt: number;
		}> = [];
		let bytes = 0;
		let truncated = false;
		let lastIncludedReceiptCreationTime: number | null = null;

		for (const receipt of receipts) {
			if (messages.length >= limit) {
				truncated = true;
				break;
			}
			const message = await ctx.db.get(receipt.messageId);
			if (message === null) continue;
			const projected = {
				receiptId: receipt._id,
				messageId: receipt.messageId,
				from: message.from,
				fromInstanceId: message.fromInstanceId,
				channel: message.channel,
				content: message.content,
				createdAt: message.createdAt,
			};
			const projectedBytes = JSON.stringify(projected).length;
			if (messages.length > 0 && bytes + projectedBytes > maxBytes) {
				truncated = true;
				break;
			}
			messages.push(projected);
			bytes += projectedBytes;
			lastIncludedReceiptCreationTime = receipt._creationTime;
		}

		const nextSince = truncated ? lastIncludedReceiptCreationTime : null;

		// Day 130 closure gate — surface the recipient's own overdue
		// in_progress work on every check_messages call, no extra cron. This
		// is the ONLY path staleInProgress is delivered on: mcp-server calls
		// exclusively checkNewMessagesEnvelope (tools.ts:2776); the legacy
		// checkNewMessages array contract stays frozen (see its own comment).
		const now = Date.now();
		const staleInProgress = await computeStaleInProgress(
			ctx,
			args.recipient,
			now,
		);

		return {
			messages,
			truncated,
			nextSince,
			staleInProgress,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// markAsRead — mark one or more receipts as read
// ─────────────────────────────────────────────────────────────────────────────

export const markAsRead = mutation({
	args: {
		// Accept raw strings (not v.id("messageReceipts")) so we can normalize
		// each element ourselves and throw an actionable ConvexError instead of
		// letting the v.id() validator reject before the handler runs. Convex
		// prod REDACTS non-ConvexError validator messages before they reach the
		// client (issue #1064) — only an explicitly-thrown ConvexError's .data
		// payload survives the wire.
		receiptIds: v.array(v.string()),
		// k179nrp3apj700pm0h1ckewm2h8b3nz7 — ownership gate. When provided, every
		// resolved receipt MUST belong to this recipient or the whole call is
		// rejected (RBAC_DENIED). Optional only to stay behavior-preserving for
		// legacy/system callers that predate the MCP-layer guard (mirrors the
		// deleteMessage callerOrchestrator pattern above); the MCP tool now
		// ALWAYS passes it (tools.ts mark_as_read), closing the cross-owner hole
		// where any caller could mark another orchestrator's mail read.
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		const normalizedIds = args.receiptIds.map((raw, index) =>
			requireId(
				ctx,
				"messageReceipts",
				raw,
				`receiptIds[${index}]`,
				"Use the full 32-char receiptId returned by check_messages.",
			),
		);

		const now = Date.now();
		let count = 0;
		for (const receiptId of normalizedIds) {
			const receipt = await ctx.db.get(receiptId);
			if (receipt === null) continue;
			if (
				args.callerOrchestrator !== undefined &&
				receipt.recipient !== args.callerOrchestrator
			) {
				throw new ConvexError(
					`RBAC_DENIED: ${args.callerOrchestrator} is not the recipient of receipt ${receiptId} — mark_as_read denied`,
				);
			}
			if (receipt.readAt === undefined) {
				await ctx.db.patch(receiptId, { readAt: now });
				count++;
			}
		}
		return count;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteMessage — delete a message and cascade-delete its receipts
// RBAC: only the sender or "system" may delete. Pass callerOrchestrator=undefined
// to bypass the check (server-to-server / admin use).
// ─────────────────────────────────────────────────────────────────────────────

export const deleteMessage = mutation({
	args: {
		messageId: v.id("messages"),
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.object({ deleted: v.boolean(), receiptsDeleted: v.number() }),
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.messageId);
		if (!message) throw new Error("Message not found");

		// RBAC: callerOrchestrator is required and must match message.from
		if (args.callerOrchestrator === undefined) {
			throw new Error(
				"Unauthorized: callerOrchestrator is required to delete a message — omitting it is refused, not exempted",
			);
		}
		if (
			args.callerOrchestrator !== "system" &&
			message.from !== args.callerOrchestrator
		) {
			throw new Error(
				`Unauthorized: only ${message.from} (sender) or system can delete this message`,
			);
		}

		// Cascade: delete all receipts for this message
		const receipts = await ctx.db
			.query("messageReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", args.messageId))
			.collect();

		for (const receipt of receipts) {
			await ctx.db.delete(receipt._id);
		}

		// Delete the message
		await ctx.db.delete(args.messageId);

		return { deleted: true, receiptsDeleted: receipts.length };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listMessages — get messages for a day or from a sender (history/replay)
// ─────────────────────────────────────────────────────────────────────────────

// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m). When
// paginating via `createdBefore`, the post-take filter only finds rows
// older than the cursor if the FETCH is wide enough to include them —
// mission k574p02m DEFECT 2, lot 2.
export const MESSAGES_LIST_SCAN_CAP = 2000;

export const listMessages = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		sessionDay: v.optional(v.number()),
		from: v.optional(creatorValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("messages"),
			_creationTime: v.number(),
			from: creatorValidator,
			fromInstanceId: v.optional(v.string()),
			channel: v.optional(v.string()),
			to: v.optional(creatorValidator),
			content: v.string(),
			sessionDay: v.optional(v.number()),
			createdAt: v.number(),
			// Day 98 Cat A k17e611z4 fix — issues #655, #644, #643. Multi-tenant
			// rows carry tenantId; returns shape must declare it or Convex
			// emits ReturnsValidationError "extra field tenantId".
			tenantId: v.optional(v.string()),
		}),
	),
	handler: async (ctx, args) => {
		// ── Identity-derived tenant scope ────────────────────────────────────────
		// m977mqck: no-identity callers (MCP server / CLI) → isMaster=true, all rows.
		// m9748paff: Clerk callers are fail-CLOSED — scoped to their own tenantId.
		// k179fk0c: same per-tool tenancy doctrine as tasks.list.
		const scope = await withOrgScope(ctx);
		requireScope(scope, "view-own-tasks");

		const limit = args.limit ?? 100;
		const before = args.createdBefore;
		const needsWideScan = before !== undefined;
		const fetchCap = needsWideScan ? MESSAGES_LIST_SCAN_CAP + 1 : limit;

		let rows: Doc<"messages">[];

		// Defense-in-depth (#776 Eta follow-up): degenerate !isMaster && orgSlug===null
		// is unreachable per withOrgScope invariant but explicit guard prevents regression.
		if (!scope.isMaster && scope.orgSlug === null) return [];

		if (!scope.isMaster && scope.orgSlug !== null) {
			// ── Clerk (non-master) path — tenant-scoped index ─────────────────────
			// Push tenantId equality BEFORE .take(limit) using by_tenant_created so
			// fleet (null-tenant) traffic cannot crowd out tenant rows in the window.
			// sessionDay and full-scan branches are intentionally merged here: Clerk
			// callers have no business querying a specific sessionDay of fleet traffic,
			// so we always use the tenant-scoped index and apply `from` as a post-index
			// .filter() (acceptable: within a single tenant, volume is low compared to
			// the full cross-tenant table). (task k176wgsrhha0fr0dxxahctvhw588q5a1,
			// Eta completeness edge from PR #775 verdict jn7563v34)
			const orgSlug = scope.orgSlug;
			rows = await ctx.db
				.query("messages")
				.withIndex("by_tenant_created", (q) => q.eq("tenantId", orgSlug))
				.order("desc")
				.filter((q) =>
					args.from !== undefined ? q.eq(q.field("from"), args.from) : true,
				)
				.take(fetchCap);

			// Belt-and-suspenders: ensure no cross-tenant row leaks through.
			rows = rows.filter((r) => r.tenantId === orgSlug);
		} else {
			// ── Master path — existing index logic, unchanged ──────────────────────
			if (args.sessionDay !== undefined) {
				const sessionDay = args.sessionDay;
				rows = await ctx.db
					.query("messages")
					.withIndex("by_day", (q) => q.eq("sessionDay", sessionDay))
					.order("asc")
					.take(fetchCap);
			} else if (args.from !== undefined) {
				const from = args.from;
				rows = await ctx.db
					.query("messages")
					.withIndex("by_from", (q) => q.eq("from", from))
					.order("desc")
					.take(fetchCap);
			} else {
				rows = await ctx.db.query("messages").order("desc").take(fetchCap);
			}
		}

		// S3.3 B8 follow-up batch 2 — drop rows newer-or-equal to anchor.
		if (before !== undefined) {
			rows = rows.filter((r) => r._creationTime < before);
		}

		return rows.slice(0, limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getUnreadCount — count unread receipts for a recipient role
// ─────────────────────────────────────────────────────────────────────────────

export const getUnreadCount = query({
	args: { orchestratorId: creatorValidator },
	returns: v.number(),
	handler: async (ctx, { orchestratorId }) => {
		const receipts = await ctx.db
			.query("messageReceipts")
			.withIndex("by_recipient_unread", (q) =>
				q.eq("recipient", orchestratorId),
			)
			.filter((q) => q.eq(q.field("readAt"), undefined))
			.take(500);
		return receipts.length;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listBroadcastStatus — show who read a broadcast message and who didn't
// ─────────────────────────────────────────────────────────────────────────────

export const listBroadcastStatus = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		messageId: v.id("messages"),
		// Fix for the "list_broadcast_status returns Server Error" incident: the
		// MCP wrapper (mcp-server/src/tools.ts) always sent `limit` even when the
		// caller omitted it, but this arg list previously did not declare it,
		// so Convex rejected EVERY call with ArgumentValidationError. `limit` is
		// now declared AND applied (see `truncated` below — a capped list never
		// looks complete).
		limit: v.optional(v.number()),
	},
	returns: v.object({
		messageId: v.id("messages"),
		from: creatorValidator,
		channel: v.optional(v.string()),
		createdAt: v.number(),
		receipts: v.array(
			v.object({
				recipient: v.string(),
				recipientInstanceId: v.optional(v.string()),
				read: v.boolean(),
				readAt: v.optional(v.number()),
			}),
		),
		// True when `limit` truncated the receipts list — "I showed you N of M"
		// must never render identically to "there are N".
		truncated: v.boolean(),
	}),
	handler: async (ctx, { messageId, limit }) => {
		const message = await ctx.db.get(messageId);
		if (!message) throw new Error("Message not found");

		// Deterministic order from the `by_message` index — no Date.now() here,
		// queries must stay reproducible for reactivity.
		const receipts = await ctx.db
			.query("messageReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", messageId))
			.collect();

		const mapped = receipts.map((r) => ({
			recipient: r.recipient,
			recipientInstanceId: r.recipientInstanceId,
			read: r.readAt !== undefined,
			readAt: r.readAt,
		}));

		const truncated = limit !== undefined && mapped.length > limit;
		const page = limit !== undefined ? mapped.slice(0, limit) : mapped;

		return {
			messageId,
			from: message.from,
			channel: message.channel,
			createdAt: message.createdAt,
			receipts: page,
			truncated,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByChannel — list recent messages for a channel (or all if unspecified)
// ─────────────────────────────────────────────────────────────────────────────

export const listByChannel = query({
	args: {
		channel: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("messages"),
			_creationTime: v.number(),
			from: creatorValidator,
			fromInstanceId: v.optional(v.string()),
			tenantId: v.optional(v.string()),
			channel: v.string(),
			content: v.string(),
			sessionDay: v.optional(v.number()),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, { channel, limit }) => {
		const take = limit ?? 100;
		const scope = await withOrgScope(ctx);

		// Fail-closed channel scoping: messages carry no orgId/tenantId column
		// (schema.ts), so channel-name proximity to the caller's own scope is the
		// only generic (non-hardcoded) signal available. A non-master, org-scoped
		// caller may only read: "broadcast" (universally shared), a channel
		// exactly matching one of its allowedOrchestrators, or one prefixed with
		// its own "team/<orgSlug>/" convention. Anything else is denied.
		const isChannelAllowed = (ch: string): boolean => {
			if (scope.isMaster) return true;
			if (ch === "broadcast") return true;
			if (scope.orgSlug !== null && ch.startsWith(`team/${scope.orgSlug}`)) {
				return true;
			}
			return scope.allowedOrchestrators.includes(ch);
		};

		if (channel !== undefined) {
			if (!isChannelAllowed(channel)) return [];
			return await ctx.db
				.query("messages")
				.withIndex("by_channel", (q) => q.eq("channel", channel))
				.order("desc")
				.take(take);
		}

		if (scope.isMaster) {
			return await ctx.db.query("messages").order("desc").take(take);
		}

		const rows = await ctx.db.query("messages").order("desc").take(take);
		return rows.filter((r) => isChannelAllowed(r.channel));
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 100 — Phase 2 get_by_id surface fix (task k172735brsw6bc3j2dkkkfxqrx88kkjq)
// Single-row read by Convex doc ID. Returns null on miss (MCP layer reshapes
// to scope-aware "not found"). No validator on returns — schema for messages
// rows varies by send variant; raw row is fine for read-by-id.
// ─────────────────────────────────────────────────────────────────────────────

export const getById = query({
	// A wrong-table but well-formed 32-char id passes the `v.id("messages")`
	// validator's format check yet fails table membership, and that rejection
	// happens BEFORE the handler, so a wrong-table ID is rejected with a message
	// Convex redacts in prod (`Server Error`, `error.data` undefined — measured).
	// Narrowing inside the handler via requireId() throws a ConvexError whose
	// payload survives redaction. Same contract as PR #1069 (markAsRead) and
	// #1072 (tasks:getById), on a read.
	args: { messageId: v.string() },
	handler: async (ctx, args) => {
		const messageId = requireId(
			ctx,
			"messages",
			args.messageId,
			"messageId",
			"Use the full 32-char messageId returned by list_messages or checkNewMessages.",
		);
		return await ctx.db.get(messageId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r).
// BM25 keyword search over message content via Convex native .searchIndex().
//
// Backed by the `search_content` searchIndex declared in schema.ts.
// Filter axes: from, channel, sessionDay, tenantId (matches messages.list()).
// ─────────────────────────────────────────────────────────────────────────────

export const searchMessagesByKeyword = query({
	args: {
		query: v.string(),
		from: v.optional(creatorValidator),
		channel: v.optional(v.string()),
		sessionDay: v.optional(v.number()),
		tenantId: v.optional(v.string()),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
	},
	handler: async (ctx, args) => {
		// ── Identity-derived tenant scope ────────────────────────────────────────
		// m977mqck: no-identity callers (MCP server / CLI) → isMaster=true, all rows.
		// m9748paff: Clerk callers are fail-CLOSED — scoped to their own tenantId.
		// k179fk0c: same per-tool tenancy doctrine as tasks.searchTasksByKeyword.
		const scope = await withOrgScope(ctx);
		requireScope(scope, "view-own-tasks");

		// Defense-in-depth (#776 Eta follow-up): degenerate !isMaster && orgSlug===null
		// is unreachable per withOrgScope invariant but explicit guard prevents regression.
		if (!scope.isMaster && scope.orgSlug === null) return [];

		const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
		const lite = args.fields === "lite";

		const results = await ctx.db
			.query("messages")
			.withSearchIndex("search_content", (q) => {
				let qb = q.search("content", args.query);
				if (args.from !== undefined) qb = qb.eq("from", args.from);
				if (args.channel !== undefined) qb = qb.eq("channel", args.channel);
				if (args.sessionDay !== undefined)
					qb = qb.eq("sessionDay", args.sessionDay);
				// For Clerk callers: push scope.orgSlug into the search index filter
				// (primary isolation). For master callers: use caller-supplied tenantId
				// if provided (backward-compatible narrow by tenant for admin queries).
				if (!scope.isMaster && scope.orgSlug !== null) {
					qb = qb.eq("tenantId", scope.orgSlug);
				} else if (args.tenantId !== undefined) {
					qb = qb.eq("tenantId", args.tenantId);
				}
				return qb;
			})
			.take(limit);

		// Defense-in-depth: messages have no pilot/assignedTo so filterByOrgScope()
		// does not fit. Enforce tenantId match inline for non-master scopes — the
		// index .eq("tenantId", scope.orgSlug) above is the primary isolation; this
		// is the belt-and-suspenders pass (mirrors briefingNotes pattern).
		const filtered = !scope.isMaster
			? results.filter((r) => r.tenantId === scope.orgSlug)
			: results;

		if (!lite) return filtered;
		return filtered.map((m) => ({
			_id: m._id,
			from: m.from,
			channel: m.channel,
			content: m.content,
			sessionDay: m.sessionDay,
			createdAt: m.createdAt,
		}));
	},
});
