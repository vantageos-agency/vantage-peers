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
//                 recipient door without an RBAC refusal; a recurring task (reminder) is
//                 created, paused, resumed and deleted, each step read back
//   other org  -> the same calls aimed at the other probe org must be REFUSED with
//                 a typed code/text, and the other org's row must not be readable; the
//                 other org's seat pausing or deleting that reminder is refused
//                 (ORG_MISMATCH|RBAC_DENIED|Forbidden) and the reminder is unchanged
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
//   VP_PROBE_BEARER_A2 / VP_PROBE_BEARER_B2 optional SECOND agent per org (default
//                      <tenant>/probe-a2.bearer, probe-b2.bearer). Absent file: single-agent
//                      fallback, announced in the output and the summary.
//
// Credentials are read from 0600 files and are never printed.
//
// RECURRING TASKS (fix #1673): the reminder uses a far-future cron (0 3 1 1 *) so it never fires
// during the probe, and is deleted in a finally. If that delete fails, a CLEANUP line carries its id.
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
		secondFile:
			process.env.VP_PROBE_BEARER_A2 ??
			join(DIR, "probe-tenant-a/probe-a2.bearer"),
	},
	{
		label: "probe-tenant-b",
		file:
			process.env.VP_PROBE_BEARER_B ??
			join(DIR, "probe-tenant-b/probe-b.bearer"),
		secondFile:
			process.env.VP_PROBE_BEARER_B2 ??
			join(DIR, "probe-tenant-b/probe-b2.bearer"),
	},
];

class CouldNotJudge extends Error {}

const failures = [];
const created = []; // { org, ns, id } rows or messages the run caused to exist and could not remove
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

// The SECOND probe agent of an org is optional. A file that does not exist (ENOENT) means
// "not provisioned": the probe falls back to the single-agent check and says so. A file that
// exists but cannot be read, or is empty, is a broken credential, never a silent fallback.
function readSecondBearer(org) {
	let raw;
	try {
		raw = readFileSync(org.secondFile, "utf8").trim();
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw new CouldNotJudge(
			`second-agent credential for ${org.label} unreadable (${org.secondFile}): ${e.code ?? e.message}`,
		);
	}
	if (!raw)
		throw new CouldNotJudge(
			`second-agent credential for ${org.label} is empty (${org.secondFile})`,
		);
	return raw;
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
	// The label this seat reads its inbox under (check_messages recipient).
	org.inboxLabel = w.suggested_orchestrator_id ?? w.fromAllowList?.[0] ?? null;
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
	await sendPole(org, stamp);
}

// send_message inside the org.
//  - With a SECOND agent credential: the seat sends to the second agent, the send must be
//    accepted with a messageId, and the RECIPIENT (the second agent's own seat) must find that
//    exact message in its inbox (check_messages). Delivered AND read back by the recipient.
//    The sender then deletes the message (delete_message, sender-only); if that is refused the
//    id is listed for the operator.
//  - Without one: single-agent fallback, said so in the output. A self-send is refused
//    INVALID_RECIPIENTS, which is only reachable once the seat is resolved, so it proves the
//    door resolves the seat but NOT that delivery works. RBAC_DENIED or any other error fails.
// The recipient's inbox, as the real check_messages returns it (measured on a local backend
// 2026-11-02): an array of { receiptId, from, fromId, channel, content, createdAt }. There is
// NO message id in an entry, so the read-back matches the exact body (it carries a unique
// timestamp) AND the sender's verified agent id (`fromId`). Body alone would pass for a
// message from anyone; an id alone does not exist.
function inboxHolds(text, marker, senderAgentId) {
	try {
		const parsed = JSON.parse(text);
		const entries = Array.isArray(parsed) ? parsed : (parsed.messages ?? []);
		return entries.some(
			(m) => m.content === marker && m.fromId === senderAgentId,
		);
	} catch {
		return false;
	}
}

