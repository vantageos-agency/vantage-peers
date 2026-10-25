import { sameOrg } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { normalizeOrchestratorId } from "./_helpers/normalizeOrchestratorId";
import {
	type OrgScope,
	ORG_ADMIN_ROLES,
	isOrchestratorOnOrgRoster,
	lookupOrgMapping,
	proveOrgAdmin,
	requireAgentCredentialMatch,
	requireOrchestratorOnRoster,
	requireResolvedCaller,
	verifiedActorValidator,
	withOrgScope,
} from "./lib/auth";
import {
	buildTurnFrame,
	type CloseReason,
	closeReasonValidator,
	type DebateSettings,
	type DebateTemplate,
	debateRoomFields,
	debateSettingsValidator,
	debateTemplateFields,
	debateTemplateValidator,
	debateTurnFields,
	effectiveDeadlineSeconds,
	type FrameTurn,
	initialParticipantState,
	nextStep,
	type ParticipantState,
	type RefusalReason,
	refusalReasonValidator,
	validateSettings,
	validateTemplate,
} from "./lib/debateTemplate";
import { isHumanActorName, memberActorOf, resolveHumanActor } from "./lib/humanActor";

// ─────────────────────────────────────────────────────────────────────────────
// Debate room: the functions. Design: sigma-scratch/debate/design.md.
//
// SINGLE WRITER. Rows of `debateTurns` are inserted by `appendTurn` below, the one
// statement that inserts into the turns table, and only the four callers
// named in `TurnWriter` reach it: `postTurn` (answers, operator turns, refusals),
// `expireTurn` (skips and drops), `closeRoom` (the operator's stop) and
// `deliverTurn` (a `system` row when a delivery fails). Every other close goes
// through `resolveAndAdvance`, which is called by `postTurn` / `expireTurn`.
//
// IDENTITY. Nobody is named by an argument. The caller is resolved from the
// credential by the existing tenant scoping (`withOrgScope`): a dashboard
// person is `user:<verified subject>` in the room's organisation (compared by
// permanent org ID); an agent is the `agents` row a `verifiedActor` names, which
// `requireAgentCredentialMatch` believes from the fleet service account only.
// Participants, order, wording and every limit are DATA read from the room's
// FROZEN template / settings copies; this file holds no participant name, no
// channel, no voice and no limit constant. The one number below,
// `TURN_READ_BOUND`, bounds a transaction read, not a business rule.
// ─────────────────────────────────────────────────────────────────────────────

type TurnWriter = Doc<"debateTurns">["writer"];

/** Upper bound on turn rows read in one transaction (a read bound, not a limit of the product). */
const TURN_READ_BOUND = 2000;
const TEMPLATE_LIST_BOUND = 200;

const refusedValidator = v.object({
	refused: refusalReasonValidator,
	awaiting: v.union(v.string(), v.null()),
	turnSeq: v.number(),
});

const acceptedValidator = v.object({
	accepted: v.literal(true),
	turnSeq: v.number(),
	closed: v.boolean(),
	closeReason: v.optional(closeReasonValidator),
	workDuringTurn: v.string(),
});

const roomDocValidator = v.object({
	_id: v.id("debateRooms"),
	_creationTime: v.number(),
	...debateRoomFields,
});

const turnDocValidator = v.object({
	_id: v.id("debateTurns"),
	_creationTime: v.number(),
	...debateTurnFields,
});

// ── refusals ────────────────────────────────────────────────────────────────

/** `RBAC_DENIED`, said in the backend's wire shape: the code as prefix, {reason, door} as payload. */
function refuse(door: string, reason: string, detail: string): never {
	throw new ConvexError(
		`RBAC_DENIED: ${detail} — ${JSON.stringify({ reason, door })}`,
	);
}

function refuseData(code: string, detail: unknown): never {
	throw new ConvexError(`${code}: ${JSON.stringify(detail)}`);
}

// ── caller resolution ───────────────────────────────────────────────────────

type Tenant = { orgSlug: string; orgId: string };

