#!/usr/bin/env node
// client-agent-set-profile.mjs — create each client agent's profile row with its OWN credential, so it becomes a
// message recipient (a role is addressable only once a profiles row exists). Run as the client's Unix user:
//   sudo -u <client-user> node scripts/client-agent-set-profile.mjs <secrets-dir> <agent> [<agent>…]
// Prints HTTP status per agent, never a secret. Runbook: runbooks/onboard-client-org.md.
import { readFileSync } from "node:fs";
const [D, ...names] = process.argv.slice(2);
for (const a of names) {
  const b = readFileSync(`${D}/${a}.bearer`, "utf-8").trim(), c = readFileSync(`${D}/${a}.secret`, "utf-8").trim();
  const r = await fetch("https://vantage-peers-production.up.railway.app/mcp", { method: "POST", headers: { Authorization: `Bearer ${b}`, "x-vantage-agent-credential": c, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_summary", arguments: { orchestratorId: a, instanceId: `${a}-vps`, summary: `Provisioned ${new Date().toISOString().slice(0, 10)}; awaiting first launch.` } } }) });
  const t = await r.text(); console.log(a, r.status, /"isError":true/.test(t) ? t.slice(0, 200) : "ok");
}
