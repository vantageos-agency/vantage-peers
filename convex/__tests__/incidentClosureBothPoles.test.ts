/// <reference types="vite/client" />
/**
 * convex/__tests__/incidentClosureBothPoles.test.ts
 *
 * Day 158/159 (k175y04n5vhek8zrdxgek0m85h8cry13) — incident-closure
 * both-poles gate. A completion on a task tagged "incident" is refused
 * unless its completionNote carries an EXECUTED call with BOTH poles: the
 * FAILING observation (request id + structured error marker) AND the
 * RETURNING observation (a second, distinct request id + a backtick-quoted
 * returned field). See convex/lib/taskClosureGate.ts for the full doc block.
 *
 * The PASS material below is the VERBATIM completionNote of the real
 * closure task k176kpz2 (author-independent material — not text written to
 * satisfy this file's own regexes). It MUST pass end-to-end; this is the
 * probe the coordinator ran that caught the first version's false-negative
 * (backtick-only returning marker, 2-distinct-id requirement) — see
 * convex/lib/taskClosureGate.ts REWORK comment for the full account.
 *
 * RED cases:
 *   (a) in-scope, ONE pole only (failing, no returning) → REFUSE
 *   (a2) in-scope, ONE pole only (returning, no failing) → REFUSE
 *   (b) in-scope, NEITHER pole → REFUSE
 * GREEN/PASS cases:
 *   (c) in-scope, BOTH poles executed — verbatim real k176kpz2 note → PASS
 *   (d) NOT in-scope (no "incident" tag) with a one-pole note that would be
 *       refused if in-scope → PASSES untouched (mandatory not-in-scope pole)
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

// CORE-A (task k1712yrxjr570…): every public task mutation now requires a verified
// identity (requireAuthenticatedCaller). Authenticate create/complete with the
// service-account subject — matches vitest.config.ts CLERK_SERVICE_ACCOUNT_USER_ID,
// the same subject the sibling CORE-A suites use.
const SERVICE_ACCOUNT_SUBJECT = "test-service-account-user-id";

// Verbatim completionNote of the real closure, task k176kpz2 — NOT authored
// by this file to satisfy its own regexes. Must pass end-to-end.
const BOTH_POLES_NOTE =
	"CLOSURE PAIR: RED pole already taken (get_task k174my0tqgh1qwjh6sggwxem7h8cpgzf threw Server Error twice, request ids cbd093fa714f6bc6 / a2db9b965398797d, while writable via update_task). GREEN pole taken now: get_task k174my0tqgh1qwjh6sggwxem7h8cpgzf RETURNS THE WHOLE ROW through the single-document path — blockedOnNobodyReason present, no Server Error — the read that used to crash now serves.";

const FAILING_ONLY_NOTE =
	"get_task threw Server Error twice (request id cbd093fa714f6bc6) — investigating root cause in the returns validator, no fix confirmed yet.";

const RETURNING_ONLY_NOTE =
	"get_task now RETURNS the whole row, blockedOnNobodyReason present — the read that used to crash now serves, no prior failure cited here.";

const NEITHER_POLE_NOTE =
	"Fixed the returns-validator omission and deployed the change to prod, all good now.";

describe("incident-closure both-poles gate (Day 158/159)", () => {
	test("(a) in-scope, FAILING pole only → REFUSE", async () => {
		const t = convexTest(schema, modules);
		const taskId = await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.create, {
			title: "Incident: returns validator ReturnsValidationError",
			assignedTo: "sigma",
			priority: "urgent" as const,
			status: "todo" as const,
			createdBy: "sigma",
			tags: ["incident"],
		});

		await expect(
			t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: FAILING_ONLY_NOTE,
			}),
		).rejects.toThrow(/INCIDENT_CLOSURE_REQUIRES_BOTH_POLES/);
	});

	test("(a2) in-scope, RETURNING pole only → REFUSE", async () => {
		const t = convexTest(schema, modules);
		const taskId = await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.create, {
			title: "Incident: returns validator ReturnsValidationError",
			assignedTo: "sigma",
			priority: "urgent" as const,
			status: "todo" as const,
			createdBy: "sigma",
			tags: ["incident"],
		});

		await expect(
			t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: RETURNING_ONLY_NOTE,
			}),
		).rejects.toThrow(/INCIDENT_CLOSURE_REQUIRES_BOTH_POLES/);
	});

	test("(b) in-scope, NEITHER pole → REFUSE", async () => {
		const t = convexTest(schema, modules);
		const taskId = await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.create, {
			title: "Incident: returns validator ReturnsValidationError",
			assignedTo: "sigma",
			priority: "urgent" as const,
			status: "todo" as const,
			createdBy: "sigma",
			tags: ["incident"],
		});

		await expect(
			t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: NEITHER_POLE_NOTE,
			}),
		).rejects.toThrow(/INCIDENT_CLOSURE_REQUIRES_BOTH_POLES/);
	});

	test("(c) in-scope, BOTH poles executed (real #1196/#1205 shape) → PASS", async () => {
		const t = convexTest(schema, modules);
		const taskId = await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.create, {
			title: "Incident: returns validator ReturnsValidationError",
			assignedTo: "sigma",
			priority: "urgent" as const,
			status: "todo" as const,
			createdBy: "sigma",
			tags: ["incident"],
		});

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: BOTH_POLES_NOTE,
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
	});

	test("(d) NOT in-scope (no incident tag), one-pole note → PASSES untouched", async () => {
		const t = convexTest(schema, modules);
		const taskId = await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.create, {
			title: "Routine follow-up, not an incident",
			assignedTo: "sigma",
			priority: "medium" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: FAILING_ONLY_NOTE,
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
	});
});
