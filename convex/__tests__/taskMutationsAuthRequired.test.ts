/// <reference types="vite/client" />
/**
 * convex/__tests__/taskMutationsAuthRequired.test.ts
 *
 * SECURITY REMEDIATION — task k1712yrxjr570m6ks81rnhjh5n8cryf0, ruled by
 * coordinator Pi. The ten public Convex task mutations (create, update,
 * blockTask, complete, failTask, start, checkout, deleteTask, bulkComplete,
 * attachReviewArtifact) were callable by ANYONE holding the deployment URL,
 * with zero identity verification — `assertTaskCallerAuthorized` trusted a
 * caller-supplied `callerOrchestrator` string with no ctx.auth check at all.
 * (attachReviewArtifact was the tenth public mutation, closed in
 * k17675gzd2bwtnvgp0qzmtx35h8csg23 / PR #1211.)
 *
 * This file proves both halves of the fix:
 *
 *   AUTH_REQUIRED        — every one of the ten mutations REFUSES a call
 *                           with no verified identity (ctx.auth.getUserIdentity()
 *                           === null), for both poles: the door is closed
 *                           unconditionally, and a call WITH identity still
 *                           succeeds (the fix does not also break legitimate
 *                           callers).
 *
 *   CONTRADICTION_REFUSED — when callerOrchestrator names an orchestrator
 *                           NOT in the verified identity's allowedOrchestrators
 *                           scope, the call is refused naming BOTH the
 *                           asserted name and the derived scope. The agreeing
 *                           pole (callerOrchestrator within the allowed scope)
 *                           still passes.
 *
 * See convex/lib/auth.ts (withOrgScope) for the client_org_mapping shape that
 * derives `allowedOrchestrators`, and convex/tasks.ts
 * (requireAuthenticatedCaller) for the full STEP 3/4 rationale comment this
 * file exercises.
 */

import { convexTest } from "convex-test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

