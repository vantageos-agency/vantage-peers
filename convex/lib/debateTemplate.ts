import { type Infer, v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Debate room: the PURE part. Validators shared by the schema and the functions,
// `validateTemplate` / `validateSettings` (used by the backend and, as the same
// source, by the page), the turn-message frame, and the stop-rule state machine.
// No database, no clock, no identity here, so each rule is testable on its own
// (convex/__tests__/debate.template.test.ts).
//
// Participants, their order, wording and every limit are DATA: nothing in this
// file or in convex/debate.ts names a participant, a channel or a voice. The only
// literal tool name is the one the turn message tells a participant to call.
// ─────────────────────────────────────────────────────────────────────────────

export const participantValidator = v.object({
	id: v.string(),
	label: v.string(),
	kind: v.union(v.literal("agent"), v.literal("human")),
	// Where the turn message goes (agents). For a human seat: the person it is
	// ("user:<subject>"); absent = the room creator.
	channel: v.optional(v.string()),
	instanceId: v.optional(v.string()),
	transport: v.union(
		v.literal("waker"),
		v.literal("live-session"),
		v.literal("human"),
	),
	// absent = template default; null = wait without limit (a human seat)
	deadlineSeconds: v.optional(v.union(v.number(), v.null())),
	expectedLatencySeconds: v.optional(v.number()),
	latencySource: v.optional(v.string()),
	latencyDeclaredAt: v.optional(v.number()),
	voiceKey: v.optional(v.union(v.string(), v.null())),
});

export const debateTemplateValidator = v.object({
	id: v.string(),
	name: v.string(),
	language: v.string(),
	turnInstruction: v.string(),
	participants: v.array(participantValidator),
	roundLimit: v.number(),
	maxAnswerChars: v.number(),
	turnDeadlineSeconds: v.number(),
	maxConsecutiveSkips: v.number(),
	voiceEnabled: v.boolean(),
});

export const debateSettingsValidator = v.object({
	maxRoundLimit: v.number(),
	maxParticipants: v.number(),
	maxRefusalRows: v.number(),
	maxTurnMessageChars: v.number(),
	pollSeconds: v.number(),
	maxAnswerCharsCeiling: v.number(),
});

export const closeReasonValidator = v.union(
	v.literal("round_limit"),
	v.literal("operator_stop"),
	v.literal("all_done"),
	v.literal("all_silent"),
);

export const turnKindValidator = v.union(
	v.literal("answer"),
	v.literal("operator"),
	v.literal("skipped"),
	v.literal("dropped"),
	v.literal("refused"),
	v.literal("system"),
);

/** Which function wrote a row. deliverTurn writes `system` rows only (a stall). */
export const turnWriterValidator = v.union(
	v.literal("postTurn"),
	v.literal("expireTurn"),
	v.literal("closeRoom"),
	v.literal("deliverTurn"),
);

export const participantStateValidator = v.object({
	participantId: v.string(),
	consecutiveSkips: v.number(),
	dropped: v.boolean(),
	// what this participant did in the CURRENT round
	roundKind: v.optional(v.union(v.literal("answer"), v.literal("skipped"))),
	roundDone: v.optional(v.boolean()),
});

export const refusalReasonValidator = v.union(
	v.literal("room_closed"),
	v.literal("room_stalled"),
	v.literal("stale_turn"),
	v.literal("not_your_turn"),
	v.literal("empty"),
	v.literal("too_long"),
	v.literal("not_a_participant"),
);

// The stored shape of a template row (the schema defines the table from it and
// `debate:listTemplates` returns it whole).
export const debateTemplateFields = {
	tenantId: v.string(),
	tenantOrgId: v.string(),
	// template.id, denormalised for the (tenant, id) upsert lookup
	templateKey: v.string(),
	template: debateTemplateValidator,
	updatedBy: v.string(),
	updatedAt: v.number(),
};

// The stored shape of a room and of a turn row. The schema defines the tables
// from these, and `convex/debate.ts` builds its `returns` validators from the
// same objects, so a column cannot be added to one and forgotten in the other.
export const debateRoomFields = {
	tenantId: v.string(),
	tenantOrgId: v.string(),
	templateId: v.id("debateTemplates"),
	// FROZEN copies taken at creation: a running room never reads the live rows.
	template: debateTemplateValidator,
	settings: debateSettingsValidator,
	subject: v.string(),
	status: v.union(v.literal("active"), v.literal("stalled"), v.literal("closed")),
	closeReason: v.optional(closeReasonValidator),
	round: v.number(),
	// index into template.participants (0-based)
	position: v.number(),
	turnSeq: v.number(),
	awaiting: v.optional(
		v.object({
			participantId: v.string(),
			messageId: v.optional(v.id("messages")),
			deliveredAt: v.optional(v.number()),
			deadlineAt: v.optional(v.number()),
		}),
	),
	participantState: v.array(participantStateValidator),
	// who created it: the label used as `from` of every turn message, and the
	// stable principal ("user:<subject>")
	createdBy: v.string(),
	createdById: v.string(),
	createdAt: v.number(),
	closedAt: v.optional(v.number()),
	// refused rows written so far (capped by settings.maxRefusalRows) and the
	// refusals beyond the cap that were only counted
	refusalRows: v.number(),
	refusalsOverflow: v.number(),
};

export const debateTurnFields = {
	roomId: v.id("debateRooms"),
	turnSeq: v.number(),
	round: v.number(),
	position: v.number(),
	participantId: v.optional(v.string()),
	kind: turnKindValidator,
	// which function wrote the row (B1)
	writer: turnWriterValidator,
	text: v.optional(v.string()),
	// refusal reason, or the closeReason of a final system row
	reason: v.optional(v.string()),
	done: v.optional(v.boolean()),
	// "found:<ids>" | "could_not_judge"; never "none" by default
	workDuringTurn: v.optional(v.string()),
	// the deadline a `skipped` row expired at
	deadlineAt: v.optional(v.number()),
	// voice (section 7): set by the voice worker, never by this backend
	audioStorageId: v.optional(v.id("_storage")),
	voiceMark: v.optional(v.string()),
	postedAt: v.number(),
};

export type DebateParticipant = Infer<typeof participantValidator>;
export type DebateTemplate = Infer<typeof debateTemplateValidator>;
export type DebateSettings = Infer<typeof debateSettingsValidator>;
export type CloseReason = Infer<typeof closeReasonValidator>;
export type TurnKind = Infer<typeof turnKindValidator>;
export type ParticipantState = Infer<typeof participantStateValidator>;
export type RefusalReason = Infer<typeof refusalReasonValidator>;

export type TemplateIssue = { path: string; message: string };

const blank = (s: string | undefined): boolean =>
	s === undefined || s.trim().length === 0;
const positiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;
const positiveNumber = (n: number): boolean => Number.isFinite(n) && n > 0;

/**
 * The deadline that applies to a participant: its own number, else the
 * template's. `null` means "waits without limit". An agent's effective deadline
 * is never null in a valid template.
 */
export function effectiveDeadlineSeconds(
	template: Pick<DebateTemplate, "turnDeadlineSeconds">,
	participant: Pick<DebateParticipant, "deadlineSeconds" | "kind">,
): number | null {
	if (participant.deadlineSeconds === null) return null;
	if (participant.deadlineSeconds !== undefined) return participant.deadlineSeconds;
	// A human seat with no stated deadline waits without limit; an agent takes
	// the template default.
	return participant.kind === "human" ? null : template.turnDeadlineSeconds;
}

/** One issue per broken rule, each with the field path. Empty = valid. */
export function validateTemplate(
	template: DebateTemplate,
	settings: DebateSettings,
): TemplateIssue[] {
	const issues: TemplateIssue[] = [];
	const add = (path: string, message: string) => issues.push({ path, message });

	if (blank(template.id)) add("id", "id must not be empty");
	if (blank(template.name)) add("name", "name must not be empty");
	if (blank(template.language)) add("language", "language must not be empty");
	if (blank(template.turnInstruction)) {
		add("turnInstruction", "turnInstruction must not be empty");
	}

	if (!positiveInt(template.roundLimit) || template.roundLimit > settings.maxRoundLimit) {
		add(
			"roundLimit",
			`roundLimit must be an integer in 1..${settings.maxRoundLimit}, got ${template.roundLimit}`,
		);
	}
	if (
		!positiveInt(template.maxAnswerChars) ||
		template.maxAnswerChars > settings.maxAnswerCharsCeiling
	) {
		add(
			"maxAnswerChars",
			`maxAnswerChars must be an integer in 1..${settings.maxAnswerCharsCeiling}, got ${template.maxAnswerChars}`,
		);
	}
	if (!positiveNumber(template.turnDeadlineSeconds)) {
		add(
			"turnDeadlineSeconds",
			`turnDeadlineSeconds must be > 0, got ${template.turnDeadlineSeconds}`,
		);
	}
	if (!positiveInt(template.maxConsecutiveSkips)) {
		add(
			"maxConsecutiveSkips",
			`maxConsecutiveSkips must be an integer >= 1, got ${template.maxConsecutiveSkips}`,
		);
	}

	const ps = template.participants;
	if (ps.length < 2) {
		add("participants", `a room needs at least 2 participants, got ${ps.length}`);
	}
	if (ps.length > settings.maxParticipants) {
		add(
			"participants",
			`at most ${settings.maxParticipants} participants, got ${ps.length}`,
		);
	}
	if (!ps.some((p) => p.kind === "agent")) {
		add("participants", "at least one participant must be an agent");
	}

	const seen = new Set<string>();
	ps.forEach((p, i) => {
		const at = `participants[${i}]`;
		if (blank(p.id)) add(`${at}.id`, "id must not be empty");
		else if (seen.has(p.id)) add(`${at}.id`, `id "${p.id}" is used twice`);
		seen.add(p.id);
		if (blank(p.label)) add(`${at}.label`, "label must not be empty");

		if (p.kind === "agent") {
			if (blank(p.channel)) add(`${at}.channel`, "an agent needs a channel");
			if (p.transport === "human") {
				add(`${at}.transport`, "an agent cannot have transport human");
			}
			if (p.deadlineSeconds === null) {
				add(
					`${at}.deadlineSeconds`,
					"an agent needs a deadline: null (wait without limit) is for human seats",
				);
			} else if (
				p.deadlineSeconds !== undefined &&
				!positiveNumber(p.deadlineSeconds)
			) {
				add(`${at}.deadlineSeconds`, `deadlineSeconds must be > 0, got ${p.deadlineSeconds}`);
			}
		} else {
			if (p.transport !== "human") {
				add(`${at}.transport`, 'a human seat must have transport "human"');
			}
			if (
				typeof p.deadlineSeconds === "number" &&
				!positiveNumber(p.deadlineSeconds)
			) {
				add(`${at}.deadlineSeconds`, `deadlineSeconds must be > 0, got ${p.deadlineSeconds}`);
			}
		}

		const eff = effectiveDeadlineSeconds(template, p);
		if (
			p.expectedLatencySeconds !== undefined &&
			eff !== null &&
			p.expectedLatencySeconds > eff
		) {
			add(
				`${at}.expectedLatencySeconds`,
				`declared latency ${p.expectedLatencySeconds} s is above the effective deadline ${eff} s: the participant would be skipped before it can answer`,
			);
		}
	});

	if (template.voiceEnabled) {
		const byVoice = new Map<string, DebateParticipant>();
		ps.forEach((p, i) => {
			if (p.voiceKey === undefined || p.voiceKey === null) return;
			const first = byVoice.get(p.voiceKey);
			if (first !== undefined) {
				add(
					`participants[${i}].voiceKey`,
					`"${first.label}" and "${p.label}" resolve to the same voice "${p.voiceKey}": one participant, one voice`,
				);
			} else {
				byVoice.set(p.voiceKey, p);
			}
		});
	}

	return issues;
}

/** Every limit is a positive integer; the refusal-row cap may be 0. */
export function validateSettings(settings: DebateSettings): TemplateIssue[] {
	const issues: TemplateIssue[] = [];
	const keys: Array<keyof DebateSettings> = [
		"maxRoundLimit",
		"maxParticipants",
		"maxTurnMessageChars",
		"pollSeconds",
		"maxAnswerCharsCeiling",
	];
	for (const k of keys) {
		if (!positiveInt(settings[k])) {
			issues.push({ path: k, message: `${k} must be an integer >= 1, got ${settings[k]}` });
		}
	}
	if (!Number.isInteger(settings.maxRefusalRows) || settings.maxRefusalRows < 0) {
		issues.push({
			path: "maxRefusalRows",
			message: `maxRefusalRows must be an integer >= 0, got ${settings.maxRefusalRows}`,
		});
	}
	return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// The turn message frame (design section 3)
// ─────────────────────────────────────────────────────────────────────────────

export type FrameTurn = {
	round: number;
	/** 1-based, as printed. */
	position: number;
	label: string;
	kind: TurnKind;
	text?: string;
	reason?: string;
};

export type FrameInput = {
	roomId: string;
	turnSeq: number;
	round: number;
	roundLimit: number;
	/** 1-based, as printed. */
	position: number;
	participantCount: number;
	subject: string;
	orderLabels: string[];
	youLabel: string;
	turns: FrameTurn[];
	turnInstruction: string;
	maxAnswerChars: number;
	deadlineAt: number;
	maxChars: number;
};

// One renderer per kind, keyed by the kind itself: a lookup, not a chain of
// comparisons, so a kind added to `turnKindValidator` is a type error here until
// it is rendered.
const TURN_INDENT = "      ";
const indented = (s: string): string => s.replace(/\r?\n/g, `\n${TURN_INDENT}`);
const RENDER_TURN: Record<TurnKind, (t: FrameTurn, head: string) => string> = {
	answer: (t, head) => head + indented(t.text ?? ""),
	operator: (t, head) => head + indented(t.text ?? ""),
	skipped: (t, head) => `${head}[skipped: ${indented(t.text ?? "")}]`,
	dropped: (t, head) => `${head}[dropped: ${indented(t.text ?? "")}]`,
	refused: (t, head) => `${head}[refused: ${t.reason ?? ""}]`,
	system: (t, head) => `${head}[system: ${indented(t.text ?? "")}]`,
};

function renderTurn(t: FrameTurn): string {
	return RENDER_TURN[t.kind](t, `  r${t.round} p${t.position} ${t.label}: `);
}

/**
 * The self-contained message a participant receives for its turn. If it would
 * exceed `maxChars`, the oldest WHOLE turns are removed and one line says how
 * many (never a cut inside a turn). `shown + omitted` is always `turns.length`.
 */
export function buildTurnFrame(input: FrameInput): {
	text: string;
	shown: number;
	omitted: number;
} {
	const lines = input.turns.map(renderTurn);
	const assemble = (omitted: number): string => {
		const kept = lines.slice(omitted);
		const transcript: string[] = [];
		if (omitted > 0) {
			transcript.push(
				`  [${omitted} earlier turns omitted; read them with debate_get_room {roomId}]`,
			);
		}
		if (kept.length === 0 && omitted === 0) transcript.push("  (no turns yet)");
		transcript.push(...kept);
		return [
			`[DEBATE-TURN] room ${input.roomId}  turnSeq ${input.turnSeq}  round ${input.round}/${input.roundLimit}  position ${input.position}/${input.participantCount}`,
			`SUBJECT: ${input.subject}`,
			`ORDER: ${input.orderLabels.join(" > ")}   YOU: ${input.youLabel}`,
			`TRANSCRIPT (${kept.length} turns, oldest first):`,
			...transcript,
			`INSTRUCTION: ${input.turnInstruction}`,
			`HOW TO ANSWER: call debate_post_turn {roomId, turnSeq, text, done?} exactly once, then mark this message read in the same turn. Answer only. Limit ${input.maxAnswerChars} characters. Deadline ${new Date(input.deadlineAt).toISOString()}.`,
		].join("\n");
	};
	let omitted = 0;
	let text = assemble(omitted);
	while (text.length > input.maxChars && omitted < lines.length) {
		omitted += 1;
		text = assemble(omitted);
	}
	return { text, shown: lines.length - omitted, omitted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop rules (design section 5): what happens after a turn is resolved
// ─────────────────────────────────────────────────────────────────────────────

export type StepOutcome =
	| { kind: "continue"; round: number; position: number; newRound: boolean }
	| { kind: "close"; reason: CloseReason };

export function initialParticipantState(
	template: Pick<DebateTemplate, "participants">,
): ParticipantState[] {
	return template.participants.map((p) => ({
		participantId: p.id,
		consecutiveSkips: 0,
		dropped: false,
	}));
}

/**
 * Decide the next step once the turn at (round, position) has been resolved and
 * `state` already reflects it. Order at the end of a round: all_done, all_silent,
 * round_limit. A room with no live agent left closes all_silent at once.
 */
export function nextStep(
	template: Pick<DebateTemplate, "participants" | "roundLimit">,
	state: ParticipantState[],
	round: number,
	position: number,
): StepOutcome {
	const stateOf = (id: string) => state.find((s) => s.participantId === id);
	const isDropped = (id: string) => stateOf(id)?.dropped === true;
	const agents = template.participants.filter((p) => p.kind === "agent");
	const live = agents.filter((p) => !isDropped(p.id));
	if (live.length === 0) return { kind: "close", reason: "all_silent" };

	for (let i = position + 1; i < template.participants.length; i++) {
		if (!isDropped(template.participants[i].id)) {
			return { kind: "continue", round, position: i, newRound: false };
		}
	}

	// End of the round.
	if (
		live.every((p) => {
			const s = stateOf(p.id);
			return s?.roundKind === "answer" && s.roundDone === true;
		})
	) {
		return { kind: "close", reason: "all_done" };
	}
	const rowed = agents.filter((p) => stateOf(p.id)?.roundKind !== undefined);
	if (rowed.length > 0 && rowed.every((p) => stateOf(p.id)?.roundKind === "skipped")) {
		return { kind: "close", reason: "all_silent" };
	}
	if (round >= template.roundLimit) return { kind: "close", reason: "round_limit" };
	const first = template.participants.findIndex((p) => !isDropped(p.id));
	return { kind: "continue", round: round + 1, position: first, newRound: true };
}
