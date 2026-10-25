/// <reference types="vite/client" />
/**
 * Debate room, pure part: `validateTemplate` (B21) and the turn message frame
 * (B15, golden string). No database: these are the two functions the page and
 * the backend share, so they are pinned apart from the Convex functions.
 *
 * Design: /root/coding/sigma-scratch/debate/design.md sections 3 and 8.
 */
import { describe, expect, test } from "vitest";
import {
	buildTurnFrame,
	type DebateSettings,
	type DebateTemplate,
	effectiveDeadlineSeconds,
	type FrameTurn,
	validateSettings,
	validateTemplate,
} from "../lib/debateTemplate";

const SETTINGS: DebateSettings = {
	maxRoundLimit: 5,
	maxParticipants: 4,
	maxRefusalRows: 3,
	maxTurnMessageChars: 4000,
	pollSeconds: 5,
	maxAnswerCharsCeiling: 2000,
};

const base = (): DebateTemplate => ({
	id: "review",
	name: "Review",
	language: "en",
	turnInstruction: "Answer in one paragraph.",
	participants: [
		{ id: "p1", label: "operator", kind: "human", transport: "human", deadlineSeconds: null },
		{ id: "p2", label: "sigma", kind: "agent", channel: "sigma", transport: "waker" },
		{ id: "p3", label: "eta", kind: "agent", channel: "eta", transport: "waker" },
	],
	roundLimit: 3,
	maxAnswerChars: 500,
	turnDeadlineSeconds: 3600,
	maxConsecutiveSkips: 2,
	voiceEnabled: false,
});

const paths = (t: DebateTemplate, s: DebateSettings = SETTINGS) =>
	validateTemplate(t, s).map((i) => i.path);

