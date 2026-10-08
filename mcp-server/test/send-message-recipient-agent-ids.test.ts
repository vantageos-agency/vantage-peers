/**
 * send_message addresses an agent BY ID; list_peers hands out the IDs.
 *
 * VantagePeers Cloud, client incident Iris RH (task
 * k1716f01f9g1a0scz7nj30118h8fx32c). Operator decision 2026-10-08: a recipient
 * is resolved by its agent ID, never by its name. The MCP never turns a name
 * into an ID itself: it forwards the IDs the caller passes, verbatim, and
 * Convex resolves and admits them (convex/__tests__/recipientByAgentId.test.ts).
 *
 * Poles:
 *   FORWARD   recipientAgentIds reach messages:sendMessage verbatim, with the
 *             seat's verified org and acting agent, and no channel key.
 *   CONTRACT  both channel and recipientAgentIds, or neither: refused before
 *             any Convex call.
 *   NAME      the channel path is unchanged (normalised, no recipientAgentIds).
 *   REFUSAL   a Convex refusal of an ID is surfaced as an error result.
 *   DIRECTORY list_peers entries carry the agentId Convex attached, for the
 *             caller's org only; a provider without the directory door falls
 *             back to the name roster with every agentId null; any other
 *             directory error is an error result.
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Result = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const HELIOS = "hélios";
const IRIS_HELIOS_ID = "jh7a2h3s0957ybsap1hqddek3x882sf3";
const IRIS_CLIO_ID = "jh72scrneffpeqwy51rg8hny1x8fv2c4";
const ACME_HELIOS_ID = "jh7acmeacmeacmeacmeacmeacme0001";

function seat(over: Partial<OAuthContext> = {}): OAuthContext {
	return {
		clientId: "client-clio",
		userId: "user-clio",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "clio-iris-rh",
		fromAllowList: ["clio"],
		namespaceReadPrefixes: ["team/iris-rh"],
		namespaceWritePrefixes: ["team/iris-rh"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		accessTokenHash: "hash-clio",
		clerkOrgSlug: "iris-rh",
		seatAgent: { agentId: IRIS_CLIO_ID, orgId: "iris-rh", agentName: "clio" },
		...over,
	};
}

type Call = {
	kind: "query" | "mutation";
	name: string;
	args: Record<string, unknown>;
};

function harness(
	ctx: OAuthContext,
	opts: {
		directory?: unknown;
		roster?: unknown;
		mutationError?: unknown;
	} = {},
) {
	const handlers = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const calls: Call[] = [];
	const convex = {
		query: async (name: string, args: Record<string, unknown>) => {
			calls.push({ kind: "query", name, args });
			if (name.includes("AgentDirectory")) {
				if (opts.directory instanceof Error) throw opts.directory;
				return opts.directory ?? [];
			}
			if (name.startsWith("orgRoster:")) return opts.roster ?? [];
			if (name === "profiles:listProfiles") return [];
			return null;
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			calls.push({ kind: "mutation", name, args });
			if (opts.mutationError !== undefined) throw opts.mutationError;
			return "msg-id";
		},
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(
		{ registerTool: reg, tool: reg } as unknown as Parameters<
			typeof registerTools
		>[0],
		convex,
		ctx,
	);
	const call = (tool: string, args: Record<string, unknown>) => {
		const h = handlers.get(tool);
		if (!h) throw new Error(`${tool} not registered`);
		return h(args);
	};
	const sends = () =>
		calls.filter(
			(c) => c.kind === "mutation" && c.name === "messages:sendMessage",
		);
	return { call, calls, sends };
}

describe("FORWARD — recipientAgentIds reach Convex verbatim", () => {
	it("forwards the IDs, the seat's org and acting agent, and no channel", async () => {
		const h = harness(seat());
		const res = await h.call("send_message", {
			from: "clio",
			recipientAgentIds: [IRIS_HELIOS_ID],
			content: "brief ready",
		});
		expect(res.isError).toBeFalsy();
		const sent = h.sends();
		expect(sent).toHaveLength(1);
		expect(sent[0].args.recipientAgentIds).toEqual([IRIS_HELIOS_ID]);
		expect("channel" in sent[0].args).toBe(false);
		expect(sent[0].args.seatOrgSlug).toBe("iris-rh");
		expect(sent[0].args.verifiedActor).toEqual({
			agentId: IRIS_CLIO_ID,
			orgSlug: "iris-rh",
		});
		expect(JSON.parse(res.content[0].text)).toMatchObject({
			messageId: "msg-id",
			recipientAgentIds: [IRIS_HELIOS_ID],
		});
	});

	it("never normalises an ID (case and accents untouched)", async () => {
		const h = harness(seat());
		const odd = ["JH7A2H3S0957YBSAP1HQDDEK3X882SF3", HELIOS];
		await h.call("send_message", {
			from: "clio",
			recipientAgentIds: odd,
			content: "x",
		});
		expect(h.sends()[0].args.recipientAgentIds).toEqual(odd);
	});
});

describe("CONTRACT — exactly one of channel and recipientAgentIds", () => {
	it("both: refused, nothing sent", async () => {
		const h = harness(seat());
		const res = await h.call("send_message", {
			from: "clio",
			channel: HELIOS,
			recipientAgentIds: [IRIS_HELIOS_ID],
			content: "x",
		});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("INVALID_RECIPIENTS");
		expect(h.sends()).toEqual([]);
	});

	it("neither: refused, nothing sent", async () => {
		const h = harness(seat());
		const res = await h.call("send_message", { from: "clio", content: "x" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("INVALID_RECIPIENTS");
		expect(h.sends()).toEqual([]);
	});
});

describe("NAME — the channel path is unchanged", () => {
	it("a channel is normalised as before and carries no recipientAgentIds", async () => {
		const h = harness(seat());
		await h.call("send_message", {
			from: "clio",
			channel: "Hélios",
			content: "x",
		});
		const sent = h.sends();
		expect(sent).toHaveLength(1);
		expect(sent[0].args.channel).toBe(HELIOS);
		expect("recipientAgentIds" in sent[0].args).toBe(false);
	});
});

describe("REFUSAL — Convex's refusal of an ID is surfaced", () => {
	it("a foreign ID refused by Convex is an error result naming the reason", async () => {
		const refusal = Object.assign(new Error("[Request ID: x] Server Error"), {
			data: `RBAC_DENIED: recipient agent "${ACME_HELIOS_ID}" is not an addressable agent of the sender's organisation — {"reason":"recipient-agent-not-addressable","door":"messages:sendMessage"}`,
		});
		const h = harness(seat(), { mutationError: refusal });
		const res = await h.call("send_message", {
			from: "clio",
			recipientAgentIds: [ACME_HELIOS_ID],
			content: "x",
		});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("recipient-agent-not-addressable");
	});
});

describe("DIRECTORY — list_peers carries the agentId Convex attached", () => {
	const DIRECTORY = [
		{ name: "clio", agentId: IRIS_CLIO_ID },
		{ name: HELIOS, agentId: IRIS_HELIOS_ID },
		{ name: "ghost", agentId: null },
	];

	const peers = async (h: ReturnType<typeof harness>) => {
		const res = await h.call("list_peers", {});
		expect(res.isError).toBeFalsy();
		return JSON.parse(res.content[0].text) as Array<{
			id: string;
			agentId: string | null;
		}>;
	};

	it("seat token: reads the directory of ITS OWN token hash; each entry has its agentId", async () => {
		const h = harness(seat(), { directory: DIRECTORY });
		const list = await peers(h);
		expect(list.map((p) => [p.id, p.agentId])).toEqual([
			["clio", IRIS_CLIO_ID],
			[HELIOS, IRIS_HELIOS_ID],
			["ghost", null],
		]);
		expect(JSON.stringify(list)).not.toContain(ACME_HELIOS_ID);
		expect(h.calls).toContainEqual({
			kind: "query",
			name: "orgRoster:getAgentDirectoryForAccessToken",
			args: { tokenHash: "hash-clio" },
		});
		expect(h.calls.some((c) => c.name === "orgRoster:getForAccessToken")).toBe(
			false,
		);
	});

	it("Clerk session: reads getMyAgentDirectory", async () => {
		const h = harness(seat({ accessTokenHash: undefined, clerkJwt: "jwt" }), {
			directory: DIRECTORY,
		});
		expect(await peers(h)).toHaveLength(3);
		expect(h.calls.map((c) => c.name)).toContain(
			"orgRoster:getMyAgentDirectory",
		);
	});

	it("a provider without the directory door: name roster, every agentId null", async () => {
		const h = harness(seat(), {
			directory: new Error(
				"[Request ID: x] Server Error Could not find public function for 'orgRoster:getAgentDirectoryForAccessToken'",
			),
			roster: ["clio", HELIOS],
		});
		const list = await peers(h);
		expect(list.map((p) => [p.id, p.agentId])).toEqual([
			["clio", null],
			[HELIOS, null],
		]);
		expect(h.calls.map((c) => c.name)).toContain("orgRoster:getForAccessToken");
	});

	it("any other directory error is an error result; the roster is not read", async () => {
		const h = harness(seat(), {
			directory: new Error(
				"RBAC_DENIED: access token not found, revoked, or expired",
			),
			roster: ["clio"],
		});
		const res = await h.call("list_peers", {});
		expect(res.isError).toBe(true);
		expect(h.calls.some((c) => c.name === "orgRoster:getForAccessToken")).toBe(
			false,
		);
	});

	it("a refusal envelope from the directory door is surfaced, naming that door", async () => {
		const h = harness(seat(), { directory: { refused: true, items: [] } });
		const res = await h.call("list_peers", {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain(
			"orgRoster:getAgentDirectoryForAccessToken",
		);
	});
});
