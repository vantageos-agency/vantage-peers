// Is a named export published by an npm package? Pure functions over the files of
// a published tarball, no network, no Node API (the action that feeds them lives
// in convex/taskDeliverable.ts).
//
// WHAT THIS CHECK IS, AND ITS RESIDUE. It is a TEXTUAL reading of the package's
// public entry points (package.json `types` / `typings` / `main` / `module` /
// every string leaf of `exports`, plus the `.d.ts` twin of each), following
// relative `export * from` and `export { ... } from` edges inside the tarball. It
// reports an export NAME as declared when an entry file, or a file reachable from
// one through those edges, carries `export <decl> NAME`, `export { x as NAME }`,
// `export * as NAME from`, `export default` (for "default"), or CommonJS
// `exports.NAME =` / `Object.defineProperty(exports, "NAME"`. Only the ROOT
// entry of an `exports` map counts (a name found only under "./internal" is not
// delivered). A search that cannot finish (visit cap, byte cap, time budget) is
// reported as `incomplete`, never as `absent`. It does NOT:
//   - execute the package or resolve it the way a bundler does;
//   - follow `export * from "<other-package>"` or a conditional `exports` map by
//     condition (every string leaf of the root entry is treated as an entry);
//   - read `module.exports = { NAME }` object literals or computed exports;
//   - prove the exported symbol is the SAME artifact the task meant, only that a
//     public name equal to it is published in the LATEST dist-tag version.
// A false "delivered" needs the name to be exported with the wrong meaning; a
// false "not_found" needs one of the unfollowed forms above. Neither case turns a
// failure to read the package into "delivered": that is the resolver's job.

export type TarFile = { path: string; text: string };

const WANTED_EXT = /\.(?:d\.[cm]?ts|[cm]?js)$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function octal(field: Uint8Array): number {
	const raw = new TextDecoder().decode(field).replace(/\0.*$/s, "").trim();
	if (raw === "") return 0;
	if (!/^[0-7]+$/.test(raw)) return Number.NaN;
	return Number.parseInt(raw, 8);
}

function cstr(field: Uint8Array): string {
	return new TextDecoder().decode(field).replace(/\0.*$/s, "");
}

/**
 * Reads the text files of a (decompressed) tar archive. Throws on a malformed
 * archive so the caller can report "unresolved" instead of an empty success.
 * The first path segment (npm uses `package/`) is stripped.
 */
export function readTarFiles(tar: Uint8Array): TarFile[] {
	const files: TarFile[] = [];
	let offset = 0;
	let longName: string | undefined;
	let sawHeader = false;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((b) => b === 0)) break;
		const size = octal(header.subarray(124, 136));
		if (Number.isNaN(size) || size < 0) throw new Error("tar_header_invalid");
		const type = String.fromCharCode(header[156] ?? 0);
		const prefix = cstr(header.subarray(345, 500));
		let name = cstr(header.subarray(0, 100));
		if (prefix !== "") name = `${prefix}/${name}`;
		const bodyStart = offset + 512;
		const bodyEnd = bodyStart + size;
		if (bodyEnd > tar.length) throw new Error("tar_truncated");
		sawHeader = true;
		if (type === "L") {
			longName = cstr(tar.subarray(bodyStart, bodyEnd));
		} else if (type === "0" || type === "\0") {
			const full = longName ?? name;
			longName = undefined;
			const slash = full.indexOf("/");
			const path = slash === -1 ? full : full.slice(slash + 1);
			if (WANTED_EXT.test(path) && size <= MAX_FILE_BYTES) {
				files.push({
					path,
					text: new TextDecoder().decode(tar.subarray(bodyStart, bodyEnd)),
				});
			}
		} else {
			longName = undefined;
		}
		offset = bodyStart + Math.ceil(size / 512) * 512;
	}
	if (!sawHeader) throw new Error("tar_empty");
	return files;
}

/**
 * Removes block comments and `//` line comments in ONE linear pass. (The earlier
 * lazy regex `/\*[\s\S]*?\*\/` was quadratic on an unclosed `/*`.) An unclosed
 * block comment swallows the rest of the file, as a compiler would.
 */
