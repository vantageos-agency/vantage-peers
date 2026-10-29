/**
 * ONE scope resolver for every door call (task k176y0q5jcz3m8m673bf61kva98h49js).
 *
 * Three pins:
 *   1. DOOR_SCOPE matches each door's Convex validator: a door that accepts
 *      verifiedPerson / verifiedOrg / seatOrgSlug is declared with exactly those.
 *   2. Every tools.ts call to such a door goes through the resolver, naming that
 *      door; no tool composes scope by hand any more.
 *   3. A pure refactor elsewhere: for every call site x caller kind x acting
 *      name, the resolver yields the SAME args the four retired helpers did
 *      (reproduced verbatim below as LEGACY), except the declared defect rows
 *      (a write door that forwarded less org scope than its read sibling) and the
 *      declared unreachable rows.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as briefingNotes from "../../convex/briefingNotes";
import * as businessUnits from "../../convex/businessUnits";
import * as githubRepoMapping from "../../convex/githubRepoMapping";
import * as kb from "../../convex/kb";
import * as kbMutations from "../../convex/kbMutations";
import * as memories from "../../convex/memories";
import * as messages from "../../convex/messages";
import * as missions from "../../convex/missions";
import * as tasks from "../../convex/tasks";
import {
	type OAuthContext,
	personActorOf,
	resolveSeatOrg,
} from "../src/auth.js";
import {
	DOOR_SCOPE,
	type DoorScopeArgs,
	type DoorScopeFacts,
	resolveDoorScope,
} from "../src/doorScope.js";
import { verifiedActorOf } from "../src/verifiedActor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_SRC = readFileSync(resolve(HERE, "../src/tools.ts"), "utf8");

const MODULES: Record<string, Record<string, unknown>> = {
	briefingNotes,
	businessUnits,
	githubRepoMapping,
	kb,
	kbMutations,
	memories,
	messages,
	missions,
	tasks,
};
const SCOPE_ARGS = ["verifiedPerson", "verifiedOrg", "seatOrgSlug"] as const;

function acceptedScopeArgs(door: string): string[] {
	const [mod, fn] = door.split(":");
	const reg = MODULES[mod]?.[fn] as { exportArgs?: () => string } | undefined;
	if (reg?.exportArgs === undefined)
		throw new Error(`no registered door ${door}`);
	const args = JSON.parse(reg.exportArgs()) as {
		type: string;
		value: Record<string, unknown>;
	};
	return SCOPE_ARGS.filter((a) => a in args.value);
}

describe("pin 1 — DOOR_SCOPE is the door's own validator", () => {
	for (const [door, rule] of Object.entries(DOOR_SCOPE)) {
		it(door, () => {
			const declared = SCOPE_ARGS.filter((a) => rule[a] !== undefined);
			expect(declared).toEqual(acceptedScopeArgs(door));
		});
	}
});

// DECLARED EXEMPTION: get_memory is a READ that reaches memories:getMemory
// without verifiedOrg and scopes the row after the read (scopeFilterGet), as it
// did at 010edc9a. It writes nothing, so it is outside this defect (a write
// forwarding less than its read); aligning it with get_episode changes what a
// read returns and is left to its own task. Listed, never silent.
const READ_EXEMPT = [{ door: "memories:getMemory", anchor: '"get_memory",' }];
function near(anchor: string, index: number): boolean {
	const at = TOOLS_SRC.lastIndexOf(anchor, index);
	return at !== -1 && index - at < 2000;
}

describe("pin 2b — the KB tools (tools/kbIngest.ts) call their doors through the resolver", () => {
	const KB_SRC = readFileSync(resolve(HERE, "../src/tools/kbIngest.ts"), "utf8");
	const calls = [
		...KB_SRC.matchAll(
			/convex\.(?:mutation|action)\(\s*"([A-Za-z0-9_]+):([A-Za-z0-9_]+)"/g,
		),
	];
	it("finds the five KB door calls", () => {
		expect(calls.length).toBe(5);
	});
	it("each names its door in a scopeArgs call within the same call", () => {
		const missing: string[] = [];
		for (const m of calls) {
			const door = `${m[1]}:${m[2]}`;
			const window = KB_SRC.slice(m.index, m.index + 600);
			if (DOOR_SCOPE[door] === undefined || !window.includes(`scopeArgs("${door}")`))
				missing.push(door);
		}
		expect(missing).toEqual([]);
	});
});

describe("pin 2 — every scope-taking door call goes through the resolver", () => {
	const calls = [
		...TOOLS_SRC.matchAll(
			/convex\.(?:mutation|query|action)\(\s*"([A-Za-z0-9_]+):([A-Za-z0-9_]+)"/g,
		),
	];

	it("no tool composes scope by hand", () => {
		for (const retired of [
			"personDoorArgs(",
			"seatOrgDoorArgs(",
			"verifiedOrgArgs(",
			"inboxOrgArgs(",
			"verifiedOrg: { orgSlug",
			"verifiedPerson: { accessTokenHash",
			"seatOrgSlug:",
		]) {
			expect(TOOLS_SRC.includes(retired), retired).toBe(false);
		}
	});

	it("a call to a door in DOOR_SCOPE names that door in a resolver call within its handler", () => {
		const missing: string[] = [];
		for (const m of calls) {
			const door = `${m[1]}:${m[2]}`;
			if (DOOR_SCOPE[door] === undefined) continue;
			const line = TOOLS_SRC.slice(0, m.index).split("\n").length;
			if (READ_EXEMPT.some((e) => e.door === door && near(e.anchor, m.index)))
				continue;
			const window = TOOLS_SRC.slice(
				Math.max(0, m.index - 1200),
				m.index + 1500,
			);
			if (
				!window.includes(`doorScopeArgs("${door}"`) &&
				!window.includes(`doorScope("${door}"`)
			) {
				missing.push(`${door}@${line}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("a door called by a tool whose validator accepts a scope argument is in DOOR_SCOPE", () => {
		const undeclared = new Set<string>();
		for (const m of calls) {
			const door = `${m[1]}:${m[2]}`;
			if (DOOR_SCOPE[door] !== undefined || MODULES[m[1]] === undefined)
				continue;
			if (acceptedScopeArgs(door).length > 0) undeclared.add(door);
		}
		expect([...undeclared]).toEqual([]);
	});
});

// ── LEGACY: the four retired helpers of tools.ts at origin/main 010edc9a,
// verbatim in behaviour (only the closure over oauthCtx became a parameter).
type Ctx = OAuthContext | undefined;
const legacyVerifiedOrgOf = (ctx: Ctx): string | undefined => {
	if (!ctx || ctx.isMaster || ctx.clerkJwt !== undefined) return undefined;
	return ctx.actor?.orgSlug ?? ctx.clerkOrgSlug;
};
const legacyPerson = (ctx: Ctx, acting: string | undefined): DoorScopeArgs =>
	acting === undefined &&
	personActorOf(ctx) !== undefined &&
	ctx?.accessTokenHash !== undefined
		? { verifiedPerson: { accessTokenHash: ctx.accessTokenHash } }
		: {};
const legacyOrg = (ctx: Ctx): DoorScopeArgs => {
	const orgSlug = legacyVerifiedOrgOf(ctx);
	return orgSlug !== undefined ? { verifiedOrg: { orgSlug } } : {};
};
const legacyInbox = (ctx: Ctx, acting: string | undefined): DoorScopeArgs =>
	verifiedActorOf(ctx) !== undefined ||
	Object.keys(legacyPerson(ctx, acting)).length > 0
		? {}
		: legacyOrg(ctx);
const legacySeat = (
	ctx: Ctx,
	acting: string | undefined,
): { args: DoorScopeArgs } | { denied: string } => {
	if (Object.keys(legacyPerson(ctx, acting)).length > 0) return { args: {} };
	const seat = resolveSeatOrg(ctx);
	if (seat.kind === "refused") return { denied: seat.error };
	return seat.kind === "org"
		? { args: { seatOrgSlug: seat.orgSlug } }
		: { args: {} };
};

type Legacy = (
	ctx: Ctx,
	acting: string | undefined,
) => { args: DoorScopeArgs } | { denied: string };
const org: Legacy = (ctx) => ({ args: legacyOrg(ctx) });
const personOnly: Legacy = (ctx, a) => ({ args: legacyPerson(ctx, a) });
const personAndOrg: Legacy = (ctx, a) => ({
	args: { ...legacyPerson(ctx, a), ...legacyOrg(ctx) },
});

/** [tool, door, legacy composition, tool is a person door (personDoor: true)] */
const SITES: [string, string, Legacy, boolean][] = [
	["get_episode", "memories:getMemory", org, false],
	[
		"send_message",
		"messages:sendMessage",
		(ctx, a) => {
			const seat = legacySeat(ctx, a);
			return "denied" in seat
				? seat
				: { args: { ...legacyPerson(ctx, a), ...seat.args } };
		},
		true,
	],
	[
		"check_messages",
		"messages:checkNewMessagesEnvelope",
		(ctx, a) => ({ args: legacyInbox(ctx, a) }),
		false,
	],
	[
		"mark_as_read",
		"messages:markAsRead",
		(ctx, a) => ({ args: { ...legacyPerson(ctx, a), ...legacyInbox(ctx, a) } }),
		false,
	],
	[
		"delete_message",
		"messages:deleteMessage",
		(ctx, a) => ({ args: legacyInbox(ctx, a) }),
		false,
	],
	["list_messages", "messages:listMessages", org, false],
	[
		"search_messages_by_keyword",
		"messages:searchMessagesByKeyword",
		org,
		false,
	],
	["list_broadcast_status", "messages:listBroadcastStatus", org, false],
	["get_message", "messages:getById", org, false],
	["create_task", "tasks:create", personOnly, true],
	["list_tasks", "tasks:list", org, false],
	["search_tasks_by_keyword", "tasks:searchTasksByKeyword", org, false],
	["bulk_complete_tasks", "tasks:bulkComplete", org, false],
	["update_task", "tasks:update", personAndOrg, true],
	["complete_task", "tasks:complete", personAndOrg, true],
	["start_task", "tasks:start", personAndOrg, true],
	["fail_task", "tasks:failTask", org, false],
	["pause_task", "tasks:pause", org, false],
	["resume_task", "tasks:resume", org, false],
	["correct_task_segment", "tasks:correctSegment", org, false],
	["checkout_task", "tasks:checkout", org, false],
	["delete_task", "tasks:deleteTask", org, false],
	["block_task", "tasks:blockTask", org, false],
	["block_task", "tasks:update", org, false],
	["add_task_dependency", "tasks:update", org, false],
	["create_mission", "missions:create", personOnly, true],
	["update_mission", "missions:update", personOnly, true],
	["create_briefing_note", "briefingNotes:create", org, false],
	["get_briefing_note", "briefingNotes:get", org, false],
	["list_briefing_notes", "briefingNotes:list", org, false],
	[
		"search_briefing_notes_by_keyword",
		"briefingNotes:searchBriefingNotesByKeyword",
		org,
		false,
	],
	["create_bu", "businessUnits:create", org, false],
	["update_bu", "businessUnits:update", org, false],
	["get_bu", "businessUnits:get", org, false],
	["list_bus", "businessUnits:list", org, false],
	["delete_bu", "businessUnits:remove", org, false],
	["list_repo_mappings", "githubRepoMapping:list", org, false],
	// Composed NO scope at 010edc9a: a seat's mapping was written as a fleet row.
	["add_repo_mapping", "githubRepoMapping:add", () => ({ args: {} }), false],
	[
		"remove_repo_mapping",
		"githubRepoMapping:remove",
		() => ({ args: {} }),
		false,
	],
];

