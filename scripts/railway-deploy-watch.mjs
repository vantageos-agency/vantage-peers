#!/usr/bin/env node
// railway-deploy-watch.mjs — detects a Railway service whose latest deployment
// FAILED while the previous container keeps answering (nothing alerts).
//
// Why: on 2026-07-21 two of seven services had their last deployment FAILED for
// weeks, unseen. This script derives the fleet from the Railway API (no service
// name or id is typed here) and judges it.
//
// Usage: RAILWAY_API_TOKEN=... node scripts/railway-deploy-watch.mjs [--notify]
//
// Exit codes:
//   0  every latest deployment is SUCCESS and no served commit diverges
//   1  at least one service is RED (FAILED/CRASHED, or serving a commit other
//      than its last success); each is NAMED with status, date and commit SHA
//   2  REFUSING TO JUDGE: token missing/invalid, API error, unreadable shape,
//      or zero services derived. Names the instrument that failed. Never 0.
//
// Token: env RAILWAY_API_TOKEN only. It is never printed or logged.
//
// SHA check: for a service with a public domain, GET https://<domain>/health.
// If the JSON carries `commit` (not "unknown"), it must match the latest SUCCESS
// deployment's commit. Absent/"unknown" commit, or unreachable health, is listed
// as "not judged" and counted in the summary; it turns the run neither red nor
// (by itself) green.
//
// --notify: on exit 1 or 2, the message body is handed to an injected `notify`
// function. In this CLI that function prints "NOTIFY: <body>" to stdout and, if
// VP_NOTIFY_CMD names an executable, runs it (no shell) with the body on stdin.
// The real send to VantagePeers, and the cron wiring that runs this script
// periodically, are done by the operator. No credentials live in this script.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";

const QUERY = `query Watch {
  projects {
    edges { node {
      id name
      services { edges { node {
        id name
        serviceInstances { edges { node {
          environmentId
          latestDeployment { id status createdAt meta }
          domains {
            serviceDomains { domain }
            customDomains { domain }
          }
        } } }
      } } }
    } }
  }
}`;

const RED_STATUSES = new Set(["FAILED", "CRASHED"]);

/** @returns {"GREEN"|"RED"|"NOT_JUDGED"} */
export function classifyDeployment(status) {
	if (status === "SUCCESS") return "GREEN";
	if (RED_STATUSES.has(status)) return "RED";
	return "NOT_JUDGED";
}

/** @returns {"same"|"different"|"not-comparable"} */
export function compareCommits(served, lastSuccess) {
	const ok = (v) => typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v);
	if (!ok(served) || !ok(lastSuccess)) return "not-comparable";
	const a = served.toLowerCase();
	const b = lastSuccess.toLowerCase();
	return a.startsWith(b) || b.startsWith(a) ? "same" : "different";
}

class Refusal extends Error {
	constructor(instrument, detail) {
		super(`${instrument}: ${detail}`);
		this.instrument = instrument;
	}
}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const edges = (v, what) => {
	if (!isObj(v) || !Array.isArray(v.edges)) {
		throw new Refusal("Railway GraphQL API", `unreadable shape at ${what}`);
	}
	return v.edges.map((e) => e?.node);
};

/** Pure: Railway response body -> flat list of service entries. */
export function parseServices(body) {
	if (!isObj(body)) throw new Refusal("Railway GraphQL API", "unreadable body");
	if (Array.isArray(body.errors) && body.errors.length > 0) {
		const msg = body.errors.map((e) => e?.message ?? "unknown").join("; ");
		throw new Refusal("Railway GraphQL API", `errors field: ${msg}`);
	}
	const out = [];
	for (const project of edges(body.data?.projects, "data.projects")) {
		if (!isObj(project))
			throw new Refusal("Railway GraphQL API", "unreadable project");
		for (const svc of edges(project.services, "project.services")) {
			if (!isObj(svc) || typeof svc.name !== "string") {
				throw new Refusal("Railway GraphQL API", "unreadable service");
			}
			const instances = edges(svc.serviceInstances, "service.serviceInstances");
			for (const inst of instances) {
				if (!isObj(inst))
					throw new Refusal("Railway GraphQL API", "unreadable instance");
				const dep = inst.latestDeployment;
				const doms = inst.domains ?? {};
				const domains = [
					...(doms.customDomains ?? []),
					...(doms.serviceDomains ?? []),
				]
					.map((d) => d?.domain)
					.filter((d) => typeof d === "string" && d.length > 0);
				out.push({
					name: svc.name,
					project: project.name,
					status: dep?.status,
					createdAt: dep?.createdAt,
					commit: dep?.meta?.commitHash,
					domains,
				});
			}
		}
	}
	return out;
}

