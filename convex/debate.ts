import {
	type ActingPrincipal,
	assertOrgAdmin,
	assertTargetBelongsTo,
	resolveCallerFromAgentCredential,
	resolveCallerFromClaims,
	resolveWriterRole,
	sameOrg,
	scopeStanding,
} from "@vantageos/cloud-identity";
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
import { anonymousRefusal } from "./lib/agentIdentity";
import {
	isMcpBoundMaster,
	isOrchestratorOnOrgRoster,
	lookupOrgMapping,
	ORG_ADMIN_ROLES,
	type OrgScope,
	refusalError,
	requireAgentCredentialMatch,
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
	TURN_ROWS_READ_BOUND,
	validateSettings,
	validateTemplate,
} from "./lib/debateTemplate";
import { isHumanActorName, memberActorOf, resolveHumanActor } from "./lib/humanActor";
import { orgByIdLookups, orgByIdPrincipalLookups } from "./lib/orgIdLookups";
import { refuseWith as refuseWithPerson } from "./lib/personPrincipal";
import { loadMemberWriterRoles } from "./memberWriterRoles";

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
// `TURN_ROWS_READ_BOUND` (lib/debateTemplate.ts), bounds a transaction read, not
// a business rule; the settings validator refuses limits that would not fit it.
// ─────────────────────────────────────────────────────────────────────────────

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
//
// Every identity refusal in this file is said by the package (`refusalError` of a
// package refusal) or by an existing door helper (`anonymousRefusal`,
// `requireResolvedCaller`); the file builds none of its own. The refusals below
// are DATA refusals (a missing settings row, an invalid template), not identity ones.

function refuseData(code: string, detail: unknown): never {
	throw new ConvexError(`${code}: ${JSON.stringify(detail)}`);
}

// ── caller resolution ───────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/**
 * The signed-in PERSON behind a dashboard session, resolved by the package from
 * the verified claims: the organisation by its permanent ID, the person stored in
 * it, its role claim. The session goes to the package and nowhere else. An absent
 * session raises `anonymousRefusal`; a session the package refuses raises its refusal.
 */
async function sessionCaller(ctx: Ctx, door: string) {
	const caller = await resolveCallerFromClaims(
		await ctx.auth.getUserIdentity(),
		{ orgLookups: orgByIdLookups(ctx), principalLookups: orgByIdPrincipalLookups(ctx) },
		{ adminRoles: ORG_ADMIN_ROLES, door },
	);
	if (!caller.ok) {
		if (caller.subject === undefined) throw anonymousRefusal(door);
		throw refusalError(caller.refusal);
	}
	return caller;
}

/** The target row is stamped with the principal's own organisation ID, judged by the package. */
async function requireRowOfOrg(
	ctx: Ctx,
	principal: ActingPrincipal,
	rowOrgId: string,
	door: string,
): Promise<void> {
	const belongs = await assertTargetBelongsTo(
		principal,
		{ orgId: rowOrgId },
		orgByIdPrincipalLookups(ctx),
		{ door },
	);
	if (!belongs.ok) throw refusalError(belongs.refusal);
}

/**
 * Each agent seat of `template` is an ACTIVE agent of organisation `orgId`, judged
 * by the package from the seat's own `agentId` (the agent's row is read by that
 * ID and must be stamped with the organisation). A name is never resolved here:
 * the template names its agents by ID.
 */
async function requireSeatsOfOrg(
	ctx: Ctx,
	orgId: string,
	template: DebateTemplate,
	door: string,
): Promise<void> {
	for (const seat of template.participants) {
		if (seat.kind !== "agent") continue;
		const resolved = await resolveCallerFromAgentCredential(
			seat.agentId === undefined ? null : { agentId: seat.agentId, verifiedOrgId: orgId },
			{ orgLookups: orgByIdLookups(ctx), principalLookups: orgByIdPrincipalLookups(ctx) },
			{ door },
		);
		if (!resolved.ok) throw refusalError(resolved.refusal);
	}
}