const base: OAuthContext = {
	clientId: "c",
	userId: "u",
	scopes: ["mcp:full"],
	scopeProfile: "team-member",
	fromAllowList: ["agent-a"],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: Date.now() + 60_000,
	isMaster: false,
};
const AGENT = { agentId: "agent_a", orgId: "org-a", agentName: "agent-a" };

const CALLERS: Record<string, Ctx> = {
	"no context": undefined,
	master: {
		...base,
		isMaster: true,
		scopeProfile: "master",
		fromAllowList: ["*"],
	},
	"clerk session": { ...base, clerkJwt: "jwt", clerkOrgSlug: "org-a" },
	"one-agent seat": {
		...base,
		clerkOrgSlug: "org-a",
		accessTokenHash: "h",
		seatAgent: AGENT,
	},
	"org token, several agents": {
		...base,
		clerkOrgSlug: "org-a",
		accessTokenHash: "h",
	},
	"org token, no org": { ...base, accessTokenHash: "h" },
	"agent credential": {
		...base,
		clerkOrgSlug: "org-a",
		accessTokenHash: "h",
		actor: { orgSlug: "org-a", agentName: "agent-a", agentId: "agent_a" },
	},
	"person, own name": {
		...base,
		clerkOrgSlug: "org-a",
		accessTokenHash: "h",
		userId: "user_p",
		principal: "person",
	},
	// The operator org's own agent: the MCP still forwards the bearer's verified
	// org for it (verifiedOrgOf has no operator exception), so Convex must treat
	// that claim as the fleet's own write (serviceAccountWriteOrg). Pinned here
	// because the org-a kinds above cannot show it.
	"operator-org agent credential": {
		...base,
		clerkOrgSlug: "org-op",
		accessTokenHash: "h",
		actor: { orgSlug: "org-op", agentName: "agent-op", agentId: "agent_op" },
	},
	"person, personal agent": {
		...base,
		clerkOrgSlug: "org-a",
		accessTokenHash: "h",
		userId: "user_p",
		principal: "person",
		actor: { orgSlug: "org-a", agentName: "telemaque", agentId: "agent_t" },
	},
};

