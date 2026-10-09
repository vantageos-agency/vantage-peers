/**
 * R4 RED reproduction — MCP knowledge tools driven as a non-master OAuth SEAT of org-a. Origins: rows 14-24 of
 * audit/doors/defects-R4.jsonl (main @16f0907). The seat reaches Convex through the REAL registerTools handlers and the
 * REAL Convex functions (convex-test) as the fleet service account WITHOUT a claim, exactly as server-http.ts does for
 * an OAuth seat (no clerkJwt). Every test asserts the CORRECT behaviour: a FAIL means the audited defect is real.
 * Identity per test: seat org-a (isMaster false, clerkOrgSlug org-a, fromAllowList ['a1'] or ['eta']).
 */
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";
import schema from "../../../convex/schema";
import { packTarball } from "../../../convex/okfBundleNode";
import type { OAuthContext } from "../../src/auth.js";
import { registerTools } from "../../src/tools.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../../convex/**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill") &&
			!path.includes("__tests__") &&
			!path.endsWith(".test.ts"),
	),
);

const SA = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
type T = ReturnType<typeof convexTest<typeof schema>>;
type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;

function bridge(t: T) {
	const sa = t.withIdentity({ subject: SA });
	return {
		query: (n: string, a: Record<string, unknown>) =>
			sa.query(makeFunctionReference<"query">(n) as never, a as never),
		mutation: (n: string, a: Record<string, unknown>) =>
			sa.mutation(makeFunctionReference<"mutation">(n) as never, a as never),
		action: (n: string, a: Record<string, unknown>) =>
			sa.action(makeFunctionReference<"action">(n) as never, a as never),
	};
}

const seatCtx = (allow: string[]): OAuthContext => ({
	clientId: "seat-org-a",
	userId: "seat-org-a-user",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "seat",
	fromAllowList: allow,
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
	clerkOrgSlug: "org-a",
	// acting agent resolved from a per-agent credential (checkActorBinding), as the bearer boundary does
	actor: { orgSlug: "org-a", agentName: allow[0] },
});

let t: T;
let tools: Map<string, Tool>;

async function mount(allow: string[]) {
	t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		for (const org of ["org-a", "org-b"])
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				allowedOrchestrators: allow,
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: 1,
			});
	});
	tools = new Map();
	const server = {
		tool() {},
		registerTool: (n: string, _c: unknown, h: Tool) => {
			tools.set(n, h);
		},
	} as never;
	// biome-ignore lint/suspicious/noExplicitAny: test bridge
	registerTools(server, bridge(t) as any, seatCtx(allow));
}
const call = async (n: string, a: Record<string, unknown>) => {
	const h = tools.get(n);
	expect(h, n).toBeDefined();
	try {
		return (await h?.(a)) as ToolResult;
	} catch (e) {
		return { isError: true, content: [{ text: String(e) }] } as ToolResult;
	}
};
const memberA = () =>
	t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
		orgRole: "org:member",
	} as never);

const memory = (ns: string) =>
	t.run((ctx) =>
		ctx.db.insert("memories", {
			namespace: ns,
			type: "project",
			content: "m",
			createdBy: "x",
			relations: [],
			isLatest: true,
			createdAt: 1,
			updatedAt: 1,
		}),
	);

describe("store_memory — relatesTo target tenant (row 14)", () => {
	beforeEach(() => mount(["a1"]));
	it("mcp:store_memory — a seat of org-a cannot supersede a memory of team/org-b through relatesTo", async () => {
		const m = await memory("team/org-b");
		const r = await call("store_memory", {
			namespace: "team/org-a",
			type: "project",
			content: "x",
			createdBy: "a1",
			relatesTo: { targetId: m, type: "updates" },
		});
		const row = await t.run((ctx) => ctx.db.get(m));
		expect({ refused: r.isError === true, stillLatest: row?.isLatest }).toEqual({
			refused: true,
			stillLatest: true,
		});
	});
	it("mcp:store_memory — positive control: the seat's plain write to team/org-a is served", async () => {
		const r = await call("store_memory", {
			namespace: "team/org-a",
			type: "project",
			content: "x",
			createdBy: "a1",
		});
		expect(r.isError, r.content[0].text).toBeFalsy();
	});
});

describe("diary tools (rows 15, 16)", () => {
	beforeEach(() => mount(["eta"]));
	it("mcp:write_diary — an entry written by the org-a seat is readable by an org-a member (tenant stamped)", async () => {
		const w = await call("write_diary", {
			date: "2026-10-09",
			orchestrator: "eta",
			content: "x",
		});
		expect(w.isError, w.content[0].text).toBeFalsy();
		const row = await memberA().query(
			makeFunctionReference<"query">("diary:get") as never,
			{ date: "2026-10-09", orchestrator: "eta" } as never,
		);
		expect(row).not.toBeNull();
	});
	it("mcp:get_diary — a seat of org-a whose allowlist has 'eta' does not read org-b's diary entry for 'eta'", async () => {
		await t.run((ctx) =>
			ctx.db.insert("diary", {
				date: "2026-10-09",
				orchestrator: "eta",
				content: "org-b secret",
				createdBy: "eta",
				createdAt: 1,
				orgId: "org-b",
			}),
		);
		const r = await call("get_diary", { date: "2026-10-09", orchestrator: "eta" });
		expect(r.content[0].text).not.toContain("org-b secret");
	});
});