type Caller =
	| { kind: "person"; actor: string; orgId: string; orgRole: string | undefined }
	| { kind: "agent"; agentId: string; orgId: string }
	| { kind: "none" };

/**
 * Who is calling a room door, from the scope the door resolved. An agent is the
 * `agents` row a `verifiedActor` names, which the existing agent-proof helper
 * believes from the fleet service account only (a scoped member presenting one is
 * refused). A person is a resolved member of an organisation. The agent's
 * organisation is the one STAMPED ON ITS ROW (`clerkOrgId`), never a claimed slug.
 */
async function roomCaller(
	ctx: Ctx,
	scope: OrgScope,
	verifiedActor: { agentId: Id<"agents">; orgSlug: string } | undefined,
): Promise<Caller> {
	if (verifiedActor !== undefined) {
		await requireAgentCredentialMatch(ctx, undefined, undefined, null, { scope, verifiedActor });
		const agent = await ctx.db.get(verifiedActor.agentId);
		return agent === null || agent.clerkOrgId === undefined
			? { kind: "none" }
			: { kind: "agent", agentId: agent._id, orgId: agent.clerkOrgId };
	}
	if (scopeStanding(scope) === "member" && scope.orgClerkId !== undefined) {
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
		if (!sameOrg({ id: caller.orgId }, { id: room.tenantOrgId })) return undefined;
		// By the agents-row ID frozen on the seat. The seat carries no name to admit:
		// a renamed agent keeps its seat, a different agent with the same name has none.
		return room.template.participants.find(
			(p) => p.kind === "agent" && p.agentId !== undefined && p.agentId === caller.agentId,
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

/** The room's creator, or an administrator of the room's organisation (a view, not a stop). */
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
		maxLabelChars: row.maxLabelChars,
		maxTurnInstructionChars: row.maxTurnInstructionChars,
		maxActiveRooms: row.maxActiveRooms,
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

/**
 * Every row of a room, oldest first. The settings validator guarantees the largest
 * transcript the room's limits allow fits the bound; a room that nevertheless holds
 * more is REFUSED, never read as a shorter transcript that lacks its newest turns.
 */
async function loadTurns(
	ctx: QueryCtx | MutationCtx,
	roomId: Id<"debateRooms">,
): Promise<Doc<"debateTurns">[]> {
	const rows = await ctx.db
		.query("debateTurns")
		.withIndex("by_room_seq", (q) => q.eq("roomId", roomId))
		.take(TURN_ROWS_READ_BOUND + 1);
	if (rows.length > TURN_ROWS_READ_BOUND) {
		return refuseData("DEBATE_TRANSCRIPT_TOO_LARGE", {
			roomId,
			reason: `the room holds more than ${TURN_ROWS_READ_BOUND} rows; reading it would drop its newest turns`,
		});
	}
	return rows;
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
		const caller = await sessionCaller(ctx, "debate:getSettings");
		const row = await settingsRow(ctx, caller.org.id);
		return row === null ? null : settingsOf(row);
	},
});

export const upsertSettings = mutation({
	args: debateSettingsValidator.fields,
	returns: v.null(),
	handler: async (ctx, args) => {
		const door = "debate:upsertSettings";
		const caller = await sessionCaller(ctx, door);
		const admin = assertOrgAdmin(caller.principal, caller.org.id, { adminRoles: ORG_ADMIN_ROLES, door });
		if (!admin.ok) throw refusalError(admin.refusal);
		const limits: DebateSettings = {
			maxRoundLimit: args.maxRoundLimit,
			maxParticipants: args.maxParticipants,
			maxRefusalRows: args.maxRefusalRows,
			maxTurnMessageChars: args.maxTurnMessageChars,
			pollSeconds: args.pollSeconds,
			maxAnswerCharsCeiling: args.maxAnswerCharsCeiling,
			maxLabelChars: args.maxLabelChars,
			maxTurnInstructionChars: args.maxTurnInstructionChars,
			maxActiveRooms: args.maxActiveRooms,
		};
		const issues = validateSettings(limits);
		if (issues.length > 0) return refuseData("DEBATE_SETTINGS_INVALID", issues);
		const existing = await settingsRow(ctx, caller.org.id);
		const fields = {
			tenantId: caller.org.label,
			tenantOrgId: caller.org.id,
			...limits,
			updatedBy: caller.actorName,
			updatedAt: Date.now(),
		};
		if (existing === null) {
			await ctx.db.insert("debateSettings", fields);
			return null;
		}
		await requireRowOfOrg(ctx, caller.principal, existing.tenantOrgId, door);
		await ctx.db.replace(existing._id, fields);
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
		const caller = await sessionCaller(ctx, "debate:listTemplates");
		return await ctx.db
			.query("debateTemplates")
			.withIndex("by_tenantOrgId_and_templateKey", (q) => q.eq("tenantOrgId", caller.org.id))
			.take(TEMPLATE_LIST_BOUND);
	},
});

export const upsertTemplate = mutation({
	args: { template: debateTemplateValidator },
	returns: v.id("debateTemplates"),
	handler: async (ctx, args) => {
		const door = "debate:upsertTemplate";
		const caller = await sessionCaller(ctx, door);
		const admin = assertOrgAdmin(caller.principal, caller.org.id, { adminRoles: ORG_ADMIN_ROLES, door });
		if (!admin.ok) throw refusalError(admin.refusal);
		const settings = await requireSettings(ctx, caller.org.id);
		const issues = validateTemplate(args.template, settings);
		if (issues.length > 0) return refuseData("DEBATE_TEMPLATE_INVALID", issues);
		await requireSeatsOfOrg(ctx, caller.org.id, args.template, door);
		const existing = await ctx.db
			.query("debateTemplates")
			.withIndex("by_tenantOrgId_and_templateKey", (q) =>
				q.eq("tenantOrgId", caller.org.id).eq("templateKey", args.template.id),
			)
			.first();
		const fields = {
			tenantId: caller.org.label,
			tenantOrgId: caller.org.id,
			templateKey: args.template.id,
			template: args.template,
			updatedBy: caller.actorName,
			updatedAt: Date.now(),
		};
		if (existing === null) return await ctx.db.insert("debateTemplates", fields);
		await requireRowOfOrg(ctx, caller.principal, existing.tenantOrgId, door);
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
		// The creator is the verified person in its own organisation, with a writer
		// role: the same human gate every dashboard write door runs.
		const identity = await ctx.auth.getUserIdentity();
		const caller = await resolveCallerFromClaims(
			identity,
			{ orgLookups: orgByIdLookups(ctx), principalLookups: orgByIdPrincipalLookups(ctx) },
			{ adminRoles: ORG_ADMIN_ROLES, door },
		);
		if (!caller.ok) {
			if (caller.subject === undefined) throw anonymousRefusal(door);
			throw refusalError(caller.refusal);
		}
		const writer = resolveWriterRole({
			role: caller.role,
			writerRoles: await loadMemberWriterRoles(ctx, caller.org.label),
			door,
			orgSlug: caller.org.label,
		});
		if (!writer.ok) return refuseWithPerson(writer.refusal);

		// The organisation the verified session resolves to: every row below is stamped with it.
		const tenant = { orgSlug: caller.org.label, orgId: caller.org.id };

		// Another tenant's template answers like a missing one.
		const templateRow = await ctx.db.get(args.templateId);
		if (templateRow === null || templateRow.tenantOrgId !== tenant.orgId) {
			return refuseData("DEBATE_TEMPLATE_NOT_FOUND", { templateId: args.templateId });
		}
		const settings = await requireSettings(ctx, tenant.orgId);
		// The limits are judged as they are today, not as they were when saved.
		const settingsIssues = validateSettings(settings);
		if (settingsIssues.length > 0) return refuseData("DEBATE_SETTINGS_INVALID", settingsIssues);
		const subject = args.subject.trim();
		if (subject.length === 0 || subject.length > settings.maxAnswerCharsCeiling) {
			return refuseData("DEBATE_SUBJECT_INVALID", {
				reason: `subject must be 1..${settings.maxAnswerCharsCeiling} characters`,
			});
		}
		const template = templateRow.template;
		const issues = validateTemplate(template, settings);
		if (issues.length > 0) return refuseData("DEBATE_TEMPLATE_INVALID", issues);
		for (const p of template.participants) {
			if (p.kind === "human" && p.channel !== undefined && !isHumanActorName(p.channel)) {
				return refuseData("DEBATE_TEMPLATE_INVALID", [
					{
						path: `participants.${p.id}.channel`,
						message: 'a human seat\'s channel must be a person ("user:<subject>") or absent (the creator)',
					},
				]);
			}
		}
		// Every agent seat is an active, rostered agent of THIS organisation today.
		await requireSeatsOfOrg(ctx, tenant.orgId, template, door);

		// Rooms of one organisation that are not closed (active or stalled) are capped by its settings.
		let open = 0;
		for (const status of ["active", "stalled"] as const) {
			open += (
				await ctx.db
					.query("debateRooms")
					.withIndex("by_tenantOrgId_and_status", (q) =>
						q.eq("tenantOrgId", tenant.orgId).eq("status", status),
					)
					.take(settings.maxActiveRooms)
			).length;
		}
		if (open >= settings.maxActiveRooms) {
			return refuseData("DEBATE_ROOM_LIMIT", {
				reason: `this organisation already has ${open} rooms that are not closed; the limit is ${settings.maxActiveRooms}`,
			});
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
			createdBy: caller.actorName,
			createdById: caller.actorName,
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
		// The fleet service account acts in an organisation only through a claim.
		if (isMcpBoundMaster(scope) && args.verifiedActor === undefined) throw anonymousRefusal(door);
		const caller = await roomCaller(ctx, scope, args.verifiedActor);
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
	args: { roomId: v.id("debateRooms") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const door = "debate:closeRoom";
		const caller = await sessionCaller(ctx, door);
		const room = await ctx.db.get(args.roomId);
		// One refusal for a participant, another tenant and a room that is not there:
		// the creator stops it, else an administrator of ITS organisation does, and
		// for a room that is absent or another organisation's there is none to administer.
		const ownRoom = room !== null && sameOrg({ id: room.tenantOrgId }, { id: caller.org.id });
		if (!(ownRoom && room.createdById === caller.actorName)) {
			const admin = assertOrgAdmin(caller.principal, ownRoom ? room.tenantOrgId : undefined, {
				adminRoles: ORG_ADMIN_ROLES,
				door,
			});
			if (!admin.ok) throw refusalError(admin.refusal);
		}
		if (room === null) return null;
		await requireRowOfOrg(ctx, caller.principal, room.tenantOrgId, door);
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
		// The fleet service account acts in an organisation only through a claim.
		if (isMcpBoundMaster(scope) && args.verifiedActor === undefined) throw anonymousRefusal(door);
		const caller = await roomCaller(ctx, scope, args.verifiedActor);
		const room = await ctx.db.get(args.roomId);

		// Not a participant (or no such room): refused with nothing about the room,
		// and nothing written. The turnSeq is the caller's own, in both cases: the
		// room's live one would tell a stranger that the room exists.
		const participant = room === null ? undefined : participantOf(room, caller);
		if (room === null || participant === undefined) {
			return {
				refused: "not_a_participant" as const,
				awaiting: null,
				turnSeq: args.turnSeq,
			};
		}
		// A person posts under the same writer-role gate that created the room.
		if (caller.kind === "person") await resolveHumanActor(ctx, scope, { door });

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

		// The seat names its agent by ID. The agent's row, read by that ID, gives the
		// address its message is delivered to (a transport label, never an admission).
		const seatAgent = participant.agentId === undefined ? null : await ctx.db.get(participant.agentId);
		const mapping = await lookupOrgMapping(ctx, { clerkOrgId: room.tenantOrgId });
		if (seatAgent === null || !seatAgent.isActive || seatAgent.clerkOrgId !== room.tenantOrgId) {
			await stallRoom(
				ctx,
				room,
				`participant "${participant.label}" is not an active agent of the room's organisation`,
			);
			return null;
		}
		const channel = seatAgent.name;
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