describe("B21 validateTemplate: one rule per row, both poles", () => {
	test("a well-formed template has no issue", () => {
		expect(validateTemplate(base(), SETTINGS)).toEqual([]);
	});

	test("participants: fewer than 2 refused, 2 passes", () => {
		const t = base();
		t.participants = [t.participants[1]];
		expect(paths(t)).toContain("participants");
		t.participants = [base().participants[1], base().participants[2]];
		expect(paths(t)).not.toContain("participants");
	});

	test("participants: more than settings.maxParticipants refused", () => {
		const t = base();
		t.participants = [
			...t.participants,
			{ id: "p4", label: "a", kind: "agent", channel: "a", transport: "waker" },
			{ id: "p5", label: "b", kind: "agent", channel: "b", transport: "waker" },
		];
		expect(paths(t)).toContain("participants");
		expect(paths(t, { ...SETTINGS, maxParticipants: 5 })).not.toContain("participants");
	});

	test("at least one agent: humans only refused", () => {
		const t = base();
		t.participants = [
			{ id: "p1", label: "a", kind: "human", transport: "human", deadlineSeconds: null },
			{ id: "p2", label: "b", kind: "human", transport: "human", deadlineSeconds: null },
		];
		expect(paths(t)).toContain("participants");
	});

	test("ids unique and non-empty, labels non-empty", () => {
		const dup = base();
		dup.participants[2].id = "p2";
		expect(paths(dup)).toContain("participants[2].id");
		const emptyId = base();
		emptyId.participants[1].id = " ";
		expect(paths(emptyId)).toContain("participants[1].id");
		const emptyLabel = base();
		emptyLabel.participants[1].label = "";
		expect(paths(emptyLabel)).toContain("participants[1].label");
	});

	test("roundLimit within 1..settings.maxRoundLimit, integer", () => {
		for (const bad of [0, 6, 1.5, -1]) {
			const t = base();
			t.roundLimit = bad;
			expect(paths(t), `roundLimit=${bad}`).toContain("roundLimit");
		}
		for (const ok of [1, 5]) {
			const t = base();
			t.roundLimit = ok;
			expect(paths(t), `roundLimit=${ok}`).not.toContain("roundLimit");
		}
	});

	test("maxAnswerChars within 1..settings.maxAnswerCharsCeiling", () => {
		for (const bad of [0, 2001]) {
			const t = base();
			t.maxAnswerChars = bad;
			expect(paths(t), `maxAnswerChars=${bad}`).toContain("maxAnswerChars");
		}
		const t = base();
		t.maxAnswerChars = 2000;
		expect(paths(t)).not.toContain("maxAnswerChars");
	});

	test("turnDeadlineSeconds must be > 0; maxConsecutiveSkips an integer >= 1", () => {
		const a = base();
		a.turnDeadlineSeconds = 0;
		expect(paths(a)).toContain("turnDeadlineSeconds");
		const b = base();
		b.maxConsecutiveSkips = 0;
		expect(paths(b)).toContain("maxConsecutiveSkips");
		expect(paths(base())).not.toContain("turnDeadlineSeconds");
		expect(paths(base())).not.toContain("maxConsecutiveSkips");
	});

	test("an agent needs a channel", () => {
		const t = base();
		delete t.participants[1].channel;
		expect(paths(t)).toContain("participants[1].channel");
		const blank = base();
		blank.participants[1].channel = "  ";
		expect(paths(blank)).toContain("participants[1].channel");
	});

	test("an agent needs a non-null effective deadline; null is refused, a number or the default passes", () => {
		const nul = base();
		nul.participants[1].deadlineSeconds = null;
		expect(paths(nul)).toContain("participants[1].deadlineSeconds");
		const zero = base();
		zero.participants[1].deadlineSeconds = 0;
		expect(paths(zero)).toContain("participants[1].deadlineSeconds");
		const own = base();
		own.participants[1].deadlineSeconds = 60;
		expect(paths(own)).not.toContain("participants[1].deadlineSeconds");
		expect(effectiveDeadlineSeconds(own, own.participants[1])).toBe(60);
		expect(effectiveDeadlineSeconds(base(), base().participants[1])).toBe(3600);
		expect(effectiveDeadlineSeconds(base(), base().participants[0])).toBeNull();
	});

	test("a human seat must have transport human; an agent must not", () => {
		const h = base();
		h.participants[0].transport = "waker";
		expect(paths(h)).toContain("participants[0].transport");
		const a = base();
		a.participants[1].transport = "human";
		expect(paths(a)).toContain("participants[1].transport");
	});

	test("a declared latency above the effective deadline is refused, naming both numbers", () => {
		const t = base();
		t.participants[1].expectedLatencySeconds = 5000;
		const issue = validateTemplate(t, SETTINGS).find(
			(i) => i.path === "participants[1].expectedLatencySeconds",
		);
		expect(issue).toBeDefined();
		expect(issue?.message).toContain("5000");
		expect(issue?.message).toContain("3600");
		t.participants[1].expectedLatencySeconds = 3600;
		expect(paths(t)).not.toContain("participants[1].expectedLatencySeconds");
	});

	test("voiceEnabled with two voiced participants on the same key is refused, naming the pair", () => {
		const t = base();
		t.voiceEnabled = true;
		t.participants[1].voiceKey = "v1";
		t.participants[2].voiceKey = "v1";
		const issue = validateTemplate(t, SETTINGS).find((i) => i.path === "participants[2].voiceKey");
		expect(issue).toBeDefined();
		expect(issue?.message).toContain("sigma");
		expect(issue?.message).toContain("eta");
		t.participants[2].voiceKey = "v2";
		expect(paths(t)).not.toContain("participants[2].voiceKey");
		// voice disabled: duplicates are not this rule's business
		t.participants[2].voiceKey = "v1";
		t.voiceEnabled = false;
		expect(paths(t)).not.toContain("participants[2].voiceKey");
	});

	test("name, id and turnInstruction must be non-empty", () => {
		const t = base();
		t.name = " ";
		t.id = "";
		t.turnInstruction = "";
		const p = paths(t);
		expect(p).toContain("name");
		expect(p).toContain("id");
		expect(p).toContain("turnInstruction");
	});
});