function stripComments(text: string): string {
	const out: string[] = [];
	let i = 0;
	let chunkStart = 0;
	const n = text.length;
	while (i < n) {
		const c = text.charCodeAt(i);
		if (c === 47 /* / */ && text.charCodeAt(i + 1) === 42 /* * */) {
			out.push(text.slice(chunkStart, i));
			const end = text.indexOf("*/", i + 2);
			if (end === -1) return out.join("");
			i = end + 2;
			chunkStart = i;
		} else if (
			c === 47 &&
			text.charCodeAt(i + 1) === 47 &&
			(i === 0 || /\s/.test(text.charAt(i - 1)))
		) {
			out.push(text.slice(chunkStart, i));
			const nl = text.indexOf("\n", i);
			if (nl === -1) return out.join("");
			i = nl;
			chunkStart = i;
		} else {
			i += 1;
		}
	}
	out.push(text.slice(chunkStart));
	return out.join("");
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The exported name of one `{ ... }` specifier: `a`, `a as b`, `type a`. */
function specifierExportedNames(list: string): string[] {
	return list
		.split(",")
		.map((part) => part.trim().replace(/^type\s+/, ""))
		.filter((part) => part !== "")
		.map((part) => {
			const as = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(part);
			return as ? (as[1] as string) : part;
		});
}

export type FileReading = { declares: boolean; relativeStarFrom: string[] };

/**
 * Every `export [type] { ... }` clause of the text, with the module specifier of
 * its `from` when it has one. Written as a scan, not as one regex with `[^}]*`:
 * that pattern is quadratic on a file of unclosed `export {` (measured 5.9 s at
 * 192 KB). Here `indexOf("}")` runs once past the last `}` and the loop ends.
 */
function exportClauses(text: string): Array<{ list: string; from?: string }> {
	const out: Array<{ list: string; from?: string }> = [];
	const open = /\bexport\s*(?:type\s*)?\{/g;
	const fromRe = /\s*from\s*["']([^"']+)["']/y;
	for (let m = open.exec(text); m !== null; m = open.exec(text)) {
		const close = text.indexOf("}", open.lastIndex);
		if (close === -1) break; // no later clause can close either
		fromRe.lastIndex = close + 1;
		const f = fromRe.exec(text);
		out.push({
			list: text.slice(open.lastIndex, close),
			...(f !== null ? { from: f[1] as string } : {}),
		});
		open.lastIndex = close + 1;
	}
	return out;
}

const RELATIVE_SPEC = /^(?:\.{1,2}\/.*|\.{1,2})$/;

export function readExportsOfFile(rawText: string, name: string): FileReading {
	const text = stripComments(rawText);
	const n = escapeRe(name);
	const clauses = exportClauses(text);
	const declares =
		new RegExp(
			`\\bexport\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:const\\s+enum|enum|const|let|var|function\\s*\\*?|class|interface|type|namespace|module)\\s+${n}(?![\\w$])`,
		).test(text) ||
		(name === "default" && /\bexport\s+default\b/.test(text)) ||
		new RegExp(`\\bexport\\s*\\*\\s*as\\s+${n}\\s+from\\b`).test(text) ||
		new RegExp(`(?:^|[^\\w$.])(?:module\\.)?exports\\.${n}\\s*=`).test(text) ||
		new RegExp(`Object\\.defineProperty\\(\\s*exports\\s*,\\s*["']${n}["']`).test(text) ||
		clauses.some((c) => specifierExportedNames(c.list).includes(name));
	const relativeStarFrom = [
		...text.matchAll(/\bexport\s*\*\s*from\s*["'](\.{1,2}\/[^"']*|\.{1,2})["']/g),
	].map((m) => m[1] as string);
	// `export { a } from "./x"` is a re-export edge too: the name may be
	// declared there under its original spelling, so follow it.
	for (const c of clauses) {
		if (c.from !== undefined && RELATIVE_SPEC.test(c.from)) relativeStarFrom.push(c.from);
	}
	return { declares, relativeStarFrom };
}

function normalise(path: string): string {
	const out: string[] = [];
	for (const seg of path.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") out.pop();
		else out.push(seg);
	}
	return out.join("/");
}

function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

const TWIN: Array<[RegExp, string]> = [
	[/\.js$/, ".d.ts"],
	[/\.mjs$/, ".d.mts"],
	[/\.cjs$/, ".d.cts"],
];

/** Every file path `candidate` may stand for inside the tarball. */
function expand(candidate: string, known: Set<string>): string[] {
	const base = normalise(candidate);
	const options = [
		base,
		`${base}.d.ts`,
		`${base}.d.mts`,
		`${base}.d.cts`,
		`${base}.js`,
		`${base}.mjs`,
		`${base}.cjs`,
		`${base}/index.d.ts`,
		`${base}/index.js`,
	];
	for (const [re, twin] of TWIN) {
		if (re.test(base)) options.push(base.replace(re, twin));
	}
	return options.filter((p) => known.has(p));
}

function stringLeaves(value: unknown, out: string[]): void {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
	else if (typeof value === "object" && value !== null) {
		for (const v of Object.values(value)) stringLeaves(v, out);
	}
}

/**
 * Leaves of the ROOT entry of an `exports` field only. A subpath ("./internal")
 * is not the package's public surface for a bare `import "pkg"`, so a name found
 * only there must not read as delivered. `exports` is either a string / conditions
 * object (all root) or a map whose keys start with ".".
 */
function rootExportLeaves(exportsField: unknown, out: string[]): void {
	if (
		typeof exportsField === "object" &&
		exportsField !== null &&
		!Array.isArray(exportsField) &&
		Object.keys(exportsField).some((k) => k.startsWith("."))
	) {
		stringLeaves((exportsField as Record<string, unknown>)["."], out);
		return;
	}
	stringLeaves(exportsField, out);
}

/** Entry files of the package, as paths that exist in the tarball. */
export function entryFiles(
	manifest: Record<string, unknown>,
	files: TarFile[],
): string[] {
	const known = new Set(files.map((f) => f.path));
	const raw: string[] = [];
	for (const key of ["types", "typings", "main", "module"] as const) {
		const v = manifest[key];
		if (typeof v === "string") raw.push(v);
	}
	rootExportLeaves(manifest.exports, raw);
	raw.push("index.d.ts", "index.js");
	const entries = new Set<string>();
	for (const r of raw) {
		if (r.includes("*")) continue;
		for (const p of expand(r, known)) entries.add(p);
	}
	return [...entries];
}

export type ExportCheck =
	| { kind: "found" }
	| { kind: "absent" }
	| { kind: "no_entry_point" }
	// The search could not be finished: NOT a negative. The caller writes
	// "unresolved" with `reason`, never "not_found".
	| { kind: "incomplete"; reason: string };

/** Files visited from the entry points before the search gives up. */
export const MAX_VISITS = 400;
/** Largest single file the regex reading will touch (bounds regex cost). */
export const MAX_SCAN_BYTES_PER_FILE = 200 * 1024;
/** Total bytes read across the files of one search. */
export const MAX_SCAN_BYTES_TOTAL = 1536 * 1024;
/** Wall-clock budget of one search. */
export const SCAN_BUDGET_MS = 8000;

export function checkExportPublished(
	manifest: Record<string, unknown>,
	files: TarFile[],
	name: string,
	now: () => number = Date.now,
): ExportCheck {
	const byPath = new Map(files.map((f) => [f.path, f.text]));
	const known = new Set(byPath.keys());
	const queue = entryFiles(manifest, files);
	if (queue.length === 0) return { kind: "no_entry_point" };
	const seen = new Set<string>();
	const deadline = now() + SCAN_BUDGET_MS;
	let scanned = 0;
	while (queue.length > 0) {
		const path = queue.shift() as string;
		if (seen.has(path)) continue;
		// A NEW file is waiting and the budget is spent: the search is unfinished.
		if (seen.size >= MAX_VISITS) return { kind: "incomplete", reason: "visit_cap_reached" };
		if (now() > deadline) return { kind: "incomplete", reason: "scan_time_budget_exceeded" };
		seen.add(path);
		const text = byPath.get(path) ?? "";
		if (text.length > MAX_SCAN_BYTES_PER_FILE) {
			return { kind: "incomplete", reason: `scan_cap_reached: ${path} is ${text.length} bytes (cap ${MAX_SCAN_BYTES_PER_FILE})` };
		}
		scanned += text.length;
		if (scanned > MAX_SCAN_BYTES_TOTAL) return { kind: "incomplete", reason: "scan_cap_reached: total bytes" };
		const reading = readExportsOfFile(text, name);
		if (reading.declares) return { kind: "found" };
		for (const spec of reading.relativeStarFrom) {
			for (const next of expand(`${dirOf(path)}/${spec}`, known)) {
				if (!seen.has(next)) queue.push(next);
			}
		}
	}
	return { kind: "absent" };
}
