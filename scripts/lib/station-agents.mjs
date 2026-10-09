/**
 * station-agents.mjs — pure helpers shared by scripts/mint-station-agents.mjs
 * and scripts/prove-station-agent-credential.mjs (task k17awnbe5njbfwxed3z4e1md358fhra0).
 *
 * Everything here is side-effect free except `writeSecretFile`, so the decisions
 * that matter (argument parsing, what to do per station, never printing a secret)
 * are unit-testable without Clerk or Convex.
 */

import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Roles that must never be minted by this tool (BU excluded by the roster). */
export const EXCLUDED_ROLES = Object.freeze(["victor", "marie", "iris", "iris-rh"]);

const ROLE_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** Same lowercase/trim normalisation the MCP layer applies to a sender name. */
export function normalizeRole(raw) {
	return String(raw ?? "").trim().toLowerCase();
}

/**
 * agentRowByLabel — the operator's own lookup: picks the agents row whose
 * display label is `label` from the org's listing (`agents:listAgentsByOrg`).
 * This is a script-side convenience for a human running a station tool; the
 * backend doors take the row's `_id` and never select a row by label.
 */
export function agentRowByLabel(rows, label) {
	const key = normalizeRole(label);
	return (rows ?? []).find((row) => normalizeRole(row.name) === key) ?? null;
}

/** Env var NAME a station reads its secret into: eta -> ETA_AGENT_SECRET. */
export function envVarNameFor(agentName) {
	return `${agentName.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_AGENT_SECRET`;
}

/**
 * parseArgs — tiny strict flag parser. Unknown flags are an error, a value flag
 * without a value is an error. Returns a plain object; never reads the env.
 */
export function parseArgs(argv) {
	const out = {
		stations: null,
		secretsDir: null,
		dryRun: false,
		rotate: false,
		station: null,
		phase: "auto",
	};
	const valueFlags = {
		"--stations": "stations",
		"--secrets-dir": "secretsDir",
		"--station": "station",
		"--phase": "phase",
	};
	const boolFlags = { "--dry-run": "dryRun", "--rotate": "rotate" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.indexOf("=");
		const flag = eq === -1 ? a : a.slice(0, eq);
		if (flag in boolFlags) {
			if (eq !== -1) throw new Error(`Flag ${flag} takes no value.`);
			out[boolFlags[flag]] = true;
		} else if (flag in valueFlags) {
			const value = eq !== -1 ? a.slice(eq + 1) : argv[++i];
			if (value === undefined || value === "" || value.startsWith("--")) {
				throw new Error(`Flag ${flag} requires a value.`);
			}
			out[valueFlags[flag]] = value;
		} else {
			throw new Error(`Unknown argument: ${flag}`);
		}
	}
	if (!["auto", "red", "green"].includes(out.phase)) {
		throw new Error(`--phase must be one of auto|red|green, got "${out.phase}".`);
	}
	return out;
}

/**
 * validateStations — input file content -> [{role, agentName, instanceId}].
 * Rejects: non-array, bad role, duplicate agentName, excluded role, and an
 * instanceId that is not a non-empty string.  instanceId defaults to
 * `{role}-vps` (the fleet convention) when omitted.
 */
export function validateStations(json) {
	if (!Array.isArray(json) || json.length === 0) {
		throw new Error("Stations file must be a non-empty JSON array of {role, instanceId}.");
	}
	const seen = new Set();
	return json.map((entry, idx) => {
		if (entry === null || typeof entry !== "object") {
			throw new Error(`Station #${idx} is not an object.`);
		}
		const role = normalizeRole(entry.role);
		if (!ROLE_RE.test(role)) {
			throw new Error(`Station #${idx}: role "${entry.role}" is not a valid agent name (^[a-z][a-z0-9-]*$).`);
		}
		if (EXCLUDED_ROLES.includes(role)) {
			throw new Error(`Station #${idx}: role "${role}" is excluded by the roster (Marie / Iris RH BU). Refusing.`);
		}
		const agentName = normalizeRole(entry.agentName ?? role);
		if (!ROLE_RE.test(agentName) || EXCLUDED_ROLES.includes(agentName)) {
			throw new Error(`Station #${idx}: agentName "${entry.agentName}" is invalid or excluded.`);
		}
		if (seen.has(agentName)) {
			throw new Error(`Station #${idx}: duplicate agentName "${agentName}".`);
		}
		seen.add(agentName);
		const instanceId = entry.instanceId === undefined ? `${role}-vps` : entry.instanceId;
		if (typeof instanceId !== "string" || instanceId.trim() === "") {
			throw new Error(`Station #${idx}: instanceId must be a non-empty string.`);
		}
		return { role, agentName, instanceId: instanceId.trim() };
	});
}

