#!/usr/bin/env node
/**
 * onboard-person.mjs — onboard ONE person onto VantagePeers Cloud with one command
 * (task k178xp66h7p0ds6vg69sqzw2vn8hbfrw). Runbook: runbooks/onboard-client-org.md ("Person onboarding").
 *
 *   node scripts/onboard-person.mjs --org-slug acme --org-name "Acme" \
 *       --name "Pat Example" --email pat@client.test \
 *       --agents "Milo:claude,Sacha:chatgpt,Alma:grok" [--lang fr|en] [--redirect-url https://…]   # DRY RUN
 *   … --send                                                                                       # executes
 *
 * Dry run is the default: it reads (Clerk, Convex) and prints the plan; it writes nothing. The
 * command RETURNS the invitation URL and never emails anyone.
 *
 * Secrets: the Clerk secret key comes from CLERK_SECRET_KEY or from the curl config file named by
 * CLERK_CURL_CONFIG (mode 0600, a `header = "Authorization: Bearer sk_…"` line). It is never printed.
 * Prod Convex goes through the allow-listed door .claude/scripts/convex-prod.sh (override the path
 * with CONVEX_PROD_SH); run this from the checkout that owns that door and its .env.local.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { onboardPerson, parseArgs } from "./lib/onboard-person-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function clerkKey(env) {
	if (env.CLERK_SECRET_KEY) return env.CLERK_SECRET_KEY;
	const file = env.CLERK_CURL_CONFIG;
	if (!file) throw new Error("no Clerk credential: set CLERK_SECRET_KEY or CLERK_CURL_CONFIG (a 0600 curl config)");
	if ((statSync(file).mode & 0o077) !== 0) throw new Error(`${file} must be mode 0600`);
	const m = /Bearer\s+(sk_[A-Za-z0-9_]+)/.exec(readFileSync(file, "utf8"));
	if (!m) throw new Error(`${file} holds no "Bearer sk_…" header`);
	return m[1];
}

function clerkApi(key) {
	return async (method, path, body) => {
		const res = await fetch(`https://api.clerk.com/v1${path}`, {
			method,
			headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const json = await res.json().catch(() => null);
		if (!res.ok) {
			// status and the first error code only: never the key, never the whole body.
			throw new Error(`Clerk ${method} ${path} -> HTTP ${res.status} ${json?.errors?.[0]?.code ?? ""}`.trim());
		}
		return json;
	};
}

const asList = (j) => (Array.isArray(j) ? j : (j?.data ?? []));

function clerkIo(api) {
	return {
		findOrg: async (slug) => {
			const hit = asList(await api("GET", `/organizations?query=${encodeURIComponent(slug)}&limit=100`)).find(
				(o) => o.slug === slug,
			);
			return hit ? { id: hit.id, slug: hit.slug } : null;
		},
		createOrg: async ({ name, slug }) => {
			const o = await api("POST", "/organizations", { name, slug });
			return { id: o.id, slug: o.slug };
		},
		findPendingInvitation: async (orgId, email) => {
			const inv = asList(
				await api("GET", `/organizations/${orgId}/invitations?status=pending&email_address=${encodeURIComponent(email)}&limit=10`),
			).find((i) => i.email_address?.toLowerCase() === email);
			return inv ? { id: inv.id, url: inv.url ?? null } : null;
		},
		createInvitation: async (orgId, body) => {
			const inv = await api("POST", `/organizations/${orgId}/invitations`, body);
			if (!inv.url) throw new Error(`Clerk created invitation ${inv.id} but returned no url; nothing was emailed (notify:false)`);
			return { id: inv.id, url: inv.url };
		},
	};
}

function convexIo(env) {
	const door = env.CONVEX_PROD_SH ?? resolve(here, "..", ".claude", "scripts", "convex-prod.sh");
	return {
		run: async (fn, args) => {
			const r = spawnSync("bash", [door, "run", fn, JSON.stringify(args)], { encoding: "utf8" });
			if (r.status !== 0) throw new Error(`${fn} failed (exit ${r.status}): ${(r.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`);
			const out = r.stdout.trim();
			try {
				return JSON.parse(out);
			} catch {
				const at = out.search(/^[[{"]/m);
				return JSON.parse(out.slice(at));
			}
		},
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2), process.env);
	const io = { clerk: clerkIo(clerkApi(clerkKey(process.env))), convex: convexIo(process.env) };
	const out = await onboardPerson(options, io);
	for (const line of out.plan) console.log(`  ${line}`);
	if (out.mode === "dry-run") {
		console.log("DRY RUN: nothing written. Re-run with --send to execute.");
		return;
	}
	console.log(JSON.stringify(out.result, null, 2));
}

main().catch((e) => {
	console.error(`onboard-person: ${e.message}`);
	process.exit(1);
});
