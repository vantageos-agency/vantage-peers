/// <reference types="vite/client" />
/**
 * CLIENT REGRESSION (modules M10a + M14): after the memory and episode doors
 * began to refuse any `createdBy` that is not the verified caller, a Clerk-JWT
 * member (Claude.ai / ChatGPT / Claude Code of VantagePeers Cloud) that typed an
 * agent name or whatever its client likes could no longer write.
 *
 * The member acts as ITSELF: the MCP server drops the typed author and forwards
 * none (the Convex door reads the verified subject off the member's own JWT and
 * stamps `user:<subject>`); the label shown to the caller is that same actor.
 *
 * POLES (real Convex functions through convex-test, the real tool handlers)
 *   (a) SERVED   store_memory / store_episode by a Clerk-JWT member succeed whatever
 *                `createdBy` the client typed (or none), stamped user:<subject>.
 *   (b) REFUSED  a member whose door is handed ANOTHER author is refused by Convex
 *                (author-not-caller): the MCP's silence is not the only guard.
 *   (c) SEAT     the fleet service account keeps stating the label of its seat; it
 *                must name one.
 */

import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import schema from "../../convex/schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
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
const ORG_ID = testClerkOrgId("author-org");

type T = ReturnType<typeof convexTest<typeof schema>>;
type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;

function bridge(c: {
	query: (...a: never[]) => unknown;
	mutation: (...a: never[]) => unknown;
}) {
	return {
		query: (name: string, args: Record<string, unknown>) =>
			c.query(makeFunctionReference<"query">(name) as never, args as never),
		mutation: (name: string, args: Record<string, unknown>) =>
			c.mutation(
				makeFunctionReference<"mutation">(name) as never,
				args as never,
			),
	};
}

function tools(
	convexClient: ReturnType<T["withIdentity"]>,
	ctx: OAuthContext,
): Map<string, Tool> {
	const map = new Map<string, Tool>();
	const server = {
		tool() {},
		registerTool: (name: string, _config: unknown, handler: Tool) => {
			map.set(name, handler);
		},
	} as never;
	registerTools(
		server,
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(convexClient as any) as any,
		ctx,
	);
	return map;
}

// What the bearer middleware attaches for a verified Clerk session JWT (auth path 2.5).
const clerkMemberCtx = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "dcr-clerk-author-org",
	userId: "user_member",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "team-member",
	fromAllowList: [],
	namespaceReadPrefixes: ["team/author-org"],
	namespaceWritePrefixes: ["team/author-org"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkJwt: "verified.clerk.jwt",
	clerkOrgSlug: "author-org",
	...over,
});

const EPISODE = {
	namespace: "team/author-org",
	context: "c",
	goal: "g",
	action: "a",
	outcome: "o",
	insight: "i",
	severity: "minor",
};

let t: T;
const member = () =>
	t.withIdentity({
		subject: "user_member",
		org_id: ORG_ID,
		org_slug: "author-org",
		org_role: "org:member",
	} as Parameters<typeof t.withIdentity>[0]);

beforeEach(async () => {
	vi.useFakeTimers();
	vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "strict");
	t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "author-org",
			clerkOrgId: ORG_ID,
			allowedOrchestrators: [],
			scopes: ["vantage:read", "vantage:write"],
			displayName: "author-org",
			isActive: true,
			createdAt: 1,
		});
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

const rows = () => t.run((ctx) => ctx.db.query("memories").collect());

