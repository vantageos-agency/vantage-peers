import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireResolvedCaller, withOrgScope } from "./lib/auth";
import {
	BACKEND_CONTRACT_VERSION,
	BACKEND_FUNCTIONS,
} from "./lib/backendManifest";

// ─────────────────────────────────────────────────────────────────────────────
// backendContract -- what THIS deployed backend exposes, said by the backend.
//
// The MCP server (Railway) and this backend deploy independently. On
// 2026-10-12 the MCP went out calling `oauth:rotateRefreshToken` and passing
// new arguments while prod was still an older build, and clients failed for
// hours. The MCP now reads this manifest at boot and refuses to serve when a
// function it calls is not in it (mcp-server/src/backendContract.ts). A
// backend that predates this query answers "Could not find public function"
// -- and that absence is itself a refusal on the MCP side.
//
// What it returns: the contract version and the list of PUBLIC function
// identifiers (`module:name`) -- names only. No argument, no value from any
// table, no environment value. The list is a committed constant generated from
// the source (`node scripts/gen-backend-manifest.mjs`) and pinned by
// convex/__tests__/backendContract.test.ts, so it cannot drift from the code
// it describes: it ships in the same bundle as the functions it names.
//
// Who may ask: the MCP-bound fleet service account only. This is a credential
// oracle for the API surface, not a public document. An unresolved caller and
// an ordinary member are RAISED at (`RBAC_DENIED`, naming this door) -- never
// answered with an empty list, because the MCP must be able to tell "you may
// not" from "there is nothing" (.claude/rules/refusal-is-distinguishable-from-
// absence.md).
//
// Bump BACKEND_CONTRACT_VERSION (convex/lib/backendManifest.ts) AND the MCP's
// REQUIRED_CONTRACT_VERSION together when the MCP starts passing a NEW ARGUMENT
// to a function that already exists: a name list cannot see that skew.
// ─────────────────────────────────────────────────────────────────────────────
export const backendContract = query({
	args: {},
	returns: v.object({
		contractVersion: v.number(),
		functions: v.array(v.string()),
		functionCount: v.number(),
	}),
	handler: async (ctx) => {
		// isolation-contract: server-side only, no reactive subscriber — enumerated 2026-10-13 with: grep -rnE "backendContract|api\.meta\." /root/coding/vantage-peers-dashboard --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git -> 0 hits. R-50 declared divergence.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "meta:backendContract", {
			alsoRefusePreOrg: true,
			masterOnly: true,
			mcpBoundOnly: true,
		});
		return {
			contractVersion: BACKEND_CONTRACT_VERSION,
			functions: [...BACKEND_FUNCTIONS],
			functionCount: BACKEND_FUNCTIONS.length,
		};
	},
});
