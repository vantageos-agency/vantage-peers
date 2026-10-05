/// <reference types="vite/client" />
/**
 * `POST /github/webhook` is idempotent per `x-github-delivery`.
 *
 * GitHub reuses the delivery GUID on a redelivery. Before this change the
 * handler never read it, so a redelivered creating event (the issue-comment
 * bridge task, the assigned task) created a second task. Now the delivery id
 * is claimed in one atomic mutation, after the signature check.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
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

const REPO = "acme/idempotency-repo";
const ISSUE_URL = `https://github.com/${REPO}/issues/7`;

const commentPayload = JSON.stringify({
	action: "created",
	repository: { full_name: REPO },
	issue: {
		number: 7,
		title: "Redelivery bug",
		state: "open",
		html_url: ISSUE_URL,
		body: "b",
		labels: [],
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
	},
	comment: {
		id: 1,
		html_url: `${ISSUE_URL}#issuecomment-1`,
		body: "please look, @elpiarthera",
		user: { login: "external-user", type: "User" },
	},
});

const assignedPayload = JSON.stringify({
	action: "assigned",
	repository: { full_name: REPO },
	assignee: { login: "elpiarthera" },
	issue: {
		number: 8,
		title: "Assigned thing",
		html_url: `https://github.com/${REPO}/issues/8`,
	},
});

type T = Awaited<ReturnType<typeof makeT>>;

const makeT = async () => {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert("githubRepoMapping", {
			repo: REPO,
			orchestrator: "sigma",
			project: "idem-project",
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

const post = (
	t: T,
	body: string,
	event: string,
	opts: { delivery?: string | null; signed?: boolean } = {},
) =>
	t.fetch("/github/webhook", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": event,
			...(opts.signed === false
				? {}
				: { "x-hub-signature-256": signGithubBody(body) }),
			...(opts.delivery ? { "x-github-delivery": opts.delivery } : {}),
		},
		body,
	});

const taskTitles = (t: T) =>
	t.run(async (ctx) => (await ctx.db.query("tasks").collect()).map((r) => r.title));
const ledger = (t: T) =>
	t.run(async (ctx) => await ctx.db.query("webhookDeliveries").collect());

describe("github webhook delivery idempotency", () => {
	beforeEach(() => {
		process.env.GITHUB_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
		delete process.env.GITHUB_TOKEN;
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		delete process.env.GITHUB_WEBHOOK_SECRET;
		vi.restoreAllMocks();
	});

	test("issue_comment bridge: same delivery twice -> one Bridge task and one mention task", async () => {
		const t = await makeT();
		const first = await post(t, commentPayload, "issue_comment", { delivery: "d-1" });
		const second = await post(t, commentPayload, "issue_comment", { delivery: "d-1" });
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		const titles = await taskTitles(t);
		expect(titles.filter((x) => x.startsWith("[Bridge #7]"))).toHaveLength(1);
		expect(titles.filter((x) => x.includes("Mentioned"))).toHaveLength(1);
		expect(titles).toHaveLength(2);
	});

	test("issues.assigned: same delivery twice -> one task", async () => {
		const t = await makeT();
		await post(t, assignedPayload, "issues", { delivery: "d-2" });
		await post(t, assignedPayload, "issues", { delivery: "d-2" });
		const titles = await taskTitles(t);
		expect(titles.filter((x) => x.includes("Assigned: Assigned thing"))).toHaveLength(1);
	});

	test("keyed on the delivery id: a DIFFERENT delivery of the same body is a new event", async () => {
		const t = await makeT();
		await post(t, assignedPayload, "issues", { delivery: "d-3a" });
		await post(t, assignedPayload, "issues", { delivery: "d-3b" });
		const titles = await taskTitles(t);
		expect(titles.filter((x) => x.includes("Assigned:"))).toHaveLength(2);
		expect(await ledger(t)).toHaveLength(2);
	});

	test("two concurrent redeliveries cannot both pass", async () => {
		const t = await makeT();
		await Promise.all([
			post(t, assignedPayload, "issues", { delivery: "d-4" }),
			post(t, assignedPayload, "issues", { delivery: "d-4" }),
		]);
		const titles = await taskTitles(t);
		expect(titles.filter((x) => x.includes("Assigned:"))).toHaveLength(1);
		expect(await ledger(t)).toHaveLength(1);
	});

	test("missing delivery header (valid signature) -> 400, no task, no ledger row", async () => {
		const t = await makeT();
		const res = await post(t, assignedPayload, "issues", { delivery: null });
		expect(res.status).toBe(400);
		expect(await taskTitles(t)).toHaveLength(0);
		expect(await ledger(t)).toHaveLength(0);
	});

	test("signature is checked FIRST: unsigned request with a delivery id -> 401, ledger untouched", async () => {
		const t = await makeT();
		const res = await post(t, assignedPayload, "issues", {
			delivery: "d-5",
			signed: false,
		});
		expect(res.status).toBe(401);
		expect(await ledger(t)).toHaveLength(0);
		expect(await taskTitles(t)).toHaveLength(0);
	});

	test("a handler failure releases the claim so GitHub's retry is processed", async () => {
		const t = await makeT();
		// assignee matches but `issue` is absent -> the handler throws.
		const broken = JSON.stringify({
			action: "assigned",
			repository: { full_name: REPO },
			assignee: { login: "elpiarthera" },
		});
		let status = 0;
		try {
			status = (await post(t, broken, "issues", { delivery: "d-6" })).status;
		} catch {
			status = 500;
		}
		expect(status).toBe(500);
		expect(await ledger(t)).toHaveLength(0);
		const retry = await post(t, assignedPayload, "issues", { delivery: "d-6" });
		expect(retry.status).toBe(200);
		expect((await taskTitles(t)).filter((x) => x.includes("Assigned:"))).toHaveLength(1);
	});

	test("purgeExpired drops only rows past retention", async () => {
		const t = await makeT();
		await t.run(async (ctx) => {
			const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
			await ctx.db.insert("webhookDeliveries", {
				deliveryId: "old",
				repo: REPO,
				eventType: "issues",
				receivedAt: old,
			});
			await ctx.db.insert("webhookDeliveries", {
				deliveryId: "fresh",
				repo: REPO,
				eventType: "issues",
				receivedAt: Date.now(),
			});
		});
		const res = await t.mutation(internal.deliveryLedger.purgeExpired, {});
		expect(res.deleted).toBe(1);
		expect((await ledger(t)).map((r) => r.deliveryId)).toEqual(["fresh"]);
	});
});
