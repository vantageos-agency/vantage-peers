/**
 * ui-resource briefing-note path is scope-aware (PR #1200 Eta REVISE item 2).
 *
 * Bug: renderBriefingNote called briefingNotes:get/list with NEITHER
 * `master` NOR `callerIdentities`, so `callerCanRead` took the legacy
 * `callerIdentities === undefined` OPEN branch — a scoped, non-participant
 * caller reading a briefing note through the ui:// resource path bypassed
 * Day-165 participant scoping entirely.
 *
 * Fix: readUiResource takes the caller's REQUIRED scope (ui-resources/scope.ts,
 * task k17apssqnw2xcf72r27c83338s8hc180), built from the verified oauthContext
 * the same way tools.ts builds it, and forwards `master`/`callerIdentities`
 * plus the tools' door arguments on the get/list Convex calls. There is no
 * longer an identity-less (legacy-open) call path.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import { readUiResource } from "../ui-resources/index.js";
import { uiReadScopeOf } from "../ui-resources/scope.js";

function htmlText(r: Awaited<ReturnType<typeof readUiResource>>): string {
	return (r.contents[0] as { text: string }).text;
}

function memberScope(fromAllowList: string[]) {
	const ctx: OAuthContext = {
		clientId: "client-1",
		userId: fromAllowList[0] ?? "nobody",
		scopes: ["vantage:read"],
		scopeProfile: "team-member",
		fromAllowList,
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Number.MAX_SAFE_INTEGER,
		isMaster: false,
		accessTokenHash: "a".repeat(64),
		clerkOrgSlug: "org-a",
	};
	return uiReadScopeOf(ctx);
}

describe("briefing-note ui-resource — scope-aware identity threading", () => {
	it("forwards master + callerIdentities + verifiedOrg on the get call", async () => {
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
			memberScope(["prometheus"]),
		);

		expect(capturedArgs).toBeDefined();
		expect(capturedArgs?.master).toBe(false);
		expect(capturedArgs?.callerIdentities).toEqual(["prometheus"]);
		expect(capturedArgs?.verifiedOrg).toEqual({ orgSlug: "org-a" });
	});

	it("forwards master + callerIdentities + verifiedOrg on the list call", async () => {
		let capturedArgs: Record<string, unknown> | undefined;
		const fetchConvex = async (
			functionName: string,
			args: Record<string, unknown>,
		) => {
			if (functionName === "briefingNotes:list") capturedArgs = args;
			return [];
		};

		await readUiResource(
			"ui://vp/v1/briefing-note",
			fetchConvex,
			memberScope(["prometheus"]),
		);

		expect(capturedArgs).toBeDefined();
		expect(capturedArgs?.master).toBe(false);
		expect(capturedArgs?.callerIdentities).toEqual(["prometheus"]);
		expect(capturedArgs?.verifiedOrg).toEqual({ orgSlug: "org-a" });
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
				const callerIdentities = args.callerIdentities as string[] | undefined;
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
			memberScope(["eta"]),
		);

		expect(htmlText(r)).toContain("No briefing notes found");
		expect(htmlText(r)).not.toContain("restricted note");
	});

	it("a note the backend returns anyway is still withheld by the tools' row gate", async () => {
		// Defense in depth, as get_briefing_note: a non-creator, non-participant
		// row is dropped by scopeFilterGet OR the participant re-check, even if
		// the door returned it.
		const fetchConvex = async () => ({
			_id: "bn1",
			topic: "ops",
			title: "restricted note",
			participants: ["pi"],
			createdBy: "sigma",
		});
		const r = await readUiResource(
			"ui://vp/v1/briefing-note?noteId=bn1",
			fetchConvex,
			memberScope(["eta"]),
		);
		expect(htmlText(r)).not.toContain("restricted note");
	});
});
