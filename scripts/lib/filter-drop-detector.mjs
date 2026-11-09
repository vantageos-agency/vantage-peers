/**
 * Silent-filter-drop detector (task k17cv03wd3g60gz3p498879f2d8hx4pv).
 *
 * CLASS: a read picks ONE branch of an if / else-if chain by the first filter it
 * finds, and a filter the caller ALSO passed is read and never applied. The
 * answer is silently broader than the question asked, wearing a complete
 * answer's clothes (a full page, a cursor). Instances: tasks:list, missions:list,
 * mandates:list (fixed by k174mpqp...), messages:listMessages master path,
 * and the MCP list_issues handler (assignedTo selected, project discarded).
 *
 * WHAT IT READS: a chain of >= 2 branches whose conditions are each a
 * conjunction of bare filter names (`args.x !== undefined`, and for MCP handlers
 * a destructured parameter `x`), and whose bodies each perform a read. For
 * branch k and a filter `a` named only by a LATER branch, the branch is a drop
 * unless one of:
 *   - the branch body mentions `a`;
 *   - `a` could not reach the branch with every earlier condition false (an
 *     earlier conjunction is wholly defined once the branch's own filters and
 *     `a` are);
 *   - a guard BEFORE the chain refuses the pair (an `if` over both names whose
 *     body throws or returns an error);
 *   - Convex files only: `a` is applied after the chain (`args.a` / `a` appears
 *     in the rest of the handler), the narrowing-in-memory shape.
 *
 * WHAT IT DOES NOT READ (declared, not hidden): conditions it cannot reduce to
 * a conjunction of bare names (counted in `skipped`), ternaries, early-return
 * ladders, a filter that is applied wrongly rather than dropped, and a filter
 * applied after `.take()` (a short page: a different defect, named in the task).
 */

/** Blank out comments, keeping every offset and newline. */
export function stripComments(source) {
	const blank = (m) => m.replace(/[^\n]/g, " ");
	return source
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/\/\/[^\n]*/g, blank);
}

function matchBrace(s, open) {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		if (s[i] === "{") depth++;
		else if (s[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function matchParen(s, from) {
	let depth = 1;
	let p = from;
	while (depth > 0 && p < s.length) {
		if (s[p] === "(") depth++;
		else if (s[p] === ")") depth--;
		p++;
	}
	return p;
}

function conjunction(cond, bare) {
	const names = new Set();
	for (const raw of cond.split("&&")) {
		const part = raw.trim();
		const m =
			/^args\.(\w+)(?:\s*!==\s*undefined)?$/.exec(part) ??
			(bare ? /^(\w+)(?:\s*!==\s*undefined)?$/.exec(part) : null);
		if (!m) return null;
		names.add(m[1]);
	}
	return names;
}

const IF = /\bif\s*\(/g;
const ELSE_IF = /\s*else\s+if\s*\(/y;
const IF_AT = /\s*if\s*\(/y;

function readsSomething(body) {
	return /\.query\(|withIndex|paginate|convex\.(query|action)/.test(body);
}

/**
 * Guards before `at` that refuse a pair: returns the sets of names mentioned in
 * each `if (...) { throw | return ... }` preceding the chain.
 */
function guardsBefore(s, at) {
	const pre = s.slice(Math.max(0, at - 6000), at);
	const guards = [];
	for (const m of pre.matchAll(IF)) {
		const condEnd = matchParen(pre, m.index + m[0].length);
		const cond = pre.slice(m.index + m[0].length, condEnd - 1);
		const open = pre.indexOf("{", condEnd);
		if (open < 0) continue;
		const head = pre.slice(open, open + 300);
		if (/\bthrow\b|mcpError|\breturn\b/.test(head)) {
			guards.push(new Set(cond.match(/\b\w+\b/g) ?? []));
		}
	}
	return guards;
}

/**
 * @param {string} source
 * @param {{ file?: string, bare?: boolean }} [opts] `bare`: conditions may be
 *   bare destructured names (MCP tool handlers); Convex handlers use `args.x`.
 * @returns {{ hits: Array<{file: string, line: number, branch: number, dropped: string}>, skipped: number, chains: number }}
 *   `chains` counts the chains actually analysed (reduced to filter sets and reading).
 */
export function findFilterDrops(source, opts = {}) {
	const file = opts.file ?? "<source>";
	const bare = opts.bare === true;
	const s = stripComments(source);
	const hits = [];
	let skipped = 0;
	let chains = 0;
	for (const m of s.matchAll(IF)) {
		if (/else\s*$/.test(s.slice(Math.max(0, m.index - 8), m.index))) continue;
		const chain = [];
		let i = m.index;
		let first = true;
		for (;;) {
			const re = first ? IF_AT : ELSE_IF;
			re.lastIndex = i;
			const mm = re.exec(s);
			if (!mm) break;
			const condStart = mm.index + mm[0].length;
			const condEnd = matchParen(s, condStart);
			const cond = s.slice(condStart, condEnd - 1);
			const open = s.indexOf("{", condEnd);
			if (open < 0 || s.slice(condEnd, open).trim() !== "") break;
			const close = matchBrace(s, open);
			if (close < 0) break;
			chain.push({ cond, body: s.slice(open, close + 1) });
			i = close + 1;
			first = false;
		}
		if (chain.length < 2) continue;
		const sets = chain.map((c) => conjunction(c.cond, bare));
		if (sets.some((x) => x === null)) {
			skipped++;
			continue;
		}
		if (!chain.every((c) => readsSomething(c.body))) continue;
		chains++;
		const guards = guardsBefore(s, m.index);
		const rest = s.slice(i, i + 1500).split("\n});")[0];
		for (let k = 0; k < chain.length; k++) {
			const later = new Set();
			for (const set of sets.slice(k + 1)) for (const n of set) later.add(n);
			for (const a of [...later].filter((n) => !sets[k].has(n)).sort()) {
				const defined = new Set([...sets[k], a]);
				const unreachable = sets
					.slice(0, k)
					.some((e) => [...e].every((n) => defined.has(n)));
				if (unreachable) continue;
				const word = new RegExp(`\\b${a}\\b`);
				if (word.test(chain[k].body)) continue;
				if (!bare && word.test(rest)) continue;
				if (guards.some((g) => g.has(a) && [...sets[k]].some((n) => g.has(n))))
					continue;
				hits.push({
					file,
					line: s.slice(0, m.index).split("\n").length,
					branch: k,
					dropped: a,
				});
			}
		}
	}
	return { hits, skipped, chains };
}
