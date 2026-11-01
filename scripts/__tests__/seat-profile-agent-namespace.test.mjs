// Pi ruling (c) on #1652, task k1701vj2gxbacdjqr1avpxx7en8hdw2q: the update of EXISTING seat
// profiles is an operator script, not a Convex function. It reads through the prod guard
// (`convex-prod.sh run oauth:listScopeProfiles`, `data agents`, `data client_org_mapping`)
// and writes through it (`run oauth:upsertScopeProfile '<one JSON object>'`). Dry run by
// default, idempotent. Hermetic: the guard is a stub.
import { describe, expect, it } from "vitest";
import {
	agentIdFromWhoami,
	planSeatProfiles,
	seatOrchestratorNamespace,
} from "../lib/seat-profile-plan.mjs";
import { main } from "../seat-profile-agent-namespace.mjs";

const A = "sp-org-a";
const B = "sp-org-b";
const FLEET = "sp-fleet";
const id = (n) => `agents_${n}`;

const mappings = [
	{ clerkOrgSlug: FLEET, clerkOrgId: "org_fleet", isActive: true, orgKind: "operator" },
	{ clerkOrgSlug: A, clerkOrgId: "org_a", isActive: true, orgKind: "client" },
	{ clerkOrgSlug: B, clerkOrgId: "org_b", isActive: true, orgKind: "client" },
	{ clerkOrgSlug: "sp-off", clerkOrgId: "org_off", isActive: false, orgKind: "client" },
];
const agent = (_id, orgSlug, name, extra = {}) => ({
	_id,
	orgSlug,
	clerkOrgId: mappings.find((m) => m.clerkOrgSlug === orgSlug)?.clerkOrgId,
	name,
	isActive: true,
	...extra,
});
const agents = [
	agent(id("sigma"), FLEET, "sigma"),
	agent(id("aliceA"), A, "alice"),
	agent(id("carolA"), A, "carol"),
	agent(id("aliceB"), B, "alice"),
	agent(id("dupA1"), A, "dup"),
	agent(id("dupA2"), A, "Dup"),
	agent(id("goneA"), A, "gone", { isActive: false }),
];
const profile = (profileId, clerkOrgSlug, fromAllowList, extra = {}) => ({
	profileId,
	description: profileId,
	fromAllowList,
	namespaceReadPrefixes: [`orchestrator/${fromAllowList[0]}`, `project/${clerkOrgSlug}`],
	namespaceWritePrefixes: [`orchestrator/${fromAllowList[0]}`, `project/${clerkOrgSlug}`],
	...(clerkOrgSlug === undefined ? {} : { clerkOrgSlug }),
	...extra,
});
const profiles = () => [
	profile(`alice-${A}`, A, ["alice"]),
	profile(`alice-${B}`, B, ["alice"]),
	profile(`multi-${A}`, A, ["alice", "carol"]),
	profile(`wild-${A}`, A, ["*"]),
	profile(`ghost-${A}`, A, ["ghost"]),
	profile(`dup-${A}`, A, ["dup"]),
	profile(`gone-${A}`, A, ["gone"]),
	profile("sigma-fleet", FLEET, ["sigma"]),
	profile("unbound", undefined, ["alice"]),
	profile("off-org", "sp-off", ["alice"]),
];

describe("planSeatProfiles", () => {
	it("selects a client-org profile with one non-* seat that is exactly one active agent of that org", () => {
		const plan = planSeatProfiles({ profiles: profiles(), agents, mappings });
		expect(plan.updates.map((u) => u.profile.profileId)).toEqual([`alice-${A}`, `alice-${B}`]);
		const a = plan.updates[0].profile;
		expect(a.namespaceReadPrefixes).toEqual(["orchestrator/alice", `project/${A}`, `orchestrator/${id("aliceA")}`]);
		expect(a.namespaceWritePrefixes).toContain(`orchestrator/${id("aliceA")}`);
		// the other org's same-named agent gives the other org's profile its OWN id
		expect(plan.updates[1].profile.namespaceWritePrefixes).toContain(`orchestrator/${id("aliceB")}`);
		expect(plan.updates[1].profile.namespaceWritePrefixes).not.toContain(`orchestrator/${id("aliceA")}`);
		expect(a.clerkOrgSlug).toBe(A);
	});

	it("skips and counts everything else, never guessing", () => {
		const plan = planSeatProfiles({ profiles: profiles(), agents, mappings });
		expect(plan.skipped).toMatchObject({
			notClientBound: 1,
			orgNotActive: 1,
			operatorOrg: 1,
			notExactlyOneSeat: 2,
			noAgentInOrg: 1,
			ambiguousAgent: 1,
			agentNotUsable: 1,
		});
		expect(plan.alreadyDone).toBe(0);
	});

	it("reports per org counts and at most 3 sample profile ids", () => {
		const plan = planSeatProfiles({ profiles: profiles(), agents, mappings });
		expect(plan.orgs).toEqual([
			{ slug: A, toUpdate: 1, sampleProfileIds: [`alice-${A}`] },
			{ slug: B, toUpdate: 1, sampleProfileIds: [`alice-${B}`] },
		]);
	});

	it("is idempotent: a profile that already lists the agent id is alreadyDone", () => {
		const first = planSeatProfiles({ profiles: profiles(), agents, mappings });
		const applied = profiles().map((p) => first.updates.find((u) => u.profile.profileId === p.profileId)?.profile ?? p);
		const again = planSeatProfiles({ profiles: applied, agents, mappings });
		expect(again.updates).toEqual([]);
		expect(again.alreadyDone).toBe(2);
	});

	it("helpers: the seat namespace is the agent id; whoami's agent_id is read, never the name", () => {
		expect(seatOrchestratorNamespace("abc")).toBe("orchestrator/abc");
		expect(agentIdFromWhoami(JSON.stringify({ agent_id: "k17x", fromAllowList: ["neo"] }))).toBe("k17x");
		expect(agentIdFromWhoami(JSON.stringify({ agent_id: null }))).toBeNull();
		expect(agentIdFromWhoami("not json")).toBeNull();
	});
});

