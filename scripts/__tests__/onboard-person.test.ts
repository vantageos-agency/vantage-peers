// VantagePeers Cloud — task k178xp66h7p0ds6vg69sqzw2vn8hbfrw. The pure core of
// scripts/onboard-person.mjs: one command onboards one person. Network and Convex are
// injected, so every case below runs the real decision code against a recording fake.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM core with JSDoc, no declaration file
import { onboardPerson, parseAgents, parseArgs } from "../lib/onboard-person-core.mjs";

type Call = [string, Record<string, unknown>];

const BASE = {
	org: { slug: "acme-tenant", name: "Acme Tenant" },
	person: { name: "Pat Example", email: "Pat.Example@Client.Test" },
	agents: parseAgents("Milo:claude,Sacha:chatgpt,Esteban:chatgpt,Alma:grok"),
	lang: "fr",
	redirectUrl: "https://accounts.example.test/sign-up",
};

const EMPTY_STATE = { mapping: null, agents: [] };

function fake(opts: {
	state?: unknown;
	clerkOrg?: { id: string; slug: string } | null;
	invitation?: { id: string; url: string } | null;
}) {
	const calls: Call[] = [];
	const io = {
		clerk: {
			findOrg: async () => opts.clerkOrg ?? null,
			createOrg: async (a: Record<string, unknown>) => {
				calls.push(["clerk.createOrg", a]);
				return { id: "org_new123", slug: a.slug };
			},
			findPendingInvitation: async () => opts.invitation ?? null,
			createInvitation: async (orgId: string, body: Record<string, unknown>) => {
				calls.push(["clerk.createInvitation", { orgId, ...body }]);
				return { id: "orginv_1", url: "https://accounts.example.test/sign-up?__clerk_ticket=tkt" };
			},
		},
		convex: {
			run: async (fn: string, args: Record<string, unknown>) => {
				if (fn === "onboardPerson:readOrgState") return opts.state ?? EMPTY_STATE;
				calls.push([fn, args]);
				if (fn === "tenantOrgSeed:seedClientOrgMapping") return "mapping_1";
				if (fn === "clientOrgMapping:seedSeatAgents") {
					const names = args.names as string[];
					const keep = (args.agentIds as string[] | undefined) ?? [];
					return [...names.map((n) => `agent_${n}`), ...keep];
				}
				return {};
			},
		},
	};
	return { io, calls };
}

const names = (calls: Call[]) => calls.map(([n]) => n);

describe("parseAgents", () => {
	it("splits label and AI client", () => {
		expect(parseAgents("Milo:claude,Sacha:chatgpt")).toEqual([
			{ label: "Milo", client: "claude" },
			{ label: "Sacha", client: "chatgpt" },
		]);
	});
	it("refuses a duplicate label, however it is cased", () => {
		expect(() => parseAgents("Milo:claude,milo:grok")).toThrow(/unique/i);
	});
	it("refuses an entry with no client tag", () => {
		expect(() => parseAgents("Milo")).toThrow(/label:client/);
	});
});

describe("dry run (the default)", () => {
	it("reads, prints a plan and writes nothing", async () => {
		const { io, calls } = fake({});
		const out = await onboardPerson({ ...BASE, send: false }, io);
		expect(calls).toEqual([]);
		expect(out.mode).toBe("dry-run");
		expect(out.plan.length).toBeGreaterThan(5);
	});
});