/** A tenant door needs a resolved organisation with a permanent ID. */
function tenantOf(scope: OrgScope, door: string): Tenant {
	if (scope.orgSlug === null || scope.orgClerkId === undefined) {
		return refuse(
			door,
			"no-organisation",
			`"${door}" works inside one organisation and the caller resolves to none`,
		);
	}
	return { orgSlug: scope.orgSlug, orgId: scope.orgClerkId };
}

type Caller =
	| { kind: "person"; actor: string; orgId: string; orgRole: string | undefined }
	| { kind: "agent"; agent: Doc<"agents"> }
	| { kind: "none" };

/**
 * Who is calling a room door. An agent is the row a `verifiedActor` names (a
 * scoped member presenting one is refused `verified-actor-not-trusted`); a
 * person is a resolved member of an organisation. Anything else is `none`, which
 * is a participant of no room.
 */
async function resolveCaller(
	ctx: QueryCtx | MutationCtx,
	scope: OrgScope,
	verifiedActor: { agentId: Id<"agents">; orgSlug: string } | undefined,
): Promise<Caller> {
	if (verifiedActor !== undefined) {
		await requireAgentCredentialMatch(ctx, undefined, undefined, null, {
			scope,
			verifiedActor,
		});
		const agent = await ctx.db.get(verifiedActor.agentId);
		return agent === null ? { kind: "none" } : { kind: "agent", agent };
	}
	if (!scope.isMaster && scope.orgSlug !== null && scope.orgClerkId !== undefined) {
		return {
			kind: "person",
			actor: memberActorOf(scope),
			orgId: scope.orgClerkId,
			orgRole: scope.orgRole,
		};
	}
	return { kind: "none" };
}

/** The participant of `room` the caller is, or undefined. Organisations are compared by ID. */
function participantOf(
	room: Doc<"debateRooms">,
	caller: Caller,
): DebateTemplate["participants"][number] | undefined {
	if (caller.kind === "agent") {
		if (!sameOrg({ id: caller.agent.clerkOrgId }, { id: room.tenantOrgId })) {
			return undefined;
		}
		const name = normalizeOrchestratorId(caller.agent.name);
		return room.template.participants.find(
			(p) =>
				p.kind === "agent" &&
				p.channel !== undefined &&
				normalizeOrchestratorId(p.channel) === name,
		);
	}
	if (caller.kind === "person") {
		if (!sameOrg({ id: caller.orgId }, { id: room.tenantOrgId })) return undefined;
		return room.template.participants.find(
			(p) => p.kind === "human" && (p.channel ?? room.createdById) === caller.actor,
		);
	}
	return undefined;
}

/** The room's creator, or an administrator of the room's organisation. */
function isOperatorOf(room: Doc<"debateRooms">, caller: Caller): boolean {
	if (caller.kind !== "person") return false;
	if (!sameOrg({ id: caller.orgId }, { id: room.tenantOrgId })) return false;
	return (
		caller.actor === room.createdById ||
		(caller.orgRole !== undefined && ORG_ADMIN_ROLES.includes(caller.orgRole))
	);
}

async function settingsRow(
	ctx: QueryCtx | MutationCtx,
	orgId: string,
): Promise<Doc<"debateSettings"> | null> {
	return await ctx.db
		.query("debateSettings")
		.withIndex("by_tenantOrgId", (q) => q.eq("tenantOrgId", orgId))
		.first();
}

function settingsOf(row: Doc<"debateSettings">): DebateSettings {
	return {
		maxRoundLimit: row.maxRoundLimit,
		maxParticipants: row.maxParticipants,
		maxRefusalRows: row.maxRefusalRows,
		maxTurnMessageChars: row.maxTurnMessageChars,
		pollSeconds: row.pollSeconds,
		maxAnswerCharsCeiling: row.maxAnswerCharsCeiling,
	};
}

async function requireSettings(
	ctx: QueryCtx | MutationCtx,
	orgId: string,
): Promise<DebateSettings> {
	const row = await settingsRow(ctx, orgId);
	if (row === null) {
		return refuseData("DEBATE_SETTINGS_MISSING", {
			reason: "this organisation has no debate settings row; the mechanism holds no default limits",
		});
	}
	return settingsOf(row);
}

// ── the single writer of turn rows ──────────────────────────────────────────

type TurnInsert = Omit<Doc<"debateTurns">, "_id" | "_creationTime">;

