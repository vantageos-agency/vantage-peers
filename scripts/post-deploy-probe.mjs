#!/usr/bin/env node
// VantagePeers Cloud: post-deploy live probe (task k179zpdjs4m7h7xfgn4yn84j8n8heqke).
//
// Founding incident, 2026-11-02: 15 live seat tokens could not write their own
// namespace while every suite, both doctors and the review were green. Nothing
// looked at live connections. This is that instrument: it speaks MCP over HTTP to
// the deployed server as the two dedicated probe seats (probe-tenant-a and
// probe-tenant-b, never a client's agent, never master) and checks both poles:
//
//   own org    -> store_memory to orchestrator/<own agent id> and project/<own slug>
//                 must be ADMITTED, read back by id; send_message must reach the
//                 recipient door without an RBAC refusal
//   other org  -> the same calls aimed at the other probe org must be REFUSED with
//                 a typed code/text, and the other org's row must not be readable
//
// Agent ids and slugs come from whoami, never hardcoded.
//
// Exit codes, one summary line each (always the last line, prefix POST-DEPLOY-PROBE:):
//   0  PASS             every pole holds
//   1  FAIL             names the org, the call and the response
//   2  COULD-NOT-JUDGE  a credential is unreadable, the MCP is unreachable, or
//                       whoami fails. Never reported as PASS.
// A FAIL already recorded is never downgraded: if the run is then cut short, the
// verdict stays FAIL and says it is incomplete.
//
// Environment (all optional):
//   VP_PROBE_MCP_URL   default https://mcp.vantagepeers.com/mcp
//   VP_PROBE_DIR       default ~/.config/vantage-probe-tenants/prod
//   VP_PROBE_BEARER_A / VP_PROBE_BEARER_B   explicit bearer file paths
//
// Credentials are read from 0600 files and are never printed.
//
// CLEANUP: the seats have no delete door (soft_delete_memory requires master scope,
// measured 2026-11-02). Rows created by a run are listed as CLEANUP ids at the end,
// for the operator to remove with the master door.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MCP = process.env.VP_PROBE_MCP_URL ?? "https://mcp.vantagepeers.com/mcp";
const DIR =
	process.env.VP_PROBE_DIR ??
	join(homedir(), ".config/vantage-probe-tenants/prod");
const TIMEOUT_MS = 20000;
const TASK = "k179zpdjs4m7h7xfgn4yn84j8n8heqke";

const ORGS = [
	{
		label: "probe-tenant-a",
		file:
			process.env.VP_PROBE_BEARER_A ??
			join(DIR, "probe-tenant-a/probe-a.bearer"),
	},
	{
		label: "probe-tenant-b",
		file:
			process.env.VP_PROBE_BEARER_B ??
			join(DIR, "probe-tenant-b/probe-b.bearer"),
	},
];

class CouldNotJudge extends Error {}

const failures = [];
const created = []; // { org, ns, id } rows the run caused to exist
const lines = [];
const say = (s) => {
	lines.push(s);
	console.log(s);
};
const clip = (s, n = 220) => String(s).replace(/\s+/g, " ").slice(0, n);

function record(org, call, ok, expectation, response) {
	if (ok) {
		say(`  ok    ${org} ${call} (${expectation})`);
	} else {
		const f = `${org} ${call}: expected ${expectation}, got ${clip(response)}`;
		failures.push(f);
		say(`  FAIL  ${f}`);
	}
}

async function readBearer(org) {
	let raw;
	try {
		raw = readFileSync(org.file, "utf8").trim();
	} catch (e) {
		throw new CouldNotJudge(
			`credential for ${org.label} unreadable (${org.file}): ${e.code ?? e.message}`,
		);
	}
	if (!raw)
		throw new CouldNotJudge(
			`credential for ${org.label} is empty (${org.file})`,
		);
	return raw;
}

function parseBody(t) {
	const line = t.split("\n").find((l) => l.startsWith("data:"));
	return JSON.parse(line ? line.slice(5) : t);
}