describe("--send on a fresh person", () => {
	it("calls in the order: org, invitation, mapping, kind, clerkOrgId, seed, invites", async () => {
		const { io, calls } = fake({});
		await onboardPerson({ ...BASE, send: true }, io);
		expect(names(calls)).toEqual([
			"clerk.createOrg",
			"clerk.createInvitation",
			"tenantOrgSeed:seedClientOrgMapping",
			"clientOrgMapping:setOrgKind",
			"clientOrgMapping:setClerkOrgId",
			"clientOrgMapping:seedSeatAgents",
			"agents:recordPersonalAgentInvite",
			"agents:recordPersonalAgentInvite",
			"agents:recordPersonalAgentInvite",
			"agents:recordPersonalAgentInvite",
		]);
	});

	it("creates the org WITHOUT created_by (the operator does not join a client org)", async () => {
		const { io, calls } = fake({});
		await onboardPerson({ ...BASE, send: true }, io);
		const create = calls.find(([n]) => n === "clerk.createOrg")?.[1] ?? {};
		expect(create).toEqual({ name: "Acme Tenant", slug: "acme-tenant" });
		expect("created_by" in create).toBe(false);
	});

	it("invites as org:admin, without Clerk's email, with the redirect and the language", async () => {
		const { io, calls } = fake({});
		await onboardPerson({ ...BASE, send: true }, io);
		const inv = calls.find(([n]) => n === "clerk.createInvitation")?.[1] ?? {};
		expect(inv).toMatchObject({
			orgId: "org_new123",
			email_address: "pat.example@client.test",
			role: "org:admin",
			notify: false,
			redirect_url: "https://accounts.example.test/sign-up",
			public_metadata: { onboarding: { lang: "fr" } },
		});
	});

	it("sets the Clerk org id on the mapping BEFORE any agent exists, and seeds once with every name", async () => {
		const { io, calls } = fake({});
		await onboardPerson({ ...BASE, send: true }, io);
		const order = names(calls);
		expect(order.indexOf("clientOrgMapping:setClerkOrgId")).toBeLessThan(
			order.indexOf("clientOrgMapping:seedSeatAgents"),
		);
		expect(order.filter((n) => n === "clientOrgMapping:seedSeatAgents")).toHaveLength(1);
		const seed = calls.find(([n]) => n === "clientOrgMapping:seedSeatAgents")?.[1];
		expect(seed).toEqual({ mappingId: "mapping_1", names: ["Milo", "Sacha", "Esteban", "Alma"] });
		const mapping = calls.find(([n]) => n === "tenantOrgSeed:seedClientOrgMapping")?.[1];
		expect(mapping).toMatchObject({
			clerkOrgSlug: "acme-tenant",
			allowedOrchestrators: ["Milo", "Sacha", "Esteban", "Alma"],
			scopes: ["view-own-tasks", "view-own-missions"],
		});
		expect(calls.find(([n]) => n === "clientOrgMapping:setClerkOrgId")?.[1]).toEqual({
			clerkOrgSlug: "acme-tenant",
			clerkOrgId: "org_new123",
		});
		expect(calls.find(([n]) => n === "clientOrgMapping:setOrgKind")?.[1]).toEqual({
			clerkOrgSlug: "acme-tenant",
			orgKind: "client",
		});
	});

	it("records the invited email, language and AI client on each agent", async () => {
		const { io, calls } = fake({});
		await onboardPerson({ ...BASE, send: true }, io);
		const invites = calls.filter(([n]) => n === "agents:recordPersonalAgentInvite").map(([, a]) => a);
		expect(invites).toEqual([
			{ agentId: "agent_Milo", email: "pat.example@client.test", lang: "fr", aiClient: "claude" },
			{ agentId: "agent_Sacha", email: "pat.example@client.test", lang: "fr", aiClient: "chatgpt" },
			{ agentId: "agent_Esteban", email: "pat.example@client.test", lang: "fr", aiClient: "chatgpt" },
			{ agentId: "agent_Alma", email: "pat.example@client.test", lang: "fr", aiClient: "grok" },
		]);
	});

	it("RETURNS the invitation URL and every agent id", async () => {
		const { io } = fake({});
		const out = await onboardPerson({ ...BASE, send: true }, io);
		expect(out.result.invitationUrl).toBe("https://accounts.example.test/sign-up?__clerk_ticket=tkt");
		expect(out.result.agents.map((a: { id: string }) => a.id)).toEqual([
			"agent_Milo",
			"agent_Sacha",
			"agent_Esteban",
			"agent_Alma",
		]);
		expect(out.result.lang).toBe("fr");
	});

	it("records --lang en on the invitation and on the agents", async () => {
		const { io, calls } = fake({});
		const out = await onboardPerson({ ...BASE, lang: "en", send: true }, io);
		const inv = calls.find(([n]) => n === "clerk.createInvitation")?.[1] as { public_metadata: unknown };
		expect(inv.public_metadata).toEqual({ onboarding: { lang: "en" } });
		expect(out.result.lang).toBe("en");
	});
});