async function appendTurn(ctx: MutationCtx, row: TurnInsert): Promise<void> {
	await ctx.db.insert("debateTurns", row);
}

async function loadTurns(
	ctx: QueryCtx | MutationCtx,
	roomId: Id<"debateRooms">,
): Promise<Doc<"debateTurns">[]> {
	return await ctx.db
		.query("debateTurns")
		.withIndex("by_room_seq", (q) => q.eq("roomId", roomId))
		.take(TURN_READ_BOUND);
}

/**
 * The turn at the pointer is resolved and `state` already reflects it: close
 * the room (final `system` row with its reason) or move the pointer and schedule
 * the next delivery.
 */
async function resolveAndAdvance(
	ctx: MutationCtx,
	room: Doc<"debateRooms">,
	state: ParticipantState[],
	writer: "postTurn" | "expireTurn",
): Promise<{ closed: boolean; closeReason?: CloseReason }> {
	const step = nextStep(room.template, state, room.round, room.position);
	const now = Date.now();
	if (step.kind === "close") {
		await appendTurn(ctx, {
			roomId: room._id,
			turnSeq: room.turnSeq,
			round: room.round,
			position: room.position,
			kind: "system",
			writer,
			text: `room closed: ${step.reason}`,
			reason: step.reason,
			postedAt: now,
		});
		await ctx.db.patch(room._id, {
			status: "closed",
			closeReason: step.reason,
			closedAt: now,
			awaiting: undefined,
			participantState: state,
		});
		return { closed: true, closeReason: step.reason };
	}
	const next: ParticipantState[] = step.newRound
		? state.map((s) => ({
				participantId: s.participantId,
				consecutiveSkips: s.consecutiveSkips,
				dropped: s.dropped,
			}))
		: state;
	const turnSeq = room.turnSeq + 1;
	await ctx.db.patch(room._id, {
		round: step.round,
		position: step.position,
		turnSeq,
		awaiting: { participantId: room.template.participants[step.position].id },
		participantState: next,
	});
	await ctx.scheduler.runAfter(0, internal.debate.deliverTurn, {
		roomId: room._id,
		turnSeq,
	});
	return { closed: false };
}

// ── settings and templates (data, tenant-scoped) ────────────────────────────

export const getSettings = query({
	args: {},
	returns: v.union(debateSettingsValidator, v.null()),
	handler: async (ctx) => {
		const door = "debate:getSettings";
		const scope = await withOrgScope(ctx, { operatorAsMember: true });
		requireResolvedCaller(scope, door);
		const tenant = tenantOf(scope, door);
		const row = await settingsRow(ctx, tenant.orgId);
		return row === null ? null : settingsOf(row);
	},
});

export const upsertSettings = mutation({
	args: debateSettingsValidator.fields,
	returns: v.null(),
	handler: async (ctx, args) => {
		const door = "debate:upsertSettings";
		const scope = await withOrgScope(ctx, { operatorAsMember: true });
		requireResolvedCaller(scope, door);
		const tenant = tenantOf(scope, door);
		await proveOrgAdmin(ctx, await ctx.auth.getUserIdentity(), tenant.orgSlug, door);
		const issues = validateSettings(args);
		if (issues.length > 0) return refuseData("DEBATE_SETTINGS_INVALID", issues);
		const existing = await settingsRow(ctx, tenant.orgId);
		const fields = {
			tenantId: tenant.orgSlug,
			tenantOrgId: tenant.orgId,
			...args,
			updatedBy: memberActorOf(scope),
			updatedAt: Date.now(),
		};
		if (existing === null) await ctx.db.insert("debateSettings", fields);
		else await ctx.db.replace(existing._id, fields);
		return null;
	},
});

export const listTemplates = query({
	args: {},
	returns: v.array(
		v.object({
			_id: v.id("debateTemplates"),
			_creationTime: v.number(),
			...debateTemplateFields,
		}),
	),
	handler: async (ctx) => {
		const door = "debate:listTemplates";
		const scope = await withOrgScope(ctx, { operatorAsMember: true });
		requireResolvedCaller(scope, door);
		const tenant = tenantOf(scope, door);
		const rows = await ctx.db
			.query("debateTemplates")
			.withIndex("by_tenantOrgId_and_templateKey", (q) =>
				q.eq("tenantOrgId", tenant.orgId),
			)
			.take(TEMPLATE_LIST_BOUND);
		return rows;
	},
});

