/**
 * debate_get_room bounds its whole serialized result (VantagePeers Cloud, task
 * k17d1q04zkfqnwxnjf6rjdbtqh8htnd0, coverage 3/3).
 *
 * Of the last ten tools it is the one whose answer carries a list that grows
 * with use: the transcript (`turns`, up to the room's turn-row bound, each turn
 * up to maxTurnMessageChars). The text and structuredContent both carry it, so
 * the 60 000-byte cap of the lists (capPage) applies to the whole result: the
 * room stays whole, the transcript is cut to its first turns, and the cut is
 * declared in both channels (_meta in the text, truncated: true in
 * structuredContent). The stub answers what debate:getRoom `returns:`.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import { MAX_LIST_RESPONSE_BYTES, registerTools } from "../tools.js";

const ROOM_ID = `k${"0".repeat(31)}`;
const TURNS = 80;

const room = {
	_id: ROOM_ID,
	_creationTime: 1,
	tenantId: "acme",
	tenantOrgId: "org_acme",
	templateId: `t${"0".repeat(31)}`,
	template: {
		id: "review",
		name: "Review",
		language: "en",
		turnInstruction: "Answer in one paragraph.",
		participants: [
			{
				id: "p1",
				label: "sigma",
				kind: "agent",
				agentId: `a${"0".repeat(31)}`,
				transport: "waker",
			},
		],
		roundLimit: 40,
		maxAnswerChars: 4000,
		turnDeadlineSeconds: 3600,
		maxConsecutiveSkips: 2,
		voiceEnabled: false,
	},
	settings: {
		maxRoundLimit: 40,
		maxParticipants: 6,
		maxRefusalRows: 2,
		maxTurnMessageChars: 4000,
		pollSeconds: 5,
		maxAnswerCharsCeiling: 4000,
		maxLabelChars: 40,
		maxTurnInstructionChars: 400,
		maxActiveRooms: 10,
	},
	subject: "Should we ship?",
	status: "active",
	round: 40,
	position: 0,
	turnSeq: TURNS + 1,
	participantState: [
		{ participantId: "p1", consecutiveSkips: 0, dropped: false },
	],
	createdBy: "user:admin",
	createdById: "user:admin",
	createdAt: 1,
	refusalRows: 0,
	refusalsOverflow: 0,
};
const turns = Array.from({ length: TURNS }, (_, i) => ({
	_id: `u${String(i).padStart(31, "0")}`,
	_creationTime: 2 + i,
	roomId: ROOM_ID,
	turnSeq: i + 1,
	round: i + 1,
	position: 0,
	participantId: "p1",
	kind: "answer",
	writer: "postTurn",
	text: "x".repeat(1_500),
	workDuringTurn: "could_not_judge",
	postedAt: 2 + i,
}));

function masterCtx(): OAuthContext {
	return {
		clientId: "m",
		userId: "m",
		scopes: [],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3600_000,
		isMaster: true,
	} as OAuthContext;
}

async function getRoom() {
	const convex = {
		query: async (name: string) =>
			name === "debate:getRoom" ? { room, turns } : null,
		mutation: async () => null,
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerTools(server, convex, masterCtx());
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	const r = await client.callTool({
		name: "debate_get_room",
		arguments: { roomId: ROOM_ID },
	});
	await client.close();
	return r as {
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
		structuredContent?: {
			room: unknown;
			turns: unknown[];
			truncated?: boolean;
		};
	};
}

describe("debate_get_room: the whole result fits in MAX_LIST_RESPONSE_BYTES", () => {
	it("a long transcript is cut to its first turns, the room whole, the cut declared in both channels", async () => {
		const r = await getRoom();
		expect(r.isError, r.content?.[0]?.text).not.toBe(true);
		const bytes = Buffer.byteLength(JSON.stringify(r), "utf8");
		expect(bytes).toBeLessThanOrEqual(MAX_LIST_RESPONSE_BYTES);
		const sc = r.structuredContent;
		expect(sc?.truncated).toBe(true);
		expect(sc?.room).toEqual(room);
		expect(sc?.turns.length).toBeGreaterThan(0);
		expect(sc?.turns.length).toBeLessThan(TURNS);
		expect(sc?.turns).toEqual(turns.slice(0, sc?.turns.length));
		const text = JSON.parse(r.content[0].text) as {
			_meta?: { _truncated: boolean; _showing: number; _total: number };
			room: unknown;
			turns: unknown[];
		};
		expect(text._meta?._truncated).toBe(true);
		expect(text._meta?._total).toBe(TURNS);
		expect(text.room).toEqual(room);
		expect(text.turns).toEqual(sc?.turns);
	});
});