/**
 * decideStation — the idempotence decision, pure.
 *   agent:  the `agents` row or null           (convex agents:getAgent)
 *   status: { hasActiveCredential, activeRows } (agentCredentials:getAgentCredentialStatus)
 *
 * - no row                      -> register + mint
 * - active row, no credential   -> mint only      (registerAgent NOT called: it would patch description away)
 * - active row + credential     -> skip           (a mint would ROTATE and lock out the live holder)
 *                                   unless rotate=true -> mint (rotation is explicit)
 * - inactive row                -> blocked        (never revived by this tool)
 */
export function decideStation({ agent, status, rotate = false }) {
	if (!agent) return { register: true, mint: true, reason: "no agents row" };
	if (agent.isActive === false) {
		return { register: false, mint: false, blocked: true, reason: "agents row is inactive (AGENT_INACTIVE); use reactivateAgent deliberately" };
	}
	if (status?.hasActiveCredential) {
		return rotate
			? { register: false, mint: true, reason: "active credential exists; --rotate requested (previous secret stops working)" }
			: { register: false, mint: false, reason: "agents row and active credential already exist; nothing to do" };
	}
	return { register: false, mint: true, reason: "agents row exists without an active credential" };
}

/** Decode the org slug claim — same precedence as convex/lib/auth.ts withOrgScope. */
export function decodeJwtClaims(jwt) {
	const parts = String(jwt).split(".");
	if (parts.length < 2) throw new Error("Minted JWT is malformed (expected 3 dot-separated parts)");
	return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
}

export function orgSlugFromClaims(payload) {
	const orgSlug =
		payload.organizationSlug ?? payload.org_slug ?? payload.organizationId ?? payload.org_id ?? null;
	if (!orgSlug || typeof orgSlug !== "string") {
		throw new Error(
			"Minted JWT carries no org-slug claim (organizationSlug/org_slug/organizationId/org_id all absent) — the org-admin user must belong to the fleet org in Clerk.",
		);
	}
	return orgSlug;
}

/**
 * assertSecretPathOutsideRepo — the operator names where secrets go; refuse a
 * path inside the git work tree (a secret next to the code gets committed).
 */
export function assertSecretPathOutsideRepo(secretsDir, repoRoot) {
	const abs = resolve(secretsDir);
	// Compare REAL paths, so a symlink outside the repo that points into it is
	// still inside; and test the first SEGMENT, so "repo/..secrets" (a name that
	// merely starts with "..") is inside.
	const rel = relative(realpathOfNearestExisting(resolve(repoRoot)), realpathOfNearestExisting(abs));
	const inside = rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
	if (inside) {
		throw new Error(`--secrets-dir ${abs} is inside the repository ${resolve(repoRoot)}. Name a path outside the work tree.`);
	}
	return abs;
}

/** realpath of the deepest existing ancestor, with the not-yet-created remainder re-appended. */
function realpathOfNearestExisting(p) {
	let head = p;
	const tail = [];
	while (!existsSync(head)) {
		const parent = dirname(head);
		if (parent === head) break;
		tail.unshift(basename(head));
		head = parent;
	}
	return join(existsSync(head) ? realpathSync(head) : head, ...tail);
}

/** The ONLY function that handles plaintext: writes it 0600 and returns the path. */
export function writeSecretFile(secretsDir, agentName, secret) {
	mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
	const path = join(secretsDir, `${agentName}.secret`);
	writeFileSync(path, `${secret}\n`, { encoding: "utf-8", mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

/** Secret file path for a station, without touching it. */
export function secretPathFor(secretsDir, agentName) {
	return join(secretsDir, `${agentName}.secret`);
}

export function secretFileExists(secretsDir, agentName) {
	return existsSync(secretPathFor(secretsDir, agentName));
}

/**
 * errorCode — the stable code token of a Convex refusal. ConvexError carries
 * its payload on `.data` (the message is the opaque "Server Error" in prod).
 */
export function errorCode(err) {
	const blob = `${typeof err?.data === "string" ? err.data : JSON.stringify(err?.data ?? "")} ${err?.message ?? err}`;
	const m = blob.match(/\b(AGENT_CREDENTIAL_REQUIRED|AGENT_IDENTITY_MISMATCH|ORG_MISMATCH|AGENT_NOT_FOUND|AGENT_INACTIVE|RBAC_DENIED|AUTH_REQUIRED|CALLER_IDENTITY_MISMATCH)\b/);
	const sub = blob.match(/reason":"([a-z-]+)"/);
	return m ? (sub ? `${m[1]}(${sub[1]})` : m[1]) : "UNCLASSIFIED";
}

