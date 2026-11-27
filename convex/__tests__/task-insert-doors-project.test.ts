/// <reference types="vite/client" />
/**
 * convex/__tests__/task-insert-doors-project.test.ts
 *
 * Task k174n9czcs7x77j2hrvqz6n4hh8hrnsb. Residue of PR #1702: every door that
 * inserts into `tasks` hands over a row with a non-empty project, or is refused
 * with TASK_PROJECT_REQUIRED. Poles per door: REFUSED (no project) and PRESENT
 * (a project is carried, trimmed).
 *
 * Doors: tasks:createForWebhook, tasks:createDeployTaskWithDedup (both of its
 * inserts), tasks:createOrUpdateReviewTask, recurringTasks:create / :update /
 * :processDueTasks, missionTemplates:instantiateTemplateIntoMission,
 * okfBundle:_insertImportedTask and okfBundleNode:importOkfBundle.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { api, internal } from "../_generated/api";
import { packTarball } from "../okfBundleNode";
import { serializeTask } from "../okfSerializer";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const SERVICE_ACCOUNT = "test-service-account-user-id";
const CODE = /TASK_PROJECT_REQUIRED/;

async function world() {
	const t = convexTest(schema, modules);
	await seedFleetAgents(t, ["sigma", "pi"]);
	return t;
}
type T = Awaited<ReturnType<typeof world>>;
const asMaster = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT });
const allTasks = (t: T) =>
	t.run(async (ctx) => ctx.db.query("tasks").collect());

const webhookBase = {
	title: "Webhook task",
	assignedTo: "pi" as const,
	priority: "medium" as const,
	status: "todo" as const,
	createdBy: "system" as const,
};

describe("tasks:createForWebhook (GitHub webhook create)", () => {
	test("REFUSED: project omitted / empty / whitespace, no row written", async () => {
		const t = await world();
		await expect(
			t.mutation(internal.tasks.createForWebhook, webhookBase),
		).rejects.toThrow(CODE);
		await expect(
			t.mutation(internal.tasks.createForWebhook, {
				...webhookBase,
				project: "",
			}),
		).rejects.toThrow(CODE);
		await expect(
			t.mutation(internal.tasks.createForWebhook, {
				...webhookBase,
				project: "  ",
			}),
		).rejects.toThrow(CODE);
		expect(await allTasks(t)).toHaveLength(0);
	});

	test("PRESENT: the mapping project is stored trimmed", async () => {
		const t = await world();
		const id = await t.mutation(internal.tasks.createForWebhook, {
			...webhookBase,
			project: " vantage-peers ",
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.project).toBe("vantage-peers");
	});
});

describe("tasks:createDeployTaskWithDedup", () => {
	const deployBase = {
		assignedTo: "pi" as const,
		priority: "medium" as const,
		createdBy: "system" as const,
	};

	test("REFUSED: parsed deploy title without project", async () => {
		const t = await world();
		await expect(
			t.mutation(internal.tasks.createDeployTaskWithDedup, {
				...deployBase,
				title: "Deploy vantage-memory PR #12",
			}),
		).rejects.toThrow(CODE);
		expect(await allTasks(t)).toHaveLength(0);
	});

	test("REFUSED: unparsed title (plain insert path) with a blank project", async () => {
		const t = await world();
		await expect(
			t.mutation(internal.tasks.createDeployTaskWithDedup, {
				...deployBase,
				title: "free-form title",
				project: " ",
			}),
		).rejects.toThrow(CODE);
		expect(await allTasks(t)).toHaveLength(0);
	});

	test("PRESENT: the plain insert path carries the project", async () => {
		const t = await world();
		const plain = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			...deployBase,
			title: "free-form title",
			project: "vantage-memory",
		});
		expect(plain).not.toBeNull();
		const rows = await allTasks(t);
		expect(rows.map((r) => r.project)).toEqual(["vantage-memory"]);
	});
});

describe("tasks:createOrUpdateReviewTask", () => {
	const reviewBase = {
		repoFullName: "acme/widgets",
		prNumber: 7,
		prTitle: "A change",
		assignedTo: "pi" as const,
		priority: "high" as const,
		createdBy: "system" as const,
	};

	test("REFUSED: no project, no row written", async () => {
		const t = await world();
		await expect(
			t.mutation(internal.tasks.createOrUpdateReviewTask, reviewBase),
		).rejects.toThrow(CODE);
		expect(await allTasks(t)).toHaveLength(0);
	});

	test("PRESENT: the project is stored", async () => {
		const t = await world();
		const id = await t.mutation(internal.tasks.createOrUpdateReviewTask, {
			...reviewBase,
			project: "widgets",
		});
		const row = id === null ? null : await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.project).toBe("widgets");
	});
});

describe("recurringTasks: a schedule carries a project, so every spawn inherits one", () => {
	const scheduleBase = {
		title: "Daily routine",
		assignedTo: "sigma" as const,
		priority: "medium" as const,
		cronExpression: "0 9 * * *",
		createdBy: "sigma" as const,
	};

	test("REFUSED: create without / with empty project", async () => {
		const t = await world();
		await expect(
			asMaster(t).mutation(api.recurringTasks.create, scheduleBase),
		).rejects.toThrow(CODE);
		await expect(
			asMaster(t).mutation(api.recurringTasks.create, {
				...scheduleBase,
				project: " ",
			}),
		).rejects.toThrow(CODE);
		expect(
			await t.run(async (ctx) => ctx.db.query("recurringTasks").collect()),
		).toHaveLength(0);
	});

	test("PRESENT: create stores the trimmed project; the spawn inherits it", async () => {
		const t = await world();
		const id = await asMaster(t).mutation(api.recurringTasks.create, {
			...scheduleBase,
			project: " vantage-peers ",
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.project).toBe("vantage-peers");
		await t.run(async (ctx) =>
			ctx.db.patch(id, { nextRunAt: Date.now() - 1_000 }),
		);
		await t.mutation(internal.recurringTasks.processDueTasks, {});
		const spawned = await allTasks(t);
		expect(spawned).toHaveLength(1);
		expect(spawned[0].project).toBe("vantage-peers");
	});

	test("REFUSED: update that blanks the project", async () => {
		const t = await world();
		const id = await asMaster(t).mutation(api.recurringTasks.create, {
			...scheduleBase,
			project: "vantage-peers",
		});
		await expect(
			asMaster(t).mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				project: "",
				callerOrchestrator: "sigma",
			}),
		).rejects.toThrow(CODE);
	});

	test("SKIPPED: a legacy schedule with no project spawns nothing, logs, records the skip", async () => {
		const t = await world();
		const past = Date.now() - 60_000;
		const id = await t.run(async (ctx) =>
			ctx.db.insert("recurringTasks", {
				title: "Legacy routine",
				assignedTo: "sigma",
				priority: "medium",
				cronExpression: "0 9 * * *",
				nextRunAt: past,
				active: true,
				createdBy: "sigma",
				createdAt: past,
				updatedAt: past,
			}),
		);
		const logs: string[] = [];
		const orig = console.error;
		console.error = (...a: unknown[]) => {
			logs.push(a.join(" "));
		};
		try {
			await t.mutation(internal.recurringTasks.processDueTasks, {});
		} finally {
			console.error = orig;
		}
		expect(await allTasks(t)).toHaveLength(0);
		expect(logs.join("\n")).toMatch(CODE);
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.skippedRuns).toBe(1);
		expect(row?.lastSkipReason).toMatch(CODE);
		expect(row?.nextRunAt).toBeGreaterThan(past);
	});
});

describe("missionTemplates:instantiateTemplateIntoMission", () => {
	async function seed(t: T, project: string) {
		const missionId = await t.run(async (ctx) =>
			ctx.db.insert("missions", {
				name: "M",
				project,
				status: "execute",
				priority: "high",
				pilot: "pi",
				agents: [],
				createdBy: "pi",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		await asMaster(t).mutation(api.missionTemplates.upsert, {
			name: "tpl",
			description: "d",
			steps: [{ title: "One", description: "d" }],
			createdBy: "pi",
		});
		return missionId;
	}

	test("REFUSED: the mission has an empty project, no task written", async () => {
		const t = await world();
		const missionId = await seed(t, "  ");
		await expect(
			asMaster(t).mutation(
				api.missionTemplates.instantiateTemplateIntoMission,
				{
					templateName: "tpl",
					missionId,
				},
			),
		).rejects.toThrow(CODE);
		expect(await allTasks(t)).toHaveLength(0);
	});

	test("PRESENT: the tasks inherit the mission's project", async () => {
		const t = await world();
		const missionId = await seed(t, "proj-x");
		await asMaster(t).mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{
				templateName: "tpl",
				missionId,
			},
		);
		const rows = await allTasks(t);
		expect(rows.map((r) => r.project)).toEqual(["proj-x"]);
	});
});

describe("OKF import", () => {
	const insertArgs = {
		namespace: "project/elpi-corp",
		title: "Imported",
		description: "d",
		assignedTo: "sigma",
		priority: "medium" as const,
		status: "todo" as const,
		createdBy: "sigma",
		contentHash: "h1",
		now: 1_700_000_000_000,
	};

	test("REFUSED: _insertImportedTask with an empty project", async () => {
		const t = await world();
		await expect(
			t.mutation(internal.okfBundle._insertImportedTask, {
				...insertArgs,
				project: " ",
			}),
		).rejects.toThrow(CODE);
		expect(await allTasks(t)).toHaveLength(0);
	});

	test("PRESENT: _insertImportedTask stores the project", async () => {
		const t = await world();
		const id = await t.mutation(internal.okfBundle._insertImportedTask, {
			...insertArgs,
			project: "elpi-corp",
		});
		expect((await t.run(async (ctx) => ctx.db.get(id)))?.project).toBe(
			"elpi-corp",
		);
	});

	async function bundleWithTask(project: string | undefined) {
		const tsk = serializeTask({
			_id: "k179tsk900",
			title: "Imported task",
			description: "Body.",
			status: "todo",
			priority: "medium",
			assignedTo: "sigma",
			createdBy: "sigma",
			...(project !== undefined ? { project } : {}),
		});
		return await packTarball([
			{
				path: "index.md",
				content: '---\nokf_version: "0.1"\ntype: index\n---\n# Bundle\n',
			},
			{ path: tsk.filePath, content: tsk.content },
		]);
	}
	// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround, as okfBundleImport.test.ts
	const IMPORT = "okfBundleNode:importOkfBundle" as any;
	const store = (t: T, buf: Buffer) =>
		t.run(async (ctx) => ctx.storage.store(new Blob([new Uint8Array(buf)])));

	test("PRESENT: a task whose frontmatter names its project keeps it", async () => {
		const t = await world();
		const storageId = await store(t, await bundleWithTask("billing-line"));
		await asMaster(t).action(IMPORT, {
			storageId,
			targetNamespace: "project/elpi-corp",
			mode: "merge",
			idempotencyKey: "k-fm",
		});
		expect((await allTasks(t)).map((r) => r.project)).toEqual(["billing-line"]);
	});

	test("PRESENT: without frontmatter project, a project/<slug> namespace names it", async () => {
		const t = await world();
		const storageId = await store(t, await bundleWithTask(undefined));
		await asMaster(t).action(IMPORT, {
			storageId,
			targetNamespace: "project/elpi-corp",
			mode: "merge",
			idempotencyKey: "k-ns",
		});
		expect((await allTasks(t)).map((r) => r.project)).toEqual(["elpi-corp"]);
	});

	test("REFUSED: no frontmatter project and a namespace that names none -> reported in conflicts, not written, rest of the bundle imported", async () => {
		const t = await world();
		const tsk = serializeTask({
			_id: "k179tsk901",
			title: "No project",
			description: "Body.",
			status: "todo",
			priority: "medium",
			assignedTo: "sigma",
			createdBy: "sigma",
		});
		const buf = await packTarball([
			{
				path: "index.md",
				content: '---\nokf_version: "0.1"\ntype: index\n---\n# Bundle\n',
			},
			{ path: tsk.filePath, content: tsk.content },
		]);
		const storageId = await store(t, buf);
		const result = await asMaster(t).action(IMPORT, {
			storageId,
			targetNamespace: "global",
			mode: "merge",
			idempotencyKey: "k-none",
		});
		expect(result.imported.tasks).toBe(0);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0].path).toBe(tsk.filePath);
		expect(result.conflicts[0].reason).toMatch(CODE);
		expect(await allTasks(t)).toHaveLength(0);
	});
});
