/**
 * The world every client-seat test runs in (VantagePeers Cloud, task
 * k177e8dyrnykk3c56yf2b0pgfs8hhz06): one organisation (immobiliere-pujol), a
 * person with a bound personal agent (ulysse), a person with none, and an agent
 * seat (seatbot), behind the REAL /mcp route and the REAL Convex functions
 * (convex-test, reached as the fleet service account). The importing test must
 * `vi.mock("convex/browser")` with ./forwardingConvex.js.
 */

import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { makeFunctionReference } from "convex/server";
import { expect } from "vitest";
import { DEFAULT_MEMBER_SCOPES } from "../../../convex/lib/memberScopes";
import schema from "../../../convex/schema";
import { convexTest } from "../../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../../tests/fixtures/testClerkOrgId";
import { app } from "../../server-http.js";
import {
	_setInternalClientForTest,
	sha256Base64Url,
	sha256Hex,
} from "../../src/auth.js";
import {
	_resetServiceAccountCacheForTest,
	_setServiceAccountDepsForTest,
} from "../../src/serviceAccountAuth.js";
import {
	authorizeAsPerson,
	type Harness,
	installAuthorizeHarness,
	membership,
} from "./authorizeHarness.js";
import { backend } from "./forwardingConvex.js";
import { type Fixtures, makeIdAliaser } from "./seatMatrix.js";

const allModules = import.meta.glob("../../../convex/**/*.ts");
const loadable = ([path]: [string, unknown]) =>
	!path.includes("ragSync") &&
	!path.includes("backfill") &&
	!path.includes("Backfill") &&
	!path.includes("__tests__") &&
	!path.endsWith(".test.ts");
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		(e) => loadable(e) && !e[0].includes("search"),
	),
);
/**
 * The same set plus convex/search.ts, for a world whose test answers the RAG
 * component through `__setRagSearcherForTests` (search tools through /mcp,
 * task k17592gg5t2tencwxks3kysghx8htqg8). Opt-in: every other world keeps the
 * module set it was measured with.
 */
const modulesWithSearch = Object.fromEntries(
	Object.entries(allModules).filter(loadable),
);

export const SERVICE_ACCOUNT_ID = process.env
	.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const SERVICE_ACCOUNT_JWT = "service-account-jwt-for-test";
const REDIRECT = "https://client.example/callback";
const CLIENT_ID = "client-claude";
const CLIENT_SECRET = "client-secret-raw";
const VERIFIER = "seat-matrix-verifier-0123456789-0123456789-0123456789";
export const SLUG = "immobiliere-pujol";
export const ORG_ID = testClerkOrgId(SLUG) as string;
export const BOUND = "user_bound";
export const FREE = "user_free";
const SEAT_OWNER = "user_seat_owner";
export const SEAT_PROFILE = "seat-immobiliere-pujol";

export type T = ReturnType<typeof convexTest<typeof schema>>;
export type ToolResult = { isError?: boolean; content: { text: string }[] };

export const SEATS = [
	"person-bound",
	"person-agentless",
	"agent-seat",
] as const;
export type Seat = (typeof SEATS)[number];

