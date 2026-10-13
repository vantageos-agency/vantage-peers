// TEST FIXTURE ONLY. The `verifiedOrg` claim of the FLEET: the organisation the
// MCP transport verifies for a fleet seat, which is the operator org.
//
// Since batch F1 (backend standard R-54) the content doors (diary, memories,
// episodes, the knowledge base and the OKF bundle doors) refuse a service-account
// call that carries no verified organisation. A test that drives such a door as
// the fleet service account therefore presents the operator org's claim, exactly
// as a fleet seat's bearer does through the MCP. The operator org is the one
// `tests/fixtures/seedServiceAccount.ts` converges (or the test's own, when it
// seeded one first), read back from the mapping rows.

import { type Runner, seedServiceAccount } from "../fixtures/seedServiceAccount";

type OperatorRow = { orgKind?: string; isActive?: boolean; clerkOrgSlug?: string };

export async function fleetClaim(
	t: Runner,
): Promise<{ verifiedOrg: { orgSlug: string } }> {
	const subject = process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
	if (!subject) {
		throw new Error("fleetClaim: CLERK_SERVICE_ACCOUNT_USER_ID is not set");
	}
	await seedServiceAccount(t, subject);
	const slug = (await t.run(async (ctx) => {
		const rows = (await ctx.db.query("client_org_mapping").collect()) as OperatorRow[];
		return rows.find((r) => r.orgKind === "operator" && r.isActive === true)
			?.clerkOrgSlug;
	})) as string | undefined;
	if (slug === undefined) {
		throw new Error("fleetClaim: no active operator organisation to claim");
	}
	return { verifiedOrg: { orgSlug: slug } };
}
