/**
 * A PERSON writes in its own space without being told which one
 * (task k172sk173z6mw5cfc5refy1pz18hgaqa).
 *
 * Measured on production: a person (claude.ai connector, OAuth person token,
 * scope profile team-member, personal agent "SP") said "remember that ...". The
 * model called store_memory with namespace "global", was refused with a text
 * that named no writable namespace, and asked the human which one to use.
 *
 * Poles:
 *   - a person omitting namespace writes in team/<org slug> (read back);
 *   - a person naming "global" is refused, and the refusal names team/<org slug>;
 *   - a person naming another org's team namespace is still refused;
 *   - whoami returns the session's writable namespaces and its default;
 *   - a seat omitting namespace writes in its own orchestrator/<agent ID>;
 *   - master omitting namespace is refused (no natural default), never guessed.
 *
 * Harness: the real bearer middleware (a person token minted through
 * oauth:createAccessToken, the personal agent resolved by Convex) and the real
 * Convex functions (convex-test), reached as the fleet service account.
 */

import { makeFunctionReference } from "convex/server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../../convex/schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedMintProfile } from "../../tests/lib/seedMintProfile";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	checkNamespaceWrite,
	defaultWriteNamespace,
	type OAuthContext,
	sha256Hex,
	writableNamespacesOf,
} from "../src/auth.js";
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
const PERSON = "user_2sp_person";
const ORG = "sp-prive";
const OTHER_ORG = "other-org";

type T = ReturnType<typeof convexTest<typeof schema>>;
type ToolResult = {
	isError?: boolean;
	content: { text: string }[];
	structuredContent?: Record<string, unknown>;
};
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;

let t: T;
let personCtx: OAuthContext;
let person: Map<string, Tool>;
let spAgentId: string;