const DONE_STATE = {
	mapping: {
		id: "mapping_1",
		orgKind: "client",
		clerkOrgId: "org_new123",
		isActive: true,
		allowedAgentIds: ["agent_Milo", "agent_Sacha"],
		allowedOrchestrators: ["Milo", "Sacha"],
	},
	agents: [
		{ id: "agent_Milo", name: "Milo", isActive: true, personalAgentOf: null, invite: { email: "pat.example@client.test" } },
		{ id: "agent_Sacha", name: "Sacha", isActive: true, personalAgentOf: null, invite: { email: "pat.example@client.test" } },
	],
};
const TWO = { ...BASE, agents: parseAgents("Milo:claude,Sacha:chatgpt") };
const EXISTING = {
	clerkOrg: { id: "org_new123", slug: "acme-tenant" },
	invitation: { id: "orginv_1", url: "https://accounts.example.test/sign-up?__clerk_ticket=old" },
};

describe("idempotent re-run", () => {
	it("changes nothing and reports the existing ids and the pending invitation URL", async () => {
		const { io, calls } = fake({ state: DONE_STATE, ...EXISTING });
		const out = await onboardPerson({ ...TWO, send: true }, io);
		expect(calls).toEqual([]);
		expect(out.result.invitationUrl).toBe("https://accounts.example.test/sign-up?__clerk_ticket=old");
		expect(out.result.agents).toEqual([
			expect.objectContaining({ label: "Milo", id: "agent_Milo", created: false }),
			expect.objectContaining({ label: "Sacha", id: "agent_Sacha", created: false }),
		]);
	});

	it("adding an agent later keeps every existing id (F14) and then appends the label roster", async () => {
		const { io, calls } = fake({ state: DONE_STATE, ...EXISTING });
		const out = await onboardPerson({ ...BASE, agents: parseAgents("Milo:claude,Sacha:chatgpt,Alma:grok"), send: true }, io);
		expect(names(calls)).toEqual([
			"clientOrgMapping:seedSeatAgents",
			"tenantOrgSeed:setOrgRoster",
			"agents:recordPersonalAgentInvite",
		]);
		expect(calls[0][1]).toEqual({
			mappingId: "mapping_1",
			names: ["Alma"],
			agentIds: ["agent_Milo", "agent_Sacha"],
		});
		// exact stored label appended, existing entries kept; addRosterMembers (normalised) is never used
		expect(calls[1][1]).toEqual({ clerkOrgSlug: "acme-tenant", allowedOrchestrators: ["Milo", "Sacha", "Alma"] });
		expect(out.result.reconnectNeeded).toBe(true);
		expect(out.result.agents.find((a: { label: string }) => a.label === "Alma").created).toBe(true);
	});

	it("the label roster equals the agents' stored names exactly, never a normalised copy", async () => {
		const { io, calls } = fake({});
		await onboardPerson({ ...BASE, send: true }, io);
		const seeded = calls.find(([n]) => n === "tenantOrgSeed:seedClientOrgMapping")?.[1] as { allowedOrchestrators: string[] };
		const created = (calls.find(([n]) => n === "clientOrgMapping:seedSeatAgents")?.[1] as { names: string[] }).names;
		expect(seeded.allowedOrchestrators).toEqual(created);
		expect(names(calls)).not.toContain("clientOrgMapping:addRosterMembers");
	});

	it("a first onboarding needs no reconnect", async () => {
		const { io } = fake({});
		expect((await onboardPerson({ ...BASE, send: true }, io)).result.reconnectNeeded).toBe(false);
	});

	it("an already-bound agent is not given an invite again", async () => {
		const state = {
			...DONE_STATE,
			agents: [{ ...DONE_STATE.agents[0], personalAgentOf: "user_abc", invite: null }, DONE_STATE.agents[1]],
		};
		const { io, calls } = fake({ state, ...EXISTING });
		await onboardPerson({ ...TWO, send: true }, io);
		expect(calls).toEqual([]);
	});
});