/** Pure: judged entries -> { exitCode, report }. Entry: {name, verdict, status, createdAt, commit, reason}. */
export function buildReport(entries) {
	const lines = [];
	const red = entries.filter((e) => e.verdict === "RED");
	const nj = entries.filter((e) => e.verdict === "NOT_JUDGED");
	const green = entries.filter((e) => e.verdict === "GREEN");
	for (const e of red) {
		lines.push(
			`RED ${e.name}: ${e.status} ${e.createdAt ?? "date unknown"} ${e.commit ?? "commit unknown"}${e.reason ? ` — ${e.reason}` : ""}`,
		);
	}
	for (const e of nj) {
		lines.push(`SKIP ${e.name}: not judged: ${e.reason}`);
	}
	for (const e of green) {
		lines.push(
			`OK ${e.name}: ${e.status} ${e.createdAt ?? ""} ${e.commit ?? ""}`.trimEnd(),
		);
	}
	lines.push(
		`SUMMARY: ${entries.length} services, ${green.length} ok, ${red.length} RED, ${nj.length} not judged`,
	);
	return { exitCode: red.length > 0 ? 1 : 0, report: lines.join("\n") };
}

async function callApi(fetchImpl, token) {
	let res;
	try {
		res = await fetchImpl(RAILWAY_API_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ query: QUERY }),
		});
	} catch (err) {
		throw new Refusal(
			"Railway GraphQL API",
			`unreachable (${err?.message ?? err})`,
		);
	}
	if (res.status !== 200) {
		throw new Refusal(
			"Railway GraphQL API",
			`HTTP ${res.status} (token missing scope, invalid or expired?)`,
		);
	}
	try {
		return await res.json();
	} catch {
		throw new Refusal("Railway GraphQL API", "response is not JSON");
	}
}

async function readHealth(fetchImpl, domains) {
	let lastErr = "no domain";
	for (const d of domains) {
		try {
			const res = await fetchImpl(`https://${d}/health`, {
				signal: AbortSignal.timeout(10_000),
			});
			if (res.status !== 200) {
				lastErr = `HTTP ${res.status}`;
				continue;
			}
			const json = await res.json();
			return { ok: true, json };
		} catch (err) {
			lastErr = err?.message ?? String(err);
		}
	}
	return { ok: false, reason: lastErr };
}

async function judge(fetchImpl, svc) {
	const base = {
		name: svc.name,
		status: svc.status,
		createdAt: svc.createdAt,
		commit: svc.commit,
		reason: "",
	};
	if (svc.status === undefined) {
		return { ...base, verdict: "NOT_JUDGED", reason: "no deployment found" };
	}
	const verdict = classifyDeployment(svc.status);
	if (verdict === "RED") return { ...base, verdict };
	if (verdict === "NOT_JUDGED") {
		return { ...base, verdict, reason: `status ${svc.status} is not final` };
	}
	if (svc.domains.length === 0) {
		return {
			...base,
			verdict: "NOT_JUDGED",
			reason: "SUCCESS but no public domain to check the served commit",
		};
	}
	const h = await readHealth(fetchImpl, svc.domains);
	if (!h.ok) {
		return {
			...base,
			verdict: "NOT_JUDGED",
			reason: `health unreachable (${h.reason})`,
		};
	}
	const served = isObj(h.json) ? h.json.commit : undefined;
	const cmp = compareCommits(served, svc.commit);
	if (cmp === "different") {
		return {
			...base,
			verdict: "RED",
			reason: `serving ${served}, last success ${svc.commit}`,
		};
	}
	if (cmp === "not-comparable") {
		return {
			...base,
			verdict: "NOT_JUDGED",
			reason: "health exposes no commit",
		};
	}
	return { ...base, verdict: "GREEN" };
}

/**
 * Whole run without process IO. Returns { exitCode, report }.
 * `notify(body)` is injected; called on exit 1 or 2 when notifyEnabled.
 */
export async function runWatch({
	env,
	fetchImpl,
	notify,
	notifyEnabled = false,
}) {
	let exitCode;
	let report;
	try {
		const token = env?.RAILWAY_API_TOKEN;
		if (!token)
			throw new Refusal("RAILWAY_API_TOKEN", "missing from the environment");
		const body = await callApi(fetchImpl, token);
		const services = parseServices(body);
		if (services.length === 0) {
			throw new Refusal(
				"Railway GraphQL API",
				"zero services derived (wrong token scope or empty account?)",
			);
		}
		const entries = [];
		for (const s of services) entries.push(await judge(fetchImpl, s));
		({ exitCode, report } = buildReport(entries));
	} catch (err) {
		if (!(err instanceof Refusal)) throw err;
		exitCode = 2;
		report = `REFUSING TO JUDGE — instrument failed: ${err.message}`;
	}
	if (notifyEnabled && notify && exitCode !== 0) {
		await notify(`railway-deploy-watch exit ${exitCode}\n${report}`);
	}
	return { exitCode, report };
}

function cliNotify(body) {
	console.log(`NOTIFY: ${body.replaceAll("\n", "\nNOTIFY: ")}`);
	const cmd = process.env.VP_NOTIFY_CMD;
	if (cmd)
		execFileSync(cmd, [], {
			input: body,
			stdio: ["pipe", "inherit", "inherit"],
		});
}

async function main() {
	const notifyEnabled = process.argv.includes("--notify");
	const { exitCode, report } = await runWatch({
		env: process.env,
		fetchImpl: fetch,
		notify: cliNotify,
		notifyEnabled,
	});
	console.log(report);
	process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(
			`REFUSING TO JUDGE — instrument failed: script (${err?.message ?? err})`,
		);
		process.exit(2);
	});
}
