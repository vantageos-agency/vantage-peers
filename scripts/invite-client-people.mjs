#!/usr/bin/env node
/**
 * invite-client-people.mjs — invite a client's people to the client's Clerk organisation,
 * so they can sign in to the VantagePeers connector from Claude.ai or ChatGPT and land in
 * their own org. Runbook: runbooks/onboard-client-org.md ("People").
 *
 *   node scripts/invite-client-people.mjs --clerk-org-id <org_…> --role org:member \
 *       --email a@client.tld --email b@client.tld            # DRY RUN: prints the plan, sends nothing
 *   node scripts/invite-client-people.mjs … --send            # sends the invitations
 *
 * Dry run is the default: an invitation is an email to a real person, sent only on an explicit
 * --send (operator order for CGT Alsachimie: sent on site, with the client).
 * Env: CLERK_SECRET_KEY (read from the environment, never printed, never on a command line).
 * The inviter is CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS, an org:admin of the client org.
 */
const argv = process.argv.slice(2);
const one = (k) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const many = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const orgId = one("clerk-org-id");
const role = one("role") ?? "org:member";
const emails = many("email");
const send = argv.includes("--send");
if (!orgId || !/^org_[A-Za-z0-9]+$/.test(orgId) || emails.length === 0) {
	console.error("usage: --clerk-org-id <org_…> [--role org:member|org:admin] --email <addr> [--email …] [--send]");
	process.exit(2);
}
if (!["org:member", "org:admin"].includes(role)) throw new Error("--role must be org:member or org:admin");
const bad = emails.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
if (bad.length) throw new Error(`invalid email(s): ${bad.join(", ")}`);
const key = process.env.CLERK_SECRET_KEY;
const inviter = process.env.CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS;
if (!key || !inviter) throw new Error("CLERK_SECRET_KEY and CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS are required");

const api = (path, init = {}) =>
	fetch(`https://api.clerk.com/v1${path}`, {
		...init,
		headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
	}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const org = await api(`/organizations/${orgId}`);
if (org.status !== 200) throw new Error(`org ${orgId} not readable: HTTP ${org.status}`);
console.log(`org ${org.body.slug} (${orgId}); role ${role}; ${emails.length} invitation(s); mode ${send ? "SEND" : "DRY RUN"}`);
for (const email of emails) {
	if (!send) {
		console.log(`  would invite ${email}`);
		continue;
	}
	const r = await api(`/organizations/${orgId}/invitations`, {
		method: "POST",
		body: JSON.stringify({ email_address: email, role, inviter_user_id: inviter }),
	});
	console.log(`  ${email}: HTTP ${r.status} ${r.body?.status ?? r.body?.errors?.[0]?.code ?? ""}`);
}
if (!send) console.log("DRY RUN: nothing sent. Re-run with --send to send.");
