#!/usr/bin/env node
/**
 * prove-cgt-agents.mjs — prove each CGT Alsachimie agent on the VantagePeers MCP
 * (task k17bnmfdan9xgxgyy3ny61ebps8fr0gw).
 *
 *   node scripts/prove-cgt-agents.mjs --env prod --agents neo,hal,mimir [--secrets-dir <dir>]
 *
 * Per agent, with its OWN bearer (and agent credential, when present) read from
 * <secrets-dir>/<agent>.bearer and <secrets-dir>/<agent>.secret (0600, never printed):
 *   1. whoami → 200, org_slug === "cgt-alsachimie", agent name in the allow-list
 *   2. store_memory in orchestrator/<agent> then recall it → the row comes back
 *   3. send_message to a sibling CGT agent → accepted
 *   4. cross-org, this agent → perello-consulting: store_memory in orchestrator/sigma
 *      and recall in project/vantage-peers → each REFUSED with an error (an empty
 *      success fails: it cannot tell a refusal from an absence)
 * Reverse direction (perello-consulting member → CGT row): run with
 *   --reverse-bearer-file <file>, a NON-master perello-consulting bearer. The first CGT
 *   seat plants a marker in project/cgt-alsachimie and reads it back (positive control);
 *   the foreign bearer's recall of that marker must be refused.
 * Exit 0 only when every probe passes. Prints scope fields only, never a secret.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const URLS = { prod: "https://vantage-peers-production.up.railway.app/mcp" };
const ORG = "cgt-alsachimie";

const argv = process.argv.slice(2);
const arg = (k, d) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : d;
};
const url = URLS[arg("env", "prod")];
if (!url) throw new Error("--env must be prod");
const agents = (arg("agents", "neo,hal,mimir") || "").split(",").filter(Boolean);
const dir = arg("secrets-dir", "/home/cgt-alsachimie/.vantage-agent-secrets");
const reverseFile = arg("reverse-bearer-file", "");

const readOpt = (p) => {
	try {
		return readFileSync(p, "utf-8").trim() || null;
	} catch {
		return null;
	}
};

let seq = 0;
async function call(headers, name, args) {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
	});
	const text = await res.text();
	const m = text.match(/\{[\s\S]*\}/);
	let body = null;
	try {
		body = m ? JSON.parse(m[0]) : null;
	} catch {}
	const result = body?.result;
	const out = result?.content?.map((c) => c.text).join("\n") ?? body?.error?.message ?? text.slice(0, 200);
	return { status: res.status, isError: !!result?.isError || !!body?.error || res.status >= 400, text: out ?? "" };
}

// A refusal is an error result whose text names the denial, never an empty success.
const refused = (r) => r.isError && /forbidden|not readable|not writable|RBAC_DENIED|denied/i.test(r.text);
let firstSeat = null;

const results = [];
const check = (agent, probe, ok, detail) => {
	results.push({ agent, probe, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${agent.padEnd(6)} ${probe.padEnd(28)} ${detail}`);
};

for (const agent of agents) {
	const bearer = readOpt(join(dir, `${agent}.bearer`));
	const cred = readOpt(join(dir, `${agent}.secret`));
	if (!bearer) {
		check(agent, "credential file", false, `no ${agent}.bearer in ${dir}`);
		continue;
	}
	const h = { Authorization: bearer.toLowerCase().startsWith("bearer ") ? bearer : `Bearer ${bearer}` };
	if (cred) h["x-vantage-agent-credential"] = cred;

	const who = await call(h, "whoami", {});
	let org = null;
	let allow = [];
	try {
		const j = JSON.parse(who.text);
		org = j.org_slug ?? j.actor?.orgSlug ?? null;
		allow = j.fromAllowList ?? [];
	} catch {}
	check(agent, "whoami in org", who.status === 200 && !who.isError && org === ORG && allow.includes(agent),
		`HTTP ${who.status} org=${org} fromAllowList=${JSON.stringify(allow)}`);

	const marker = `prove-cgt-${agent}-${Date.now()}`;
	const st = await call(h, "store_memory", { namespace: `orchestrator/${agent}`, type: "reference", content: marker, createdBy: agent });
	const rc = await call(h, "recall", { query: marker, namespace: `orchestrator/${agent}`, limit: 5 });
	check(agent, "own memory round-trip", !st.isError && rc.text.includes(marker), st.isError ? st.text.slice(0, 120) : "stored + recalled");

	const sibling = agents.find((a) => a !== agent) ?? ["neo", "hal", "mimir"].find((a) => a !== agent);
	const sm = await call(h, "send_message", { from: agent, channel: sibling, content: `[INFO ONLY] prove-cgt-agents probe from ${agent}\n\nOrchestrator: ${agent} — CGT Alsachimie | probe` });
	check(agent, `message to ${sibling}`, !sm.isError, sm.isError ? sm.text.slice(0, 120) : "accepted");

	const xw = await call(h, "store_memory", { namespace: "orchestrator/sigma", type: "reference", content: `cross-org write probe ${marker}`, createdBy: agent });
	check(agent, "cross-org write refused", refused(xw), xw.isError ? xw.text.slice(0, 120) : "ACCEPTED (leak)");
	const xr = await call(h, "recall", { query: "vantage peers", namespace: "project/vantage-peers", limit: 5 });
	// An empty success cannot tell "you may not" from "there is nothing": only the refusal passes.
	check(agent, "cross-org read refused", refused(xr), xr.isError ? xr.text.slice(0, 120) : `NOT REFUSED (${xr.text.slice(0, 80)})`);
	if (!firstSeat) firstSeat = { agent, h };
}

if (reverseFile) {
	const rb = readOpt(reverseFile);
	if (!rb) check("reverse", "reverse bearer", false, `cannot read ${reverseFile}`);
	else if (!firstSeat) check("reverse", "positive control", false, "no CGT seat available to plant the marker");
	else {
		// Positive control: a CGT seat plants a marker in project/<org> and reads it back, so the
		// row the foreign bearer is refused on demonstrably exists.
		const planted = `prove-cgt-reverse-${Date.now()}`;
		const ps = await call(firstSeat.h, "store_memory", { namespace: `project/${ORG}`, type: "reference", content: planted, createdBy: firstSeat.agent });
		const pr = await call(firstSeat.h, "recall", { query: planted, namespace: `project/${ORG}`, limit: 5 });
		const plantedOk = !ps.isError && pr.text.includes(planted);
		check("reverse", "positive control (cgt reads)", plantedOk, plantedOk ? `${firstSeat.agent} stored + recalled` : ps.isError ? ps.text.slice(0, 120) : "marker not recalled");
		const h = { Authorization: rb.toLowerCase().startsWith("bearer ") ? rb : `Bearer ${rb}` };
		const rr = await call(h, "recall", { query: planted, namespace: `project/${ORG}`, limit: 5 });
		check("reverse", "foreign reads cgt refused", plantedOk && refused(rr) && !rr.text.includes(planted),
			rr.text.includes(planted) ? "CGT ROW RETURNED (leak)" : rr.isError ? rr.text.slice(0, 120) : `NOT REFUSED (${rr.text.slice(0, 80)})`);
	}
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} probes passed`);
process.exit(failed ? 1 : 0);
