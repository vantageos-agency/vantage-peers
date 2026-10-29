"use node";
// Resolves a task's `deliverable` ({ pkg, export }) against the npm registry and
// records the reading in `deliverableState` (through taskDeliverableDb). A Convex
// query cannot reach the network, so this runs as an action: scheduled when a
// deliverable is set or changed (convex/tasks.ts), and re-run for open tasks by
// the cron in convex/crons.ts.
//
// FAIL-CLOSED: anything that is not a positive reading of the published package
// (network error, non-200, bad JSON, bad tarball, no entry point, oversize) is
// "unresolved" with a named reason. "delivered" is written only when the export
// name was found in the published entry files. The residue of that check is
// stated in convex/lib/npmExportCheck.ts.
import { gunzipSync } from "node:zlib";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
	RECHECK_COOLDOWN_MS,
	RECHECK_MAX_PER_RUN,
	deliverableProblem,
	type DeliverableState,
} from "./lib/taskDeliverable";
import { checkExportPublished, readTarFiles } from "./lib/npmExportCheck";

export { RECHECK_MAX_PER_RUN };

const REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const REASON_MAX = 240;
/** Spacing between the resolutions a cron run schedules (registry politeness). */
const STAGGER_MS = 250;

type Reading = Omit<DeliverableState, "checkedAt">;

function unresolved(reason: string): Reading {
	return { state: "unresolved", reason: reason.slice(0, REASON_MAX) };
}

async function fetchChecked(url: string): Promise<Response | Reading> {
	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (err) {
		return unresolved(`fetch_failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!res.ok) return unresolved(`registry_http_${res.status}`);
	return res;
}

/** One reading of {pkg, export}. Never throws: every failure is a named "unresolved". */
async function readDeliverable(pkg: string, name: string): Promise<Reading> {
	const problem = deliverableProblem({ pkg, export: name });
	if (problem !== null) return unresolved(`invalid_deliverable: ${problem}`);

	const manifestRes = await fetchChecked(`${REGISTRY}/${pkg.replace("/", "%2F")}/latest`);
	if (!(manifestRes instanceof Response)) return manifestRes;
	let manifest: Record<string, unknown>;
	try {
		const parsed: unknown = await manifestRes.json();
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return unresolved("registry_json_invalid: not an object");
		}
		manifest = parsed as Record<string, unknown>;
	} catch (err) {
		return unresolved(`registry_json_invalid: ${err instanceof Error ? err.message : String(err)}`);
	}
	const version = manifest.version;
	const dist = manifest.dist;
	const tarballUrl =
		typeof dist === "object" && dist !== null
			? (dist as { tarball?: unknown }).tarball
			: undefined;
	if (typeof version !== "string" || typeof tarballUrl !== "string") {
		return unresolved("registry_manifest_incomplete: version or dist.tarball missing");
	}
	// The tarball URL comes from the response body: only the registry's own host
	// is ever fetched (no SSRF through a crafted manifest).
	if (!tarballUrl.startsWith(`${REGISTRY}/`)) {
		return unresolved("tarball_url_not_registry");
	}

	const tarRes = await fetchChecked(tarballUrl);
	if (!(tarRes instanceof Response)) return tarRes;
	const declared = Number(tarRes.headers.get("content-length") ?? "0");
	if (declared > MAX_TARBALL_BYTES) return unresolved("tarball_too_large");
	let files;
	try {
		const gz = new Uint8Array(await tarRes.arrayBuffer());
		if (gz.length > MAX_TARBALL_BYTES) return unresolved("tarball_too_large");
		const tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
		files = readTarFiles(new Uint8Array(tar.buffer, tar.byteOffset, tar.byteLength));
	} catch (err) {
		return unresolved(`tarball_unreadable: ${err instanceof Error ? err.message : String(err)}`);
	}

	const check = checkExportPublished(manifest, files, name);
	if (check.kind === "found") return { state: "delivered", version };
	if (check.kind === "absent") {
		return { state: "not_found", version, reason: `export "${name}" not declared by the entry files of ${pkg}@${version}` };
	}
	return { ...unresolved(`no_entry_point_in_tarball of ${pkg}@${version}`), version };
}

export const resolveTaskDeliverable = internalAction({
	args: {
		taskId: v.id("tasks"),
		pkg: v.string(),
		export: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const reading = await readDeliverable(args.pkg, args.export);
		const written: boolean = await ctx.runMutation(
			internal.taskDeliverableDb.recordDeliverableState,
			{
				taskId: args.taskId,
				deliverable: { pkg: args.pkg, export: args.export },
				deliverableState: { ...reading, checkedAt: Date.now() },
			},
		);
		console.log(
			`[taskDeliverable] ${args.pkg}#${args.export} -> ${reading.state} written=${written}${reading.reason ? ` reason=${reading.reason}` : ""}`,
		);
		return null;
	},
});

/**
 * Cron body: re-resolve open tasks that carry a deliverable. Bounded at
 * RECHECK_MAX_PER_RUN resolutions per run (scan bound: RECHECK_SCAN_PER_STATUS per
 * open status, convex/taskDeliverableDb.ts), skipping readings younger than
 * RECHECK_COOLDOWN_MS. Returns how many resolutions it scheduled.
 */
export const recheckOpenDeliverables = internalAction({
	args: {},
	returns: v.number(),
	handler: async (ctx) => {
		const candidates: Array<{
			taskId: import("./_generated/dataModel").Id<"tasks">;
			deliverable: { pkg: string; export: string };
			checkedAt?: number;
		}> = await ctx.runQuery(internal.taskDeliverableDb.listOpenDeliverables, {});
		const now = Date.now();
		let scheduled = 0;
		for (const c of candidates) {
			if (scheduled >= RECHECK_MAX_PER_RUN) break;
			if (c.checkedAt !== undefined && now - c.checkedAt < RECHECK_COOLDOWN_MS) continue;
			await ctx.scheduler.runAfter(scheduled * STAGGER_MS, internal.taskDeliverable.resolveTaskDeliverable, {
				taskId: c.taskId,
				pkg: c.deliverable.pkg,
				export: c.deliverable.export,
			});
			scheduled += 1;
		}
		console.log(
			`[taskDeliverable] recheck: ${candidates.length} candidate(s), ${scheduled} scheduled (cap ${RECHECK_MAX_PER_RUN})`,
		);
		return scheduled;
	},
});
