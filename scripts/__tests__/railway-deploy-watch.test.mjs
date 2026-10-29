import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildReport,
	classifyDeployment,
	compareCommits,
	runWatch,
} from "../railway-deploy-watch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "../railway-deploy-watch.mjs");

const SHA_A = "aaaaaaa1111111111111111111111111111111aa";
const SHA_B = "bbbbbbb2222222222222222222222222222222bb";
const TOKEN = "tok-secret-do-not-print";

// Fictive fleet: seven services, none of them a real one.
function fleet({ failed = [], healthCommit = {}, noDomain = [] } = {}) {
	return Array.from({ length: 7 }, (_, i) => {
		const name = `svc-fictive-${i + 1}`;
		const isFailed = failed.includes(name);
		return {
			name,
			status: isFailed ? "FAILED" : "SUCCESS",
			createdAt: isFailed
				? "2026-06-27T08:00:00.000Z"
				: "2026-10-20T08:00:00.000Z",
			commit: isFailed ? SHA_B : SHA_A,
			domains: noDomain.includes(name) ? [] : [`${name}.example.test`],
			// A failed service answers with no commit, so only the classifier can
			// turn it red (the SHA check must not mask a classifier mutant).
			health:
				name in healthCommit
					? healthCommit[name]
					: isFailed
						? { status: "ok" }
						: { commit: SHA_A },
		};
	});
}

function projectsPayload(services) {
	return {
		data: {
			projects: {
				edges: [
					{
						node: {
							id: "p1",
							name: "proj-fictive",
							services: {
								edges: services.map((s) => ({
									node: {
										id: `id-${s.name}`,
										name: s.name,
										serviceInstances: {
											edges: [
												{
													node: {
														latestDeployment: s.status
															? {
																	id: `dep-${s.name}`,
																	status: s.status,
																	createdAt: s.createdAt,
																	meta: { commitHash: s.commit },
																}
															: null,
														domains: {
															serviceDomains: s.domains.map((d) => ({
																domain: d,
															})),
															customDomains: [],
														},
													},
												},
											],
										},
									},
								})),
							},
						},
					},
				],
			},
		},
	};
}