export const upsertTemplate = mutation({
	args: { template: debateTemplateValidator },
	returns: v.id("debateTemplates"),
	handler: async (ctx, args) => {
		const door = "debate:upsertTemplate";
		const scope = await withOrgScope(ctx, { operatorAsMember: true });
		requireResolvedCaller(scope, door);
		const tenant = tenantOf(scope, door);
		await proveOrgAdmin(ctx, await ctx.auth.getUserIdentity(), tenant.orgSlug, door);
		const settings = await requireSettings(ctx, tenant.orgId);
		const issues = validateTemplate(args.template, settings);
		if (issues.length > 0) return refuseData("DEBATE_TEMPLATE_INVALID", issues);
		const existing = await ctx.db
			.query("debateTemplates")
			.withIndex("by_tenantOrgId_and_templateKey", (q) =>
				q.eq("tenantOrgId", tenant.orgId).eq("templateKey", args.template.id),
			)
			.first();
		const fields = {
			tenantId: tenant.orgSlug,
			tenantOrgId: tenant.orgId,
			templateKey: args.template.id,
			template: args.template,
			updatedBy: memberActorOf(scope),
			updatedAt: Date.now(),
		};
		if (existing === null) return await ctx.db.insert("debateTemplates", fields);
		await ctx.db.replace(existing._id, fields);
		return existing._id;
	},
});

// ── rooms ───────────────────────────────────────────────────────────────────

export const createRoom = mutation({
	args: { templateId: v.id("debateTemplates"), subject: v.string() },
	returns: v.id("debateRooms"),
	handler: async (ctx, args) => {
		const door = "debate:createRoom";
		const scope = await withOrgScope(ctx, { operatorAsMember: true });
		requireResolvedCaller(scope, door);
		const tenant = tenantOf(scope, door);
		// The creator is the verified person in its own organisation, with a writer
		// role: the same human gate every dashboard write door runs.
		const actor = await resolveHumanActor(ctx, scope, { door });

		// Another tenant's template answers like a missing one.
		const templateRow = await ctx.db.get(args.templateId);
		if (templateRow === null || templateRow.tenantOrgId !== tenant.orgId) {
			return refuseData("DEBATE_TEMPLATE_NOT_FOUND", { templateId: args.templateId });
		}
		const settings = await requireSettings(ctx, tenant.orgId);
		const subject = args.subject.trim();
		if (subject.length === 0 || subject.length > settings.maxAnswerCharsCeiling) {
			return refuseData("DEBATE_SUBJECT_INVALID", {
				reason: `subject must be 1..${settings.maxAnswerCharsCeiling} characters`,
			});
		}
		// The template is judged against the limits of today, not of the day it was saved.
		const template = templateRow.template;
		const issues = validateTemplate(template, settings);
		if (issues.length > 0) return refuseData("DEBATE_TEMPLATE_INVALID", issues);
		for (const p of template.participants) {
			if (p.kind === "agent" && p.channel !== undefined) {
				requireOrchestratorOnRoster(scope, p.channel, door, "participant");
			}
			if (p.kind === "human" && p.channel !== undefined && !isHumanActorName(p.channel)) {
				return refuseData("DEBATE_TEMPLATE_INVALID", [
					{
						path: `participants.${p.id}.channel`,
						message: 'a human seat\'s channel must be a person ("user:<subject>") or absent (the creator)',
					},
				]);
			}
		}

		const roomId = await ctx.db.insert("debateRooms", {
			tenantId: tenant.orgSlug,
			tenantOrgId: tenant.orgId,
			templateId: templateRow._id,
			template,
			settings,
			subject,
			status: "active",
			round: 1,
			position: 0,
			turnSeq: 1,
			awaiting: { participantId: template.participants[0].id },
			participantState: initialParticipantState(template),
			createdBy: actor,
			createdById: actor,
			createdAt: Date.now(),
			refusalRows: 0,
			refusalsOverflow: 0,
		});
		await ctx.scheduler.runAfter(0, internal.debate.deliverTurn, {
			roomId,
			turnSeq: 1,
		});
		return roomId;
	},
});