async function sendPole(org, stamp) {
	const marker = `post-deploy-probe ${stamp} send ${org.label} (task ${TASK})`;
	const second = org.second;
	if (!second) {
		say(
			`  NOTE  ${org.label}: SINGLE-AGENT FALLBACK, no second-agent credential (${org.secondFile}); in-org send_message delivery is NOT tested for this org`,
		);
		const s = await call(org, "send_message", {
			fromAgentId: org.agentId,
			recipientAgentIds: [org.agentId],
			content: marker,
		});
		record(
			org.label,
			"send_message to own roster (single-agent fallback)",
			!s.isError || /INVALID_RECIPIENTS/.test(s.text),
			"delivered, or INVALID_RECIPIENTS (single-agent roster)",
			s.text,
		);
		return;
	}
	const before = Date.now() - 60000;
	const s = await call(org, "send_message", {
		fromAgentId: org.agentId,
		recipientAgentIds: [second.agentId],
		content: marker,
	});
	let messageId = null;
	try {
		messageId = JSON.parse(s.text).messageId ?? null;
	} catch {
		messageId = null;
	}
	record(
		org.label,
		`send_message to own second agent ${second.agentId}`,
		!s.isError && !!messageId,
		"delivered with a messageId",
		s.text,
	);
	if (!messageId) return;
	const inbox = await call(second, "check_messages", {
		recipient: second.inboxLabel ?? second.label,
		since: before,
		limit: 50,
	});
	record(
		second.label,
		`check_messages (recipient read-back of ${messageId})`,
		!inbox.isError && inboxHolds(inbox.text, marker, org.agentId),
		"an inbox entry with the exact body, sent by the sender's agent id",
		inbox.text,
	);
	const d = await call(org, "delete_message", { messageId });
	if (d.isError) {
		created.push({ org: org.label, ns: "message", id: messageId });
		say(
			`  note  ${org.label} delete_message ${messageId} refused: ${clip(d.text, 120)}`,
		);
	}
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
	for (const target of [other, other.second].filter(Boolean)) {
		const s = await call(org, "send_message", {
			fromAgentId: org.agentId,
			recipientAgentIds: [target.agentId],
			content: `post-deploy-probe ${stamp} cross send ${org.label}->${other.label} (task ${TASK})`,
		});
		record(
			org.label,
			`send_message to other org's agent ${target.agentId}`,
			s.isError && WRITE_REFUSAL.test(s.text),
			"refused with a typed code (RBAC_DENIED|Forbidden|INVALID_RECIPIENTS|AUTH_NAMESPACE_DENIED)",
			s.text,
		);
	}
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

// Recurring tasks (reminders), fix #1673. OWN pole: create -> get -> pause -> get -> resume -> get
// -> delete -> get (not found). FOREIGN pole: the other org's seat pauses and deletes the reminder,
// both must be refused with a typed code, and the owner's row must be unchanged afterwards.
// A far-future cron keeps the reminder from ever firing; a finally removes it whatever happened.
const RECURRING_REFUSAL = /\b(ORG_MISMATCH|RBAC_DENIED|Forbidden)\b/;
const RECURRING_CRON = "0 3 1 1 *";

function rowOf(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function recurringPole(org, other, stamp) {
	const actingName = org.inboxLabel;
	if (!actingName)
		throw new CouldNotJudge(
			`whoami for ${org.label} carries no acting name (suggested_orchestrator_id); cannot create a recurring task as the seat`,
		);
	const c = await call(org, "create_recurring_task", {
		title: `post-deploy-probe ${stamp} recurring ${org.label}`,
		description: `probe reminder, deleted at the end of the run (task ${TASK})`,
		assignedTo: actingName,
		createdBy: actingName,
		priority: "low",
		cronExpression: RECURRING_CRON,
	});
	const id = c.isError ? null : (rowOf(c.text)?.taskId ?? null);
	record(
		org.label,
		"create_recurring_task",
		!!id,
		"admitted with a taskId",
		c.text,
	);
	if (!id) return;
	const getRow = async () => {
		const g = await call(org, "get_recurring_task", { recurringTaskId: id });
		return { g, row: g.isError ? null : rowOf(g.text) };
	};
	let deleted = false;
	try {
		let { g, row } = await getRow();
		record(
			org.label,
			`get_recurring_task ${id} (after create)`,
			!!row &&
				row._id === id &&
				row.active === true &&
				row.assignedTo === actingName &&
				typeof row.clerkOrgId === "string" &&
				row.clerkOrgId.length > 0,
			"own row: same id, active true, assigned to the seat, stamped with its org id",
			g.text,
		);
		org.clerkOrgId = row?.clerkOrgId ?? null;
		// FOREIGN pole: the other org's seat acts on this reminder.
		for (const [tool, label] of [
			["pause_recurring_task", "pause"],
			["delete_recurring_task", "delete"],
		]) {
			const f = await call(other, tool, { taskId: id });
			record(
				other.label,
				`${tool} ${id} (${org.label}'s reminder)`,
				f.isError && RECURRING_REFUSAL.test(f.text),
				`${label} refused with a typed code (ORG_MISMATCH|RBAC_DENIED|Forbidden)`,
				f.text,
			);
		}
		({ g, row } = await getRow());
		record(
			org.label,
			`get_recurring_task ${id} (after the foreign attempts)`,
			!!row && row._id === id && row.active === true,
			"row unchanged by the other org: still there, still active",
			g.text,
		);
		const p = await call(org, "pause_recurring_task", { taskId: id });
		record(
			org.label,
			"pause_recurring_task",
			!p.isError,
			"own pause admitted",
			p.text,
		);
		({ g, row } = await getRow());
		record(
			org.label,
			`get_recurring_task ${id} (after pause)`,
			!!row && row.active === false,
			"active false",
			g.text,
		);
		const r = await call(org, "resume_recurring_task", { taskId: id });
		record(
			org.label,
			"resume_recurring_task",
			!r.isError,
			"own resume admitted",
			r.text,
		);
		({ g, row } = await getRow());
		record(
			org.label,
			`get_recurring_task ${id} (after resume)`,
			!!row && row.active === true,
			"active true",
			g.text,
		);
		const d = await call(org, "delete_recurring_task", { taskId: id });
		deleted = !d.isError;
		record(
			org.label,
			"delete_recurring_task",
			!d.isError,
			"own delete admitted",
			d.text,
		);
		({ g } = await getRow());
		const gone = g.isError && /not found/i.test(g.text);
		record(
			org.label,
			`get_recurring_task ${id} (after delete)`,
			gone,
			"not found",
			g.text,
		);
		if (!gone) deleted = false;
	} finally {
		if (!deleted) {
			let removed = false;
			try {
				const d = await call(org, "delete_recurring_task", { taskId: id });
				const g = await getRow();
				removed = !d.isError && g.g.isError && /not found/i.test(g.g.text);
			} catch {
				removed = false;
			}
			if (!removed) created.push({ org: org.label, ns: "recurring-task", id });
		}
	}
}

function summary(verdict, detail, code) {
	if (created.length) {
		say(
			`CLEANUP: ${created.length} item(s) left (memories have no seat delete door, soft_delete_memory is master-only; a recurring task or message whose delete failed is listed too). Ids for the operator:`,
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
	for (const org of ORGS) {
		const bearer = readSecondBearer(org);
		if (bearer === null) continue;
		const second = { label: `${org.label}/second`, bearer };
		await openSession(second);
		await whoami(second);
		if (second.slug !== org.slug || second.agentId === org.agentId) {
			throw new CouldNotJudge(
				`second-agent credential for ${org.label} resolves to agent ${second.agentId} of org ${second.slug}; expected a DIFFERENT agent of ${org.slug}`,
			);
		}
		say(
			`  whoami ${second.label}: agent ${second.agentId}, org ${second.slug}`,
		);
		org.second = second;
	}
	const [a, b] = ORGS;
	await ownPole(a, stamp);
	await ownPole(b, stamp);
	await crossPole(a, b, stamp);
	await crossPole(b, a, stamp);
	await recurringPole(a, b, stamp);
	await recurringPole(b, a, stamp);
	if (a.clerkOrgId && b.clerkOrgId) {
		record(
			"probe",
			"recurring task org stamps",
			a.clerkOrgId !== b.clerkOrgId,
			"the two probe orgs stamp DIFFERENT org ids on their reminders",
			`both stamped ${a.clerkOrgId}`,
		);
	}
	if (failures.length) {
		summary(
			"FAIL",
			`${failures.length} pole(s) broken: ${failures.map((f) => clip(f, 160)).join(" | ")}`,
			1,
		);
	}
	const single = ORGS.filter((o) => !o.second).map((o) => o.label);
	summary(
		"PASS",
		`${a.label} and ${b.label}: own namespaces admitted and read back, cross-org refused; recurring tasks: own create/pause/resume/delete read back, cross-org pause/delete refused` +
			(single.length
				? `; SINGLE-AGENT FALLBACK for ${single.join(", ")}: in-org send delivery NOT tested`
				: "; in-org send delivered and read back by the recipient"),
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