describe("validateSettings", () => {
	test("every limit must be a positive integer (maxRefusalRows may be 0)", () => {
		expect(validateSettings(SETTINGS)).toEqual([]);
		expect(validateSettings({ ...SETTINGS, maxRoundLimit: 0 }).map((i) => i.path)).toContain(
			"maxRoundLimit",
		);
		expect(validateSettings({ ...SETTINGS, maxRefusalRows: 0 })).toEqual([]);
		expect(validateSettings({ ...SETTINGS, maxRefusalRows: -1 }).map((i) => i.path)).toContain(
			"maxRefusalRows",
		);
		expect(validateSettings({ ...SETTINGS, pollSeconds: 1.5 }).map((i) => i.path)).toContain(
			"pollSeconds",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// B15 — the frame. The golden string is written here by hand; the builder must
// reproduce it byte for byte.
// ─────────────────────────────────────────────────────────────────────────────

const GOLDEN_TURNS: FrameTurn[] = [
	{ round: 1, position: 1, label: "operator", kind: "operator", text: "Start with the risks." },
	{ round: 1, position: 2, label: "sigma", kind: "skipped", text: "no answer by deadline" },
];

const frameInput = (turns: FrameTurn[], maxChars = 4000) => ({
	roomId: "R1",
	turnSeq: 3,
	round: 1,
	roundLimit: 2,
	position: 3,
	participantCount: 3,
	subject: "Should we ship?",
	orderLabels: ["operator", "sigma", "eta"],
	youLabel: "eta",
	turns,
	turnInstruction: "Answer in one paragraph.",
	maxAnswerChars: 500,
	deadlineAt: Date.UTC(2026, 0, 1),
	maxChars,
});

const GOLDEN = [
	"[DEBATE-TURN] room R1  turnSeq 3  round 1/2  position 3/3",
	"SUBJECT: Should we ship?",
	"ORDER: operator > sigma > eta   YOU: eta",
	"TRANSCRIPT (2 turns, oldest first):",
	"  r1 p1 operator: Start with the risks.",
	"  r1 p2 sigma: [skipped: no answer by deadline]",
	"INSTRUCTION: Answer in one paragraph.",
	"HOW TO ANSWER: call debate_post_turn {roomId, turnSeq, text, done?} exactly once, then mark this message read in the same turn. Answer only. Limit 500 characters. Deadline 2026-01-01T00:00:00.000Z.",
].join("\n");

describe("B15 turn message frame", () => {
	test("reproduces the golden frame byte for byte", () => {
		const out = buildTurnFrame(frameInput(GOLDEN_TURNS));
		expect(out.text).toBe(GOLDEN);
		expect(out.shown).toBe(2);
		expect(out.omitted).toBe(0);
	});

	test("carries subject, round, order, transcript, the answer token and the instruction", () => {
		const t = buildTurnFrame(frameInput(GOLDEN_TURNS)).text;
		for (const needle of [
			"SUBJECT: Should we ship?",
			"round 1/2",
			"ORDER: operator > sigma > eta",
			"TRANSCRIPT",
			"debate_post_turn",
			"INSTRUCTION: Answer in one paragraph.",
			"room R1",
		]) {
			expect(t).toContain(needle);
		}
	});

	test("an empty transcript says so instead of printing nothing", () => {
		const t = buildTurnFrame(frameInput([])).text;
		expect(t).toContain("TRANSCRIPT (0 turns, oldest first):");
		expect(t).toContain("(no turns yet)");
	});

	test("over the limit: oldest WHOLE turns are replaced by one omitted line; shown + omitted = all", () => {
		const many: FrameTurn[] = Array.from({ length: 8 }, (_, i) => ({
			round: 1,
			position: (i % 3) + 1,
			label: i % 2 === 0 ? "sigma" : "eta",
			kind: "answer" as const,
			text: `answer number ${i} ${"x".repeat(60)}`,
		}));
		const full = buildTurnFrame(frameInput(many, 100000));
		expect(full.omitted).toBe(0);
		const cut = buildTurnFrame(frameInput(many, full.text.length - 150));
		expect(cut.omitted).toBeGreaterThan(0);
		expect(cut.shown + cut.omitted).toBe(many.length);
		expect(cut.text).toContain(
			`[${cut.omitted} earlier turns omitted; read them with debate_get_room {roomId}]`,
		);
		// the newest turn survives, the oldest does not, and no kept turn is cut mid-text
		expect(cut.text).toContain("answer number 7");
		expect(cut.text).not.toContain("answer number 0 ");
		for (const line of cut.text.split("\n").filter((l) => l.startsWith("  r1 "))) {
			expect(line.endsWith("x".repeat(60))).toBe(true);
		}
		expect(cut.text.length).toBeLessThanOrEqual(full.text.length - 150);
	});

	test("refused, dropped and system rows are rendered without inventing a body", () => {
		const t = buildTurnFrame(
			frameInput([
				{ round: 1, position: 2, label: "sigma", kind: "refused", reason: "not_your_turn" },
				{ round: 1, position: 2, label: "sigma", kind: "dropped", text: "dropped after 2 consecutive skips" },
				{ round: 1, position: 2, label: "system", kind: "system", text: "closed: all_silent" },
			]),
		).text;
		expect(t).toContain("r1 p2 sigma: [refused: not_your_turn]");
		expect(t).toContain("r1 p2 sigma: [dropped: dropped after 2 consecutive skips]");
		expect(t).toContain("r1 p2 system: [system: closed: all_silent]");
	});
});
