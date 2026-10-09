/// <reference types="vite/client" />
/**
 * Audit R3 reproductions (iframeEmbedSessions). Provenance: static audit of
 * VantagePeers main @16f0907, row iframeEmbedSessions:createSession in defects-R3.jsonl.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const asOrg = (t: T, org: string) =>
	t.withIdentity({ subject: `user-${org}`, organizationId: org } as Parameters<
		T["withIdentity"]
	>[0]);

async function seedOrg(t: T, slug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: [`seat-${slug}`],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

describe("iframeEmbedSessions:createSession", () => {
	test("iframeEmbedSessions:createSession — a member of org B cannot re-use org A's sessionId, and org A keeps read/revoke on its own session", async () => {
		// Identities: org A member and org B member (Clerk org claim), neither is the service account.
		const t = convexTest(schema, modules);
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const future = Date.now() + 3_600_000;
		await asOrg(t, "org-a").mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "S1",
			origin: "https://a.example",
			expiresAt: future,
		});
		const second = asOrg(t, "org-b").mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "S1",
			origin: "https://b.example",
			expiresAt: future,
		});
		await expect(second, "org B's second insert of sessionId S1").rejects.toThrow();
		// the rightful owner is still served
		const got = await asOrg(t, "org-a").query(api.iframeEmbedSessions.getSession, {
			sessionId: "S1",
		});
		expect(got?.tenantId).toBe("org-a");
		await expect(
			asOrg(t, "org-a").mutation(api.iframeEmbedSessions.revokeSession, { sessionId: "S1" }),
		).resolves.toBe(true);
	});

	test("iframeEmbedSessions:createSession — userId is taken from the verified identity, not the caller's claim", async () => {
		// Identity: org A member.
		const t = convexTest(schema, modules);
		await seedOrg(t, "org-a");
		const tA = asOrg(t, "org-a");
		let storedUserId: string | undefined;
		try {
			await tA.mutation(api.iframeEmbedSessions.createSession, {
				sessionId: "S2",
				origin: "https://a.example",
				userId: "someone-else",
				expiresAt: Date.now() + 3_600_000,
			});
			const rows = await t.run((ctx) => ctx.db.query("iframeEmbedSessions").collect());
			storedUserId = rows[0]?.userId;
		} catch {
			return; // refusing the claimed userId is also correct
		}
		expect(storedUserId, "stored userId").toBe("user-org-a");
	});
});
