// invite-client-people sends org invitations through Clerk. Without redirect_url, Clerk links the
// invitee to a page that consumes no ticket (task k172sk173z6mw5cfc5refy1pz18hgaqa, scope 1:
// "every other invitation path"). The body now always carries the account-portal sign-up page.
import { describe, expect, it } from "vitest";
import { invitationBody } from "../lib/invite-body.mjs";

const base = { email: "pat@client.test", role: "org:member", inviterUserId: "user_admin" };

describe("invitationBody", () => {
	it("derives redirect_url from CLERK_DOMAIN on the account portal host", () => {
		const b = invitationBody({ ...base, clerkDomain: "https://clerk.vantagepeers.com" });
		expect(b).toEqual({
			email_address: "pat@client.test",
			role: "org:member",
			inviter_user_id: "user_admin",
			redirect_url: "https://accounts.vantagepeers.com/sign-up",
		});
	});

	it("an explicit --redirect-url wins", () => {
		const b = invitationBody({ ...base, clerkDomain: "https://clerk.vantagepeers.com", redirectUrl: "https://accounts.vantagepeers.com/sign-up?x=1" });
		expect(b.redirect_url).toBe("https://accounts.vantagepeers.com/sign-up?x=1");
	});

	it("refuses a redirect on the Clerk frontend-API host, and no source at all", () => {
		expect(() => invitationBody({ ...base, redirectUrl: "https://clerk.vantagepeers.com/sign-up" })).toThrow(/frontend API/);
		expect(() => invitationBody({ ...base })).toThrow(/redirect/);
		expect(() => invitationBody({ ...base, clerkDomain: "https://vantagepeers.com" })).toThrow(/clerk\./);
	});
});
