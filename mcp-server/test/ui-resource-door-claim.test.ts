/**
 * S-28 on resources/read of ui://vp/v1/<primitive> (task k1740ydgqb7bxwnftrfyskx1ch8jwtgg;
 * VantagePeers Cloud). The ONE injection point is the `fetchConvex` bridge in
 * src/ui-resources/register.ts: every door a primitive reads through it must carry the
 * caller's verified claim, and a caller that holds none is refused, typed, before any door call.
 *
 * Per door class (the six doors of the verifiedOrg group, each a DOOR_SCOPE entry):
 *   caller with a verified org (slug + ID) -> the door receives `verifiedOrg { orgSlug, orgId }`
 *   caller admitted by org ID alone, no slug -> RBAC_DENIED verified-org-unresolved, ZERO door calls
 *   master / Clerk-JWT session -> no `verifiedOrg` (Convex resolves their scope itself)
 * A claim written into the URI never replaces the verified one.
 *
 * Runs the REAL McpServer through an in-memory transport, so the refusal is the wire shape a
 * client receives.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import {
	registerUiResources,
	type UiResourceConvexClient,
} from "../src/ui-resources/register.js";

type Call = { name: string; args: Record<string, unknown> };

const ORG_SLUG = "org-a";
const ORG_ID = "org_AAAA";

function baseCtx(over: Partial<OAuthContext>): OAuthContext {
	return {
		clientId: "client-a",
		userId: "alice",
		scopes: ["vantage:read"],
		scopeProfile: "team-member",
		fromAllowList: ["alice"],
		namespaceReadPrefixes: ["team/org-a"],
		namespaceWritePrefixes: ["team/org-a"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		...over,
	};
}

/** A bearer whose org resolved fully: the slug and the permanent ID. */
const MEMBER = baseCtx({
	accessTokenHash: "a".repeat(64),
	clerkOrgSlug: ORG_SLUG,
	orgClerkId: ORG_ID,
});
/** Admitted by the read gate (org ID resolved) but carrying no org slug to build the claim from. */
const ID_ONLY = baseCtx({
	accessTokenHash: "b".repeat(64),
	orgClerkId: ORG_ID,
});
const CLERK = baseCtx({ clerkJwt: "eyJ.raw.clerk", clerkOrgSlug: ORG_SLUG });
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

/** One URI per door of the verifiedOrg group, with the params that route to that door. */
const DOORS: Array<{ door: string; uri: string }> = [
	{ door: "tasks:list", uri: "ui://vp/v1/tasks-table" },
	{ door: "messages:listMessages", uri: "ui://vp/v1/messages-feed" },
	{
		door: "diary:get",
		uri: "ui://vp/v1/diary-entry?date=2026-11-01&orchestrator=alice",
	},
	{ door: "diary:list", uri: "ui://vp/v1/diary-entry" },
	{ door: "briefingNotes:get", uri: "ui://vp/v1/briefing-note?noteId=bn1" },
	{ door: "briefingNotes:list", uri: "ui://vp/v1/briefing-note" },
];

async function readAs(oauthCtx: OAuthContext, uri: string) {
	const calls: Call[] = [];
	const fake = {
		query: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			// a single-row door finds nothing; a list door returns an empty page
			return name.endsWith(":get") ? null : [];
		},
	} as unknown as UiResourceConvexClient;
	const server = new McpServer({ name: "t", version: "0.0.0" });
	const master = oauthCtx.isMaster;
	registerUiResources(server, fake, oauthCtx, {
		master,
		callerIdentities: master ? undefined : oauthCtx.fromAllowList,
	});
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	try {
		await client.readResource({ uri });
		return { calls, err: undefined as unknown };
	} catch (err: unknown) {
		return { calls, err };
	} finally {
		await client.close();
	}
}

describe("ui:// resource read forwards the caller's verified claim (S-28)", () => {
	for (const { door, uri } of DOORS) {
		it(`${door}: a caller with a verified org -> the door receives verifiedOrg`, async () => {
			const { calls, err } = await readAs(MEMBER, uri);
			expect(err).toBeUndefined();
			const call = calls.find((c) => c.name === door);
			expect(call, `${door} was not called`).toBeDefined();
			expect(call?.args.verifiedOrg).toEqual({
				orgSlug: ORG_SLUG,
				orgId: ORG_ID,
			});
		});

		it(`${door}: a caller with no verified org slug -> typed refusal, no door call`, async () => {
			const { calls, err } = await readAs(ID_ONLY, uri);
			expect(calls).toEqual([]);
			expect(String((err as Error)?.message)).toContain("RBAC_DENIED");
			const data = (err as { data?: { reason?: string; code?: string } }).data;
			expect(data?.code).toBe("RBAC_DENIED");
			expect(data?.reason).toBe("verified-org-unresolved");
		});

		it(`${door}: a URI-supplied verifiedOrg never replaces the verified one`, async () => {
			const sep = uri.includes("?") ? "&" : "?";
			const { calls } = await readAs(MEMBER, `${uri}${sep}verifiedOrg=org-b`);
			const call = calls.find((c) => c.name === door);
			expect(call?.args.verifiedOrg).toEqual({
				orgSlug: ORG_SLUG,
				orgId: ORG_ID,
			});
		});

		it(`${door}: master and Clerk-JWT carry no verifiedOrg (Convex scopes them itself)`, async () => {
			for (const ctx of [MASTER, CLERK]) {
				const { calls, err } = await readAs(ctx, uri);
				expect(err).toBeUndefined();
				const call = calls.find((c) => c.name === door);
				expect(call, `${door} was not called`).toBeDefined();
				expect(call?.args.verifiedOrg).toBeUndefined();
			}
		});
	}
});