const SERVICE_ACCOUNT_SUBJECT = "test-service-account-user-id"; // matches vitest.config.ts CLERK_SERVICE_ACCOUNT_USER_ID

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	opts: { clerkOrgSlug: string; allowedOrchestrators: string[] },
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: opts.clerkOrgSlug,
			allowedOrchestrators: opts.allowedOrchestrators,
			scopes: ["view-own-tasks", "view-own-missions", "view-orchestrator-summary"],
			displayName: opts.clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedTask(
	t: ReturnType<typeof createT>,
	overrides: Partial<{ assignedTo: string; createdBy: string; status: string }> = {},
) {
	return await t
		.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
		.mutation(api.tasks.create, {
			title: "Seed task",
			assignedTo: overrides.assignedTo ?? "sigma",
			priority: "medium",
			status: (overrides.status as "todo") ?? "todo",
			createdBy: overrides.createdBy ?? overrides.assignedTo ?? "sigma",
		});
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH_REQUIRED — both poles, all nine mutations
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTH_REQUIRED — unauthenticated callers are refused, all ten public task mutations", () => {
	test("create: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();

		await expect(
			t.mutation(api.tasks.create, {
				title: "anon-created",
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const taskId = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.mutation(api.tasks.create, {
				title: "auth-created",
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
			});
		expect(taskId).toBeTruthy();
	});

	test("update: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				title: "anon-mutated",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			title: "auth-mutated",
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.title).toBe("auth-mutated");
	});

	test("blockTask: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const blockerId = await seedTask(t, { assignedTo: "eta", createdBy: "eta" });
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.blockTask, {
				taskId,
				callerOrchestrator: "sigma",
				blockedOnTaskId: blockerId,
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			blockedOnTaskId: blockerId,
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("blocked");
	});

	test("complete: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "anon completion attempt sha:deadbeef1",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: "auth completion sha:deadbeef2",
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("done");
	});

	test("failTask: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.failTask, {
				taskId,
				callerOrchestrator: "sigma",
				failureNote: "anon failure attempt",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.failTask, {
			taskId,
			callerOrchestrator: "sigma",
			failureNote: "auth failure note",
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("failed");
	});

	test("start: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.start, {
				taskId,
				callerOrchestrator: "sigma",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "sigma",
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("in_progress");
	});

	test("checkout: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.checkout, {
				taskId,
				callerOrchestrator: "sigma",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const result = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.mutation(api.tasks.checkout, {
				taskId,
				callerOrchestrator: "sigma",
			});
		expect(result.claimed).toBe(true);
	});

	test("deleteTask: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.deleteTask, {
				taskId,
				callerOrchestrator: "sigma",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const result = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.mutation(api.tasks.deleteTask, {
				taskId,
				callerOrchestrator: "sigma",
			});
		expect(result.deleted).toBe(true);
	});

	test("bulkComplete: no identity -> AUTH_REQUIRED on the dry-run preview path too", async () => {
		const t = createT();
		await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.bulkComplete, {
				filter: { assignedTo: "sigma" },
				dryRun: true,
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const preview = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.mutation(api.tasks.bulkComplete, {
				filter: { assignedTo: "sigma" },
				dryRun: true,
			});
		expect(preview.count).toBeGreaterThanOrEqual(1);
	});

	test("attachReviewArtifact: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "eta", createdBy: "pi" });

		await expect(
			t.mutation(api.tasks.attachReviewArtifact, {
				taskId,
				callerOrchestrator: "sigma",
				artifactRef: "https://github.com/org/repo/pull/1234",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.mutation(api.tasks.attachReviewArtifact, {
				taskId,
				callerOrchestrator: "sigma",
				artifactRef: "https://github.com/org/repo/pull/1234",
			});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.reviewArtifactRef).toBe("https://github.com/org/repo/pull/1234");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRADICTION_REFUSED — callerOrchestrator vs the verified identity's
// derived scope (client_org_mapping.allowedOrchestrators)
// ─────────────────────────────────────────────────────────────────────────────

describe("CALLER_IDENTITY_MISMATCH — callerOrchestrator contradicting the verified identity's scope is refused, agreeing passes", () => {
	test("update: callerOrchestrator outside the org's allowedOrchestrators -> refused naming both; inside -> passes", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-hr",
			allowedOrchestrators: ["victor"],
		});
		const taskId = await seedTask(t, { assignedTo: "victor", createdBy: "victor" });

		const tVictorOrg = t.withIdentity({
			subject: "user-nadia",
			organizationSlug: "acme-hr",
		} as Parameters<typeof t.withIdentity>[0]);

		// Contradicting pole: the verified identity's org only allows "victor",
		// but the call asserts "sigma" as callerOrchestrator.
		const error = await tVictorOrg
			.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				title: "mismatch-attempt",
			})
			.catch((e) => e);
		expect(String(error)).toMatch(/CALLER_IDENTITY_MISMATCH/);
		expect(String(error)).toMatch(/sigma/);
		expect(String(error)).toMatch(/victor/);

		// Agreeing pole: callerOrchestrator "victor" is in the org's allowed set.
		await tVictorOrg.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "victor",
			title: "agreeing-update",
		});
		const after = await tVictorOrg.query(api.tasks.get, { taskId });
		expect(after?.title).toBe("agreeing-update");
	});

	test("complete: callerOrchestrator outside allowedOrchestrators -> refused; inside -> passes", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-hr",
			allowedOrchestrators: ["victor"],
		});
		const taskId = await seedTask(t, { assignedTo: "victor", createdBy: "victor" });
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: Date.now(),
			});
		});

		const tVictorOrg = t.withIdentity({
			subject: "user-nadia",
			organizationSlug: "acme-hr",
		} as Parameters<typeof t.withIdentity>[0]);

		const error = await tVictorOrg
			.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "mismatch attempt sha:deadbeef3",
			})
			.catch((e) => e);
		expect(String(error)).toMatch(/CALLER_IDENTITY_MISMATCH/);
		expect(String(error)).toMatch(/sigma/);
		expect(String(error)).toMatch(/victor/);

		await tVictorOrg.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "victor",
			completionNote: "agreeing completion sha:deadbeef4",
		});
		const after = await tVictorOrg.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("done");
	});

	test("master/service-account identity bypasses the membership check regardless of callerOrchestrator (isMaster short-circuit, unaffected regression)", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		// Service account has isMaster=true (see convex/lib/auth.ts
		// CLERK_SERVICE_ACCOUNT_USER_ID carve-out) — any callerOrchestrator
		// string still reaches the resource-derived assertTaskCallerAuthorized
		// check below it, unaffected by CALLER_IDENTITY_MISMATCH.
		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "system",
			title: "master-bypass-update",
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.title).toBe("master-bypass-update");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// DERIVED — task k172m4cv5cnn8qw9qwsh69gjqx8ctsyc: the mutation list this suite
// exercises MUST be read out of convex/tasks.ts at runtime, not kept as a
// hand-written property of the test file itself. The twelve hand-written
// cases above named the ten mutations from memory — that is exactly why the
// suite stayed green when an eleventh, ungated public mutation existed
// (ETA-M10 / #1211). This block re-derives the public-mutation surface by
// parsing the source and asserts each handler body calls
// requireAuthenticatedCaller. It also refuses (fails loud) on an unreadable
// source or an empty derived list — the empty-list-reported-as-green failure
// mode is the same disease one layer down and must not recur here.
// ─────────────────────────────────────────────────────────────────────────────