async function post(org, sid, payload, expectBody = true) {
	const headers = {
		authorization: `Bearer ${org.bearer}`,
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(sid ? { "mcp-session-id": sid } : {}),
	};
	let res;
	try {
		res = await fetch(MCP, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		throw new CouldNotJudge(
			`MCP unreachable at ${MCP} for ${org.label}: ${e.cause?.code ?? e.name ?? ""} ${e.message}`.trim(),
		);
	}
	if (!res.ok) {
		throw new CouldNotJudge(
			`MCP answered HTTP ${res.status} to ${org.label} (${payload.method}); credential rejected or server unhealthy`,
		);
	}
	if (!expectBody) return { res, json: null };
	try {
		return { res, json: parseBody(await res.text()) };
	} catch (e) {
		throw new CouldNotJudge(
			`MCP answer to ${org.label} (${payload.method}) is not parseable: ${e.message}`,
		);
	}
}

async function openSession(org) {
	const { res } = await post(
		org,
		null,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "post-deploy-probe", version: "1" },
			},
		},
		true,
	);
	// A stateless server issues no session id (measured on prod 2026-11-02): carry one only if given.
	const sid = res.headers.get("mcp-session-id");
	await post(
		org,
		sid,
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		false,
	);
	org.sid = sid;
	org.rpcId = 2;
}

// Returns { isError, text, structured }. A JSON-RPC level error counts as a refusal
// carrying its message; a transport failure throws CouldNotJudge.
async function call(org, name, args) {
	const { json } = await post(org, org.sid, {
		jsonrpc: "2.0",
		id: org.rpcId++,
		method: "tools/call",
		params: { name, arguments: args },
	});
	if (json.error)
		return {
			isError: true,
			text: `${json.error.code ?? ""} ${json.error.message ?? ""}`,
			structured: null,
		};
	const r = json.result ?? {};
	return {
		isError: r.isError === true,
		text: (r.content ?? []).map((c) => c.text).join(" "),
		structured: r.structuredContent ?? null,
	};
}

// The ACCEPTED SET of typed refusals. A cross-org call counts as refused only if the
// response carries one of these, case-sensitive, as a whole word. An untyped or unknown
// error (for example the opaque "Server Error", or a validation error) is a FAIL: it
// cannot tell a refusal from a crash, so it is never a PASS.
//   writes and sends: a refusal code the backend raises on purpose
//   reads: the same codes, or the existence-hiding "Memory not found" prod answers
//          (measured 2026-11-02) so that another org's ids are not confirmed
const WRITE_REFUSAL =
	/\b(RBAC_DENIED|Forbidden|INVALID_RECIPIENTS|AUTH_NAMESPACE_DENIED)\b/;
const READ_REFUSAL = /\b(RBAC_DENIED|Forbidden|NOT_FOUND)\b|Memory not found/;

// The read-back must return the SAME row (id) with EXACTLY the content that was written.
// Substring or "no error" is not enough: a wrong row or a stale body would pass.
function readBackMatches(text, id, content) {
	try {
		const row = JSON.parse(text);
		return row._id === id && row.content === content;
	} catch {
		return false;
	}
}

async function whoami(org) {
	const r = await call(org, "whoami", {});
	if (r.isError)
		throw new CouldNotJudge(`whoami failed for ${org.label}: ${clip(r.text)}`);
	let w = r.structured;
	if (!w) {
		try {
			w = JSON.parse(r.text);
		} catch {
			throw new CouldNotJudge(
				`whoami for ${org.label} is not parseable: ${clip(r.text)}`,
			);
		}
	}
	const agentId = w.agent_id ?? w.actor?.agentId;
	const slug = w.org_slug ?? w.actor?.orgSlug;
	if (!agentId || !slug) {
		throw new CouldNotJudge(
			`whoami for ${org.label} carries no agent_id/org_slug (agent_unresolved_reason=${w.agent_unresolved_reason ?? "n/a"})`,
		);
	}
	org.agentId = agentId;
	org.slug = slug;
}

function memoryIdOf(text) {
	try {
		return JSON.parse(text).memoryId ?? null;
	} catch {
		return null;
	}
}

