// A task may name the artifact it delivers. The typed `status` is a claim; the
// artifact is what the machine can read. This module holds the validators, the
// input guards and the ONE pure derivation shared by every reader.
//
// Nothing here touches the network: a Convex query cannot. Resolution happens in
// convex/taskDeliverable.ts (an internalAction) and lands in `deliverableState`.
import { v } from "convex/values";

/** What a task claims to deliver. Extensible later to { repo, pr }. */
export const deliverableValidator = v.object({
	pkg: v.string(),
	export: v.string(),
});

/** The last machine reading of that artifact. Written only by the resolver. */
export const deliverableStateValidator = v.object({
	state: v.union(
		v.literal("delivered"),
		v.literal("not_found"),
		v.literal("unresolved"),
	),
	version: v.optional(v.string()),
	checkedAt: v.number(),
	reason: v.optional(v.string()),
});

/** The only divergence there is today; absent means "no divergence known". */
export const deliverableDivergenceValidator = v.literal("delivered-but-open");

export type Deliverable = { pkg: string; export: string };
export type DeliverableState = {
	state: "delivered" | "not_found" | "unresolved";
	version?: string;
	checkedAt: number;
	reason?: string;
};

// npm package-name grammar (validate-npm-package-name, new packages): lower-case,
// optional @scope/, no path traversal. This string is concatenated into a registry
// URL, so it is checked before any fetch.
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// An ECMAScript identifier (an export name). `default` matches and is handled by
// the resolver.
const EXPORT_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const MAX_PKG_LENGTH = 214;
export const MAX_EXPORT_LENGTH = 200;

/** Returns a reason when the deliverable is not a well-formed {pkg, export}. */
export function deliverableProblem(d: Deliverable): string | null {
	if (d.pkg.length === 0 || d.pkg.length > MAX_PKG_LENGTH || !NPM_NAME_RE.test(d.pkg)) {
		return `pkg "${d.pkg.slice(0, 80)}" is not a valid npm package name`;
	}
	if (
		d.export.length === 0 ||
		d.export.length > MAX_EXPORT_LENGTH ||
		!EXPORT_NAME_RE.test(d.export)
	) {
		return `export "${d.export.slice(0, 80)}" is not a valid identifier`;
	}
	return null;
}

export function sameDeliverable(
	a: Deliverable | undefined,
	b: Deliverable | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.pkg === b.pkg && a.export === b.export;
}

/**
 * The derived signal, a pure function of STORED fields. "delivered-but-open":
 * the artifact is published but the typed status still says the work is open.
 * "Open" is anything that is not done or cancelled (a failed task whose export
 * is published is also a divergence worth surfacing). Otherwise undefined.
 */
export function deliverableDivergenceOf(doc: {
	status: string;
	deliverableState?: { state: string };
}): "delivered-but-open" | undefined {
	if (doc.deliverableState?.state !== "delivered") return undefined;
	if (doc.status === "done" || doc.status === "cancelled") return undefined;
	return "delivered-but-open";
}

/**
 * Adds `deliverableDivergence` beside the stored fields, only when it is set.
 * A row with no divergence is returned as the SAME object: its read shape is
 * byte-identical to before this field existed. The stored fields and `status`
 * are never overwritten.
 */
export function withDeliverableDivergence<
	T extends { status: string; deliverableState?: { state: string } },
>(doc: T): T & { deliverableDivergence?: "delivered-but-open" } {
	const divergence = deliverableDivergenceOf(doc);
	return divergence === undefined ? doc : { ...doc, deliverableDivergence: divergence };
}

// ── bounds of the re-resolution cron (convex/taskDeliverable.ts) ─────────────
/** Rows read per open status per run, newest first (the table's by_status index). */
export const RECHECK_SCAN_PER_STATUS = 300;
/** Resolutions scheduled per run, whatever the scan found. */
export const RECHECK_MAX_PER_RUN = 100;
/** A reading younger than this is not repeated by the cron. */
export const RECHECK_COOLDOWN_MS = 30 * 60 * 1000;
/** Statuses the cron re-reads: every one that is not done or cancelled. */
export const RECHECK_STATUSES = ["todo", "in_progress", "review", "blocked", "failed"] as const;
