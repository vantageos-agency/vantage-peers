// Preload (bun --preload) for provision-client-org-agents.test.mjs: replaces globalThis.fetch so
// the script talks to NOTHING real. Every request is appended to $STUB_LOG as one JSON line.
// STUB_ADMIN_ORG is the org_id the stubbed Clerk "convex" template token carries.
import { appendFileSync } from "node:fs";

const log = (o) =>
	appendFileSync(process.env.STUB_LOG, `${JSON.stringify(o)}\n`);
const jwtFor = (orgId) =>
	`h.${Buffer.from(JSON.stringify({ sub: "user_stub", org_id: orgId })).toString("base64url")}.s`;
const json = (body, init = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});

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
			"agents:listAgentsByOrg": [],
			"agents:registerAgent": "agent_stub_1",
			"agents:getAgent": { _id: "agent_stub_1", name: "probe-a" },
			"agentCredentials:mintAgentCredential": { secret: "stub-secret-value" },
		};
		return json({ status: "success", value: values[body.path] ?? null });
	}
	if (url.includes("/touch")) {
		log({ kind: "clerk-touch", body: String(init.body) });
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
				isTemplate ? process.env.STUB_ADMIN_ORG : process.env.STUB_NATIVE_ORG,
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
