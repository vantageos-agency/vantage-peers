/**
 * Task k179y0wpsd6fv7055f4p2w6b358hdrxe — VantagePeers Cloud: the per-request
 * Convex client of a NON-MASTER bearer carries that bearer's verified
 * organisation on EVERY call.
 *
 * A non-master OAuth bearer reaches Convex as the fleet service account. The org
 * it was verified for (`oauthContext.orgClerkId`, read live from the token row's
 * ACTIVE mapping by `oauth:getAccessTokenByHash`) now rides as the reserved
 * `__actingOrg` argument on every query/mutation/action, so Convex resolves the
 * call as an ordinary member of that org at every door, whether or not the tool
 * remembered a `verifiedOrg`.
 *
 * Poles:
 *   - non-master + org        -> every call carries __actingOrg = the VERIFIED org
 *                                ID; a tool-supplied __actingOrg is overwritten;
 *   - non-master, no org ID   -> no call reaches the wire; RBAC_DENIED;
 *   - master bearer / stdio   -> the plain service-account client, no argument;
 *   - Clerk JWT               -> the caller's own JWT, no argument;
 *   - no oauthContext at all  -> refused (absence is never master).
 */

import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../auth.js";
import { selectConvexClientForRequest } from "../authenticatedConvexClient.js";

function fakeClient(): ConvexHttpClient & {
	query: ReturnType<typeof vi.fn>;
	mutation: ReturnType<typeof vi.fn>;
	action: ReturnType<typeof vi.fn>;
} {
	return {
		setAuth: vi.fn(),
		clearAuth: vi.fn(),
		query: vi.fn().mockResolvedValue("q"),
		mutation: vi.fn().mockResolvedValue("m"),
		action: vi.fn().mockResolvedValue("a"),
	} as never;
}

const seat = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "c",
	userId: "u",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "team-member",
	fromAllowList: ["alice"],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: Number.MAX_SAFE_INTEGER,
	isMaster: false,
	accessTokenHash: "h",
	clerkOrgSlug: "org-a",
	orgClerkId: "org_A",
	...over,
});

const URL = "https://tenant.convex.cloud";

describe("non-master bearer: every call carries the verified org", () => {
	it("query, mutation and action each carry __actingOrg = oauthContext.orgClerkId", async () => {
		const sa = fakeClient();
		const client = selectConvexClientForRequest(URL, seat(), {
			createServiceAccountClient: () => sa,
		});
		const args = { taskId: "t1" };
		await client.query("tasks:getById" as never, args as never);
		await client.mutation("tasks:update" as never, args as never);
		await client.action("search:recall" as never, args as never);
		for (const fn of [sa.query, sa.mutation, sa.action]) {
			expect(fn).toHaveBeenCalledTimes(1);
			expect(fn.mock.calls[0][1]).toEqual({ taskId: "t1", __actingOrg: "org_A" });
		}
		// The caller's object is not mutated.
		expect(args).toEqual({ taskId: "t1" });
	});

	it("a tool-supplied __actingOrg is overwritten by the verified one", async () => {
		const sa = fakeClient();
		const client = selectConvexClientForRequest(URL, seat(), {
			createServiceAccountClient: () => sa,
		});
		await client.query("tasks:list" as never, { __actingOrg: "org_B" } as never);
		expect(sa.query.mock.calls[0][1]).toEqual({ __actingOrg: "org_A" });
	});

	it("a call with no args object still carries the org", async () => {
		const sa = fakeClient();
		const client = selectConvexClientForRequest(URL, seat(), {
			createServiceAccountClient: () => sa,
		});
		await client.query("meta:backendContract" as never);
		expect(sa.query.mock.calls[0][1]).toEqual({ __actingOrg: "org_A" });
	});

	it("two bearers of different orgs never share an org", async () => {
		const saA = fakeClient();
		const saB = fakeClient();
		const a = selectConvexClientForRequest(URL, seat(), { createServiceAccountClient: () => saA });
		const b = selectConvexClientForRequest(URL, seat({ clerkOrgSlug: "org-b", orgClerkId: "org_B" }), {
			createServiceAccountClient: () => saB,
		});
		await a.query("x:y" as never, {} as never);
		await b.query("x:y" as never, {} as never);
		expect(saA.query.mock.calls[0][1]).toEqual({ __actingOrg: "org_A" });
		expect(saB.query.mock.calls[0][1]).toEqual({ __actingOrg: "org_B" });
	});
});

describe("non-master bearer with no resolvable org: no client", () => {
	for (const [label, ctx] of [
		["no orgClerkId", seat({ orgClerkId: undefined })],
		["empty orgClerkId", seat({ orgClerkId: "" })],
	] as const) {
		it(`${label}: every call is refused RBAC_DENIED and nothing reaches the wire`, async () => {
			const sa = fakeClient();
			const create = vi.fn(() => sa);
			const client = selectConvexClientForRequest(URL, ctx, {
				createServiceAccountClient: create,
			});
			for (const method of ["query", "mutation", "action"] as const) {
				await expect(
					(client[method] as (...a: unknown[]) => Promise<unknown>)("tasks:list", {}),
				).rejects.toThrow(/RBAC_DENIED/);
			}
			expect(sa.query).not.toHaveBeenCalled();
			expect(sa.mutation).not.toHaveBeenCalled();
			expect(sa.action).not.toHaveBeenCalled();
		});
	}

	it("no oauthContext at all is refused, never the fleet", async () => {
		const sa = fakeClient();
		const client = selectConvexClientForRequest(URL, undefined, {
			createServiceAccountClient: () => sa,
		});
		await expect(client.query("tasks:list" as never, {} as never)).rejects.toThrow(/RBAC_DENIED/);
		expect(sa.query).not.toHaveBeenCalled();
	});
});

describe("master and Clerk callers are unchanged", () => {
	it("the master bearer gets the plain service-account client, no __actingOrg", async () => {
		const sa = fakeClient();
		const client = selectConvexClientForRequest(
			URL,
			seat({ isMaster: true, viaMasterBearer: true, orgClerkId: undefined, clerkOrgSlug: undefined }),
			{ createServiceAccountClient: () => sa },
		);
		expect(client).toBe(sa);
		await client.query("tasks:list" as never, { a: 1 } as never);
		expect(sa.query.mock.calls[0][1]).toEqual({ a: 1 });
	});

	it("the local stdio trust context is master: plain service-account client", () => {
		const sa = fakeClient();
		const client = selectConvexClientForRequest(URL, LOCAL_STDIO_TRUST_CTX, {
			createServiceAccountClient: () => sa,
		});
		expect(client).toBe(sa);
	});

	it("a Clerk JWT caller gets its own JWT and no __actingOrg", async () => {
		const plain = fakeClient();
		const wire = plain.query; // withQueryRetry wraps .query on the same object
		const sa = fakeClient();
		const client = selectConvexClientForRequest(URL, seat({ clerkJwt: "jwt-a" }), {
			createPlainClient: () => plain,
			createServiceAccountClient: () => sa,
		});
		expect(plain.setAuth).toHaveBeenCalledWith("jwt-a");
		await client.query("tasks:list" as never, { a: 1 } as never);
		expect(wire.mock.calls[0][1]).toEqual({ a: 1 });
		expect(sa.query).not.toHaveBeenCalled();
	});
});