/** One fresh backend per seat: a destructive call of one seat never changes another's cells. */
export async function freshBackend(
	seat: Seat,
	opts: { search?: boolean } = {},
): Promise<{
	t: T;
	harness: Harness;
	fixtures: Fixtures;
	ulysse: string;
	/** Translates between client-visible IDs and convex-test's own. */
	ids: ReturnType<typeof makeIdAliaser>;
}> {
	const harness = await installAuthorizeHarness();
	const t = convexTest(schema, opts.search ? modulesWithSearch : modules);
	const asService = t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
	const ids = makeIdAliaser();
	const call = async (kind: string, name: string, rawArgs: unknown) => {
		const ref = makeFunctionReference<"mutation">(name) as never;
		const args = ids.toBackend(rawArgs ?? {}) as never;
		const out =
			kind === "query"
				? await asService.query(ref, args)
				: kind === "action"
					? await asService.action(ref, args)
					: await asService.mutation(ref, args);
		return ids.fromBackend(out);
	};
	backend.run = call;
	_setInternalClientForTest({
		query: (n: string, a: Record<string, unknown>) => call("query", n, a),
		mutation: (n: string, a: Record<string, unknown>) => call("mutation", n, a),
	} as unknown as Parameters<typeof _setInternalClientForTest>[0]);
	_setServiceAccountDepsForTest({
		createSignInTicket: async () => "ticket",
		exchangeTicketForSession: async () => "session",
		getSessionToken: async () => ({
			jwt: SERVICE_ACCOUNT_JWT,
			exp: Date.now() + 3_600_000,
		}),
	});
	const now = Date.now();
	const seeded = await t.run(async (ctx) => {
		await ctx.db.insert("oauth_clients", {
			clientId: CLIENT_ID,
			clientSecretHash: await sha256Hex(CLIENT_SECRET),
			redirectUris: [REDIRECT],
			name: "Claude",
			scopeProfile: "client-generic",
			createdAt: now,
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		const ulysse = await ctx.db.insert("agents", {
			orgSlug: SLUG,
			clerkOrgId: ORG_ID,
			name: "ulysse",
			normalizedName: "ulysse",
			ownerPersonId: BOUND,
			personalAgentOf: BOUND,
			isActive: true,
			createdAt: now,
		});
		const seatbot = await ctx.db.insert("agents", {
			orgSlug: SLUG,
			clerkOrgId: ORG_ID,
			name: "seatbot",
			normalizedName: "seatbot",
			ownerPersonId: SEAT_OWNER,
			isActive: true,
			createdAt: now,
		});
		// The rows a seat's plain call names are that seat's own: written by the
		// principal it acts as (its agent by ID, or the person by subject).
		const own =
			seat === "person-bound"
				? { label: "ulysse", id: String(ulysse) }
				: seat === "agent-seat"
					? { label: "seatbot", id: String(seatbot) }
					: { label: `user:${FREE}`, id: `user:${FREE}` };
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_ID,
			allowedOrchestrators: ["ulysse", "seatbot"],
			allowedAgentIds: [ulysse, seatbot],
			scopes: ["vantage:read", "vantage:write", ...DEFAULT_MEMBER_SCOPES],
			displayName: SLUG,
			isActive: true,
			createdAt: now,
		});
		for (const [user, role] of [
			[BOUND, "member"],
			[FREE, "member"],
			[SEAT_OWNER, "member"],
		] as const) {
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: SLUG,
				clerkOrgId: ORG_ID,
				clerkUserId: user,
				role,
				createdAt: now,
				updatedAt: now,
			});
		}
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: SEAT_PROFILE,
			description: "seatbot's seat",
			fromAllowList: ["seatbot"],
			namespaceReadPrefixes: [`team/${ORG_ID}`, `project/${SLUG}`],
			namespaceWritePrefixes: [`team/${ORG_ID}`, `project/${SLUG}`],
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_ID,
			agentId: seatbot,
			createdAt: now,
			updatedAt: now,
		});
		const memoryId = await ctx.db.insert("memories", {
			namespace: `team/${SLUG}`,
			clerkOrgId: ORG_ID,
			type: "reference",
			content: "seeded memory",
			createdBy: own.label,
			createdById: own.id,
			relations: [],
			isLatest: true,
			createdAt: now,
			updatedAt: now,
		});
		const taskId = await ctx.db.insert("tasks", {
			title: "seeded task",
			assignedTo: "ulysse",
			priority: "medium",
			status: "todo",
			assignedToId: String(ulysse),
			createdBy: own.label,
			createdById: own.id,
			createdAt: now,
			updatedAt: now,
			orgId: SLUG,
			clerkOrgId: ORG_ID,
		});
		const noteId = await ctx.db.insert("briefingNotes", {
			title: "seeded note",
			topic: "t",
			participants: ["ulysse"],
			content: "seeded note",
			createdBy: own.label,
			createdById: own.id,
			createdAt: now,
			orgId: SLUG,
			clerkOrgId: ORG_ID,
		});
		const messageId = await ctx.db.insert("messages", {
			from: own.label,
			fromId: own.id,
			channel: "ulysse",
			content: "seeded message",
			tenantId: SLUG,
			tenantOrgId: ORG_ID,
			createdAt: now,
		});
		const missionId = await ctx.db.insert("missions", {
			name: "seeded mission",
			project: "p",
			status: "brainstorm",
			priority: "medium",
			pilot: "ulysse",
			agents: ["ulysse"],
			pilotId: String(ulysse),
			agentIds: [String(ulysse)],
			createdBy: own.label,
			createdById: own.id,
			createdAt: now,
			updatedAt: now,
			orgId: SLUG,
			clerkOrgId: ORG_ID,
		} as never);
		return { ulysse, seatbot, memoryId, taskId, noteId, messageId, missionId };
	});
	const a = (id: string) => ids.alias(id);
	harness.setMemberships(BOUND, [membership(ORG_ID, SLUG, "org:editor")]);
	harness.setMemberships(FREE, [membership(ORG_ID, SLUG, "org:editor")]);
	return {
		t,
		harness,
		ids,
		ulysse: a(seeded.ulysse),
		fixtures: {
			ids: {
				memoryId: a(seeded.memoryId),
				targetId: a(seeded.memoryId),
				taskId: a(seeded.taskId),
				noteId: a(seeded.noteId),
				briefingNoteId: a(seeded.noteId),
				messageId: a(seeded.messageId),
				missionId: a(seeded.missionId),
			},
			strings: {
				assignedTo: "ulysse",
				pilot: "ulysse",
				orchestratorId: "ulysse",
				orchestrator: "ulysse",
				agentId: a(seeded.ulysse),
				seatAgentId: a(seeded.seatbot),
				agents: "ulysse",
				participants: "ulysse",
				table: "memories",
				rowId: a(seeded.memoryId),
				// The namespace a read must name: the session's own team space.
				namespace: seat === "agent-seat" ? `team/${ORG_ID}` : `team/${SLUG}`,
				recipient: seat === "agent-seat" ? "seatbot" : "ulysse",
				query: "seeded",
				keyword: "seeded",
			},
		},
	};
}