describe("(a) a Clerk-JWT member writes in its own name", () => {
	for (const typed of [undefined, "claude", "pi", "user:user_member"]) {
		it(`store_memory createdBy=${String(typed)} is stamped user:<subject>`, async () => {
			const store = tools(member(), clerkMemberCtx()).get("store_memory");
			const r = await store?.({
				namespace: "team/author-org",
				type: "project",
				content: `memory typed as ${String(typed)}`,
				...(typed === undefined ? {} : { createdBy: typed }),
			});
			expect(r?.isError, r?.content[0]?.text).toBeFalsy();
			const [row] = await rows();
			expect(row?.createdBy).toBe("user:user_member");
			expect(row?.clerkOrgId).toBe(ORG_ID);
			expect(JSON.parse(r?.content[0]?.text ?? "{}").createdBy).toBe(
				"user:user_member",
			);
		});

		it(`store_episode createdBy=${String(typed)} is stamped user:<subject>`, async () => {
			const store = tools(member(), clerkMemberCtx()).get("store_episode");
			const r = await store?.({
				...EPISODE,
				...(typed === undefined ? {} : { createdBy: typed }),
			});
			expect(r?.isError, r?.content[0]?.text).toBeFalsy();
			const [row] = await rows();
			expect(row?.createdBy).toBe("user:user_member");
			expect(row?.clerkOrgId).toBe(ORG_ID);
		});
	}

	it("a member that also presents an agent credential keeps the agent rules: a name that is not the credential's is refused", async () => {
		const ctx = clerkMemberCtx({
			actor: { orgSlug: "author-org", agentName: "alice" },
			fromAllowList: ["alice"],
		});
		const store = tools(member(), ctx).get("store_memory");
		const bad = await store?.({
			namespace: "team/author-org",
			type: "project",
			content: "x",
			createdBy: "bob",
		});
		expect(bad?.isError).toBe(true);
		expect(bad?.content[0]?.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(await rows()).toHaveLength(0);
		const ok = await store?.({
			namespace: "team/author-org",
			type: "project",
			content: "y",
			createdBy: "alice",
		});
		expect(ok?.isError, ok?.content[0]?.text).toBeFalsy();
		expect((await rows())[0]?.createdBy).toBe("user:user_member");
	});

	it("the member's JWT still decides the namespace: a foreign team namespace is refused", async () => {
		const store = tools(member(), clerkMemberCtx()).get("store_memory");
		const r = await store?.({
			namespace: "team/other-org",
			type: "project",
			content: "x",
			createdBy: "claude",
		});
		expect(r?.isError).toBe(true);
		expect(await rows()).toHaveLength(0);
	});
});

describe("(b) Convex still refuses a member that is handed another author", () => {
	it("storeMemory and storeEpisode with a foreign createdBy: author-not-caller, nothing written", async () => {
		for (const [fn, args] of [
			[
				"memories:storeMemory",
				{ namespace: "team/author-org", type: "project", content: "x" },
			],
			["episodes:storeEpisode", { ...EPISODE }],
		] as const) {
			const err = await bridge(member())
				.mutation(fn, { ...args, createdBy: "pi" })
				.then(
					() => null,
					(e: Error) => e,
				);
			expect(`${err?.message} ${JSON.stringify((err as { data?: unknown })?.data)}`).toMatch(
				/author-not-caller/,
			);
		}
		expect(await rows()).toHaveLength(0);
	});
});

describe("(c) the fleet service account is unchanged", () => {
	const seat = (): ReturnType<T["withIdentity"]> =>
		t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

	it("store_memory and store_episode record the label of the seat", async () => {
		const map = tools(seat(), LOCAL_STDIO_TRUST_CTX);
		const m = await map.get("store_memory")?.({
			namespace: "team/author-org",
			type: "project",
			content: "seat memory",
			createdBy: "pi",
		});
		const e = await map.get("store_episode")?.({ ...EPISODE, createdBy: "pi" });
		expect(m?.isError, m?.content[0]?.text).toBeFalsy();
		expect(e?.isError, e?.content[0]?.text).toBeFalsy();
		const all = await rows();
		expect(all.map((r) => r.createdBy)).toEqual(["pi", "pi"]);
		expect(all.map((r) => r.clerkOrgId)).toEqual([ORG_ID, ORG_ID]);
	});

	it("a seat that names no author is refused by the tool, not invented one", async () => {
		const map = tools(seat(), LOCAL_STDIO_TRUST_CTX);
		const m = await map.get("store_memory")?.({
			namespace: "team/author-org",
			type: "project",
			content: "no author",
		});
		expect(m?.isError).toBe(true);
		expect(m?.content[0]?.text).toMatch(/createdBy/);
		expect(await rows()).toHaveLength(0);
	});
});