// A stub of the guard: `convex-prod.sh run|data ...`, recording every call.
function stubGuard(state) {
	const calls = [];
	const exec = (args) => {
		calls.push(args);
		const [verb, target, ...rest] = args;
		if (verb === "run" && target === "oauth:listScopeProfiles") return JSON.stringify(state.profiles);
		if (verb === "run" && target === "oauth:upsertScopeProfile") {
			const { profile } = JSON.parse(rest[0]);
			state.profiles = state.profiles.map((p) => (p.profileId === profile.profileId ? profile : p));
			return JSON.stringify("updated");
		}
		if (verb === "data" && target === "agents") return JSON.stringify(state.agents);
		if (verb === "data" && target === "client_org_mapping") return JSON.stringify(state.mappings);
		throw new Error(`REFUSED: '${verb} ${target}' is not in the allow list`);
	};
	return { exec, calls };
}
const world = () => ({ profiles: profiles(), agents, mappings });
const capture = () => {
	const lines = [];
	return { out: (s) => lines.push(s), text: () => lines.join("\n") };
};

describe("seat-profile-agent-namespace main()", () => {
	it("DRY RUN is the default: prints per-org counts + sample ids and issues no write", async () => {
		const state = world();
		const { exec, calls } = stubGuard(state);
		const o = capture();
		const code = await main({ argv: [], exec, out: o.out });
		expect(code).toBe(0);
		expect(calls.some((c) => c[1] === "oauth:upsertScopeProfile")).toBe(false);
		expect(o.text()).toMatch(/DRY RUN/);
		expect(o.text()).toContain(`${A}: toUpdate=1 sample=alice-${A}`);
		expect(o.text()).toMatch(/skipped: .*ambiguousAgent=1/);
		expect(state.profiles.find((p) => p.profileId === `alice-${A}`).namespaceReadPrefixes.length).toBe(2);
	});

	it("--apply writes through the guard, one JSON object argument per profile, and a second run writes 0", async () => {
		const state = world();
		const { exec, calls } = stubGuard(state);
		const o = capture();
		expect(await main({ argv: ["--apply"], exec, out: o.out })).toBe(0);
		const writes = calls.filter((c) => c[0] === "run" && c[1] === "oauth:upsertScopeProfile");
		expect(writes.length).toBe(2);
		for (const w of writes) {
			expect(w.length).toBe(3); // run <fn> '<one JSON object>' and nothing else
			expect(w[2].startsWith("{")).toBe(true);
			expect(Object.keys(JSON.parse(w[2]))).toEqual(["profile"]);
		}
		const o2 = capture();
		expect(await main({ argv: ["--apply"], exec, out: o2.out })).toBe(0);
		expect(calls.filter((c) => c[1] === "oauth:upsertScopeProfile").length).toBe(2);
		expect(o2.text()).toMatch(/nothing to update/);
	});

	it("refuses a truncated read (rows == limit) instead of deciding from part of the table", async () => {
		const state = world();
		const { exec } = stubGuard(state);
		const o = capture();
		const code = await main({ argv: ["--agents-limit", String(agents.length)], exec, out: o.out });
		expect(code).toBe(2);
		expect(o.text()).toMatch(/truncated/);
	});

	it("a guard refusal is surfaced, not swallowed", async () => {
		const exec = () => {
			throw new Error("REFUSED: 'run oauth:listScopeProfiles' is not in the allow list");
		};
		const o = capture();
		const code = await main({ argv: [], exec, out: o.out });
		expect(code).toBe(2);
		expect(o.text()).toMatch(/REFUSED/);
	});
});