export async function personToken(
	harness: Harness,
	userId: string,
	agentField: string,
	orgId: string = ORG_ID,
): Promise<string> {
	const r = await authorizeAsPerson(app, {
		clientId: CLIENT_ID,
		redirectUri: REDIRECT,
		challenge: await sha256Base64Url(VERIFIER),
		sessionToken: await harness.session(userId),
		orgId,
		extraFields: { [`agent_${orgId}`]: agentField },
	});
	if (r.code === undefined) {
		throw new Error(`authorize failed: ${r.status} ${JSON.stringify(r.json)}`);
	}
	const res = await app.request("http://localhost:3000/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: r.code,
			code_verifier: VERIFIER,
			redirect_uri: REDIRECT,
			client_id: CLIENT_ID,
		}).toString(),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { access_token: string }).access_token;
}

export async function seatToken(t: T): Promise<string> {
	const raw = "seat-matrix-raw-seat-token";
	await t.withIdentity({ subject: SERVICE_ACCOUNT_ID }).mutation(
		makeFunctionReference<"mutation">("oauth:createAccessToken") as never,
		{
			tokenHash: await sha256Hex(raw),
			clientId: CLIENT_ID,
			userId: "seat-user",
			scopes: ["mcp:full"],
			scopeProfile: SEAT_PROFILE,
			fromAllowList: ["seatbot"],
			namespaceReadPrefixes: [`team/${ORG_ID}`, `project/${SLUG}`],
			namespaceWritePrefixes: [`team/${ORG_ID}`, `project/${SLUG}`],
			expiresAt: Date.now() + 3_600_000,
			clerkOrgSlug: SLUG,
		} as never,
	);
	return raw;
}

/**
 * A client of /mcp presenting `token` as its bearer, and, when given, an agent
 * credential (x-vantage-agent-credential) beside it.
 */
export async function connectAs(
	token: string,
	agentCredential?: string,
): Promise<Client> {
	const client = new Client({ name: "seat-matrix", version: "0.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
			fetch: async (url: string | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				headers.set("Authorization", `Bearer ${token}`);
				if (agentCredential !== undefined) {
					headers.set("x-vantage-agent-credential", agentCredential);
				}
				return app.fetch(new Request(url, { ...init, headers }));
			},
		}),
	);
	return client;
}

/** Undo everything a world installed. */
export function closeWorld(harness: Harness): void {
	harness.restore();
	backend.run = null;
	_setInternalClientForTest(null);
	_setServiceAccountDepsForTest(null);
	_resetServiceAccountCacheForTest();
}

/** The bearer a seat's client presents, minted the way that seat's client gets it. */
export async function tokenFor(
	seat: Seat,
	world: { t: T; harness: Harness; ulysse: string },
): Promise<string> {
	if (seat === "person-bound")
		return await personToken(world.harness, BOUND, world.ulysse);
	if (seat === "person-agentless")
		return await personToken(world.harness, FREE, "");
	return await seatToken(world.t);
}
