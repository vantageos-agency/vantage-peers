/**
 * resources/read of ui://vp/v1/<primitive> is FAIL-CLOSED. VantagePeers Cloud
 * (HTTP /mcp entry). Task k17d6s1fsfy9fg7p339gq3rqnx8hc4qh.
 *
 * Defect: the /mcp handler hands a non-Clerk caller the fleet SERVICE-ACCOUNT
 * Convex client (selectConvexClientForRequest), which Convex resolves as
 * master/fleet-wide. The six primitives apply no tenant gate of their own, so a
 * non-master OAuth bearer read every tenant's rows through a ui:// resource.
 *
 * Fix: the read is served only to (a) a Clerk-JWT caller, whose own token
 * reaches Convex and is scoped there, or (b) a master caller. Every other
 * caller is REFUSED with an MCP error carrying RBAC_DENIED and the door name,
 * BEFORE any Convex query (refusal-is-distinguishable-from-absence.md: a
 * refusal, never an empty resource).
 *
 * Runs the REAL McpServer through an in-memory transport so the refusal is
 * measured on the wire shape a client actually receives.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import {
	registerUiResources,
	type UiResourceConvexClient,
} from "../src/ui-resources/register.js";

// One URI per primitive, carrying the params each needs to reach Convex.
const PRIMITIVE_URIS: Record<string, string> = {
	"tasks-table": "ui://vp/v1/tasks-table",
	"messages-feed": "ui://vp/v1/messages-feed",
	"memory-quote": "ui://vp/v1/memory-quote?namespace=global",
	"mission-timeline": "ui://vp/v1/mission-timeline",
	"diary-entry": "ui://vp/v1/diary-entry",
	"briefing-note": "ui://vp/v1/briefing-note",
};

function baseCtx(over: Partial<OAuthContext>): OAuthContext {
	return {
		clientId: "client-1",
		userId: "user_2abc",
		scopes: ["vantage:read"],
		scopeProfile: "team-member",
		fromAllowList: ["ada"],
		namespaceReadPrefixes: ["team/acme"],
		namespaceWritePrefixes: ["team/acme"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		...over,
	};
}

/** Non-master OAuth bearer: no clerkJwt, so it gets the service-account client. */
const OAUTH_NON_MASTER = baseCtx({ accessTokenHash: "a".repeat(64) });
/** Clerk-JWT caller: its own token reaches Convex. */
const CLERK_JWT = baseCtx({ clerkJwt: "eyJ.raw.clerk", clerkOrgSlug: "acme" });
/** Master bearer (auth.ts branch 1). */
const MASTER = baseCtx({
	clientId: "master",
	userId: "master",
	scopeProfile: "master",
	scopes: ["vantage:read", "vantage:write"],
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	isMaster: true,
	viaMasterBearer: true,
});

async function readAs(oauthCtx: OAuthContext | undefined, uri: string) {
	const query = vi.fn(async () => []);
	const convex = { query } as unknown as UiResourceConvexClient;
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerUiResources(server, convex, oauthCtx);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	try {
		const res = await client.readResource({ uri });
		return { query, res, err: undefined as unknown };
	} catch (err: unknown) {
		return { query, res: undefined, err };
	} finally {
		await client.close();
	}
}

describe("ui://vp/v1/* resources/read is fail-closed", () => {
	for (const [primitive, uri] of Object.entries(PRIMITIVE_URIS)) {
		describe(primitive, () => {
			it("REFUSED: non-master OAuth bearer gets RBAC_DENIED naming the door, and NO Convex query is made", async () => {
				const { query, res, err } = await readAs(OAUTH_NON_MASTER, uri);
				expect(res).toBeUndefined();
				expect(err).toBeInstanceOf(Error);
				const e = err as Error & { data?: unknown };
				expect(e.message).toContain("RBAC_DENIED");
				expect(e.message).toContain(`ui://vp/v1/${primitive}`);
				expect(e.data).toMatchObject({
					code: "RBAC_DENIED",
					door: `resources/read ui://vp/v1/${primitive}`,
				});
				expect(query).not.toHaveBeenCalled();
			});

			it("REFUSED: no verified caller at all (undefined context) is refused, never treated as master", async () => {
				const { query, err } = await readAs(undefined, uri);
				expect((err as Error | undefined)?.message).toContain("RBAC_DENIED");
				expect(query).not.toHaveBeenCalled();
			});

			it("SERVED: Clerk-JWT caller is served as today (Convex queried, HTML + markdown)", async () => {
				const { query, res, err } = await readAs(CLERK_JWT, uri);
				expect(err).toBeUndefined();
				expect(res?.contents).toHaveLength(2);
				expect(query).toHaveBeenCalled();
			});

			it("SERVED: master caller is served as today (Convex queried, HTML + markdown)", async () => {
				const { query, res, err } = await readAs(MASTER, uri);
				expect(err).toBeUndefined();
				expect(res?.contents).toHaveLength(2);
				expect(query).toHaveBeenCalled();
			});
		});
	}

	it("resources/list still lists the six templates for a refused caller", async () => {
		const server = new McpServer({ name: "t", version: "0.0.0" });
		const query = vi.fn(async () => []);
		registerUiResources(
			server,
			{ query } as unknown as UiResourceConvexClient,
			OAUTH_NON_MASTER,
		);
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "c", version: "0.0.0" });
		await Promise.all([server.connect(st), client.connect(ct)]);
		const list = await client.listResources();
		await client.close();
		const uris = list.resources.map((r) => r.uri);
		for (const p of Object.keys(PRIMITIVE_URIS)) {
			expect(uris).toContain(`ui://vp/v1/${p}`);
		}
		expect(query).not.toHaveBeenCalled();
	});
});