interface DerivedPublicMutation {
	name: string;
	/** 1-indexed line number of the `export const <name> = mutation(` declaration */
	line: number;
	/** source slice from the declaration line up to (excluding) the next top-level `export const` */
	body: string;
}

class TaskMutationSourceUnreadableError extends Error {
	constructor(path: string, cause: unknown) {
		super(
			`DERIVED_MUTATION_LIST_UNREADABLE: could not read/parse ${path} to derive the public mutation list — refusing to report an empty list as green. Cause: ${String(cause)}`,
		);
		this.name = "TaskMutationSourceUnreadableError";
	}
}

function resolveTasksSourcePath(): string {
	const testFileDir = dirname(fileURLToPath(import.meta.url));
	// this test lives at convex/__tests__/taskMutationsAuthRequired.test.ts
	return resolve(testFileDir, "..", "tasks.ts");
}

/**
 * Strips line comments (`// ...`) and block comments (`/* ... *\/`) from a
 * source string, WITHOUT collapsing lines, so that (a) a gate mentioned only
 * in a comment can never satisfy the gate check (ETA-M11), and (b) line
 * numbers computed against the stripped source still line up with the
 * original source (each removed comment is replaced by whitespace of the
 * same length, newlines preserved).
 */
function stripComments(source: string): string {
	let out = "";
	let i = 0;
	const len = source.length;
	while (i < len) {
		const ch = source[i];
		const next = source[i + 1];
		if (ch === "/" && next === "/") {
			// line comment: blank out to (not including) the newline
			while (i < len && source[i] !== "\n") {
				out += " ";
				i++;
			}
			continue;
		}
		if (ch === "/" && next === "*") {
			// block comment: blank out everything except newlines, up to `*/`
			out += "  ";
			i += 2;
			while (i < len && !(source[i] === "*" && source[i + 1] === "/")) {
				out += source[i] === "\n" ? "\n" : " ";
				i++;
			}
			if (i < len) {
				out += "  ";
				i += 2;
			}
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * Parses the WHOLE (comment-stripped) convex/tasks.ts source and extracts
 * every PUBLIC mutation (`export const <name> =` followed, after any
 * whitespace/newlines, by `mutation(`), explicitly excluding
 * `internalMutation(` exports, along with the source slice of its body (up
 * to the next top-level `export const` declaration) so callers can grep the
 * body for the identity gate. Unlike a line-by-line scan, this survives a
 * wrapped declaration such as:
 *
 *   export const x =
 *     mutation({ ... })
 *
 * (ETA-M12) which a `^export const \w+ = mutation\(` per-line regex simply
 * never sees — the declaration is invisible to the parser rather than
 * flagged as ungated, so the derived count silently stays wrong.
 *
 * EXPORTED (ETA-M13) so its two refusal branches — unreadable source, and a
 * real file with zero public mutations — can be exercised directly by unit
 * tests instead of only indirectly through the whole-suite "file absent"
 * case.
 */
// eslint-disable-next-line no-restricted-exports -- ETA-M13: exported deliberately so the
// two refusal branches (unreadable source, real file with zero public mutations) can be
// exercised directly by unit tests below, not only indirectly via the whole-suite case.
export function deriveTaskMutationsOrThrow(sourcePath: string): DerivedPublicMutation[] {
	let rawSource: string;
	try {
		rawSource = readFileSync(sourcePath, "utf8");
	} catch (cause) {
		throw new TaskMutationSourceUnreadableError(sourcePath, cause);
	}

	if (!rawSource || rawSource.trim().length === 0) {
		throw new TaskMutationSourceUnreadableError(
			sourcePath,
			"file read succeeded but content is empty",
		);
	}

	const source = stripComments(rawSource);

	// Whole-source scan: `export const NAME =` then, allowing intervening
	// whitespace/newlines (a wrapped declaration), `mutation(`. A lookahead
	// negative on `internal` immediately before `mutation(` is not needed
	// because `internalMutation(` never matches the required `\bmutation\(`
	// boundary below (the `\b` sits between `internal` and `Mutation`, so
	// `internalMutation(` fails the `mutation\(` match entirely — it reads as
	// one identifier token, not two). Guarded explicitly anyway for clarity.
	const DECL_RE = /export const (\w+)\s*=\s*(internalMutation|mutation)\s*\(/g;

	const declarations: Array<{ name: string; index: number; kind: string }> = [];
	for (const match of source.matchAll(DECL_RE)) {
		const [, name, kind] = match;
		if (kind === "internalMutation") continue;
		declarations.push({ name, index: match.index, kind });
	}

	if (declarations.length === 0) {
		throw new TaskMutationSourceUnreadableError(
			sourcePath,
			"parsed the file successfully but derived ZERO public mutations — this is the exact empty-enumeration failure mode this test guards against",
		);
	}

	// Top-level `export const NAME =` boundaries (any kind), used only to
	// bound each mutation's handler body slice.
	const TOP_LEVEL_EXPORT_RE = /export const \w+\s*=/g;
	const exportBoundaries: number[] = [];
	for (const boundaryMatch of source.matchAll(TOP_LEVEL_EXPORT_RE)) {
		exportBoundaries.push(boundaryMatch.index);
	}

	const indexToLine = (index: number): number => {
		// count newlines in the ORIGINAL raw source up to `index`; stripComments
		// preserves newline positions exactly, so this is 1:1 accurate.
		let line = 1;
		for (let i = 0; i < index && i < rawSource.length; i++) {
			if (rawSource[i] === "\n") line++;
		}
		return line;
	};

	const results: DerivedPublicMutation[] = declarations.map((decl) => {
		const nextBoundary = exportBoundaries.find((b) => b > decl.index);
		const endIndex = nextBoundary ?? source.length;
		const body = source.slice(decl.index, endIndex);
		return { name: decl.name, line: indexToLine(decl.index), body };
	});

	return results;
}

/**
 * True only when the handler body contains a REAL CALL to
 * requireAuthenticatedCaller (`requireAuthenticatedCaller(` — the call
 * form), never a bare textual mention. Comments are already stripped out of
 * `body` by deriveTaskMutationsOrThrow, so a comment-only reference such as
 * `// requireAuthenticatedCaller(ctx, args)` cannot satisfy this (ETA-M11) —
 * both defenses (comment-stripping upstream, call-form regex here) are
 * independently sufficient and kept together deliberately.
 */
function callsRequireAuthenticatedCaller(body: string): boolean {
	return /requireAuthenticatedCaller\s*\(/.test(body);
}

describe("DERIVED — public mutation list read structurally from convex/tasks.ts, not hand-written", () => {
	test("MUST_REFUSE: fails loud (non-zero) naming the source when convex/tasks.ts is unreadable, never a silent pass on an empty list", () => {
		expect(() =>
			deriveTaskMutationsOrThrow(
				resolve(dirname(fileURLToPath(import.meta.url)), "does-not-exist-tasks.ts"),
			),
		).toThrow(/DERIVED_MUTATION_LIST_UNREADABLE/);
	});

	test("derives a non-empty public mutation list from convex/tasks.ts and every one carries requireAuthenticatedCaller in its handler body", () => {
		const sourcePath = resolveTasksSourcePath();
		const derived = deriveTaskMutationsOrThrow(sourcePath);

		// eslint-disable-next-line no-console
		console.log(
			`DERIVED public task mutations (${derived.length}): ${derived
				.map((d) => `${d.name}@L${d.line}`)
				.join(", ")}`,
		);

		expect(
			derived.length,
			"derived public mutation list must be non-empty — an empty enumeration must never report green",
		).toBeGreaterThan(0);

		const ungated = derived.filter((d) => !callsRequireAuthenticatedCaller(d.body));

		if (ungated.length > 0) {
			const detail = ungated.map((d) => `${d.name} (convex/tasks.ts:${d.line})`).join(", ");
			throw new Error(
				`UNGATED_PUBLIC_MUTATION: the following public mutation(s) in convex/tasks.ts do not call requireAuthenticatedCaller in their handler body: ${detail}`,
			);
		}

		expect(ungated).toEqual([]);
	});

	// ETA-M13: exercise the derivation helper's two refusal branches directly,
	// not only through the whole-suite "file absent" case. "never green on
	// empty" requires proving BOTH poles refuse loudly: an unreadable path,
	// and a real, readable file that legitimately has zero public mutations.

	test("MUST_REFUSE: throws the named error for an absent/unreadable source path (never returns [])", () => {
		const absentPath = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"does-not-exist-tasks.ts",
		);
		expect(() => deriveTaskMutationsOrThrow(absentPath)).toThrow(
			/DERIVED_MUTATION_LIST_UNREADABLE/,
		);
	});

	test("MUST_REFUSE: throws the named error for a real, readable file with ZERO public mutations, never returns [] / passes", () => {
		// convex/schema.ts is a real file in this repo with no
		// `export const X = mutation(` declarations at all — the exact
		// zero-mutation pole this guard must refuse, not silently pass.
		const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schema.ts");
		expect(() => deriveTaskMutationsOrThrow(schemaPath)).toThrow(
			/DERIVED_MUTATION_LIST_UNREADABLE/,
		);
	});
});
