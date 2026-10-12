/**
 * withOrgScope decides the fleet service account by the verified SUBJECT alone
 * (convex/lib/serviceAccount.ts: an `agents` row carries `authSubject`, no
 * issuer). That is sound only while Convex admits tokens of ONE issuer: two
 * providers could mint the same subject for two different people.
 *
 * This test reads the configuration Convex actually loads and fails as soon as
 * a second provider appears, naming what the service-account decision then
 * needs: an issuer comparison, which requires @vantageos/cloud-identity to
 * return `issuer` with the caller (it returns `subject` only today).
 */
import { describe, expect, test } from "vitest";
import authConfig from "../auth.config";

describe("convex/auth.config.ts — the service account is decided by subject alone", () => {
	test("exactly one token provider is configured", () => {
		expect(
			authConfig.providers,
			"convex/auth.config.ts names more than one provider. withOrgScope decides the service account by subject alone; with two issuers a subject is no longer unique. Add an issuer comparison first (cloud-identity must return `issuer` from resolveCallerFromClaims, and the service row must store it).",
		).toHaveLength(1);
	});
});
