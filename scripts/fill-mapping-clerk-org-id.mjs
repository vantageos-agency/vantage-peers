#!/usr/bin/env node
/**
 * fill-mapping-clerk-org-id.mjs — fill client_org_mapping.clerkOrgId (the permanent Clerk
 * org id, org_...) for every mapping, resolved from its slug through the Clerk Backend API.
 * Pi ruling (d), task k174d95s5qqy8t2r5rdrz3pr3d8fqv82: an organisation is identified by
 * its Clerk org id, never by its slug. This is step 1 of the deploy; the row backfill
 * (convex migrations/backfill_org_clerk_id) is step 2 and reads what this fills.
 *
 *   node scripts/fill-mapping-clerk-org-id.mjs --target dev|prod            # DRY RUN
 *   node scripts/fill-mapping-clerk-org-id.mjs --target dev|prod --apply    # writes
 *
 * --target is REQUIRED and has no default (a deploy target is never assumed).
 *
 * DRY RUN (default) prints the INVENTORY first -- every mapping, the id it already carries,
 * the id Clerk returns for its slug, and the verdict -- and writes nothing. --apply then
 * writes ONLY the rows whose verdict is FILL, through the internal mutation
 * clientOrgMapping:setClerkOrgId. A row already carrying a DIFFERENT id than Clerk reports
 * is CONFLICT and is never overwritten here (a correction is made on purpose, with
 * `replace:true`, by hand). A slug Clerk does not know is UNRESOLVED and listed, never guessed.
 *
 * SECRET HANDLING. CLERK_SECRET_KEY is read from .env.local and handed to curl through a
 * 0600 curl config file in a 0700 temp directory (deleted afterwards). It is never placed on
 * a command line, in the environment of a child, or in the output.
 *
 * Needs: the Convex CLI logged in for the chosen target, curl, a .env.local with
 * CLERK_SECRET_KEY at the repo root. For prod, only run it at the deploy step.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLERK_BASE = "https://api.clerk.com/v1/organizations/";
const ORG_ID = /^org_[A-Za-z0-9]+$/;

export function classify(mapping, resolved) {
	if (resolved === null) return "UNRESOLVED";
	if (resolved.slug !== mapping.clerkOrgSlug) return "UNRESOLVED";
	if (!ORG_ID.test(resolved.id)) return "UNRESOLVED";
	if (mapping.clerkOrgId === null) return "FILL";
	return mapping.clerkOrgId === resolved.id ? "OK" : "CONFLICT";
}

function readEnvLocal() {
	const text = readFileSync(join(ROOT, ".env.local"), "utf8");
	const m = text.match(/^\s*(?:export\s+)?CLERK_SECRET_KEY\s*=\s*(.+?)\s*$/m);
	if (!m) throw new Error("CLERK_SECRET_KEY not found in .env.local");
	return m[1].replace(/^["']|["']$/g, "");
}

function convexRun(target, fn, args) {
	const argv = ["convex", "run", ...(target === "prod" ? ["--prod"] : []), fn];
	if (args !== undefined) argv.push(JSON.stringify(args));
	return JSON.parse(
		execFileSync("npx", argv, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
	);
}

function clerkLookup(cfgDir, slug) {
	const cfg = join(cfgDir, `c-${Buffer.from(slug).toString("hex").slice(0, 24)}.cfg`);
	writeFileSync(cfg, `url = "${CLERK_BASE}${encodeURIComponent(slug)}"\n${HEADER_LINE}`, { mode: 0o600 });
	chmodSync(cfg, 0o600);
	const out = execFileSync("curl", ["-sS", "-K", cfg, "-w", "\n%{http_code}"], { encoding: "utf8" });
	const nl = out.lastIndexOf("\n");
	const status = Number(out.slice(nl + 1));
	if (status === 404) return null;
	if (status !== 200) throw new Error(`Clerk answered HTTP ${status} for slug "${slug}"`);
	const body = JSON.parse(out.slice(0, nl));
	return { id: String(body.id), slug: String(body.slug) };
}

let HEADER_LINE = "";

function main() {
	const argv = process.argv.slice(2);
	const ti = argv.indexOf("--target");
	const target = ti >= 0 ? argv[ti + 1] : undefined;
	if (target !== "dev" && target !== "prod") {
		console.error("usage: --target dev|prod [--apply]   (--target is required, no default)");
		process.exit(2);
	}
	const apply = argv.includes("--apply");
	HEADER_LINE = `header = "Authorization: Bearer ${readEnvLocal()}"\n`;
	const cfgDir = mkdtempSync(join(tmpdir(), "fill-clerk-org-id-"));
	chmodSync(cfgDir, 0o700);
	try {
		const mappings = convexRun(target, "clientOrgMapping:listMappingsForClerkIdFill");
		const rows = mappings.map((m) => {
			const resolved = clerkLookup(cfgDir, m.clerkOrgSlug);
			return { ...m, resolved, verdict: classify(m, resolved) };
		});
		console.log(`INVENTORY target=${target} mappings=${rows.length} mode=${apply ? "APPLY" : "DRY-RUN"}`);
		for (const r of rows) {
			console.log(
				[
					r.verdict.padEnd(10),
					r.clerkOrgSlug,
					`active=${r.isActive}`,
					`kind=${r.orgKind}`,
					`stored=${r.clerkOrgId ?? "-"}`,
					`clerk=${r.resolved === null ? "NOT_FOUND" : r.resolved.id}`,
				].join("  "),
			);
		}
		const count = (v) => rows.filter((r) => r.verdict === v).length;
		console.log(`SUMMARY FILL=${count("FILL")} OK=${count("OK")} CONFLICT=${count("CONFLICT")} UNRESOLVED=${count("UNRESOLVED")}`);
		if (!apply) {
			console.log("DRY RUN: nothing written. Re-run with --apply to write the FILL rows.");
			return;
		}
		for (const r of rows.filter((x) => x.verdict === "FILL")) {
			const res = convexRun(target, "clientOrgMapping:setClerkOrgId", {
				clerkOrgSlug: r.clerkOrgSlug,
				clerkOrgId: r.resolved.id,
			});
			console.log(`WROTE  ${res.clerkOrgSlug}  ${res.previous ?? "-"} -> ${res.current}`);
		}
	} finally {
		rmSync(cfgDir, { recursive: true, force: true });
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