async function ownPole(org, stamp) {
	org.rows = [];
	for (const ns of [`orchestrator/${org.agentId}`, `project/${org.slug}`]) {
		const content = `post-deploy-probe ${stamp} own-pole ${org.label} (task ${TASK})`;
		const r = await call(org, "store_memory", {
			namespace: ns,
			type: "project",
			content,
		});
		const id = r.isError ? null : memoryIdOf(r.text);
		record(
			org.label,
			`store_memory ${ns}`,
			!r.isError && !!id,
			"admitted with a memoryId",
			r.text,
		);
		if (!id) continue;
		created.push({ org: org.label, ns, id });
		org.rows.push({ ns, id, content });
		const g = await call(org, "get_memory", { memoryId: id });
		record(
			org.label,
			`get_memory ${id} (read-back)`,
			!g.isError && readBackMatches(g.text, id, content),
			"own row read back: same id, exact content written",
			g.text,
		);
	}
	// send_message: the probe roster is a single agent, so no deliverable recipient exists.
	// Self-send is refused INVALID_RECIPIENTS; that refusal is only reachable once the seat
	// is resolved, so it proves the door resolves the seat. A delivery is also accepted
	// (the roster may grow). RBAC_DENIED or any other error means the seat is not served.
	const s = await call(org, "send_message", {
		fromAgentId: org.agentId,
		recipientAgentIds: [org.agentId],
		content: `post-deploy-probe ${stamp} send ${org.label} (task ${TASK})`,
	});
	const sendOk = !s.isError || /INVALID_RECIPIENTS/.test(s.text);
	record(
		org.label,
		"send_message to own roster",
		sendOk,
		"delivered, or INVALID_RECIPIENTS (single-agent roster)",
		s.text,
	);
}

async function crossPole(org, other, stamp) {
	for (const ns of [`orchestrator/${other.agentId}`, `project/${other.slug}`]) {
		const r = await call(org, "store_memory", {
			namespace: ns,
			type: "project",
			content: `post-deploy-probe ${stamp} cross-pole ${org.label}->${other.label} (task ${TASK})`,
		});
		if (!r.isError) {
			const id = memoryIdOf(r.text);
			if (id) created.push({ org: org.label, ns, id });
		}
		record(
			org.label,
			`store_memory ${ns} (other org)`,
			r.isError && WRITE_REFUSAL.test(r.text),
			"refused with a typed code (RBAC_DENIED|Forbidden|INVALID_RECIPIENTS|AUTH_NAMESPACE_DENIED)",
			r.text,
		);
	}
	const s = await call(org, "send_message", {
		fromAgentId: org.agentId,
		recipientAgentIds: [other.agentId],
		content: `post-deploy-probe ${stamp} cross send ${org.label}->${other.label} (task ${TASK})`,
	});
	record(
		org.label,
		"send_message to other org's agent",
		s.isError && WRITE_REFUSAL.test(s.text),
		"refused with a typed code (RBAC_DENIED|Forbidden|INVALID_RECIPIENTS|AUTH_NAMESPACE_DENIED)",
		s.text,
	);
	for (const row of other.rows ?? []) {
		const g = await call(org, "get_memory", { memoryId: row.id });
		record(
			org.label,
			`get_memory ${row.id} (other org's row)`,
			g.isError && READ_REFUSAL.test(g.text) && !g.text.includes(row.content),
			"typed refusal or not-found, content not returned",
			g.text,
		);
	}
}

function summary(verdict, detail, code) {
	if (created.length) {
		say(
			`CLEANUP: ${created.length} row(s) created, no seat delete door (soft_delete_memory is master-only). Ids for the operator:`,
		);
		for (const c of created) say(`  CLEANUP ${c.org} ${c.ns} ${c.id}`);
	}
	console.log(`POST-DEPLOY-PROBE: ${verdict} ${detail}`);
	process.exit(code);
}

async function main() {
	const stamp = new Date().toISOString();
	say(`post-deploy-probe ${stamp} against ${MCP}`);
	for (const org of ORGS) org.bearer = await readBearer(org);
	for (const org of ORGS) {
		await openSession(org);
		await whoami(org);
		say(`  whoami ${org.label}: agent ${org.agentId}, org ${org.slug}`);
	}
	const [a, b] = ORGS;
	await ownPole(a, stamp);
	await ownPole(b, stamp);
	await crossPole(a, b, stamp);
	await crossPole(b, a, stamp);
	if (failures.length) {
		summary(
			"FAIL",
			`${failures.length} pole(s) broken: ${failures.map((f) => clip(f, 160)).join(" | ")}`,
			1,
		);
	}
	summary(
		"PASS",
		`${a.label} and ${b.label}: own namespaces admitted and read back, cross-org refused`,
		0,
	);
}

main().catch((e) => {
	if (!(e instanceof CouldNotJudge)) {
		// An unexpected exception is not a verdict about the deployment.
		e = new CouldNotJudge(`unexpected error: ${e?.stack ?? e}`);
	}
	if (failures.length) {
		summary(
			"FAIL",
			`${failures.length} pole(s) broken, run INCOMPLETE (${clip(e.message, 120)}): ${failures.map((f) => clip(f, 160)).join(" | ")}`,
			1,
		);
	}
	summary("COULD-NOT-JUDGE", e.message, 2);
});
