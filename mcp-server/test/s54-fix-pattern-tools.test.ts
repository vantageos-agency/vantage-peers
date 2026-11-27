/**
 * create_fix_pattern, add_fix_attempt and update_mission_template are called
 * through the real registerTools() against a mocked Convex client (VantagePeers
 * Cloud + Self-host, MCP server; S-54 of mcp-doctor "tools-tested"). All three
 * are actor-bound `from` tools (fromArg: createdBy).
 *
 * Success: the door receives the documented fields and the answer is the
 * documented envelope, as text and as a structuredContent that validates against
 * the declared outputSchema. Refusal: a bearer whose allow-list does not name the
 * author is refused before any door; a door failure is a typed error result.
 */

import { describe, expect, it } from "vitest";
import { CLIENT_CTX, expectRefused, expectServed, harness } from "./lib/s54Harness.js";

describe("create_fix_pattern", () => {
	const args = {
		symptom: "hydration mismatch",
		rootCause: "SSR/CSR time skew",
		tags: ["next.js"],
		stack: ["next.js", "convex"],
		sourceProject: "vantage-starter",
		createdBy: "alpha",
		severity: "major",
	};

	it("creates the pattern and answers { patternId, created: true }", async () => {
		const h = harness({ "fixPatterns:create": () => "pattern-1" });
		const res = await h.tools.get("create_fix_pattern")!.handler(args);
		const out = expectServed(h.tools, "create_fix_pattern", res);
		expect(out).toEqual({ patternId: "pattern-1", created: true });
		expect(JSON.parse(res.content[0].text)).toEqual(out);
		expect(h.calls[0].fn).toBe("fixPatterns:create");
		expect(h.calls[0].args).toMatchObject({
			symptom: "hydration mismatch",
			tags: ["next.js"],
			stack: ["next.js", "convex"],
			createdBy: "alpha",
			severity: "major",
		});
	});

	it("answers a typed error when the door throws", async () => {
		const h = harness({
			"fixPatterns:create": () => {
				throw new Error("door down");
			},
		});
		const res = await h.tools.get("create_fix_pattern")!.handler(args);
		expectRefused(res, /door down/);
	});

	it("refuses an author the bearer's allow-list does not name, before any door", async () => {
		const h = harness({ "fixPatterns:create": () => "pattern-1" }, CLIENT_CTX);
		const res = await h.tools.get("create_fix_pattern")!.handler(args);
		expectRefused(res, /alpha/);
		expect(h.calls).toHaveLength(0);
	});
});

describe("add_fix_attempt", () => {
	const args = {
		patternId: "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		description: "Added suppressHydrationWarning",
		worked: true,
		why: "Prevents mismatches",
		createdBy: "beta",
		commit: "abc1234",
	};

	it("records the attempt and answers { attemptId, patternId, worked }", async () => {
		const h = harness({ "fixPatterns:addAttempt": () => "attempt-1" });
		const res = await h.tools.get("add_fix_attempt")!.handler(args);
		const out = expectServed(h.tools, "add_fix_attempt", res);
		expect(out).toEqual({
			attemptId: "attempt-1",
			patternId: "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			worked: true,
		});
		expect(JSON.parse(res.content[0].text)).toEqual(out);
		expect(h.calls[0].fn).toBe("fixPatterns:addAttempt");
		expect(h.calls[0].args).toMatchObject({
			patternId: "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			worked: true,
			why: "Prevents mismatches",
			commit: "abc1234",
		});
	});

	it("keeps a failed attempt as worked: false", async () => {
		const h = harness({ "fixPatterns:addAttempt": () => "attempt-2" });
		const res = await h.tools.get("add_fix_attempt")!.handler({ ...args, worked: false });
		const out = expectServed(h.tools, "add_fix_attempt", res);
		expect(out.worked).toBe(false);
	});

	it("refuses an author the bearer's allow-list does not name, before any door", async () => {
		const h = harness({ "fixPatterns:addAttempt": () => "attempt-1" }, CLIENT_CTX);
		const res = await h.tools.get("add_fix_attempt")!.handler({ ...args, createdBy: "alpha" });
		expectRefused(res, /alpha/);
		expect(h.calls).toHaveLength(0);
	});
});

describe("update_mission_template", () => {
	const args = {
		name: "issue-resolution-v2",
		description: "Triage then fix",
		steps: [
			{ title: "Triage", description: "Read the issue" },
			{ title: "Fix", description: "Fix it", dependsOn: [0] },
		],
		createdBy: "alpha",
	};

	it("upserts the template and answers { templateId, name, stepCount }", async () => {
		const h = harness({ "missionTemplates:upsert": () => "template-1" });
		const res = await h.tools.get("update_mission_template")!.handler(args);
		const out = expectServed(h.tools, "update_mission_template", res);
		expect(out).toEqual({ templateId: "template-1", name: "issue-resolution-v2", stepCount: 2 });
		expect(JSON.parse(res.content[0].text)).toEqual(out);
		expect(h.calls[0].fn).toBe("missionTemplates:upsert");
		expect(h.calls[0].args).toMatchObject({ name: "issue-resolution-v2", createdBy: "alpha", steps: args.steps });
	});

	it("answers a typed error when the door refuses (a non-master author)", async () => {
		const h = harness({
			"missionTemplates:upsert": () => {
				throw new Error("RBAC_DENIED master only");
			},
		});
		const res = await h.tools.get("update_mission_template")!.handler(args);
		expectRefused(res, /RBAC_DENIED|master only/);
	});

	it("refuses an author the bearer's allow-list does not name, before any door", async () => {
		const h = harness({ "missionTemplates:upsert": () => "template-1" }, CLIENT_CTX);
		const res = await h.tools.get("update_mission_template")!.handler(args);
		expectRefused(res, /alpha/);
		expect(h.calls).toHaveLength(0);
	});
});
