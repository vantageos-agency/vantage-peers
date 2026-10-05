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
import { deliveryTestSeam } from "../deliveryLedger";
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
const ledgerDeliveries = async (t: T) =>
	new Set((await ledger(t)).map((r) => r.deliveryId));

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
		expect(await ledgerDeliveries(t)).toEqual(new Set(["d-3a", "d-3b"]));
	});

	test("two concurrent redeliveries cannot both pass", async () => {
		const t = await makeT();
		await Promise.all([
			post(t, assignedPayload, "issues", { delivery: "d-4" }),
			post(t, assignedPayload, "issues", { delivery: "d-4" }),
		]);
		const titles = await taskTitles(t);
		expect(titles.filter((x) => x.includes("Assigned:"))).toHaveLength(1);
		// one row per creating step (task + notice), never two for the same step
		expect(await ledger(t)).toHaveLength(2);
		expect(await ledgerDeliveries(t)).toEqual(new Set(["d-4"]));
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

	const claimFor = (deliveryId: string, step: string) => ({
		deliveryId,
		step,
		repo: REPO,
		eventType: "issues",
	});

	test("task: work throws AFTER the claim in the same mutation -> claim AND task roll back, redelivery creates exactly one task", async () => {
		const t = await makeT();
		const base = {
			title: "[GitHub #9] Assigned: x",
			assignedTo: "sigma",
			project: "idem-project",
			priority: "high" as const,
			status: "todo" as const,
			createdBy: "system" as const,
			delivery: claimFor("d-6", "assigned-task"),
		};
		// Inject a throw after the task insert and the claim, inside the mutation.
		deliveryTestSeam.afterWork = () => {
			throw new Error("injected failure after claim and insert");
		};
		try {
			await expect(
				t.mutation(internal.tasks.createForWebhookDelivery, base),
			).rejects.toThrow("injected failure");
		} finally {
			deliveryTestSeam.afterWork = undefined;
		}
		// neither the claim nor the task survived the throw (same transaction)
		expect(
			(await ledger(t)).filter((r) => r.deliveryId === "d-6"),
		).toHaveLength(0);
		expect(await taskTitles(t)).toHaveLength(0);
		// the redelivery succeeds, and a third delivery is a no-op
		const first = await t.mutation(internal.tasks.createForWebhookDelivery, base);
		const third = await t.mutation(internal.tasks.createForWebhookDelivery, base);
		expect(first).not.toBeNull();
		expect(third).toBeNull();
		expect(await taskTitles(t)).toHaveLength(1);
	});

	const injectFailureOnce = async (run: () => Promise<unknown>) => {
		deliveryTestSeam.afterWork = () => {
			throw new Error("injected failure after claim and work");
		};
		try {
			await expect(run()).rejects.toThrow("injected failure");
		} finally {
			deliveryTestSeam.afterWork = undefined;
		}
	};

	test("mission: work throws AFTER the claim in the same mutation -> claim AND mission roll back, redelivery creates exactly one mission", async () => {
		const t = await makeT();
		// missions.create needs an identity: the service account, as other tests do.
		const asMaster = t.withIdentity({ subject: "test-service-account-user-id" });
		const args = {
			delivery: claimFor("d-8", "mission"),
			name: "Fix #8 - redelivery",
			project: "idem-project",
			status: "execute" as const,
			priority: "high" as const,
			pilot: "sigma" as const,
			agents: ["sigma"],
			createdBy: "system" as const,
		};
		const missionCount = () =>
			t.run(async (ctx) => (await ctx.db.query("missions").collect()).length);
		await injectFailureOnce(() =>
			asMaster.mutation(internal.missions.createForWebhookDelivery, args),
		);
		expect(
			(await ledger(t)).filter((r) => r.deliveryId === "d-8"),
		).toHaveLength(0);
		expect(await missionCount()).toBe(0);
		const first = await asMaster.mutation(internal.missions.createForWebhookDelivery, args);
		const third = await asMaster.mutation(internal.missions.createForWebhookDelivery, args);
		expect(first).not.toBeNull();
		expect(third).toBeNull();
		expect(await missionCount()).toBe(1);
	});

	test("review task: work throws AFTER the claim in the same mutation -> claim AND task roll back, redelivery creates exactly one task", async () => {
		const t = await makeT();
		const args = {
			delivery: claimFor("d-9", "review-task"),
			repoFullName: REPO,
			prNumber: 9,
			prTitle: "A pull request",
			assignedTo: "sigma",
			project: "idem-project",
			priority: "high" as const,
			createdBy: "system" as const,
		};
		await injectFailureOnce(() =>
			t.mutation(internal.tasks.createOrUpdateReviewTaskDelivery, args),
		);
		expect(
			(await ledger(t)).filter((r) => r.deliveryId === "d-9"),
		).toHaveLength(0);
		expect(await taskTitles(t)).toHaveLength(0);
		const first = await t.mutation(internal.tasks.createOrUpdateReviewTaskDelivery, args);
		const third = await t.mutation(internal.tasks.createOrUpdateReviewTaskDelivery, args);
		expect(first).not.toBeNull();
		expect(first).not.toBe("duplicate");
		expect(third).toBe("duplicate");
		expect(await taskTitles(t)).toHaveLength(1);
	});

	test("message: work throws AFTER the claim in the same mutation -> claim rolls back, redelivery creates exactly one message", async () => {
		const t = await makeT();
		const msg = {
			from: "system" as const,
			channel: "sigma",
			content: "[GitHub] hello",
			delivery: claimFor("d-7", "comment-notice"),
		};
		// tenantId "" is refused by sendMessageCore AFTER the claim was taken.
		await expect(
			t.mutation(internal.messages.sendMessageDelivery, { ...msg, tenantId: "" }),
		).rejects.toThrow();
		expect(
			(await ledger(t)).filter((r) => r.deliveryId === "d-7"),
		).toHaveLength(0);
		const first = await t.mutation(internal.messages.sendMessageDelivery, msg);
		const again = await t.mutation(internal.messages.sendMessageDelivery, msg);
		expect(first).not.toBeNull();
		expect(again).toBeNull();
		const count = await t.run(
			async (ctx) =>
				(await ctx.db.query("messages").collect()).filter((m) =>
					m.content.includes("[GitHub] hello"),
				).length,
		);
		expect(count).toBe(1);
	});

	test("purgeExpired drops only rows past retention", async () => {
		const t = await makeT();
		await t.run(async (ctx) => {
			const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
			await ctx.db.insert("webhookDeliveries", {
				deliveryId: "old",
				step: "s",
				repo: REPO,
				eventType: "issues",
				receivedAt: old,
			});
			await ctx.db.insert("webhookDeliveries", {
				deliveryId: "fresh",
				step: "s",
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
