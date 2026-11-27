/**
 * update_profile and set_summary are called through the real registerTools()
 * against a mocked Convex client (VantagePeers Cloud + Self-host, MCP server;
 * S-54 of mcp-doctor "tools-tested"). Both are actor-bound `from` tools
 * (fromArg: orchestratorId).
 *
 * Success: the door receives the fields the tool forwards, and the answer is the
 * documented { profileId, orchestratorId, name } / { orchestratorId, instanceId,
 * summary }, as text and as a structuredContent that validates against the
 * declared outputSchema. Refusal: a bearer whose allow-list does not name the
 * orchestratorId is refused before any door is reached.
 */

import { describe, expect, it } from "vitest";
import {
	CLIENT_CTX,
	expectRefused,
	expectServed,
	harness,
} from "./lib/s54Harness.js";

describe("update_profile", () => {
	it("upserts the profile and answers { profileId, orchestratorId, name }", async () => {
		const h = harness({ "profiles:upsertProfile": () => "profile-1" });
		const res = await h.tools.get("update_profile")!.handler({
			orchestratorId: "alpha",
			name: "Alpha",
			static: {
				role: "builder",
				workspace: "/root/coding/vantage-peers",
				capabilities: ["code"],
			},
			dynamic: { sessionCount: 5 },
		});
		const out = expectServed(h.tools, "update_profile", res);
		expect(out).toEqual({
			profileId: "profile-1",
			orchestratorId: "alpha",
			name: "Alpha",
		});
		expect(JSON.parse(res.content[0].text)).toEqual(out);
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0].fn).toBe("profiles:upsertProfile");
		expect(h.calls[0].args).toMatchObject({
			orchestratorId: "alpha",
			name: "Alpha",
			dynamic: { sessionCount: 5 },
		});
	});

	it("answers a typed error when the door throws", async () => {
		const h = harness({
			"profiles:upsertProfile": () => {
				throw new Error("door down");
			},
		});
		const res = await h.tools
			.get("update_profile")!
			.handler({ orchestratorId: "alpha" });
		expectRefused(res, /door down/);
	});

	it("refuses an orchestratorId the bearer's allow-list does not name, before any door", async () => {
		const h = harness(
			{ "profiles:upsertProfile": () => "profile-1" },
			CLIENT_CTX,
		);
		const res = await h.tools
			.get("update_profile")!
			.handler({ orchestratorId: "alpha" });
		expectRefused(res, /alpha/);
		expect(h.calls).toHaveLength(0);
	});
});

describe("set_summary", () => {
	it("writes the summary as currentTask and answers { orchestratorId, instanceId, summary }", async () => {
		const h = harness({ "profiles:updateDynamic": () => null });
		const res = await h.tools.get("set_summary")!.handler({
			orchestratorId: "alpha",
			instanceId: "alpha-vps",
			summary: "Covering S-54 tools",
			endOfDayIndex: "idx-1",
		});
		const out = expectServed(h.tools, "set_summary", res);
		expect(out).toEqual({
			orchestratorId: "alpha",
			instanceId: "alpha-vps",
			summary: "Covering S-54 tools",
		});
		expect(JSON.parse(res.content[0].text)).toEqual(out);
		expect(h.calls[0].fn).toBe("profiles:updateDynamic");
		expect(h.calls[0].args).toMatchObject({
			orchestratorId: "alpha",
			instanceId: "alpha-vps",
			currentTask: "Covering S-54 tools",
			endOfDayIndex: "idx-1",
		});
	});

	it("refuses an orchestratorId the bearer's allow-list does not name, before any door", async () => {
		const h = harness({ "profiles:updateDynamic": () => null }, CLIENT_CTX);
		const res = await h.tools.get("set_summary")!.handler({
			orchestratorId: "alpha",
			summary: "x",
		});
		expectRefused(res, /alpha/);
		expect(h.calls).toHaveLength(0);
	});
});
