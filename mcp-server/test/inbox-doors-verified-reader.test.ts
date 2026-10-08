// Task k17c5q842gm1gbh0j2qjtc80g18fx5kb (inbox by agent ID), MCP side: an agent's
// inbox doors (check_messages -> checkNewMessagesEnvelope, mark_as_read,
// delete_message) carry the agent's VERIFIED ID, on QUERIES as well as mutations,
// so Convex never has to read an inbox by the `recipient` name another org's
// same-named agent also carries.
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import {
	VERIFIED_ACTOR_DOORS,
	withVerifiedActor,
} from "../src/verifiedActor.js";

const CLIO_ID = "agentclio0000000000000000000001";

const seat: OAuthContext = {
	clientId: "c",
	userId: "u",
	scopes: [],
	scopeProfile: "p",
	fromAllowList: ["clio"],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: 0,
	isMaster: false,
	accessTokenHash: "h",
	clerkOrgSlug: "iris-rh",
	seatAgent: { agentId: CLIO_ID, orgId: "iris-rh", agentName: "clio" },
};

function fake() {
	const calls: Array<{ kind: "query" | "mutation"; name: string; args: unknown }> =
		[];
	return {
		calls,
		client: {
			query: async (name: string, args: unknown) => {
				calls.push({ kind: "query", name, args });
				return null;
			},
			mutation: async (name: string, args: unknown) => {
				calls.push({ kind: "mutation", name, args });
				return null;
			},
		},
	};
}

const INBOX_DOORS = [
	"messages:checkNewMessages",
	"messages:checkNewMessagesEnvelope",
	"messages:getUnreadCount",
	"messages:markAsRead",
	"messages:deleteMessage",
];

describe("the inbox doors carry the verified agent ID", () => {
	it("every inbox door is a verifiedActor door", () => {
		for (const door of INBOX_DOORS) {
			expect(VERIFIED_ACTOR_DOORS.has(door), door).toBe(true);
		}
	});

	it("a QUERY to check_messages' door carries verifiedActor beside the typed recipient", async () => {
		const { client, calls } = fake();
		await withVerifiedActor(client, seat).query(
			"messages:checkNewMessagesEnvelope",
			{ recipient: "hélios" },
		);
		expect(calls[0]).toEqual({
			kind: "query",
			name: "messages:checkNewMessagesEnvelope",
			args: {
				recipient: "hélios",
				verifiedActor: { agentId: CLIO_ID, orgSlug: "iris-rh" },
			},
		});
	});

	it("mark_as_read and delete_message (mutations) carry it too", async () => {
		const { client, calls } = fake();
		const wrapped = withVerifiedActor(client, seat);
		await wrapped.mutation("messages:markAsRead", { receiptIds: ["r1"] });
		await wrapped.mutation("messages:deleteMessage", { messageId: "m1" });
		for (const call of calls) {
			expect((call.args as { verifiedActor: unknown }).verifiedActor).toEqual({
				agentId: CLIO_ID,
				orgSlug: "iris-rh",
			});
		}
	});

	it("a read of a door that takes no actor is left byte for byte alone", async () => {
		const { client, calls } = fake();
		await withVerifiedActor(client, seat).query("profiles:listProfiles", {});
		expect(calls[0].args).toEqual({});
	});

	it("one proof per call: a person's verifiedPerson is never joined by an agent ID", async () => {
		const { client, calls } = fake();
		await withVerifiedActor(client, seat).mutation("messages:markAsRead", {
			receiptIds: ["r1"],
			verifiedPerson: { accessTokenHash: "h" },
		});
		expect(
			(calls[0].args as { verifiedActor?: unknown }).verifiedActor,
		).toBeUndefined();
	});

	it("a caller with no resolved agent gets the very same client back", () => {
		const { client } = fake();
		expect(withVerifiedActor(client, { ...seat, seatAgent: null })).toBe(client);
	});
});
