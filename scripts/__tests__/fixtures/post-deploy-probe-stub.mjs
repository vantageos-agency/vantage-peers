// Local stub of the MCP HTTP door for scripts/__tests__/test-post-deploy-probe.sh.
// No network beyond 127.0.0.1, no real credentials. Two fake orgs, one agent each.
//
//   node post-deploy-probe-stub.mjs <portFile>
//   STUB_MODE = ok | stateless | wrong-readback | wrong-id | untyped-write | untyped-send | untyped-read | admit-other | refuse-own | leak-read | whoami-fails | send-refused-own
//
// stateless        as ok, but issues no mcp-session-id (what prod does)
// wrong-readback   get_memory returns the right id with WRONG content (own read-back)
// wrong-id         get_memory returns the right content under a WRONG id
// untyped-write    a refused cross-org store_memory answers an opaque "Server Error"
// untyped-send     a refused cross-org send_message answers an opaque "Server Error"
// untyped-read     a refused cross-org get_memory answers an opaque "Server Error"
// wrong-readback   get_memory returns the right id with WRONG content (own read-back)
// wrong-id         get_memory returns the right content under a WRONG id
// untyped-write    a refused cross-org store_memory answers an opaque "Server Error"
// untyped-send     a refused cross-org send_message answers an opaque "Server Error"
// untyped-read     a refused cross-org get_memory answers an opaque "Server Error"
// ok               own is admitted, other is refused (the healthy backend)
// admit-other      writes and sends across orgs are admitted (a leak)
// refuse-own       the seat's own orchestrator/<agent id> is refused (2026-11-02 incident)
// leak-read        writes are fine, but get_memory returns the other org's row
// whoami-fails     whoami answers an error
// send-refused-own the seat's own send is refused with RBAC_DENIED

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const MODE = process.env.STUB_MODE ?? "ok";
const ORGS = {
	"bearer-a": {
		agent: "agentA0000000000000000000000000aa",
		slug: "stub-org-a",
	},
	"bearer-b": {
		agent: "agentB0000000000000000000000000bb",
		slug: "stub-org-b",
	},
};
const rows = new Map(); // memoryId -> { bearer, content }
let seq = 0;

const text = (t, isError = false) => ({
	content: [{ type: "text", text: t }],
	isError,
});

function callTool(bearer, name, args) {
	const me = ORGS[bearer];
	const other = bearer === "bearer-a" ? ORGS["bearer-b"] : ORGS["bearer-a"];
	if (name === "whoami") {
		if (MODE === "whoami-fails")
			return text("Error: identity unavailable", true);
		const r = {
			agent_id: me.agent,
			org_slug: me.slug,
			scope_profile_name: `stub-${me.slug}`,
		};
		return { ...text(JSON.stringify(r)), structuredContent: r };
	}
	if (name === "store_memory") {
		const ns = String(args.namespace ?? "");
		const ownNs =
			ns === `orchestrator/${me.agent}` || ns === `project/${me.slug}`;
		const otherNs =
			ns === `orchestrator/${other.agent}` || ns === `project/${other.slug}`;
		if (MODE === "refuse-own" && ns === `orchestrator/${me.agent}`) {
			return text(
				`Forbidden: namespace ${ns} not writable by scope_profile=stub-${me.slug}`,
				true,
			);
		}
		if (ownNs || (otherNs && MODE === "admit-other")) {
			const id = `mem${String(++seq).padStart(4, "0")}`;
			rows.set(id, { bearer, content: args.content });
			return text(JSON.stringify({ memoryId: id, namespace: ns }));
		}
		if (MODE === "untyped-write") return text("Server Error", true);
		return text(
			`Forbidden: namespace ${ns} not writable by scope_profile=stub-${me.slug}`,
			true,
		);
	}
	if (name === "get_memory") {
		const row = rows.get(String(args.memoryId));
		if (!row) return text("Error: NOT_FOUND memory", true);
		if (
			row.bearer !== bearer &&
			MODE !== "leak-read" &&
			MODE !== "admit-other"
		) {
			if (MODE === "untyped-read") return text("Server Error", true);
			return text(
				"Error: RBAC_DENIED memory belongs to another organisation",
				true,
			);
		}
		if (MODE === "wrong-readback")
			return text(
				JSON.stringify({ _id: args.memoryId, content: "some other body" }),
			);
		if (MODE === "wrong-id")
			return text(JSON.stringify({ _id: "memWRONG", content: row.content }));
		return text(JSON.stringify({ _id: args.memoryId, content: row.content }));
	}
	if (name === "send_message") {
		const to = (args.recipientAgentIds ?? [])[0];
		if (to === other.agent) {
			if (MODE === "admit-other")
				return text(JSON.stringify({ messageId: "msgX" }));
			if (MODE === "untyped-send") return text("Server Error", true);
			return text(
				`RBAC_DENIED: recipient agent "${to}" is not an addressable agent of the sender's organisation`,
				true,
			);
		}
		if (MODE === "send-refused-own")
			return text("RBAC_DENIED: sender not permitted", true);
		return text(
			"Error: INVALID_RECIPIENTS: recipientAgentIds names no recipient other than the sender",
			true,
		);
	}
	return text(`Error: unknown tool ${name}`, true);
}

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const bearer = String(req.headers.authorization ?? "").replace(
			/^Bearer /,
			"",
		);
		if (!ORGS[bearer]) {
			res.writeHead(401).end("unauthorized");
			return;
		}
		const msg = JSON.parse(body || "{}");
		if (msg.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		let result;
		const headers = { "content-type": "text/event-stream" };
		if (msg.method === "initialize") {
			if (MODE !== "stateless") headers["mcp-session-id"] = `sess-${bearer}`;
			result = {
				protocolVersion: "2025-06-18",
				capabilities: {},
				serverInfo: { name: "stub", version: "0" },
			};
		} else if (msg.method === "tools/call") {
			result = callTool(bearer, msg.params.name, msg.params.arguments ?? {});
		} else {
			result = {};
		}
		res.writeHead(200, headers);
		res.end(
			`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`,
		);
	});
});

server.listen(0, "127.0.0.1", () => {
	writeFileSync(process.argv[2], String(server.address().port));
});