export const getRoom = query({
	args: {
		roomId: v.id("debateRooms"),
		verifiedActor: v.optional(verifiedActorValidator),
	},
	returns: v.union(
		v.null(),
		v.object({ room: roomDocValidator, turns: v.array(turnDocValidator) }),
	),
	handler: async (ctx, args) => {
		const door = "debate:getRoom";
		const scope = await withOrgScope(ctx, { operatorAsMember: true });
		requireResolvedCaller(scope, door);
		const caller = await resolveCaller(ctx, scope, args.verifiedActor);
		const room = await ctx.db.get(args.roomId);
		// A room the caller may not see answers like a room that does not exist.
		if (room === null) return null;
		if (!isOperatorOf(room, caller) && participantOf(room, caller) === undefined) {
			return null;
		}
		return { room, turns: await loadTurns(ctx, room._id) };
	},
});

export const closeRoom = mutation({
	args: {
		roomId: v.id("debateRooms"),
		verifiedActor: v.optional(verifiedActorValidator),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const door = "debate:closeRoom";
		const scope = await withOrgScope(ctx, { operatorAsMember: true });
		requireResolvedCaller(scope, door);
		const caller = await resolveCaller(ctx, scope, args.verifiedActor);
		const room = await ctx.db.get(args.roomId);
		// One refusal for a participant, another tenant and a room that is not there.
		if (room === null || !isOperatorOf(room, caller)) {
			return refuse(
				door,
				"not_operator",
				"only the room's creator or an administrator of its organisation may stop it",
			);
		}
		if (room.status === "closed") return null;
		const now = Date.now();
		await appendTurn(ctx, {
			roomId: room._id,
			turnSeq: room.turnSeq,
			round: room.round,
			position: room.position,
			kind: "system",
			writer: "closeRoom",
			text: "room closed: operator_stop",
			reason: "operator_stop",
			postedAt: now,
		});
		await ctx.db.patch(room._id, {
			status: "closed",
			closeReason: "operator_stop",
			closedAt: now,
			awaiting: undefined,
		});
		return null;
	},
});

// ── the turn rule (design section 2) ────────────────────────────────────────