function stubFetch(services, opts = {}) {
	const calls = [];
	const fn = async (url, init = {}) => {
		calls.push({ url: String(url), init });
		const u = String(url);
		if (u.includes("backboard.railway.com")) {
			if (opts.apiStatus && opts.apiStatus !== 200) {
				return new Response(JSON.stringify({ error: "nope" }), {
					status: opts.apiStatus,
				});
			}
			if (opts.apiBody !== undefined) {
				return new Response(
					typeof opts.apiBody === "string"
						? opts.apiBody
						: JSON.stringify(opts.apiBody),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify(projectsPayload(services)), {
				status: 200,
			});
		}
		const host = new URL(u).hostname;
		const svc = services.find((s) => s.domains.includes(host));
		if (!svc || svc.health === "unreachable") throw new Error("ECONNREFUSED");
		return new Response(JSON.stringify(svc.health), { status: 200 });
	};
	fn.calls = calls;
	return fn;
}

const env = { RAILWAY_API_TOKEN: TOKEN };

describe("MUST_BLOCK — failed latest deployments", () => {
	it("two of seven FAILED -> exit 1, both named with status, date and SHA", async () => {
		const svcs = fleet({ failed: ["svc-fictive-2", "svc-fictive-5"] });
		const r = await runWatch({ env, fetchImpl: stubFetch(svcs) });
		expect(r.exitCode).toBe(1);
		const lines = r.report.split("\n");
		for (const n of ["svc-fictive-2", "svc-fictive-5"]) {
			const line = lines.find((l) => l.includes(n) && l.includes("RED"));
			expect(line).toBeTruthy();
			expect(line).toContain("FAILED");
			expect(line).toContain("2026-06-27");
			expect(line).toContain(SHA_B);
		}
		expect(r.report).not.toContain(TOKEN);
	});
});

describe("MUST_PASS", () => {
	it("all SUCCESS and health commit equals latest success -> exit 0", async () => {
		const r = await runWatch({ env, fetchImpl: stubFetch(fleet()) });
		expect(r.exitCode).toBe(0);
		expect(r.report.split("\n").some((l) => l.startsWith("RED "))).toBe(false);
		expect(r.report).toContain("0 RED");
	});
});

describe("SHA divergence", () => {
	it("SUCCESS but health serves an older commit -> exit 1 naming both SHAs", async () => {
		const svcs = fleet({
			healthCommit: { "svc-fictive-3": { commit: SHA_B } },
		});
		const r = await runWatch({ env, fetchImpl: stubFetch(svcs) });
		expect(r.exitCode).toBe(1);
		const line = r.report
			.split("\n")
			.find((l) => l.includes("svc-fictive-3") && l.includes("RED"));
		expect(line).toContain(`serving ${SHA_B}`);
		expect(line).toContain(`last success ${SHA_A}`);
	});
});

describe("REFUSE — exit 2, never 0", () => {
	it("missing token", async () => {
		const f = stubFetch(fleet());
		const r = await runWatch({ env: {}, fetchImpl: f });
		expect(r.exitCode).toBe(2);
		expect(r.report).toMatch(/RAILWAY_API_TOKEN/);
		expect(f.calls.length).toBe(0);
	});
	it("API 401", async () => {
		const r = await runWatch({
			env,
			fetchImpl: stubFetch(fleet(), { apiStatus: 401 }),
		});
		expect(r.exitCode).toBe(2);
		expect(r.report).toMatch(/Railway GraphQL API/);
		expect(r.report).not.toContain(TOKEN);
	});
	it("GraphQL errors field", async () => {
		const r = await runWatch({
			env,
			fetchImpl: stubFetch(fleet(), {
				apiBody: { errors: [{ message: "Not Authorized" }] },
			}),
		});
		expect(r.exitCode).toBe(2);
	});
	it("zero services derived", async () => {
		const r = await runWatch({ env, fetchImpl: stubFetch([]) });
		expect(r.exitCode).toBe(2);
		expect(r.report).toMatch(/zero services/i);
	});
	it("unreadable shape", async () => {
		const r = await runWatch({
			env,
			fetchImpl: stubFetch(fleet(), { apiBody: { data: { projects: 42 } } }),
		});
		expect(r.exitCode).toBe(2);
		const r2 = await runWatch({
			env,
			fetchImpl: stubFetch(fleet(), { apiBody: "<html>not json</html>" }),
		});
		expect(r2.exitCode).toBe(2);
	});
	it("network failure on the API", async () => {
		const r = await runWatch({
			env,
			fetchImpl: async () => {
				throw new Error("ENOTFOUND");
			},
		});
		expect(r.exitCode).toBe(2);
	});
});

describe("health without commit", () => {
	it("is listed 'not judged', run stays 0, summary counts it", async () => {
		const svcs = fleet({
			healthCommit: {
				"svc-fictive-1": { status: "ok" },
				"svc-fictive-4": { commit: "unknown" },
			},
		});
		const r = await runWatch({ env, fetchImpl: stubFetch(svcs) });
		expect(r.exitCode).toBe(0);
		expect(r.report).toMatch(
			/svc-fictive-1.*not judged: health exposes no commit/,
		);
		expect(r.report).toMatch(
			/svc-fictive-4.*not judged: health exposes no commit/,
		);
		expect(r.report).toMatch(/2 not judged/);
	});
	it("unreachable health is listed with the reason, not judged", async () => {
		const svcs = fleet({ healthCommit: { "svc-fictive-6": "unreachable" } });
		const r = await runWatch({ env, fetchImpl: stubFetch(svcs) });
		expect(r.exitCode).toBe(0);
		expect(r.report).toMatch(
			/svc-fictive-6.*not judged: health unreachable \(ECONNREFUSED\)/,
		);
	});
});

describe("notify (dependency injection)", () => {
	it("calls notify on exit 1 and exit 2 with --notify, not on exit 0", async () => {
		const sent = [];
		const notify = async (body) => sent.push(body);
		await runWatch({
			env,
			fetchImpl: stubFetch(fleet()),
			notify,
			notifyEnabled: true,
		});
		expect(sent.length).toBe(0);
		await runWatch({
			env,
			fetchImpl: stubFetch(fleet({ failed: ["svc-fictive-1"] })),
			notify,
			notifyEnabled: true,
		});
		await runWatch({
			env: {},
			fetchImpl: stubFetch(fleet()),
			notify,
			notifyEnabled: true,
		});
		expect(sent.length).toBe(2);
		expect(sent[0]).toContain("svc-fictive-1");
	});
	it("does not call notify when the flag is off", async () => {
		const sent = [];
		await runWatch({
			env,
			fetchImpl: stubFetch(fleet({ failed: ["svc-fictive-1"] })),
			notify: async (b) => sent.push(b),
		});
		expect(sent.length).toBe(0);
	});
});

describe("pure functions", () => {
	it("classifyDeployment", () => {
		expect(classifyDeployment("SUCCESS")).toBe("GREEN");
		expect(classifyDeployment("FAILED")).toBe("RED");
		expect(classifyDeployment("CRASHED")).toBe("RED");
		expect(classifyDeployment("BUILDING")).toBe("NOT_JUDGED");
		expect(classifyDeployment(undefined)).toBe("NOT_JUDGED");
	});
	it("compareCommits", () => {
		expect(compareCommits(SHA_A, SHA_A)).toBe("same");
		expect(compareCommits(SHA_A.slice(0, 7), SHA_A)).toBe("same");
		expect(compareCommits(SHA_B, SHA_A)).toBe("different");
		expect(compareCommits("unknown", SHA_A)).toBe("not-comparable");
		expect(compareCommits(undefined, SHA_A)).toBe("not-comparable");
	});
	it("buildReport returns exit code and lines without IO", () => {
		const out = buildReport([
			{
				name: "x",
				verdict: "RED",
				status: "FAILED",
				createdAt: "2026-01-02T00:00:00Z",
				commit: SHA_A,
				reason: "",
			},
		]);
		expect(out.exitCode).toBe(1);
		expect(out.report).toContain("x");
	});
});

describe("source grep", () => {
	it("no hard-coded service names", () => {
		const src = readFileSync(SCRIPT, "utf8");
		const names = [
			"vantageos-crm",
			"vantage-peers",
			"vantage-radar",
			"vantage-registry-mcp",
			"vp-doc-forge-mcp",
			"doc-forge-renderer",
			"vantage-docling-worker",
		];
		const hits = names.filter((n) => src.includes(n));
		expect(hits).toEqual([]);
	});
});

describe("a run that judged nothing refuses to judge (exit 2), never green", () => {
	const allHealth = (h) =>
		Object.fromEntries(
			Array.from({ length: 7 }, (_, i) => [`svc-fictive-${i + 1}`, h]),
		);
	const cases = [
		["every /health unreachable", (s) => fleet({ healthCommit: allHealth("unreachable") })],
		["every deployment mid-flight", () => fleet().map((x, i) => ({ ...x, status: ["DEPLOYING", "QUEUED", "WAITING"][i % 3] }))],
		["every deployment REMOVED", () => fleet().map((x) => ({ ...x, status: "REMOVED" }))],
		["no health exposes a commit", () => fleet({ healthCommit: allHealth({ status: "ok" }) })],
	];
	for (const [label, build] of cases) {
		it(`${label} -> exit 2, reasons named, notify called`, async () => {
			const sent = [];
			const r = await runWatch({
				env,
				fetchImpl: stubFetch(build()),
				notify: async (b) => sent.push(b),
				notifyEnabled: true,
			});
			expect(r.exitCode).toBe(2);
			expect(r.report).toMatch(/REFUSING TO JUDGE/);
			expect(r.report).toMatch(/not judged:/);
			expect(sent).toHaveLength(1);
		});
	}
});
