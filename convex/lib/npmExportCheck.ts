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
// `exports.NAME =` / `Object.defineProperty(exports, "NAME"`. It does NOT:
//   - execute the package or resolve it the way a bundler does;
//   - follow `export * from "<other-package>"` or a conditional `exports` map by
//     condition (every string leaf is treated as an entry);
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

function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
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

export function readExportsOfFile(rawText: string, name: string): FileReading {
	const text = stripComments(rawText);
	const n = escapeRe(name);
	const declares =
		new RegExp(
			`\\bexport\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:const\\s+enum|enum|const|let|var|function\\s*\\*?|class|interface|type|namespace|module)\\s+${n}(?![\\w$])`,
		).test(text) ||
		(name === "default" && /\bexport\s+default\b/.test(text)) ||
		new RegExp(`\\bexport\\s*\\*\\s*as\\s+${n}\\s+from\\b`).test(text) ||
		new RegExp(`(?:^|[^\\w$.])(?:module\\.)?exports\\.${n}\\s*=`).test(text) ||
		new RegExp(`Object\\.defineProperty\\(\\s*exports\\s*,\\s*["']${n}["']`).test(text) ||
		[...text.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g)].some((m) =>
			specifierExportedNames(m[1] ?? "").includes(name),
		);
	const relativeStarFrom = [
		...text.matchAll(/\bexport\s*\*\s*from\s*["'](\.{1,2}\/[^"']*|\.{1,2})["']/g),
	].map((m) => m[1] as string);
	// `export { a } from "./x"` is a re-export edge too: the name may be
	// declared there under its original spelling, so follow it.
	for (const m of text.matchAll(
		/\bexport\s*(?:type\s*)?\{[^}]*\}\s*from\s*["'](\.{1,2}\/[^"']*|\.{1,2})["']/g,
	)) {
		relativeStarFrom.push(m[1] as string);
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
	stringLeaves(manifest.exports, raw);
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
	| { kind: "no_entry_point" };

export function checkExportPublished(
	manifest: Record<string, unknown>,
	files: TarFile[],
	name: string,
): ExportCheck {
	const byPath = new Map(files.map((f) => [f.path, f.text]));
	const known = new Set(byPath.keys());
	const queue = entryFiles(manifest, files);
	if (queue.length === 0) return { kind: "no_entry_point" };
	const seen = new Set<string>();
	const MAX_VISITS = 400;
	while (queue.length > 0 && seen.size < MAX_VISITS) {
		const path = queue.shift() as string;
		if (seen.has(path)) continue;
		seen.add(path);
		const reading = readExportsOfFile(byPath.get(path) ?? "", name);
		if (reading.declares) return { kind: "found" };
		for (const spec of reading.relativeStarFrom) {
			for (const next of expand(`${dirOf(path)}/${spec}`, known)) {
				if (!seen.has(next)) queue.push(next);
			}
		}
	}
	return { kind: "absent" };
}
