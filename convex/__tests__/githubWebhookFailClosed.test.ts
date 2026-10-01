/// <reference types="vite/client" />
/**
 * `POST /github/webhook` fails closed.
 *
 * Before: an unset GITHUB_WEBHOOK_SECRET skipped HMAC verification entirely and
 * the signature was compared with `!==`. Now an unset/empty secret refuses
 * every delivery (503, no write) and the compare is constant-time over
 * equal-length byte arrays.
 *
 * Served pole: a correctly signed delivery is processed (same fixture shape as
 * closeWebhookDoors.test.ts).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import {
	TEST_WEBHOOK_SECRET,
	signGithubBody,
} from "../../tests/lib/githubWebhookSignature";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const REPO = "acme/failclosed-repo";

const payload = JSON.stringify({
	action: "opened",
	repository: { full_name: REPO },
	issue: {
		number: 11,
		title: "fail closed",
		body: "b",
		html_url: `https://github.com/${REPO}/issues/11`,
		labels: [],
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
	},
});

const makeT = async () => {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert("githubRepoMapping", {
			repo: REPO,
			orchestrator: "sigma",
			project: "failclosed-project",
			active: true,
		});
		await ctx.db.insert("profiles", {
			orchestratorId: "sigma",
			name: "sigma",
			static: { role: "sigma", workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
	return t;
};

const post = (t: Awaited<ReturnType<typeof makeT>>, signature?: string) =>
	t.fetch("/github/webhook", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": "issues",
			...(signature === undefined ? {} : { "x-hub-signature-256": signature }),
		},
		body: payload,
	});

const issueCount = (t: Awaited<ReturnType<typeof makeT>>) =>
	t.run(async (ctx) => (await ctx.db.query("issues").collect()).length);

describe("github webhook fails closed", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		delete process.env.GITHUB_WEBHOOK_SECRET;
		vi.restoreAllMocks();
	});

	test("secret unset -> refused 503, no DB write, log names the variable", async () => {
		delete process.env.GITHUB_WEBHOOK_SECRET;
		const t = await makeT();
		const res = await post(t, signGithubBody(payload));
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("Server misconfiguration");
		expect(await issueCount(t)).toBe(0);
		expect(errorSpy.mock.calls.flat().join(" ")).toContain(
			"GITHUB_WEBHOOK_SECRET",
		);
	});

	test("secret empty string -> refused 503, no DB write", async () => {
		process.env.GITHUB_WEBHOOK_SECRET = "";
		const t = await makeT();
		const res = await post(t, signGithubBody(payload, ""));
		expect(res.status).toBe(503);
		expect(await issueCount(t)).toBe(0);
	});

	test("wrong signature (right length) -> 401, no DB write", async () => {
		process.env.GITHUB_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
		const t = await makeT();
		const res = await post(t, signGithubBody(payload, "some-other-secret"));
		expect(res.status).toBe(401);
		expect(await issueCount(t)).toBe(0);
	});

	test("signature of the wrong length -> 401, no DB write", async () => {
		process.env.GITHUB_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
		const t = await makeT();
		const res = await post(t, `${signGithubBody(payload)}00`);
		expect(res.status).toBe(401);
		expect(await issueCount(t)).toBe(0);
	});

	test("missing signature header -> 401, no DB write", async () => {
		process.env.GITHUB_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
		const t = await makeT();
		const res = await post(t);
		expect(res.status).toBe(401);
		expect(await issueCount(t)).toBe(0);
	});

	test("valid signature -> processed", async () => {
		process.env.GITHUB_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
		const t = await makeT();
		const res = await post(t, signGithubBody(payload));
		expect(res.status).toBe(200);
		expect(await issueCount(t)).toBe(1);
	});
});