describe("get_diary control (row 16)", () => {
	beforeEach(() => mount(["eta"]));
	it("mcp:get_diary — positive control: the same seat reads an entry whose row it may see (unstamped fleet row, createdBy eta), so the read path is not vacuous", async () => {
		await t.run((ctx) =>
			ctx.db.insert("diary", {
				date: "2026-10-09",
				orchestrator: "eta",
				content: "visible row",
				createdBy: "eta",
				createdAt: 1,
			}),
		);
		const r = await call("get_diary", { date: "2026-10-09", orchestrator: "eta" });
		expect(r.content[0].text).toContain("visible row");
	});
});

describe("briefing note tools (rows 17-21)", () => {
	beforeEach(() => mount(["eta"]));
	const bNote = (o: Record<string, unknown>) =>
		t.run((ctx) =>
			ctx.db.insert("briefingNotes", {
				title: "org-b note",
				topic: "handoff",
				participants: ["eta"],
				content: "org-b secret content",
				createdBy: "eta",
				createdAt: 1,
				orgId: "org-b",
				...o,
			} as never),
		);
	it("mcp:create_briefing_note — a note created by the org-a seat is listed to an org-a member (tenant stamped)", async () => {
		const c = await call("create_briefing_note", {
			title: "t",
			topic: "handoff",
			participants: ["eta"],
			content: "c",
			createdBy: "eta",
		});
		expect(c.isError, c.content[0].text).toBeFalsy();
		const rows = (await memberA().query(
			makeFunctionReference<"query">("briefingNotes:list") as never,
			{} as never,
		)) as unknown;
		const items = Array.isArray(rows) ? rows : [];
		expect(items.length).toBe(1);
	});
	it("mcp:update_briefing_note — a seat of org-a cannot edit org-b's note by naming its creator", async () => {
		const id = await bNote({});
		await call("update_briefing_note", { noteId: id, callerOrchestrator: "eta", content: "pwned" });
		expect((await t.run((ctx) => ctx.db.get(id)))?.content).toBe("org-b secret content");
	});
	it("mcp:get_briefing_note — a seat of org-a does not read org-b's note on a participant-name collision", async () => {
		const id = await bNote({});
		const r = await call("get_briefing_note", { noteId: id });
		expect(r.content[0].text).not.toContain("org-b secret content");
	});
	it("mcp:list_briefing_notes — a seat of org-a does not list org-b's notes on a participant-name collision", async () => {
		await bNote({});
		const r = await call("list_briefing_notes", { fields: "full" });
		expect(r.content[0].text).not.toContain("org-b secret content");
	});
	it("mcp:search_briefing_notes_by_keyword — a seat of org-a does not find org-b's notes on a participant-name collision", async () => {
		await bNote({});
		const r = await call("search_briefing_notes_by_keyword", { query: "secret", fields: "full" });
		expect(r.content[0].text).not.toContain("org-b secret content");
	});
	it("mcp:get_briefing_note — positive control: the seat reads its own org-a note", async () => {
		const id = await bNote({ orgId: "org-a", content: "org-a own content" });
		const r = await call("get_briefing_note", { noteId: id });
		expect(r.content[0].text).toContain("org-a own content");
	});
});

describe("add_fix_attempt (row 22)", () => {
	beforeEach(() => mount(["a1"]));
	it("mcp:add_fix_attempt — an org-a seat cannot append an attempt to a fleet fix pattern", async () => {
		const pid = await t.run((ctx) =>
			ctx.db.insert("fixPatterns", {
				symptom: "s",
				rootCause: "r",
				tags: [],
				stack: [],
				sourceProject: "fleet",
				createdBy: "pi",
				severity: "minor",
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		const r = await call("add_fix_attempt", {
			patternId: pid,
			description: "x",
			worked: true,
			why: "y",
			createdBy: "a1",
		});
		const attempts = await t.run((ctx) => ctx.db.query("fixAttempts").collect());
		expect({ refused: r.isError === true, attempts: attempts.length }).toEqual({
			refused: true,
			attempts: 0,
		});
	});
});

describe("OKF storage tools (rows 23, 24)", () => {
	beforeEach(() => mount(["a1"]));
	async function orgBBlob() {
		const buf = await packTarball([
			{ path: "index.md", content: '---\nokf_version: "0.1"\ntype: index\n---\n# Bundle\n' },
			{
				path: "memories/m1.md",
				content:
					"---\ntype: memory-project\ntitle: m\ndescription: d\nresource: vp://memory/m1\ntags: [vp-memory]\ntimestamp: 2026-01-01T00:00:00Z\ncreatedBy: x\n---\norg-b private memory body\n",
			},
		]);
		const sid = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(buf)])));
		await t.run((ctx) => ctx.db.insert("kbUploads", { storageId: sid, orgId: "org-b", createdAt: 1 }));
		return sid;
	}
	it("mcp:import_okf_bundle — an org-a seat cannot import a blob bound to org-b into team/org-a", async () => {
		const sid = await orgBBlob();
		const r = await call("import_okf_bundle", {
			storageId: sid,
			targetNamespace: "team/org-a",
			mode: "merge",
		});
		const mems = await t.run((ctx) => ctx.db.query("memories").collect());
		expect({ refused: r.isError === true, copied: mems.length }).toEqual({ refused: true, copied: 0 });
	});
	it("mcp:validate_okf_bundle — an org-a seat cannot read the validation report of a blob bound to org-b", async () => {
		const sid = await orgBBlob();
		const r = await call("validate_okf_bundle", { storageId: sid });
		expect(r.isError === true, r.content[0].text).toBe(true);
	});
});