function bridge(c: T) {
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

async function contextOf(token: string): Promise<OAuthContext> {
	const probe = new Hono();
	probe.use("*", bearerAuthMiddleware());
	probe.get("/ctx", (c) => c.json(c.get("oauthContext")));
	const res = await probe.request("http://localhost:3000/ctx", {
		headers: { authorization: `Bearer ${token}` },
	});
	expect(res.status).toBe(200);
	return (await res.json()) as OAuthContext;
}

function realTools(ctx: OAuthContext): Map<string, Tool> {
	const tools = new Map<string, Tool>();
	const server = {
		tool() {},
		registerTool: (name: string, _config: unknown, handler: Tool) => {
			tools.set(name, handler);
		},
	} as never;
	registerTools(
		server,
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
		ctx,
	);
	return tools;
}

async function call(
	tools: Map<string, Tool>,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const tool = tools.get(name);
	expect(tool, name).toBeDefined();
	return (await tool?.(args)) as ToolResult;
}

beforeEach(async () => {
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	const now = Date.now();
	await t.run(async (ctx) => {
		for (const [slug, roster] of [
			[ORG, ["SP"]],
			[OTHER_ORG, ["other"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [...roster],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		}
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
	});
	const sp = await t.run((ctx) =>
		ctx.db.insert("agents", {
			orgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			name: "SP",
			normalizedName: "sp",
			isActive: true,
			createdAt: now,
			personalAgentOf: PERSON,
		}),
	);
	spAgentId = sp;
	await t.run(async (ctx) => {
		const m = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", ORG))
			.unique();
		if (m !== null) await ctx.db.patch(m._id, { allowedAgentIds: [sp] });
	});
	await seedMintProfile(t, "team-member", ORG);
	const raw = "raw-sp-person";
	await t.withIdentity({ subject: SERVICE_ACCOUNT_ID }).mutation(
		makeFunctionReference<"mutation">("oauth:createAccessToken") as never,
		{
			tokenHash: await sha256Hex(raw),
			clientId: "claude",
			userId: PERSON,
			scopes: ["mcp:full"],
			scopeProfile: "team-member",
			fromAllowList: ["SP"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			clerkOrgSlug: ORG,
			orgRole: "org:editor",
			principal: "person",
		} as never,
	);
	personCtx = await contextOf(raw);
	expect(personCtx.principal).toBe("person");
	expect(personCtx.scopeProfile).toBe("team-member");
	person = realTools(personCtx);
});

afterEach(() => {
	_setInternalClientForTest(null);
	vi.unstubAllEnvs();
});

describe("store_memory: a person's write lands in its own space", () => {
	it("no namespace -> stored in team/<org slug>, read back from the row", async () => {
		const r = await call(person, "store_memory", {
			type: "user",
			content: "SP prefers short answers",
		});
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		const out = JSON.parse(r.content[0].text) as {
			memoryId: string;
			namespace: string;
		};
		expect(out.namespace).toBe(`team/${ORG}`);
		const row = await t.run((ctx) =>
			ctx.db.get(out.memoryId as never),
		);
		expect((row as { namespace?: string } | null)?.namespace).toBe(
			`team/${ORG}`,
		);
	});

	it("namespace 'global' -> refused, and the refusal names team/<org slug>", async () => {
		const r = await call(person, "store_memory", {
			namespace: "global",
			type: "user",
			content: "x",
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain(`team/${ORG}`);
		expect(r.content[0].text).toContain("namespace='global'");
	});

	it("another org's team namespace -> still refused", async () => {
		const r = await call(person, "store_memory", {
			namespace: `team/${OTHER_ORG}`,
			type: "user",
			content: "x",
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("Forbidden");
		const rows = await t.run((ctx) => ctx.db.query("memories").collect());
		expect(
			rows.filter((m) => m.namespace === `team/${OTHER_ORG}`),
		).toHaveLength(0);
	});
});

describe("store_episode: a person's episode lands in its own space", () => {
	it("no namespace -> stored in team/<org slug>", async () => {
		const r = await call(person, "store_episode", {
			context: "c",
			goal: "g",
			action: "a",
			outcome: "o",
			insight: "i",
			severity: "minor",
		});
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		const out = JSON.parse(r.content[0].text) as { namespace: string };
		expect(out.namespace).toBe(`team/${ORG}`);
	});
});

describe("whoami: the session's writable namespaces", () => {
	it("returns writableNamespaces and default_write_namespace", async () => {
		const r = await call(person, "whoami", {});
		const sc = r.structuredContent as {
			writableNamespaces?: string[];
			default_write_namespace?: string | null;
		};
		expect(sc.writableNamespaces).toContain(`team/${ORG}`);
		expect(sc.writableNamespaces).toContain(`orchestrator/${spAgentId}`);
		expect(sc.default_write_namespace).toBe(`team/${ORG}`);
	});
});

describe("defaultWriteNamespace / writableNamespacesOf: seat and master", () => {
	const seat: OAuthContext = {
		clientId: "seat",
		userId: "seat",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "acme-seat",
		fromAllowList: ["alpha"],
		namespaceReadPrefixes: ["team/org_acme", "project/acme"],
		namespaceWritePrefixes: ["team/org_acme", "project/acme"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		ownAgentNamespace: "orchestrator/agent123",
		ownProjectNamespace: "project/acme",
	};
	const master: OAuthContext = {
		...seat,
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		isMaster: true,
		ownAgentNamespace: undefined,
		ownProjectNamespace: undefined,
	};

	it("a seat defaults to its own orchestrator/<agent ID>", () => {
		expect(defaultWriteNamespace(seat)).toBe("orchestrator/agent123");
	});

	it("a seat's writable list is its prefixes plus its own namespaces, deduped", () => {
		expect(writableNamespacesOf(seat)).toEqual([
			"team/org_acme",
			"project/acme",
			"orchestrator/agent123",
		]);
	});

	it("a seat's refusal names its writable namespaces", () => {
		const err = checkNamespaceWrite(seat, "global");
		expect(err).toContain("orchestrator/agent123");
		expect(err).toContain("team/org_acme");
	});

	it("a seat with no verified agent and several prefixes has no default", () => {
		expect(
			defaultWriteNamespace({ ...seat, ownAgentNamespace: undefined }),
		).toBeUndefined();
	});

	it("master has no default (never guessed)", () => {
		expect(defaultWriteNamespace(master)).toBeUndefined();
		expect(writableNamespacesOf(master)).toEqual([]);
	});

	it("master omitting namespace on store_memory is refused, nothing written", async () => {
		const tools = realTools(master);
		const r = await call(tools, "store_memory", {
			type: "user",
			content: "x",
			createdBy: "pi",
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("namespace");
		const rows = await t.run((ctx) => ctx.db.query("memories").collect());
		expect(rows).toHaveLength(0);
	});
});
