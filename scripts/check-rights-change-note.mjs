#!/usr/bin/env node
// check-rights-change-note -- refuses a diff that changes who may read or write what
// without saying how the live connections follow. Rule:
// .claude/rules/rights-change-migrates-live-connections.md. Task k17dhntq3m2w5x3x1jtdmkkba18hek7m.
//
//   node scripts/check-rights-change-note.mjs [--base origin/main] [--repo <dir>]
//
// Touches the rights surface when the range changes:
//   - convex/lib/seatNamespace.ts or convex/lib/tokenRights.ts (any change);
//   - convex/migrations/seed_client_scope_profiles.ts (any change);
//   - mcp-server/src/auth.ts, a changed line naming checkNamespace* or the own-namespace fields;
//   - convex/schema.ts or convex/oauth.ts, a changed line naming a scope-profile or
//     token grant field (namespaceReadPrefixes, namespaceWritePrefixes, fromAllowList,
//     oauth_scope_profiles, rightsPinned).
// and passes only if the commit messages of the range, or an ADDED line of the diff
// outside this check, its test and the rule, carry
//   rights-derivation: <reason, ten characters or more>
//   rights-migration:  <reason, ten characters or more>
//
// Exit 0 pass (or nothing touched), 1 refused (names each file), 2 cannot judge.
// The note's presence is checked, not its truth: the reviewer's verdict names the
// command that proves it.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALWAYS = [
	/^convex\/lib\/seatNamespace\.ts$/,
	/^convex\/lib\/tokenRights\.ts$/,
	/^convex\/migrations\/seed_client_scope_profiles\.ts$/,
];
const LINE_GATED = [
	{
		file: /^mcp-server\/src\/auth\.ts$/,
		line: /checkNamespace|checkOwnNamespaces|ownNamespacesOf|ownAgentNamespace|ownProjectNamespace/,
	},
	{
		file: /^convex\/(schema|oauth)\.ts$/,
		line: /namespaceReadPrefixes|namespaceWritePrefixes|fromAllowList|oauth_scope_profiles|rightsPinned/,
	},
];
const NOTE = /rights-(derivation|migration):\s*(\S[^\n]{9,})/i;
const NOTE_EXEMPT_FILES = [
	/^scripts\/check-rights-change-note\.mjs$/,
	/^scripts\/__tests__\/check-rights-change-note\.test\.mjs$/,
	/^\.claude\/rules\/rights-change-migrates-live-connections\.md$/,
];

/** Split a unified diff into { file, added: string[], removed: string[] }. */
export function parseDiff(diffText) {
	const files = [];
	let cur = null;
	for (const line of diffText.split("\n")) {
		const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (m) {
			cur = { file: m[2], added: [], removed: [] };
			files.push(cur);
			continue;
		}
		if (!cur) continue;
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) cur.added.push(line.slice(1));
		else if (line.startsWith("-")) cur.removed.push(line.slice(1));
	}
	return files;
}

/**
 * Pure judgement. Returns { touched: string[], noted: boolean, verdict }.
 * verdict: "pass" | "refuse".
 */
export function judge({ diffText, messages }) {
	const files = parseDiff(diffText);
	const touched = [];
	for (const f of files) {
		if (ALWAYS.some((re) => re.test(f.file))) {
			touched.push(f.file);
			continue;
		}
		const gate = LINE_GATED.find((g) => g.file.test(f.file));
		if (gate && [...f.added, ...f.removed].some((l) => gate.line.test(l))) {
			touched.push(f.file);
		}
	}
	const inMessages = NOTE.test(messages);
	const inDiff = files.some(
		(f) =>
			!NOTE_EXEMPT_FILES.some((re) => re.test(f.file)) &&
			f.added.some((l) => NOTE.test(l)),
	);
	const noted = inMessages || inDiff;
	return {
		touched,
		noted,
		verdict: touched.length === 0 || noted ? "pass" : "refuse",
	};
}

function git(repo, args) {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
}

function main(argv) {
	let base = "origin/main";
	let repo = process.cwd();
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--base") base = argv[++i];
		else if (argv[i] === "--repo") repo = argv[++i];
		else {
			console.error(`check-rights-change-note: unknown argument ${argv[i]}`);
			return 2;
		}
	}
	let diffText;
	let messages;
	try {
		git(repo, ["rev-parse", "--verify", `${base}^{commit}`]);
		diffText = git(repo, ["diff", `${base}...HEAD`]);
		messages = git(repo, ["log", `${base}..HEAD`, "--format=%B"]);
	} catch (err) {
		console.error(
			`check-rights-change-note: COULD NOT JUDGE (base ${base} in ${repo}): ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
		);
		return 2;
	}
	const r = judge({ diffText, messages });
	if (r.verdict === "pass") {
		console.log(
			r.touched.length === 0
				? `check-rights-change-note: PASS, no rights file touched in ${base}...HEAD`
				: `check-rights-change-note: PASS, rights files touched (${r.touched.join(", ")}) and a rights-derivation/rights-migration note is present`,
		);
		return 0;
	}
	console.error(
		`check-rights-change-note: REFUSED. ${base}...HEAD changes the rights surface (${r.touched.join(", ")}) with no "rights-derivation: <reason>" or "rights-migration: <reason>" note (ten characters or more) in a commit message or an added line. State which live connections this affects and how they follow: .claude/rules/rights-change-migrates-live-connections.md`,
	);
	return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