export const postTurn = mutation({
	args: {
		roomId: v.id("debateRooms"),
		turnSeq: v.number(),
		text: v.string(),
		done: v.optional(v.boolean()),
		verifiedActor: v.optional(verifiedActorValidator),
	},
	returns: v.union(refusedValidator, acceptedValidator),
	handler: async (ctx, args) => {
		const door = "debate:postTurn";
		const scope = await withOrgScope(ctx, { operatorAsMember: true });
		requireResolvedCaller(scope, door);
		const caller = await resolveCaller(ctx, scope, args.verifiedActor);
		const room = await ctx.db.get(args.roomId);

		// Not a participant (or no such room): refused with nothing about the room,
		// and nothing written.
		const participant = room === null ? undefined : participantOf(room, caller);
		if (room === null || participant === undefined) {
			return {
				refused: "not_a_participant" as const,
				awaiting: null,
				turnSeq: room === null ? args.turnSeq : room.turnSeq,
			};
		}

		const awaitingLabel =
			room.awaiting === undefined
				? null
				: (room.template.participants.find((p) => p.id === room.awaiting?.participantId)
						?.label ?? null);
		const refusal = (reason: RefusalReason) => ({
			refused: reason,
			awaiting: awaitingLabel,
			turnSeq: room.turnSeq,
		});

		if (room.status === "closed") return refusal("room_closed");
		if (room.status === "stalled") return refusal("room_stalled");

		const text = args.text.trim();
		let reason: RefusalReason | undefined;
		if (args.turnSeq !== room.turnSeq) reason = "stale_turn";
		else if (room.awaiting?.participantId !== participant.id) reason = "not_your_turn";
		else if (text.length === 0) reason = "empty";
		else if (text.length > room.template.maxAnswerChars) reason = "too_long";

		if (reason !== undefined) {
			// A refusal is visible to the operator, up to the room's own cap; past it only counted.
			if (room.refusalRows < room.settings.maxRefusalRows) {
				await appendTurn(ctx, {
					roomId: room._id,
					turnSeq: room.turnSeq,
					round: room.round,
					position: room.position,
					participantId: participant.id,
					kind: "refused",
					writer: "postTurn",
					reason,
					postedAt: Date.now(),
				});
				await ctx.db.patch(room._id, { refusalRows: room.refusalRows + 1 });
			} else {
				await ctx.db.patch(room._id, { refusalsOverflow: room.refusalsOverflow + 1 });
			}
			return refusal(reason);
		}

		const isAgent = participant.kind === "agent";
		// No index on `tasks` by creator exists, so what an agent did during its turn
		// cannot be judged here: said so, never reported as clean.
		const workDuringTurn = isAgent ? "could_not_judge" : "not_applicable";
		await appendTurn(ctx, {
			roomId: room._id,
			turnSeq: room.turnSeq,
			round: room.round,
			position: room.position,
			participantId: participant.id,
			kind: isAgent ? "answer" : "operator",
			writer: "postTurn",
			text,
			...(isAgent ? { done: args.done === true, workDuringTurn } : {}),
			postedAt: Date.now(),
		});
		const state = room.participantState.map((s) =>
			s.participantId === participant.id && isAgent
				? {
						participantId: s.participantId,
						consecutiveSkips: 0,
						dropped: s.dropped,
						roundKind: "answer" as const,
						roundDone: args.done === true,
					}
				: s,
		);
		const outcome = await resolveAndAdvance(ctx, room, state, "postTurn");
		return {
			accepted: true as const,
			turnSeq: args.turnSeq,
			closed: outcome.closed,
			...(outcome.closeReason !== undefined ? { closeReason: outcome.closeReason } : {}),
			workDuringTurn,
		};
	},
});

// ── scheduled: delivery and the deadline (design sections 2, 3) ─────────────

async function stallRoom(
	ctx: MutationCtx,
	room: Doc<"debateRooms">,
	reason: string,
): Promise<void> {
	await appendTurn(ctx, {
		roomId: room._id,
		turnSeq: room.turnSeq,
		round: room.round,
		position: room.position,
		kind: "system",
		writer: "deliverTurn",
		text: `delivery failed: ${reason}`,
		postedAt: Date.now(),
	});
	await ctx.db.patch(room._id, { status: "stalled" });
}

