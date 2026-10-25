#!/usr/bin/env node
// agent-link.mjs — grant or revoke an explicit agent link as the signed-in organisation
// admin (task k17965eh23twqzsbjc8mjgfcmx8gpxmh, docs/cloud/agent-links.md).
//
//   CONVEX_URL=<deployment url> AGENT_LINK_SESSION_TOKEN=<your Clerk session JWT, template "convex"> \
//     node scripts/agent-link.mjs grant <fromAgentId> <toAgentId> "<reason, 10+ characters>"
//   ... node scripts/agent-link.mjs revoke <fromAgentId> <toAgentId>
//
// The token is the admin's OWN session; it is read from the environment and never printed.
// The door refuses anyone who is not an admin of the organisation of <toAgentId>.
import { ConvexHttpClient } from "convex/browser";
import { agentLinkCall } from "./lib/agent-link-client.mjs";

const [action, fromAgentId, toAgentId, reason] = process.argv.slice(2);
const url = process.env.CONVEX_URL;
const token = process.env.AGENT_LINK_SESSION_TOKEN;
if (!url) throw new Error("CONVEX_URL is required");
if (!token) throw new Error("AGENT_LINK_SESSION_TOKEN is required (your own Clerk session token)");

const client = new ConvexHttpClient(url);
client.setAuth(token);
const result = await agentLinkCall(client, action, { fromAgentId, toAgentId, reason });
console.log(action === "grant" ? `granted: agentLinks row ${result}` : "revoked");
