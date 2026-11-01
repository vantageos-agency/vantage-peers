/**
 * onboard-orchestrator.sh stores a new station's credential in the Infisical vault and installs
 * the vault relay; no plaintext secrets directory remains. Runs the real script as a child
 * process; bun is a stub on PATH so the dry run needs no Clerk or Convex access.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ONBOARD = join(REPO, "scripts", "onboard-orchestrator.sh");
const PUT = join(REPO, "scripts", "vault-put-agent-secret.py");
const HELPER =
	process.env.VP_VAULT_HELPER ?? "/opt/vantage-secrets/mcp_headers_vault.py";

let tmp;
let ws;
let bin;
let envFile;
let config;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "onboard-vault-"));
	ws = join(tmp, "ws");
	bin = join(tmp, "bin");
	mkdirSync(ws);
	mkdirSync(bin);
	writeFileSync(join(bin, "bun"), "#!/usr/bin/env bash\nexit 0\n");
	chmodSync(join(bin, "bun"), 0o755);
	envFile = join(tmp, "env");
	writeFileSync(
		envFile,
		"CLERK_SECRET_KEY_VANTAGE_PEERS=x\nCLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS=y\nCLERK_ORG_ID_VANTAGE_PEERS=org_stub1\nCLERK_DOMAIN=https://clerk.stub.test\n" +
			"INFISICAL_UNIVERSAL_AUTH_CLIENT_ID_TEST_SLUG=cid\nINFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET_TEST_SLUG=csecret\n",
	);
	config = join(tmp, "hosts.json");
	writeFileSync(
		config,
		JSON.stringify({
			project_id: "proj-1",
			api_base: "https://eu.infisical.com/api",
			environment: "prod",
			hosts: { testhost: { slug: "test-slug", env_file: envFile } },
		}),
	);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("onboard-orchestrator.sh --dry-run", () => {
	const run = () =>
		spawnSync("bash", [ONBOARD, "testrole", ws, "--dry-run"], {
			cwd: REPO,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				VP_ONBOARD_ENV_FILE: envFile,
				VP_INFISICAL_CONFIG: config,
				VP_ONBOARD_HOST: "testhost",
			},
		});

	it("names the vault path and key, prints the relay for the role, writes nothing", () => {
		const r = run();
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("/agent-secrets/test-slug");
		expect(r.stdout).toContain("TESTROLE_SECRET");
		expect(r.stdout).toContain("#!/usr/bin/env bash");
		expect(r.stdout).toContain(
			"exec python3 /opt/vantage-secrets/mcp_headers_vault.py --role testrole --config /opt/vantage-secrets/infisical-hosts.json",
		);
		expect(readdirSync(ws)).toEqual([]);
	});

	it("fails on one stderr line when the host is not in the vault config", () => {
		const r = spawnSync("bash", [ONBOARD, "testrole", ws, "--dry-run"], {
			cwd: REPO,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				VP_ONBOARD_ENV_FILE: envFile,
				VP_INFISICAL_CONFIG: config,
				VP_ONBOARD_HOST: "unknown-host",
			},
		});
		expect(r.status).not.toBe(0);
		expect(r.stderr.trim().split("\n")).toHaveLength(1);
		expect(r.stderr).toContain("unknown-host");
		expect(r.stdout).not.toContain("/agent-secrets/");
	});
});

describe("onboard-orchestrator.sh owner step (task k177034bdx6cqb82grpc862pw58hckgk)", () => {
	const OWNER_CMD =
		'npx convex run agents:setAgentOwner \'{"agentIds":["agent_x"],"ownerPersonId":"user_y","reason":"station testrole: onboarding"}\'';
	// bun stub: the dry run passes; the write run reports a live credential (SKIP) and the owner step
	// pending, exactly as mint-station-agents.mjs does (exit 3).
	const runWithMint = (mintExit, mintOut) => {
		const home = join(tmp, `home-${mintExit}`);
		const wsDir = join(tmp, `ws-${mintExit}`);
		mkdirSync(home, { recursive: true });
		mkdirSync(wsDir, { recursive: true });
		writeFileSync(join(home, ".claude.json"), "{}");
		const b = join(tmp, `bin-${mintExit}`);
		mkdirSync(b, { recursive: true });
		writeFileSync(
			join(b, "bun"),
			`#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = "--dry-run" ] && exit 0; done\ncat <<'EOF'\n${mintOut}\nEOF\nexit ${mintExit}\n`,
		);
		chmodSync(join(b, "bun"), 0o755);
		return spawnSync("bash", [ONBOARD, "testrole", wsDir], {
			cwd: REPO,
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				PATH: `${b}:${process.env.PATH}`,
				VP_ONBOARD_ENV_FILE: envFile,
				VP_INFISICAL_CONFIG: config,
				VP_ONBOARD_HOST: "testhost",
				VP_ONBOARD_SHM: tmp,
			},
		});
	};
	const planSkip =
		'[mint-stations]   SKIP          agent="testrole" instanceId="testrole-vps" row=agent_x activeCredentialRows=1';

	it("exits 3 and repeats that the owner step is pending, with the command, when the mint reports it", () => {
		const r = runWithMint(
			3,
			`${planSkip}\nOWNER_STEP_REQUIRED: testrole has no owner\n  ${OWNER_CMD}`,
		);
		expect(r.status, r.stdout + r.stderr).toBe(3);
		expect(r.stdout).toContain("OWNER_STEP_REQUIRED");
		expect(r.stdout).toContain(OWNER_CMD);
		expect(r.stdout).toContain("OWNER_STEP_PENDING");
		expect(r.stdout).not.toContain("OK: testrole onboarded");
	});

	it("a mint failure (any other non-zero) is a failure, not a pending step", () => {
		const r = runWithMint(1, "boom");
		expect(r.status).toBe(1);
		expect(r.stdout).not.toContain("OWNER_STEP_PENDING");
	});
});

describe("onboard-orchestrator.sh source", () => {
	it("no longer references the plaintext secrets directory", () => {
		expect(readFileSync(ONBOARD, "utf8")).not.toContain(
			".vantage-agent-secrets",
		);
	});
});

describe("vault-put-agent-secret.py against a local vault double", () => {
	const hasHelper = existsSync(HELPER);
	// The shared helper lives on the hosts at /opt/vantage-secrets, outside this repository
	// (improve-the-shared-part: it is imported, never copied). Where it is absent the write path
	// cannot load it, so this case is skipped by name; the three cases above never need it.
	it.skipIf(!hasHelper)(
		"creates then updates the key and verifies by readback, printing no value",
		async () => {
			const store = new Map();
			const seen = [];
			const server = createServer((req, res) => {
				let body = "";
				req.on("data", (c) => {
					body += c;
				});
				req.on("end", () => {
					const url = new URL(req.url, "http://x");
					seen.push(`${req.method} ${url.pathname}`);
					res.setHeader("content-type", "application/json");
					if (url.pathname === "/v1/auth/universal-auth/login") {
						return res.end(JSON.stringify({ accessToken: "tok" }));
					}
					const key = url.pathname.split("/").pop();
					if (req.method === "GET") {
						if (!store.has(key)) {
							res.statusCode = 404;
							return res.end("{}");
						}
						return res.end(
							JSON.stringify({ secret: { secretValue: store.get(key) } }),
						);
					}
					store.set(key, JSON.parse(body).secretValue);
					return res.end("{}");
				});
			});
			await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
			const base = `http://127.0.0.1:${server.address().port}`;
			const secretFile = join(tmp, "s.secret");
			const go = () =>
				new Promise((done) => {
					const p = spawn(
						"python3",
						[
							PUT,
							"--role",
							"testrole",
							"--secret-file",
							secretFile,
							"--config",
							config,
							"--host",
							"testhost",
						],
						{ env: { ...process.env, INFISICAL_API_BASE: base } },
					);
					let out = "";
					p.stdout.on("data", (c) => {
						out += c;
					});
					p.stderr.on("data", (c) => {
						out += c;
					});
					p.on("close", (code) => done({ code, out }));
				});
			writeFileSync(secretFile, "vpagent_first\n");
			const first = await go();
			writeFileSync(secretFile, "vpagent_second\n");
			const second = await go();
			server.close();
			expect(first.code, first.out).toBe(0);
			expect(second.code, second.out).toBe(0);
			expect(store.get("TESTROLE_SECRET")).toBe("vpagent_second");
			expect(seen).toContain("POST /v3/secrets/raw/TESTROLE_SECRET");
			expect(seen).toContain("PATCH /v3/secrets/raw/TESTROLE_SECRET");
			expect(first.out + second.out).not.toContain("vpagent_");
		},
	);
});