export const deliverTurn = internalMutation({
	args: { roomId: v.id("debateRooms"), turnSeq: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const room = await ctx.db.get(args.roomId);
		// Late, duplicate or for a finished room: nothing to send.
		if (
			room === null ||
			room.status !== "active" ||
			room.turnSeq !== args.turnSeq ||
			room.awaiting === undefined ||
			room.awaiting.deliveredAt !== undefined
		) {
			return null;
		}
		const awaitingId = room.awaiting.participantId;
		const participant = room.template.participants.find((p) => p.id === awaitingId);
		if (participant === undefined) {
			await stallRoom(ctx, room, `participant ${awaitingId} is not in the room's template`);
			return null;
		}
		const now = Date.now();
		const seconds = effectiveDeadlineSeconds(room.template, participant);
		const deadlineAt = seconds === null ? undefined : now + seconds * 1000;
		const scheduleExpiry = async () => {
			if (seconds !== null) {
				await ctx.scheduler.runAfter(seconds * 1000, internal.debate.expireTurn, {
					roomId: room._id,
					turnSeq: room.turnSeq,
				});
			}
		};

		// A human seat is not messaged: it is shown as waiting on the page.
		if (participant.kind === "human") {
			await ctx.db.patch(room._id, {
				awaiting: {
					participantId: awaitingId,
					deliveredAt: now,
					...(deadlineAt !== undefined ? { deadlineAt } : {}),
				},
			});
			await scheduleExpiry();
			return null;
		}

		const channel = participant.channel;
		const mapping = await lookupOrgMapping(ctx, { clerkOrgId: room.tenantOrgId });
		if (channel === undefined) {
			await stallRoom(ctx, room, `participant "${participant.label}" has no channel`);
			return null;
		}
		if (mapping === null || !mapping.isActive) {
			await stallRoom(ctx, room, "the room's organisation is not an active organisation");
			return null;
		}
		if (!isOrchestratorOnOrgRoster(mapping, channel)) {
			await stallRoom(
				ctx,
				room,
				`"${channel}" is not on the roster of org "${mapping.clerkOrgSlug}"`,
			);
			return null;
		}

		const labelOf = new Map(room.template.participants.map((p) => [p.id, p.label]));
		const turns: FrameTurn[] = (await loadTurns(ctx, room._id)).map((t) => ({
			round: t.round,
			position: t.position + 1,
			label:
				t.participantId === undefined
					? "system"
					: (labelOf.get(t.participantId) ?? t.participantId),
			kind: t.kind,
			...(t.text !== undefined ? { text: t.text } : {}),
			...(t.reason !== undefined ? { reason: t.reason } : {}),
		}));
		const frame = buildTurnFrame({
			roomId: room._id,
			turnSeq: room.turnSeq,
			round: room.round,
			roundLimit: room.template.roundLimit,
			position: room.position + 1,
			participantCount: room.template.participants.length,
			subject: room.subject,
			orderLabels: room.template.participants.map((p) => p.label),
			youLabel: participant.label,
			turns,
			turnInstruction: room.template.turnInstruction,
			maxAnswerChars: room.template.maxAnswerChars,
			deadlineAt: deadlineAt ?? now,
			maxChars: room.settings.maxTurnMessageChars,
		});

		// ONE message, to this participant only, from the room's creator. A failing
		// send rolls its own writes back; the room says why it stopped.
		let messageId: Id<"messages">;
		try {
			messageId = await ctx.runMutation(internal.messages.sendMessageInternal, {
				from: room.createdBy,
				channel,
				content: frame.text,
				tenantId: mapping.clerkOrgSlug,
			});
		} catch (error) {
			const why =
				error instanceof ConvexError
					? String(error.data)
					: error instanceof Error
						? error.message
						: String(error);
			await stallRoom(ctx, room, why);
			return null;
		}
		await ctx.db.patch(room._id, {
			awaiting: {
				participantId: awaitingId,
				messageId,
				deliveredAt: now,
				...(deadlineAt !== undefined ? { deadlineAt } : {}),
			},
		});
		await scheduleExpiry();
		return null;
	},
});

export const expireTurn = internalMutation({
	args: { roomId: v.id("debateRooms"), turnSeq: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const room = await ctx.db.get(args.roomId);
		// The turn was answered, skipped or the room ended before the deadline: no-op.
		if (
			room === null ||
			room.status !== "active" ||
			room.turnSeq !== args.turnSeq ||
			room.awaiting === undefined
		) {
			return null;
		}
		const awaitingId = room.awaiting.participantId;
		const participant = room.template.participants.find((p) => p.id === awaitingId);
		if (participant === undefined) return null;
		const now = Date.now();
		await appendTurn(ctx, {
			roomId: room._id,
			turnSeq: room.turnSeq,
			round: room.round,
			position: room.position,
			participantId: awaitingId,
			kind: "skipped",
			writer: "expireTurn",
			text: "no answer by deadline",
			...(room.awaiting.deadlineAt !== undefined
				? { deadlineAt: room.awaiting.deadlineAt }
				: {}),
			postedAt: now,
		});
		const state = room.participantState.map((s) => ({ ...s }));
		const mine = state.find((s) => s.participantId === awaitingId);
		if (mine !== undefined && participant.kind === "agent") {
			mine.consecutiveSkips += 1;
			mine.roundKind = "skipped";
			if (mine.consecutiveSkips >= room.template.maxConsecutiveSkips) {
				mine.dropped = true;
				await appendTurn(ctx, {
					roomId: room._id,
					turnSeq: room.turnSeq,
					round: room.round,
					position: room.position,
					participantId: awaitingId,
					kind: "dropped",
					writer: "expireTurn",
					text: `dropped after ${mine.consecutiveSkips} consecutive skips`,
					postedAt: now,
				});
			}
		}
		await resolveAndAdvance(ctx, room, state, "expireTurn");
		return null;
	},
});
