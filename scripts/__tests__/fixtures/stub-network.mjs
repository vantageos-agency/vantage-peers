// Preload (bun --preload) for provision-client-org-agents.test.mjs: replaces globalThis.fetch so
// the script talks to NOTHING real. Every request is appended to $STUB_LOG as one JSON line.
// STUB_ADMIN_ORG is the org_id the stubbed Clerk "convex" template token carries.
import { appendFileSync } from "node:fs";

const log = (o) =>
	appendFileSync(process.env.STUB_LOG, `${JSON.stringify(o)}\n`);
// A "convex"-template token carries aud "convex" (what convex/auth.config.ts requires); a native
// session token carries no aud. That difference is what the service-account test reads.
const jwtFor = (orgId, template) =>
	`h.${Buffer.from(JSON.stringify({ sub: "user_stub", org_id: orgId, ...(template ? { aud: "convex" } : {}) })).toString("base64url")}.s`;
const json = (body, init = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});

// STUB_LAST_ACTIVE_ORG models Clerk: a session opens with the user's last-active org and only a
// /touch with active_organization_id changes it. Unset, tokens carry STUB_ADMIN_ORG / STUB_NATIVE_ORG.
let activeOrg = process.env.STUB_LAST_ACTIVE_ORG || null;

globalThis.fetch = async (input, init = {}) => {
	const url = typeof input === "string" ? input : (input.url ?? String(input));
	const auth = new Headers(init.headers ?? {}).get("authorization");
	if (url.includes("/api/query") || url.includes("/api/mutation")) {
		const body = JSON.parse(String(init.body));
		log({ kind: "convex", path: body.path, args: body.args, authJwt: auth });
		const values = {
			"clientOrgMapping:getByClerkSlug": {
				isActive: true,
				allowedOrchestrators: ["probe-a"],
			},
			"agents:listAgentsByOrg": process.env.STUB_AGENTS
				? JSON.parse(process.env.STUB_AGENTS)
				: [],
			"agentCredentials:getAgentCredentialStatus": process.env.STUB_AGENTS
				? { hasActiveCredential: true, activeRows: 1 }
				: { hasActiveCredential: false, activeRows: 0 },
			// the caller's org agent directory (orgRoster:getMyAgentDirectory): [{name, agentId}]
			"orgRoster:getMyAgentDirectory": process.env.STUB_DIRECTORY
				? JSON.parse(process.env.STUB_DIRECTORY)
				: [],
			"agents:registerAgent": "agent_stub_1",
			"agents:getAgent": { _id: "agent_stub_1", name: "probe-a" },
			"agentCredentials:mintAgentCredential": {
				secret: "stub-secret-value",
				mintedAt: 1760000000000,
			},
			"githubRepoMapping:getByRepo": {
				_id: "map_stub_1",
				orchestrator: "angelia",
				project: "proj-x",
				active: true,
			},
		};
		return json({ status: "success", value: values[body.path] ?? null });
	}
	if (url.includes("/touch")) {
		log({ kind: "clerk-touch", body: String(init.body) });
		if (activeOrg !== null)
			activeOrg =
				new URLSearchParams(String(init.body)).get("active_organization_id") ??
				activeOrg;
		return json({ ok: true });
	}
	if (url.includes("/v1/client/sign_ins")) {
		log({ kind: "clerk-sign-in" });
		return json(
			{ response: { created_session_id: "sess_stub" } },
			{ headers: { authorization: "client-token-stub" } },
		);
	}
	if (url.includes("/sessions/") && url.includes("/tokens")) {
		const isTemplate = /\/tokens\/[^/?]+/.test(url);
		log({ kind: "clerk-session-token", template: isTemplate });
		return json({
			object: "token",
			jwt: jwtFor(
				activeOrg !== null
					? activeOrg
					: isTemplate
						? process.env.STUB_ADMIN_ORG
						: process.env.STUB_NATIVE_ORG,
				isTemplate,
			),
		});
	}
	if (url.includes("sign_in_tokens")) {
		log({ kind: "clerk-ticket" });
		return json({
			id: "sit_stub",
			token: "ticket-stub",
			object: "sign_in_token",
			status: "pending",
		});
	}
	log({ kind: "UNSTUBBED", url });
	return new Response("unstubbed", { status: 599 });
};
