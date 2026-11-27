/**
 * S-35 pin -- get_mission_template, one answer per caller class.
 *
 * The caller classes are derived from what the handler reads: the after-read
 * scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, row) and the scope the tool forwards to the door
 * (doorScopeArgs -> verifiedOrgSlugOf: undefined for master, for a Clerk session and for a
 * bearer with no org; the org slug for an org member).
 *
 * The door is a mock that implements #1818's rule for the arguments it receives:
 *   - verifiedOrg forwarded: the template is served when the org's scope is fleet-wide, or when
 *     its creator is on that org's roster; otherwise null.
 *   - no verifiedOrg, transport = fleet service account: the row is served (claimless read).
 *   - no verifiedOrg, transport = an ordinary member (Clerk session): refused (RBAC_DENIED).
 *
 * This file pins what each class gets TODAY (text, structuredContent found/item/id, isError)
 * so that moving the scope decision before/inside the read cannot change an answer.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
	structuredContent?: unknown;
	isError?: boolean;
}>;

type Row = { _id: string; name: string; createdBy: string };

const ROSTER: Record<string, { fleetWide: boolean; roster: string[] }> = {
	"org-alpha": { fleetWide: false, roster: ["alpha"] },
	"org-fleet": { fleetWide: true, roster: ["fleet"] },
};

/** #1818's door rule, given the args the door receives. */
function door(
	transport: "service" | "member",
	row: Row | null,
	args: { verifiedOrg?: { orgSlug: string } },
): Row | null {
	if (args.verifiedOrg === undefined) {
		if (transport === "member") {
			throw new Error("RBAC_DENIED: missionTemplates:getByName is master-only");
		}
		return row;
	}
	const org = ROSTER[args.verifiedOrg.orgSlug];
	if (org === undefined || row === null) return null;
	return org.fleetWide || org.roster.includes(row.createdBy) ? row : null;
}

async function run(
	ctx: OAuthContext | undefined,
	row: Row | null,
	transport: "service" | "member" = "service",
) {
	const handlers = new Map<string, ToolHandler>();
	const capture = (...a: unknown[]): unknown => {
		handlers.set(a[0] as string, a[a.length - 1] as ToolHandler);
		return {};
	};
	const server = {
		tool: capture,
		registerTool: capture,
	} as unknown as McpServer;
	const query = vi.fn(async (_fn: string, args: Record<string, unknown>) =>
		door(transport, row, args as { verifiedOrg?: { orgSlug: string } }),
	);
	const convex = {
		query,
		mutation: vi.fn(),
		action: vi.fn(),
	} as unknown as ConvexHttpClient;
	registerTools(server, convex, ctx);
	const handler = handlers.get("get_mission_template");
	if (!handler) throw new Error("get_mission_template not registered");
	const result = await handler({ name: row?.name ?? "nope" });
	return { result, query };
}

const base = {
	scopes: ["mcp:full"],
	expiresAt: Date.now() + 3600_000,
};

const MASTER: OAuthContext = {
	...base,
	clientId: "c-master",
	userId: "u-master",
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	isMaster: true,
	viaMasterBearer: true,
};
const CLERK: OAuthContext = {
	...base,
	clientId: "c-clerk",
	userId: "u-clerk",
	scopeProfile: "tenant",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	isMaster: false,
	clerkJwt: "jwt-fixture",
	clerkOrgSlug: "org-alpha",
};
const orgMember = (slug: string, seat: string): OAuthContext => ({
	...base,
	clientId: `c-${slug}`,
	userId: `u-${slug}`,
	scopeProfile: "tenant",
	fromAllowList: [seat],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	isMaster: false,
	clerkOrgSlug: slug,
	actor: { orgSlug: slug, agentName: seat },
});
const MEMBER = orgMember("org-alpha", "alpha");
// A fleet-wide roster is the literal "*" in the caller's roster (scopeFilterGet reads it as master).
const FLEET_MEMBER: OAuthContext = {
	...orgMember("org-fleet", "fleet"),
	fromAllowList: ["*"],
};
// A bearer whose org does not resolve: no actor, no clerkOrgSlug, no Clerk session.
const NO_ORG_ROSTER: OAuthContext = {
	...base,
	clientId: "c-noorg",
	userId: "u-noorg",
	scopeProfile: "tenant",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	isMaster: false,
};
const NO_ORG_EMPTY: OAuthContext = {
	...NO_ORG_ROSTER,
	clientId: "c-noorg-empty",
	fromAllowList: [],
};

const OWN: Row = { _id: "t1", name: "alpha-template", createdBy: "alpha" };
const OTHER: Row = { _id: "t2", name: "beta-template", createdBy: "beta" };

const found = (row: Row) => ({
	content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
	structuredContent: { found: true, item: row },
});
const notFound = (name: string) => ({
	content: [{ type: "text", text: "null" }],
	structuredContent: { found: false, id: name },
});

describe("S-35 pin -- get_mission_template answer per caller class", () => {
	it("master: any template", async () => {
		expect((await run(MASTER, OTHER)).result).toEqual(found(OTHER));
	});
	it("local stdio trust: any template", async () => {
		expect((await run(LOCAL_STDIO_TRUST_CTX, OTHER)).result).toEqual(
			found(OTHER),
		);
	});
	it("master: no such template", async () => {
		expect((await run(MASTER, null)).result).toEqual(notFound("nope"));
	});
	it("Clerk session: the door refuses an ordinary member, answered as an error", async () => {
		const { result } = await run(CLERK, OWN, "member");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/RBAC_DENIED/);
	});
	it("org member: own-org template", async () => {
		expect((await run(MEMBER, OWN)).result).toEqual(found(OWN));
	});
	it("org member: other-org template", async () => {
		expect((await run(MEMBER, OTHER)).result).toEqual(notFound("beta-template"));
	});
	it("org member: no such template", async () => {
		expect((await run(MEMBER, null)).result).toEqual(notFound("nope"));
	});
	it("org member of a fleet-wide org: another creator's template", async () => {
		expect((await run(FLEET_MEMBER, OTHER)).result).toEqual(found(OTHER));
	});
	it("bearer with no resolvable org, creator on its roster: the row", async () => {
		expect((await run(NO_ORG_ROSTER, OWN)).result).toEqual(found(OWN));
	});
	it("bearer with no resolvable org, creator off its roster: null", async () => {
		expect((await run(NO_ORG_ROSTER, OTHER)).result).toEqual(
			notFound("beta-template"),
		);
	});
	it("bearer with no resolvable org and an empty roster: null for any row", async () => {
		expect((await run(NO_ORG_EMPTY, OWN)).result).toEqual(
			notFound("alpha-template"),
		);
	});
	it("no oauthCtx: null, absence is never master", async () => {
		expect((await run(undefined, OWN)).result).toEqual(
			notFound("alpha-template"),
		);
	});
});
