/**
 * check_messages: the whole serialized result fits in MAX_LIST_RESPONSE_BYTES
 * (VantagePeers Cloud, task k170byeq1nzzv2q1z6qpag5fp18hvj8a, the Eta REVISE
 * on #1714 applied to 2/3).
 *
 * The inbox page is bounded inside Convex (messages:checkNewMessagesEnvelope
 * `maxBytes`, 40 000 by default, measured on the projected messages). The text
 * repeats those messages and structuredContent repeats them again, so a page
 * at the default bound serializes to about twice it. The stub below answers
 * like the door does: it takes at most `limit` messages (20 by default) while
 * their projected JSON stays within `maxBytes` (the first one always), and says
 * truncated / nextSince.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import { MAX_LIST_RESPONSE_BYTES, registerTools } from "../tools.js";

const BIG = "x".repeat(1_500);
const INBOX = Array.from({ length: 60 }, (_, i) => ({
	receiptId: `r${String(i).padStart(31, "0")}`,
	messageId: `m${String(i).padStart(31, "0")}`,
	from: "pi",
	channel: "sigma",
	content: BIG,
	createdAt: 1_000 + i,
	receiptCreationTime: 2_000 + i,
}));
const EMPTY_STUCK = {
	entries: [],
	total: 0,
	truncated: false,
	actionableStuckCount: 0,
};

/** messages:checkNewMessagesEnvelope, as the door bounds a page. */
function door(args: { maxBytes?: number; since?: number; limit?: number }) {
	const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
	const maxBytes = Math.min(Math.max(args.maxBytes ?? 40_000, 1_000), 60_000);
	const unread = INBOX.filter(
		(m) => args.since === undefined || m.receiptCreationTime > args.since,
	);
	const messages: Array<Record<string, unknown>> = [];
	let bytes = 0;
	let last: number | null = null;
	let truncated = false;
	for (const m of unread) {
		const { receiptCreationTime, ...projected } = m;
		const size = JSON.stringify(projected).length;
		if (
			messages.length >= limit ||
			(messages.length > 0 && bytes + size > maxBytes)
		) {
			truncated = true;
			break;
		}
		messages.push(projected);
		bytes += size;
		last = receiptCreationTime;
	}
	return {
		messages,
		truncated,
		nextSince: truncated ? last : null,
		staleInProgress: [],
		stuckInProgress: EMPTY_STUCK,
		peersStuckOnYou: EMPTY_STUCK,
	};
}

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

async function checkMessages(args: Record<string, unknown>) {
	const convex = {
		query: async (
			name: string,
			a: { maxBytes?: number; since?: number; limit?: number },
		) => (name === "messages:checkNewMessagesEnvelope" ? door(a) : null),
		mutation: async () => null,
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerTools(server, convex, masterCtx());
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	const r = await client.callTool({ name: "check_messages", arguments: args });
	await client.close();
	return r as {
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
		structuredContent?: {
			messages: Array<{ receiptId: string }>;
			truncated: boolean;
			nextSince: number | null;
		};
	};
}

describe("check_messages: the whole result fits in MAX_LIST_RESPONSE_BYTES", () => {
	it("a full inbox page fits, cut by the door, and still says where to resume", async () => {
		const r = await checkMessages({ recipient: "sigma" });
		expect(r.isError, r.content?.[0]?.text).not.toBe(true);
		const bytes = Buffer.byteLength(JSON.stringify(r), "utf8");
		expect(bytes).toBeLessThanOrEqual(MAX_LIST_RESPONSE_BYTES);
		const sc = r.structuredContent;
		expect(sc?.truncated).toBe(true);
		expect(sc?.messages.length).toBeGreaterThan(0);
		expect(typeof sc?.nextSince).toBe("number");
		// The resume value is the door's: the next page starts right after the
		// last message shown, so nothing is skipped.
		const next = await checkMessages({
			recipient: "sigma",
			since: sc?.nextSince,
		});
		expect(next.structuredContent?.messages[0]?.receiptId).toBe(
			INBOX[sc?.messages.length ?? 0].receiptId,
		);
		// The text is still the messages as JSON followed by the resume note.
		expect(r.content[0].text).toBe(
			`${JSON.stringify(sc?.messages, null, 2)}\n— truncated. Resume with check_messages since=${sc?.nextSince}`,
		);
	});

	it("a small inbox is unchanged: one call, every message, not truncated", async () => {
		const r = await checkMessages({ recipient: "sigma", limit: 3 });
		expect(r.isError, r.content?.[0]?.text).not.toBe(true);
		expect(r.structuredContent?.messages).toHaveLength(3);
	});
});
