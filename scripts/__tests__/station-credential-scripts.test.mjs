/**
 * Station onboarding scripts against PROD Clerk/Convex rules (task k177034bdx6cqb82grpc862pw58hckgk):
 * every Convex client carries a "convex"-template token (aud convex, else NoAuthProvider), the
 * org-admin token is minted for OUR org explicitly (not the shared admin user's last-active org),
 * and the Clerk frontend domain is required (no dev fallback). The REAL scripts run under bun with
 * fetch replaced by the stub preload: no Clerk, no Convex.
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const MINT = join(here, "..", "mint-station-agents.mjs");
const ADD_MAPPING = join(here, "..", "add-repo-mapping.mjs");
const PRELOAD = join(here, "fixtures", "stub-network.mjs");
const OUR_ORG = "org_ourperello111";
const OTHER_ORG = "org_cgtalsachimie222";

const made = [];
afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function exec(script, args, extraEnv = {}) {
	const dir = mkdtempSync(join(tmpdir(), "station-cred-test-"));
	made.push(dir);
	const logFile = join(dir, "requests.jsonl");
	const stations = join(dir, "stations.json");
	writeFileSync(
		stations,
		JSON.stringify([{ role: "angelia", instanceId: "angelia-vps" }]),
	);
	const r = spawnSync(
		"bun",
		["--preload", PRELOAD, script, ...args(stations)],
		{
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				HOME: dir,
				CONVEX_URL: "https://stub.convex.cloud",
				CLERK_SECRET_KEY: "sk_test_stub",
				CLERK_DOMAIN: "https://clerk.stub.test",
				CLERK_ORG_ADMIN_USER_ID: "user_admin1",
				CLERK_ORG_ID: OUR_ORG,
				CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS: "user_svc",
				STUB_LOG: logFile,
				STUB_ADMIN_ORG: OUR_ORG,
				STUB_NATIVE_ORG: OUR_ORG,
				// the shared org-admin user last had ANOTHER org active (what Clerk hands a fresh ticket session)
				STUB_LAST_ACTIVE_ORG: OTHER_ORG,
				...extraEnv,
			},
		},
	);
	const calls = existsSync(logFile)
		? readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
	return { ...r, calls, convex: calls.filter((c) => c.kind === "convex") };
}

const mint = (extraEnv) =>
	exec(MINT, (st) => ["--stations", st, "--dry-run"], extraEnv);
const addMapping = (extraEnv) =>
	exec(
		ADD_MAPPING,
		() => ["acme/angelia-workspace", "angelia", "proj-x"],
		extraEnv,
	);
const claimsOf = (c) =>
	JSON.parse(
		Buffer.from(
			c.authJwt.replace("Bearer ", "").split(".")[1],
			"base64url",
		).toString(),
	);

describe("mint-station-agents: prod token rules", () => {
	it("(a) every Convex call carries a convex-template token (aud convex)", () => {
		const r = mint();
		expect(r.status, r.stderr).toBe(0);
		expect(r.convex.length).toBeGreaterThan(0);
		for (const c of r.convex) expect(claimsOf(c).aud).toBe("convex");
	});

	it("(b) the token names OUR org even though the user's last-active org is another", () => {
		const r = mint();
		expect(r.status, r.stderr).toBe(0);
		expect(r.calls.find((c) => c.kind === "clerk-touch")?.body).toContain(
			OUR_ORG,
		);
		for (const c of r.convex) expect(claimsOf(c).org_id).toBe(OUR_ORG);
	});

	it("(b) an org claim that is not ours refuses before any Convex call", () => {
		const r = mint({ STUB_LAST_ACTIVE_ORG: "", STUB_ADMIN_ORG: OTHER_ORG });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("ORG_MISMATCH");
		expect(r.stderr).toContain(OUR_ORG);
		expect(r.stderr).toContain(OTHER_ORG);
		expect(r.convex).toEqual([]);
	});

	it("(b) our org id missing from the environment refuses", () => {
		const r = mint({ CLERK_ORG_ID: "" });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("CLERK_ORG_ID");
		expect(r.convex).toEqual([]);
	});

	it("(c) CLERK_DOMAIN missing refuses: no dev-instance fallback, no Clerk request", () => {
		const r = mint({ CLERK_DOMAIN: "" });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("CLERK_DOMAIN");
		expect(r.calls).toEqual([]);
	});
});

const mintWrite = (extraEnv) =>
	exec(
		MINT,
		(st) => ["--stations", st, "--secrets-dir", join(dirname(st), "secrets")],
		extraEnv,
	);
const EXISTING = (ownerPersonId) =>
	JSON.stringify([
		{
			_id: "agent_existing_1",
			name: "angelia",
			isActive: true,
			...(ownerPersonId ? { ownerPersonId } : {}),
		},
	]);

describe("mint-station-agents: owner step (agents:setAgentOwner is internal, no JWT can call it)", () => {
	it("a newly registered agent ends with OWNER_STEP_REQUIRED, the exact command, and exit 3", () => {
		const r = mintWrite();
		expect(r.status, r.stderr).toBe(3);
		expect(r.stdout).toContain("OWNER_STEP_REQUIRED");
		const cmd = r.stdout
			.split("\n")
			.find((l) => l.includes("agents:setAgentOwner"));
		expect(cmd).toBeDefined();
		expect(cmd).toContain("npx convex run agents:setAgentOwner");
		expect(cmd).toContain("agent_stub_1");
		expect(cmd).toContain("user_admin1");
		expect(cmd).toContain("angelia");
		expect(r.stdout + r.stderr).not.toContain("stub-secret-value");
		// the owner step is printed, never executed: no Convex call names the internal mutation
		expect(r.convex.map((c) => c.path)).not.toContain("agents:setAgentOwner");
	});

	it("an existing agent with a live credential and no owner still gets the step (the fab1 angelia case)", () => {
		const r = mintWrite({ STUB_AGENTS: EXISTING() });
		expect(r.status, r.stderr).toBe(3);
		expect(r.stdout).toContain("OWNER_STEP_REQUIRED");
		expect(r.stdout).toContain("agent_existing_1");
		expect(r.convex.map((c) => c.path)).not.toContain(
			"agentCredentials:mintAgentCredential",
		);
	});

	it("an agent that already has an owner is skipped: no step, exit 0", () => {
		const r = mintWrite({
			STUB_AGENTS: EXISTING("user_admin1"),
			STUB_DIRECTORY: ON_ROSTER("agent_existing_1"),
		});
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).not.toContain("OWNER_STEP_REQUIRED");
		expect(r.stdout).toContain("owner already set");
	});

	it("a dry run never exits 3 and prints no owner command", () => {
		const r = mint();
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).not.toContain("agents:setAgentOwner");
	});
});

const ON_ROSTER = (agentId) => JSON.stringify([{ name: "angelia", agentId }]);

describe("mint-station-agents: operator roster step (clientOrgMapping:addOperatorRosterMember is internal)", () => {
	const rosterLine = (r) =>
		r.stdout.split("\n").find((l) => l.includes("addOperatorRosterMember"));

	it("an owned agent that is not on the roster ends with ROSTER_STEP_REQUIRED, the exact command, and exit 3", () => {
		const r = mintWrite({ STUB_AGENTS: EXISTING("user_admin1") });
		expect(r.status, r.stderr).toBe(3);
		expect(r.stdout).toContain("ROSTER_STEP_REQUIRED");
		expect(r.stdout).not.toContain("OWNER_STEP_REQUIRED");
		const cmd = rosterLine(r);
		expect(cmd).toBeDefined();
		expect(cmd).toContain(
			"npx convex run clientOrgMapping:addOperatorRosterMember",
		);
		expect(cmd).toContain('{"agentId":"agent_existing_1"}');
		// printed, never executed
		expect(r.convex.map((c) => c.path)).not.toContain(
			"clientOrgMapping:addOperatorRosterMember",
		);
		expect(r.convex.map((c) => c.path)).toContain(
			"orgRoster:getMyAgentDirectory",
		);
	});

	it("a newly registered agent gets both steps, one command each, exit 3", () => {
		const r = mintWrite();
		expect(r.status, r.stderr).toBe(3);
		expect(r.stdout).toContain("OWNER_STEP_REQUIRED");
		expect(r.stdout).toContain("ROSTER_STEP_REQUIRED");
		expect(rosterLine(r)).toContain('{"agentId":"agent_stub_1"}');
	});

	it("an agent already on the roster is skipped: no step, exit 0", () => {
		const r = mintWrite({
			STUB_AGENTS: EXISTING("user_admin1"),
			STUB_DIRECTORY: ON_ROSTER("agent_existing_1"),
		});
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).not.toContain("ROSTER_STEP_REQUIRED");
		expect(r.stdout).toContain("already on the operator roster");
	});

	it("a directory entry for ANOTHER agent id does not count (a label is not an identity)", () => {
		const r = mintWrite({
			STUB_AGENTS: EXISTING("user_admin1"),
			STUB_DIRECTORY: ON_ROSTER("agent_someone_else"),
		});
		expect(r.status, r.stderr).toBe(3);
		expect(r.stdout).toContain("ROSTER_STEP_REQUIRED");
	});

	it("a dry run reads nothing of the roster and prints no roster command", () => {
		const r = mint();
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).not.toContain("addOperatorRosterMember");
		expect(r.convex.map((c) => c.path)).not.toContain(
			"orgRoster:getMyAgentDirectory",
		);
	});
});

describe("add-repo-mapping: prod token rules", () => {
	it("(a) every Convex call carries a convex-template token (aud convex)", () => {
		const r = addMapping();
		expect(r.status, r.stderr).toBe(0);
		expect(r.convex.map((c) => c.path)).toEqual([
			"githubRepoMapping:add",
			"githubRepoMapping:getByRepo",
		]);
		for (const c of r.convex) expect(claimsOf(c).aud).toBe("convex");
	});

	it("(c) CLERK_DOMAIN missing refuses: no dev-instance fallback, no Clerk request", () => {
		const r = addMapping({ CLERK_DOMAIN: "" });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("CLERK_DOMAIN");
		expect(r.calls).toEqual([]);
	});
});
