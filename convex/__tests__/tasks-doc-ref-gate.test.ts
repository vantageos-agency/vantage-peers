/// <reference types="vite/client" />
/**
 * convex/__tests__/tasks-doc-ref-gate.test.ts
 *
 * Server-side DOC-REF gate on tasks:create (convex/lib/docRefGate.ts).
 * Poles:
 *   ACCEPTED   mapped project + `DOC-REF: <bible repo> @ <sha> <path> §<section>`
 *   REFUSED    mapped project: no DOC-REF / other repo / bare path / no sha / no section
 *   ABSTAIN    unmapped project, or the only mapping row is not an active fleet bible
 *   EXEMPT     [REVIEW] and *-AUTHORIZED titles, optionally behind [META] / [ADMIN]
 * Fixture names are generic: the client project and its bible repo are DATA.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { api } from "../_generated/api";
import { isDocRefExemptTitle, parseDocRefLines } from "../lib/docRefGate";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const SERVICE_ACCOUNT = "test-service-account-user-id";
const PROJECT = "acme-client";
const BIBLE = "acme-org/acme-bible";
const SHA = "0123abc";

async function world(rows: Array<Record<string, unknown>> = [bibleRow()]) {
	const t = convexTest(schema, modules);
	await seedFleetAgents(t, ["sigma", "pi"]);
	await t.run(async (ctx) => {
		for (const row of rows) {
			await ctx.db.insert("githubRepoMapping", row as never);
		}
	});
	return t.withIdentity({ subject: SERVICE_ACCOUNT });
}

function bibleRow(over: Record<string, unknown> = {}) {
	return {
		repo: BIBLE,
		orchestrator: "pi",
		project: PROJECT,
		active: true,
		bible: true,
		...over,
	};
}

const base = {
	title: "Build the thing",
	assignedTo: "pi" as const,
	priority: "medium" as const,
	status: "todo" as const,
	createdBy: "sigma" as const,
	project: PROJECT,
};

const goodRef = `DOC-REF: ${BIBLE} @ ${SHA} docs/spec.md §3.2`;

describe("tasks:create DOC-REF gate — mapped project", () => {
	test("ACCEPTED: bible repo @ sha + path + section", async () => {
		const t = await world();
		const id = await t.mutation(api.tasks.create, {
			...base,
			description: `Context.\n${goodRef}\nVERIFIED: x`,
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.project).toBe(PROJECT);
	});

	test("ACCEPTED: repo and sha case-insensitive, full 40-char sha", async () => {
		const t = await world();
		const id = await t.mutation(api.tasks.create, {
			...base,
			description: `doc-ref: ACME-ORG/Acme-Bible @ ${"0123456789ABCDEF".repeat(2)}01234567 a/b.md §1`,
		});
		expect(id).toBeTruthy();
	});

	test("REFUSED: no DOC-REF at all", async () => {
		const t = await world();
		await expect(
			t.mutation(api.tasks.create, { ...base, description: "just a brief" }),
		).rejects.toThrow(/DOC_REF_REQUIRED/);
	});

	test("REFUSED: description omitted", async () => {
		const t = await world();
		await expect(t.mutation(api.tasks.create, base)).rejects.toThrow(/DOC_REF_REQUIRED/);
	});

	test("REFUSED: DOC-REF names another repository", async () => {
		const t = await world();
		await expect(
			t.mutation(api.tasks.create, {
				...base,
				description: `DOC-REF: other-org/other-repo @ ${SHA} docs/spec.md §3.2`,
			}),
		).rejects.toThrow(/DOC_REF_REQUIRED/);
	});

	test("REFUSED: bare path (a fixture file, not the bible)", async () => {
		const t = await world();
		await expect(
			t.mutation(api.tasks.create, {
				...base,
				description: "DOC-REF: scripts/fixtures/x.json",
			}),
		).rejects.toThrow(/DOC_REF_REQUIRED/);
	});

	test("REFUSED: bible repo without a sha", async () => {
		const t = await world();
		await expect(
			t.mutation(api.tasks.create, {
				...base,
				description: `DOC-REF: ${BIBLE} docs/spec.md §3.2`,
			}),
		).rejects.toThrow(/DOC_REF_REQUIRED/);
	});

	test("REFUSED: bible repo @ sha without a section", async () => {
		const t = await world();
		await expect(
			t.mutation(api.tasks.create, {
				...base,
				description: `DOC-REF: ${BIBLE} @ ${SHA} docs/spec.md`,
			}),
		).rejects.toThrow(/DOC_REF_REQUIRED/);
	});

	test("REFUSED: the refusal names the expected form and repo, and writes no row", async () => {
		const t = await world();
		await expect(
			t.mutation(api.tasks.create, { ...base, description: "nope" }),
		).rejects.toThrow(new RegExp(`DOC-REF: <owner>/<repo> @ <sha.*${BIBLE}`));
		const rows = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(rows).toHaveLength(0);
	});
});

describe("tasks:create DOC-REF gate — exempt titles", () => {
	for (const title of [
		"[PR-MERGE-AUTHORIZED] merge PR 12",
		"[PROD-DEPLOY-AUTHORIZED] deploy",
		"[META] [PR-MERGE-AUTHORIZED] merge PR 12",
		"[ADMIN][REVIEW] gate PR 12",
		"[REVIEW] gate PR 12",
	]) {
		test(`EXEMPT: ${title}`, async () => {
			const t = await world();
			const id = await t.mutation(api.tasks.create, { ...base, title });
			expect(id).toBeTruthy();
		});
	}

	test("NOT exempt: a token in the middle of the title", async () => {
		const t = await world();
		await expect(
			t.mutation(api.tasks.create, { ...base, title: "Build [REVIEW] thing" }),
		).rejects.toThrow(/DOC_REF_REQUIRED/);
	});
});

describe("tasks:create DOC-REF gate — abstains", () => {
	test("ABSTAIN: unmapped project accepts a task with no DOC-REF", async () => {
		const t = await world();
		const id = await t.mutation(api.tasks.create, { ...base, project: "unmapped-project" });
		expect(id).toBeTruthy();
	});

	test("ABSTAIN: a mapping row that is not flagged bible does not gate", async () => {
		const t = await world([bibleRow({ bible: undefined })]);
		expect(await t.mutation(api.tasks.create, base)).toBeTruthy();
	});

	test("ABSTAIN: an inactive bible row does not gate", async () => {
		const t = await world([bibleRow({ active: false })]);
		expect(await t.mutation(api.tasks.create, base)).toBeTruthy();
	});

	test("ABSTAIN: a client org's bible row never gates the project", async () => {
		const t = await world([bibleRow({ orgId: "some-client-org" })]);
		expect(await t.mutation(api.tasks.create, base)).toBeTruthy();
	});
});

describe("githubRepoMapping:add carries the bible flag", () => {
	test("the master sets it and the gate then applies", async () => {
		const t = await world([]);
		await t.mutation(api.githubRepoMapping.add, {
			repo: BIBLE,
			orchestrator: "pi",
			project: PROJECT,
			bible: true,
		});
		const row = await t.run(async (ctx) =>
			ctx.db
				.query("githubRepoMapping")
				.withIndex("by_repo", (q) => q.eq("repo", BIBLE))
				.unique(),
		);
		expect(row?.bible).toBe(true);
		await expect(t.mutation(api.tasks.create, base)).rejects.toThrow(/DOC_REF_REQUIRED/);
	});
});

describe("docRefGate pure helpers", () => {
	test("parseDocRefLines reads every well-formed line", () => {
		const lines = parseDocRefLines(`x\n${goodRef}\nDOC-REF: bad`);
		expect(lines).toEqual([
			{ repo: BIBLE, sha: SHA, path: "docs/spec.md", section: "3.2" },
		]);
	});

	test("isDocRefExemptTitle", () => {
		expect(isDocRefExemptTitle("[REVIEW] x")).toBe(true);
		expect(isDocRefExemptTitle("fix [REVIEW]")).toBe(false);
	});
});
