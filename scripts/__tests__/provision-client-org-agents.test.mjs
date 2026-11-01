import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertTokenOrg, ownerStepCommand } from "../lib/org-admin-token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "provision-client-org-agents.mjs");
const PRELOAD = join(here, "fixtures", "stub-network.mjs");
const REQUESTED = "org_requested111";
const OTHER = "org_active_last222";

const made = [];
afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Runs the REAL script under bun with fetch replaced by the preload: no Clerk, no Convex.
function run(adminOrg, nativeOrg = adminOrg, extraEnv = {}) {
	const dir = mkdtempSync(join(tmpdir(), "prov-test-"));
	made.push(dir);
	const logFile = join(dir, "requests.jsonl");
	const r = spawnSync(
		"bun",
		[
			"--preload",
			PRELOAD,
			SCRIPT,
			"--org",
			"probe-tenant-a",
			"--clerk-org-id",
			REQUESTED,
			"--agents",
			"probe-a",
			"--stage-dir",
			join(dir, "stage"),
		],
		{
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				HOME: dir,
				CONVEX_URL: "https://stub.convex.cloud",
				CLERK_SECRET_KEY: "sk_test_stub",
				CLERK_DOMAIN: "https://clerk.stub.test",
				CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS: "user_svc",
				CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS: "user_admin1",
				STUB_LOG: logFile,
				STUB_ADMIN_ORG: adminOrg,
				STUB_NATIVE_ORG: nativeOrg,
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

describe("provision-client-org-agents: the org-admin token is for the requested org", () => {
	it("token org_id != requested org: exits non-zero naming both ids, zero Convex calls", () => {
		const r = run(OTHER);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(REQUESTED);
		expect(r.stderr).toContain(OTHER);
		expect(r.convex.map((c) => c.path)).toEqual([]);
		expect(r.calls.filter((c) => c.kind === "UNSTUBBED")).toEqual([]);
	});

	it("native token for the requested org but the convex TEMPLATE token for another: exit 1, ORG_MISMATCH, zero registry requests", () => {
		const r = run(OTHER, REQUESTED);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("ORG_MISMATCH");
		expect(r.stderr).toContain('"convex" template token');
		expect(r.stderr).toContain(REQUESTED);
		expect(r.stderr).toContain(OTHER);
		expect(r.convex).toEqual([]);
		expect(r.calls.filter((c) => c.kind === "UNSTUBBED")).toEqual([]);
	});

	it("CLERK_DOMAIN unset: exit 1 naming it, zero registry requests", () => {
		const r = run(REQUESTED, REQUESTED, { CLERK_DOMAIN: "" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("CLERK_DOMAIN");
		expect(r.convex).toEqual([]);
	});

	it("matching org: registers with a token carrying that org, then prints the owner step", () => {
		const r = run(REQUESTED);
		expect(r.stderr).not.toContain("ORG_MISMATCH");
		expect(r.status).toBe(0);
		expect(r.calls.filter((c) => c.kind === "UNSTUBBED")).toEqual([]);
		const reg = r.convex.find((c) => c.path === "agents:registerAgent");
		expect(reg).toBeDefined();
		const claims = JSON.parse(
			Buffer.from(
				reg.authJwt.replace("Bearer ", "").split(".")[1],
				"base64url",
			).toString(),
		);
		expect(claims.org_id).toBe(REQUESTED);
		expect(r.stdout).toContain("OWNER_STEP_REQUIRED");
		expect(r.stdout).toContain("agents:setAgentOwner");
		expect(r.stdout).toContain('"agentIds":["agent_stub_1"]');
		expect(r.stdout).toContain('"ownerPersonId":"user_admin1"');
		expect(r.stdout).not.toContain("stub-secret-value");
	});

	it("the template token is requested after the org was made active", () => {
		const r = run(REQUESTED);
		const kinds = r.calls.map((c) => c.kind + (c.template ? ":template" : ""));
		expect(kinds.indexOf("clerk-touch")).toBeGreaterThan(-1);
		expect(kinds.indexOf("clerk-session-token:template")).toBeGreaterThan(
			kinds.indexOf("clerk-touch"),
		);
		expect(r.calls.find((c) => c.kind === "clerk-touch").body).toContain(
			`active_organization_id=${REQUESTED}`,
		);
	});
});

describe("provision-client-org-agents: the service-account client authenticates with the convex template", () => {
	const claimsOf = (c) =>
		JSON.parse(
			Buffer.from(
				c.authJwt.replace("Bearer ", "").split(".")[1],
				"base64url",
			).toString(),
		);
	it("every service-account Convex call carries a token with aud convex (NoAuthProvider otherwise)", () => {
		const r = run(REQUESTED);
		expect(r.status).toBe(0);
		const svcCall = r.convex.find(
			(c) => c.path === "clientOrgMapping:getByClerkSlug",
		);
		expect(svcCall).toBeDefined();
		expect(claimsOf(svcCall).aud).toBe("convex");
	});
	it("no Convex call in the run is made with a native (aud-less) token", () => {
		const r = run(REQUESTED);
		expect(r.convex.length).toBeGreaterThan(0);
		for (const c of r.convex) expect(claimsOf(c).aud).toBe("convex");
	});
});

describe("org-admin-token helpers", () => {
	const jwt = (orgId) =>
		`h.${Buffer.from(JSON.stringify({ org_id: orgId })).toString("base64url")}.s`;
	it("assertTokenOrg passes on equal and throws naming both ids otherwise", () => {
		expect(() => assertTokenOrg(jwt("org_a"), "org_a")).not.toThrow();
		expect(() => assertTokenOrg(jwt("org_b"), "org_a")).toThrow(/org_b.*org_a/);
		expect(() => assertTokenOrg(jwt(undefined), "org_a")).toThrow(
			/\(none\).*org_a/,
		);
	});
	it("ownerStepCommand carries ids and no secret", () => {
		const c = ownerStepCommand({
			agentIds: ["a1"],
			ownerPersonId: "user_x",
			org: "acme",
		});
		expect(c).toContain("agents:setAgentOwner");
		expect(c).toContain('"agentIds":["a1"]');
	});
});