const facts = (ctx: Ctx): DoorScopeFacts => {
	const verifiedOrgSlug = legacyVerifiedOrgOf(ctx);
	return {
		...(personActorOf(ctx) !== undefined && ctx?.accessTokenHash !== undefined
			? { personAccessTokenHash: ctx.accessTokenHash }
			: {}),
		...(verifiedOrgSlug !== undefined ? { verifiedOrgSlug } : {}),
		hasVerifiedActor: verifiedActorOf(ctx) !== undefined,
		seat: resolveSeatOrg(ctx),
	};
};

// THE DEFECT ROWS: these write doors gained verifiedOrg for every bearer that
// has a verified org and no person proof (their read siblings already carried it).
const DEFECT_DOORS = new Set([
	"tasks:create",
	"missions:create",
	"githubRepoMapping:add",
	"githubRepoMapping:remove",
]);
const DEFECT_CALLERS = new Set([
	"one-agent seat",
	"org token, several agents",
	"agent credential",
	"operator-org agent credential",
	"person, personal agent",
]);
// The org each defect caller is verified for (a literal, not derived from the
// code under test).
const ORG_OF: Record<string, string> = {
	"operator-org agent credential": "org-op",
};

describe("pin 3 — identical args for every caller kind not in the defect", () => {
	for (const [tool, door, legacy, personDoor] of SITES) {
		for (const [caller, ctx] of Object.entries(CALLERS)) {
			for (const acting of [undefined, "agent-a"]) {
				const label = `${tool} -> ${door} | ${caller} | acting=${acting ?? "none"}`;
				const before = legacy(ctx, acting);
				const after = resolveDoorScope(door, acting, facts(ctx));
				const personOwnName = Object.keys(legacyPerson(ctx, acting)).length > 0;
				if (!personDoor && personOwnName && door === "tasks:update") {
					// UNREACHABLE: a person reaches a non-person-door tool only with an
					// acting name (defineTool refuses an omitted one, registerTool.ts
					// "from" scope), so this row's acting=none never calls the door.
					it(`unreachable: ${label}`, () => {
						expect(personDoor).toBe(false);
					});
					continue;
				}
				// A person NAMING an actor (an agent, or restating itself) at a create
				// door is the same defect: no verifiedPerson rides that call, so the
				// bearer's org must.
				// At the repo-mapping doors (which take no verifiedPerson) a person in its
				// own name was a fleet writer too.
				const personNaming =
					caller === "person, own name" &&
					(acting !== undefined || door.startsWith("githubRepoMapping:"));
				if (
					DEFECT_DOORS.has(door) &&
					(DEFECT_CALLERS.has(caller) || personNaming)
				) {
					it(`defect row, now carries the bearer's org: ${label}`, () => {
						expect(after).toEqual({
							args: {
								...("args" in before ? before.args : {}),
								verifiedOrg: { orgSlug: ORG_OF[caller] ?? "org-a" },
							},
						});
					});
					continue;
				}
				it(label, () => {
					expect(after).toEqual(before);
				});
			}
		}
	}

	it("an operator-org agent credential sends verifiedOrg (the operator org) to both create doors", () => {
		const ctx = CALLERS["operator-org agent credential"];
		for (const door of ["tasks:create", "missions:create"]) {
			expect(resolveDoorScope(door, "agent-op", facts(ctx))).toEqual({
				args: { verifiedOrg: { orgSlug: "org-op" } },
			});
		}
	});

	it("SITES covers every resolver call in tools.ts", () => {
		const inSource = [
			...TOOLS_SRC.matchAll(/doorScope(?:Args)?\("([A-Za-z]+:[A-Za-z]+)"/g),
		].map((m) => m[1]);
		expect(inSource.length).toBe(SITES.length);
		expect([...new Set(inSource)].sort()).toEqual(
			[...new Set(SITES.map((s) => s[1]))].sort(),
		);
	});

	it("a door missing from DOOR_SCOPE throws instead of forwarding nothing", () => {
		expect(() =>
			resolveDoorScope("tasks:nope", undefined, facts(undefined)),
		).toThrow(/not in DOOR_SCOPE/);
	});
});
