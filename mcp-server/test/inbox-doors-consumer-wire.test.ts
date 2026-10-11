/**
 * The inbox doors, driven from the CONSUMER side. VantagePeers Cloud.
 *
 * PR #1491 changes the contract of messages:checkNewMessagesEnvelope,
 * checkNewMessages, getUnreadCount, markAsRead and deleteMessage (new optional
 * args `recipient` / `verifiedActor` / `verifiedOrg`, `orchestratorId` made
 * optional, new return shapes in convex/lib/inboxReader.ts). Their only consumer
 * is the MCP server, so this suite lives outside convex/ and speaks to the doors
 * the way the MCP does:
 *
 *   OLD WIRE (main 71510d2, the MCP that is live until #1492 deploys): the REAL
 *   check_messages / mark_as_read / delete_message handlers of
 *   mcp-server/src/tools.ts (registerTools), reaching the REAL Convex functions
 *   (convex-test) as the fleet service account. No claim is sent. The doors
 *   must serve it exactly as production serves it today (expand mode).
 *
 *   NEW WIRE (#1492): the arguments that PR forwards, `verifiedActor` (a seat
 *   resolved to an agent ID) or `verifiedOrg` (an org-level token), sent to the
 *   same doors. The strict reader serves the caller's own inbox only.
 *
 * Every pole asserts a returned value or a refusal code, never a mock call.
 */

import { makeFunctionReference } from "convex/server";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { beforeEach, describe, expect, it } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { normalizeOrchestratorId } from "../../convex/_helpers/normalizeOrchestratorId";
import { UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT } from "../../convex/lib/inboxReader";
import schema from "../../convex/schema";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../convex/**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill") &&
			!path.includes("__tests__") &&
			!path.endsWith(".test.ts"),
	),
);

const SERVICE_ACCOUNT_ID = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const FLEET = "vantage-fleet";
const ORG_A = "org-a";
const ORG_B = "org-b";
const NOW = 1_700_000_000_000;

type T = ReturnType<typeof convexTest<typeof schema>>;
type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;

/** A Convex client that reaches the real functions as the service account. */
function bridge(t: T) {
	const sa = t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
	return {
		query: (name: string, args: Record<string, unknown>) =>
			sa.query(makeFunctionReference<"query">(name) as never, args as never),
		mutation: (name: string, args: Record<string, unknown>) =>
			sa.mutation(
				makeFunctionReference<"mutation">(name) as never,
				args as never,
			),
	};
}

type World = {
	t: T;
	agentA: Id<"agents">;
	agentB: Id<"agents">;
	receipt: Record<string, string>;
	message: Record<string, Id<"messages">>;
};

let w: World;
let tools: Map<string, Tool>;
let client: ReturnType<typeof bridge>;

