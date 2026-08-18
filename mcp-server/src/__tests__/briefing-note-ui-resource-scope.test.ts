/**
 * ui-resource briefing-note path is scope-aware (PR #1200 Eta REVISE item 2).
 *
 * Bug: renderBriefingNote called briefingNotes:get/list with NEITHER
 * `master` NOR `callerIdentities`, so `callerCanRead` took the legacy
 * `callerIdentities === undefined` OPEN branch — a scoped, non-participant
 * caller reading a briefing note through the ui:// resource path bypassed
 * Day-165 participant scoping entirely.
 *
 * Fix: readUiResource/renderBriefingNote accept an optional `identity`
 * ({ master, callerIdentities }) threaded from server-http.ts's oauthCtx
 * (mirrors tools.ts's master/callerIdentities computation), and forward it
 * as `master`/`callerIdentities` args on the get/list Convex calls.
 */

import { describe, expect, it } from "vitest";
import { readUiResource } from "../ui-resources/index.js";

function htmlText(r: Awaited<ReturnType<typeof readUiResource>>): string {
	return (r.contents[0] as { text: string }).text;
}

describe("briefing-note ui-resource — scope-aware identity threading", () => {
	it("forwards master + callerIdentities on the get call when identity is provided", async () => {
		let capturedArgs: Record<string, unknown> | undefined;
		const fetchConvex = async (
			functionName: string,
			args: Record<string, unknown>,
		) => {
			if (functionName === "briefingNotes:get") capturedArgs = args;
			return null;
		};

		await readUiResource(
			"ui://vp/v1/briefing-note?noteId=bn1",
			fetchConvex,
			{ master: false, callerIdentities: ["prometheus"] },
		);

		expect(capturedArgs).toBeDefined();
		expect(capturedArgs?.master).toBe(false);
		expect(capturedArgs?.callerIdentities).toEqual(["prometheus"]);
	});

	it("forwards master + callerIdentities on the list call when identity is provided", async () => {
		let capturedArgs: Record<string, unknown> | undefined;
		const fetchConvex = async (
			functionName: string,
			args: Record<string, unknown>,
		) => {
			if (functionName === "briefingNotes:list") capturedArgs = args;
			return [];
		};

		await readUiResource("ui://vp/v1/briefing-note", fetchConvex, {
			master: false,
			callerIdentities: ["prometheus"],
		});

		expect(capturedArgs).toBeDefined();
		expect(capturedArgs?.master).toBe(false);
		expect(capturedArgs?.callerIdentities).toEqual(["prometheus"]);
	});

	it("a non-participant scoped identity does not get the note through the ui path", async () => {
		// Simulate the real Convex visibility contract: callerCanRead returns
		// null/filters out the note when callerIdentities is scoped and the
		// caller is not creator/participant. This proves the ui path is wired
		// to actually receive and use the identity, not just to pass extra
		// no-op args.
		const fetchConvex = async (
			functionName: string,
			args: Record<string, unknown>,
		) => {
			if (functionName === "briefingNotes:get") {
				const callerIdentities = args.callerIdentities as
					| string[]
					| undefined;
				const master = args.master as boolean | undefined;
				const note = {
					_id: "bn1",
					topic: "ops",
					title: "restricted note",
					participants: ["pi", "sigma"],
					createdBy: "sigma",
				};
				if (master === true) return note;
				if (callerIdentities === undefined) return note; // legacy open
				const visible =
					callerIdentities.includes(note.createdBy) ||
					callerIdentities.some((id) => note.participants.includes(id));
				return visible ? note : null;
			}
			return null;
		};

		const r = await readUiResource(
			"ui://vp/v1/briefing-note?noteId=bn1",
			fetchConvex,
			{ master: false, callerIdentities: ["eta"] },
		);

		expect(htmlText(r)).toContain("No briefing notes found");
		expect(htmlText(r)).not.toContain("restricted note");
	});

	it("omitting identity preserves the legacy unscoped call (back-compat)", async () => {
		let capturedArgs: Record<string, unknown> | undefined;
		const fetchConvex = async (
			functionName: string,
			args: Record<string, unknown>,
		) => {
			if (functionName === "briefingNotes:get") capturedArgs = args;
			return null;
		};

		await readUiResource("ui://vp/v1/briefing-note?noteId=bn1", fetchConvex);

		expect(capturedArgs).toBeDefined();
		expect(capturedArgs?.master).toBeUndefined();
		expect(capturedArgs?.callerIdentities).toBeUndefined();
	});
});
