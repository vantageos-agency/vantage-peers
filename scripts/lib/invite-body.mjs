/**
 * invite-body.mjs — the Clerk organisation-invitation body sent by scripts/invite-client-people.mjs
 * (VantagePeers Cloud, task k172sk173z6mw5cfc5refy1pz18hgaqa). It always carries redirect_url: the
 * account-portal sign-up page that consumes __clerk_ticket, the same page onboard-person uses.
 */
import { accountPortalSignUp } from "./onboard-person-core.mjs";

export function invitationBody({ email, role, inviterUserId, clerkDomain, redirectUrl }) {
	let redirect = redirectUrl;
	if (!redirect) {
		if (!clerkDomain) {
			throw new Error("no redirect URL: pass --redirect-url (a Clerk-hosted sign-up page) or set CLERK_DOMAIN");
		}
		redirect = accountPortalSignUp(clerkDomain);
	}
	let host;
	try {
		host = new URL(redirect).hostname;
	} catch {
		throw new Error(`redirect URL "${redirect}" is not a URL`);
	}
	if (host.startsWith("clerk.")) {
		throw new Error(`redirect URL "${redirect}" is on the Clerk frontend API host, which answers 404 on /sign-up`);
	}
	return { email_address: email, role, inviter_user_id: inviterUserId, redirect_url: redirect };
}