async function seed(): Promise<World> {
	const t = convexTest(schema, modules);
	const world = await t.run(async (ctx) => {
		const mapping = (slug: string, names: string[], operator: boolean) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: names,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(operator ? { orgKind: "operator" as const } : {}),
			});
		await mapping(FLEET, ["pi", "sigma"], true);
		await mapping(ORG_A, ["hélios"], false);
		await mapping(ORG_B, ["hélios"], false);
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		const fleetPi = await agent(FLEET, "pi");
		const agentA = await agent(ORG_A, "hélios");
		const agentB = await agent(ORG_B, "hélios");

		const message: Record<string, Id<"messages">> = {};
		const receipt: Record<string, string> = {};
		const put = async (
			key: string,
			o: {
				from: string;
				recipient: string;
				recipientId?: string;
				tenantId?: string;
			},
		) => {
			message[key] = await ctx.db.insert("messages", {
				from: o.from,
				channel: o.recipient,
				content: key,
				tenantId: o.tenantId,
				createdAt: NOW,
			});
			receipt[key] = await ctx.db.insert("messageReceipts", {
				messageId: message[key],
				recipient: o.recipient,
				...(o.recipientId !== undefined ? { recipientId: o.recipientId } : {}),
				tenantId: o.tenantId,
				readAt: undefined,
			});
		};
		await put("pi-UNSTAMPED", { from: "omega", recipient: "pi" });
		await put("pi-FLEET", {
			from: "omega",
			recipient: "pi",
			tenantId: FLEET,
			recipientId: fleetPi,
		});
		await put("A-BY-ID", {
			from: "nova",
			recipient: "hélios",
			recipientId: agentA,
			tenantId: ORG_A,
		});
		await put("A-LEGACY", {
			from: "nova",
			recipient: "hélios",
			tenantId: ORG_A,
		});
		await put("B-BY-ID", {
			from: "x",
			recipient: "hélios",
			recipientId: agentB,
			tenantId: ORG_B,
		});
		await put("B-LEGACY", { from: "x", recipient: "hélios", tenantId: ORG_B });
		message["A-SENT"] = await ctx.db.insert("messages", {
			from: "hélios",
			channel: "nova",
			content: "A-SENT",
			tenantId: ORG_A,
			createdAt: NOW,
		});
		return { agentA, agentB, receipt, message };
	});
	return { t, ...world };
}

beforeEach(async () => {
	w = await seed();
	client = bridge(w.t);
	tools = new Map<string, Tool>();
	const server = {
		tool() {},
		registerTool: (name: string, _config: unknown, handler: Tool) => {
			tools.set(name, handler);
		},
	} as never;
	// The master bearer: the claimless service-account seat the OLD MCP serves
	// (no seatAgent, no clerkOrgSlug, so no claim is ever attached to a door).
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
	// biome-ignore lint/suspicious/noExplicitAny: test bridge
	registerTools(server, client as any, master);
});

async function tool(name: string, args: Record<string, unknown>) {
	const handler = tools.get(name);
	expect(handler, name).toBeDefined();
	return (await handler?.(args)) as ToolResult;
}

/** check_messages through the real tool: the contents it listed, sorted. */
async function checkMessages(
	args: Record<string, unknown>,
): Promise<{ contents: string[]; receiptIds: string[] }> {
	const r = await tool("check_messages", args);
	expect(r.isError, r.content[0].text).toBeFalsy();
	const text = r.content[0].text;
	if (text === "No new messages.") return { contents: [], receiptIds: [] };
	const rows = JSON.parse(text) as Array<{
		receiptId: string;
		content: string;
	}>;
	return {
		contents: rows.map((m) => m.content).sort(),
		receiptIds: rows.map((m) => m.receiptId),
	};
}

const doorContents = async (args: Record<string, unknown>) =>
	(
		(await client.query("messages:checkNewMessagesEnvelope", args)) as {
			messages: Array<{ content: string }>;
		}
	).messages
		.map((m) => m.content)
		.sort();

