// Local stub of the MCP HTTP door for scripts/__tests__/test-post-deploy-probe.sh.
// No network beyond 127.0.0.1, no real credentials. Two fake orgs, two agents each
// (the primary seats bearer-a / bearer-b, the second agents bearer-a2 / bearer-b2).
//
//   node post-deploy-probe-stub.mjs <portFile>
//   STUB_MODE = one of the modes below (default ok)
//
// ok                as prod behaves: own admitted, other refused, in-org send delivered
// stateless         as ok, but issues no mcp-session-id (what prod does)
// wrong-readback    get_memory returns the right id with WRONG content (own read-back)
// wrong-id          get_memory returns the right content under a WRONG id
// untyped-write     a refused cross-org store_memory answers an opaque "Server Error"
// untyped-send      a refused cross-org send_message answers an opaque "Server Error"
// untyped-read      a refused cross-org get_memory answers an opaque "Server Error"
// admit-other       writes and sends across orgs are admitted (a leak)
// refuse-own        the seat's own orchestrator/<agent id> is refused (2026-11-02 incident)
// leak-read         writes are fine, but get_memory returns the other org's row
// whoami-fails      whoami answers an error
// send-refused-own  the seat's own send is refused with RBAC_DENIED
// no-delivery       send to the second agent is accepted but never reaches its inbox
// send-second-refused  send to the second agent is refused RBAC_DENIED
// wrong-inbox       the recipient's inbox shows a DIFFERENT message than the one sent
// wrong-sender      the right body arrives, attributed to a different sender id
// second-is-primary whoami for the second credential returns the primary's agent
// delete-refused    delete_message is refused (the message id must be listed for cleanup)

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const MODE = process.env.STUB_MODE ?? "ok";
const AG = {
	"bearer-a": {
		agent: "agentA0000000000000000000000000aa",
		slug: "stub-org-a",
		label: "stub-a",
	},
	"bearer-a2": {
		agent: "agentA2000000000000000000000000aa",
		slug: "stub-org-a",
		label: "stub-a2",
	},
	"bearer-b": {
		agent: "agentB0000000000000000000000000bb",
		slug: "stub-org-b",
		label: "stub-b",
	},
	"bearer-b2": {
		agent: "agentB2000000000000000000000000bb",
		slug: "stub-org-b",
		label: "stub-b2",
	},
};
const byAgent = (id) => Object.values(AG).find((x) => x.agent === id);
const rows = new Map(); // memoryId -> { slug, content }
const msgs = new Map(); // messageId -> { slug, from, to, content }
let seq = 0;

const text = (t, isError = false) => ({
	content: [{ type: "text", text: t }],
	isError,
});

function callTool(bearer, name, args) {
	const me = AG[bearer];
	const otherSlug = me.slug === "stub-org-a" ? "stub-org-b" : "stub-org-a";
	const otherPrimary =
		me.slug === "stub-org-a" ? AG["bearer-b"] : AG["bearer-a"];
	if (name === "whoami") {
		if (MODE === "whoami-fails")
			return text("Error: identity unavailable", true);
		let who = me;
		if (MODE === "second-is-primary" && bearer.endsWith("2"))
			who = AG[bearer.slice(0, -1)];
		const r = {
			agent_id: who.agent,
			org_slug: who.slug,
			scope_profile_name: `stub-${who.slug}`,
			suggested_orchestrator_id: who.label,
			fromAllowList: [who.label],
		};
		return { ...text(JSON.stringify(r)), structuredContent: r };
	}
	if (name === "store_memory") {
		const ns = String(args.namespace ?? "");
		const ownNs =
			ns === `orchestrator/${me.agent}` || ns === `project/${me.slug}`;
		const otherNs =
			ns === `orchestrator/${otherPrimary.agent}` ||
			ns === `project/${otherSlug}`;
		if (MODE === "refuse-own" && ns === `orchestrator/${me.agent}`) {
			return text(
				`Forbidden: namespace ${ns} not writable by scope_profile=stub-${me.slug}`,
				true,
			);
		}
		if (ownNs || (otherNs && MODE === "admit-other")) {
			const id = `mem${String(++seq).padStart(4, "0")}`;
			rows.set(id, { slug: me.slug, content: args.content });
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
			row.slug !== me.slug &&
			MODE !== "leak-read" &&
			MODE !== "admit-other"
		) {
			if (MODE === "untyped-read") return text("Server Error", true);
			return text(
				"Error: RBAC_DENIED memory belongs to another organisation",
				true,
			);
		}
		if (MODE === "wrong-readback") {
			return text(
				JSON.stringify({ _id: args.memoryId, content: "some other body" }),
			);
		}
		if (MODE === "wrong-id")
			return text(JSON.stringify({ _id: "memWRONG", content: row.content }));
		return text(JSON.stringify({ _id: args.memoryId, content: row.content }));
	}
	if (name === "send_message") {
		const to = (args.recipientAgentIds ?? [])[0];
		const target = byAgent(to);
		if (target && target.slug !== me.slug) {
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
		if (!target || target.agent === me.agent) {
			return text(
				"Error: INVALID_RECIPIENTS: recipientAgentIds names no recipient other than the sender",
				true,
			);
		}
		if (MODE === "send-second-refused")
			return text("RBAC_DENIED: recipient not addressable", true);
		const id = `msg${String(++seq).padStart(4, "0")}`;
		msgs.set(id, { slug: me.slug, from: me.agent, to, content: args.content });
		return text(
			JSON.stringify({
				messageId: id,
				from: me.label,
				recipientAgentIds: [to],
			}),
		);
	}
	if (name === "check_messages") {
		// The real shape (measured on a local backend): an array of
		// { receiptId, from, fromId, channel, content, createdAt }, no message id.
		const entry = ([id, m]) => ({
			receiptId: `rcpt-${id}`,
			from: byAgent(m.from)?.label,
			fromId: MODE === "wrong-sender" ? "agentSomeoneElse" : m.from,
			channel: me.label,
			content: m.content,
			createdAt: 1,
		});
		const mine = [...msgs.entries()].filter(([, m]) => m.to === me.agent);
		if (MODE === "no-delivery") return text("[]");
		if (MODE === "wrong-inbox" && mine.length) {
			return text(
				JSON.stringify([
					{
						receiptId: "r",
						from: "x",
						fromId: "x",
						channel: me.label,
						content: "unrelated",
						createdAt: 1,
					},
				]),
			);
		}
		return text(JSON.stringify(mine.map(entry)));
	}
	if (name === "delete_message") {
		if (MODE === "delete-refused")
			return text("Forbidden: delete not permitted", true);
		const m = msgs.get(String(args.messageId));
		if (!m || m.from !== me.agent)
			return text("Error: NOT_FOUND message", true);
		msgs.delete(String(args.messageId));
		return text(JSON.stringify({ deleted: true }));
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
		if (!AG[bearer]) {
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
