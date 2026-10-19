/**
 * check_messages renders the sender's agent ID (task k17bxcx1wz2c7sn86k25nx3j718ggf9f).
 * VantagePeers Cloud. checkNewMessagesEnvelope now returns `fromId` on a message
 * stored by a verifiedActor send; the tool must pass it on to the recipient, and
 * a message without one must render exactly as before (no `fromId` key at all).
 * The Convex client is a stub returning a fixed envelope: this pins the RENDER.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;

const SENDER_ID = "r570wnd6n8mpvcprad2mm00h398ggj7b";

const master: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

async function checkMessages(
	messages: Array<Record<string, unknown>>,
): Promise<ToolResult> {
	const tools = new Map<string, Tool>();
	const server = {
		tool() {},
		registerTool: (name: string, _config: unknown, handler: Tool) => {
			tools.set(name, handler);
		},
	} as never;
	const client = {
		query: async () => ({ messages, truncated: false, nextSince: null }),
		mutation: async () => null,
	};
	// biome-ignore lint/suspicious/noExplicitAny: stub client
	registerTools(server, client as any, master);
	const handler = tools.get("check_messages");
	expect(handler).toBeDefined();
	return (await handler?.({ recipient: "helios" })) as ToolResult;
}

const row = (extra: Record<string, unknown>) => ({
	receiptId: "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	from: "clio",
	fromInstanceId: "clio-vps",
	channel: "helios",
	content: "hello",
	createdAt: 1_700_000_000_000,
	...extra,
});

describe("check_messages renders fromId", () => {
	it("carries the sender's agent ID when the envelope has one", async () => {
		const r = await checkMessages([row({ fromId: SENDER_ID })]);
		expect(r.isError).toBeFalsy();
		const items = JSON.parse(r.content[0].text) as Array<
			Record<string, unknown>
		>;
		expect(items[0].fromId).toBe(SENDER_ID);
		expect(items[0].from).toBe("clio");
	});

	it("renders exactly as before when fromId is absent", async () => {
		const r = await checkMessages([row({})]);
		const items = JSON.parse(r.content[0].text) as Array<
			Record<string, unknown>
		>;
		expect("fromId" in items[0]).toBe(false);
		expect(Object.keys(items[0]).sort()).toEqual(
			[
				"channel",
				"content",
				"createdAt",
				"from",
				"fromInstanceId",
				"receiptId",
			].sort(),
		);
	});
});