async function refusedWith(p: Promise<unknown>, reason: string) {
	let caught: unknown;
	try {
		await p;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeDefined();
	const e = caught as { data?: unknown; message?: string };
	const text = `${typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? "")} ${e.message ?? ""}`;
	expect(text).toContain("RBAC_DENIED");
	expect(text).toContain(reason);
}

describe.runIf(UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
	"OLD WIRE (71510d2, real MCP tools, no claim): served as production serves it",
	() => {
		it("check_messages, then mark_as_read with its receiptIds, drains a fleet station's inbox", async () => {
			const first = await checkMessages({ recipient: "pi" });
			expect(first.contents).toEqual(["pi-FLEET", "pi-UNSTAMPED"]);

			const marked = await tool("mark_as_read", {
				receiptIds: first.receiptIds,
				callerOrchestrator: "pi",
			});
			expect(marked.isError, marked.content[0].text).toBeFalsy();
			expect(JSON.parse(marked.content[0].text)).toEqual({ markedAsRead: 2 });

			expect(await checkMessages({ recipient: "pi" })).toEqual({
				contents: [],
				receiptIds: [],
			});
		});

		it("getUnreadCount, called as the dashboard calls it ({ orchestratorId }), counts the station's receipts", async () => {
			expect(
				await client.query("messages:getUnreadCount", { orchestratorId: "pi" }),
			).toBe(2);
		});

		it("a seat of org A passing its own tenantId reads exactly its own two", async () => {
			expect(
				(await checkMessages({ recipient: "hélios", tenantId: ORG_A }))
					.contents,
			).toEqual(["A-BY-ID", "A-LEGACY"]);
		});

		it("two same-named seats send identical bytes and are answered identically (every tenant)", async () => {
			// The claimless wire cannot tell org A's hélios from org B's; the new
			// wire below is what separates them.
			expect((await checkMessages({ recipient: "hélios" })).contents).toEqual([
				"A-BY-ID",
				"A-LEGACY",
				"B-BY-ID",
				"B-LEGACY",
			]);
		});

		it("delete_message by the original sender is served", async () => {
			const r = await tool("delete_message", {
				messageId: w.message["A-SENT"],
				callerOrchestrator: "hélios",
			});
			expect(r.isError, r.content[0].text).toBeFalsy();
			expect(JSON.parse(r.content[0].text)).toEqual({
				deleted: true,
				receiptsDeleted: 0,
			});
		});

		it("a name that does not own the receipt still cannot mark it", async () => {
			const r = await tool("mark_as_read", {
				receiptIds: [w.receipt["A-LEGACY"]],
				callerOrchestrator: "pi",
			});
			expect(r.isError).toBe(true);
		});
	},
);

describe("NEW WIRE (#1492): verifiedActor / verifiedOrg get the strict reader", () => {
	it("org B's seat (verifiedActor) reads and counts its own inbox, not the same-named agent of org A", async () => {
		const verifiedActor = { agentId: w.agentB, orgSlug: ORG_B };
		expect(await doorContents({ recipient: "hélios", verifiedActor })).toEqual([
			"B-BY-ID",
			"B-LEGACY",
		]);
		expect(
			await client.query("messages:getUnreadCount", {
				orchestratorId: "hélios",
				verifiedActor,
			}),
		).toBe(2);
	});

	it("org B's seat marking org A's receipt is refused; marking its own is served", async () => {
		const verifiedActor = { agentId: w.agentB, orgSlug: ORG_B };
		await refusedWith(
			client.mutation("messages:markAsRead", {
				receiptIds: [w.receipt["A-LEGACY"]],
				callerOrchestrator: "hélios",
				verifiedActor,
			}),
			"receipt-not-yours",
		);
		expect(
			await client.mutation("messages:markAsRead", {
				receiptIds: [w.receipt["B-BY-ID"], w.receipt["B-LEGACY"]],
				callerOrchestrator: "hélios",
				verifiedActor,
			}),
		).toBe(2);
		expect(await doorContents({ recipient: "hélios", verifiedActor })).toEqual(
			[],
		);
		// Org A's inbox is untouched by org B's marking.
		expect(
			await doorContents({
				recipient: "hélios",
				verifiedActor: { agentId: w.agentA, orgSlug: ORG_A },
			}),
		).toEqual(["A-BY-ID", "A-LEGACY"]);
	});

	it("an org-level token (verifiedOrg) reads its org's inbox only", async () => {
		expect(
			await doorContents({
				recipient: "hélios",
				verifiedOrg: { orgSlug: ORG_A },
			}),
		).toEqual(["A-BY-ID", "A-LEGACY"]);
	});

	it("org A's agent naming org B as the tenant is refused", async () => {
		await refusedWith(
			client.query("messages:checkNewMessagesEnvelope", {
				recipient: "hélios",
				tenantId: ORG_B,
				verifiedActor: { agentId: w.agentA, orgSlug: ORG_A },
			}),
			"tenant-not-the-readers-org",
		);
	});
});