describe("refusals", () => {
	it("a legacy normalised roster entry is kept and the exact stored label is added beside it", async () => {
		const state = { ...DONE_STATE, mapping: { ...DONE_STATE.mapping, allowedOrchestrators: ["milo", "Sacha"] } };
		const { io, calls } = fake({ state, ...EXISTING });
		await onboardPerson({ ...TWO, send: true }, io);
		expect(calls).toEqual([["tenantOrgSeed:setOrgRoster", { clerkOrgSlug: "acme-tenant", allowedOrchestrators: ["milo", "Sacha", "Milo"] }]]);
	});

	it("aborts when an existing agent has no clerkOrgId", async () => {
		const state = { ...DONE_STATE, agents: [{ ...DONE_STATE.agents[0], clerkOrgId: null }, DONE_STATE.agents[1]] };
		const { io, calls } = fake({ state, ...EXISTING });
		await expect(onboardPerson({ ...TWO, send: true }, io)).rejects.toThrow(/clerkOrgId/);
		expect(calls).toEqual([]);
	});

	it("aborts when the mapping already carries a DIFFERENT Clerk org id", async () => {
		const state = { ...DONE_STATE, mapping: { ...DONE_STATE.mapping, clerkOrgId: "org_other999" } };
		const { io, calls } = fake({ state, ...EXISTING });
		await expect(onboardPerson({ ...TWO, send: true }, io)).rejects.toThrow(/org_other999/);
		expect(calls).toEqual([]);
	});

	it("aborts when a requested label is held by an INACTIVE agent", async () => {
		const state = { ...DONE_STATE, agents: [{ ...DONE_STATE.agents[0], isActive: false }, DONE_STATE.agents[1]] };
		const { io, calls } = fake({ state, ...EXISTING });
		await expect(onboardPerson({ ...TWO, send: true }, io)).rejects.toThrow(/inactive/i);
		expect(calls).toEqual([]);
	});
});

describe("parseArgs", () => {
	const argv = [
		"--org-slug", "acme-tenant", "--org-name", "Acme Tenant",
		"--name", "Pat Example", "--email", "pat@client.test",
		"--agents", "Milo:claude", "--redirect-url", "https://accounts.example.test/sign-up",
	];
	it("defaults to a dry run in French", () => {
		const o = parseArgs(argv, {});
		expect(o.send).toBe(false);
		expect(o.lang).toBe("fr");
	});
	it("--send and --lang en", () => {
		const o = parseArgs([...argv, "--send", "--lang", "en"], {});
		expect(o.send).toBe(true);
		expect(o.lang).toBe("en");
	});
	it("refuses a language other than fr or en", () => {
		expect(() => parseArgs([...argv, "--lang", "de"], {})).toThrow(/fr|en/);
	});
	it("refuses a missing redirect URL (the invitation must land on a page that consumes the ticket)", () => {
		const without = argv.slice(0, -2);
		expect(() => parseArgs(without, {})).toThrow(/redirect/i);
	});
	it("derives the redirect from CLERK_DOMAIN when none is passed", () => {
		const without = argv.slice(0, -2);
		const o = parseArgs(without, { CLERK_DOMAIN: "https://clerk.example.test" });
		expect(o.redirectUrl).toBe("https://clerk.example.test/sign-up");
	});
	it("refuses a non-https redirect", () => {
		expect(() => parseArgs([...argv.slice(0, -1), "javascript:alert(1)"], {})).toThrow(/https/);
	});
});
