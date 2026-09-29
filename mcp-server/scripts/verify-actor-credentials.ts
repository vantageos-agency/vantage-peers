/**
 * verify-actor-credentials — is every agent of an organisation ready for the
 * credential cutover (Deployment B), proven ONE ACTOR AT A TIME?
 *
 * VantagePeers Cloud (multi-tenant). task k17dbtczxy047kav3qtxx1dpe18fbzf5.
 *
 * Run: bun scripts/verify-actor-credentials.ts [--window-days N|all] [--ops-file f.json] [--json]
 *
 * WHAT IT PROVES, per actor, as TWO proofs (a credential that resolves proves an
 * identity, never that the actor can still do its work):
 *
 *   1. RESOLVES  — the credential presented for actor X resolves to EXACTLY X.
 *      Observed through the server's own binding, not asserted: a call that
 *      types X's server-read identifier is served, while the same call typing a
 *      name that is NOT the actor is refused AGENT_IDENTITY_MISMATCH (the
 *      control). A credential that resolves to another actor, or a server that
 *      does not bind at all, cannot pass both.
 *   2. OPERATES  — the operations the actor performs SUCCEED under that
 *      credential, with the name both typed and omitted (omitted is what must
 *      survive strict mode). Defaults are side-effect-free (own-inbox read; a
 *      dry-run of the acting-name path). The actor's REAL write operations are
 *      supplied with --ops-file and are never guessed here.
 *
 * THE ACTOR LIST IS DERIVED FROM THE SERVER, NEVER TYPED. Identifiers come from
 * `list_peers` byte-for-byte and are compared by exact equality. A typed
 * "helios" does not match the registered "hélios" (which returns ZERO with
 * no error on the server, read as an empty queue — the 2026-09-01 incident);
 * a credentials file keyed on the typed spelling is REPORTED as the near-miss
 * it is, never silently accepted.
 *
 * THREE STATES, and the third is the point:
 *   clean           exit 0  every derived actor passed both proofs
 *   accused         exit 1  at least one actor demonstrably failed
 *   could-not-judge exit 2  the instrument could not read its subject (no
 *                           config, server unreachable, empty or unparseable
 *                           actor list, bearer is master, server does not bind).
 *                           NEVER printed as zeros with exit 0.
 * Precedence: accused > could-not-judge > clean.
 *
 * Secrets: only VARIABLE NAMES are ever printed. Credential and bearer values
 * are scrubbed from every string this script emits.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ENV_URL = "VANTAGE_MCP_URL";
export const ENV_BEARER = "VANTAGE_ORG_BEARER";
export const ENV_CREDENTIALS_FILE = "VANTAGE_AGENT_CREDENTIALS_FILE";
export const AGENT_CREDENTIAL_HEADER = "x-vantage-agent-credential";
/** A name that is, by construction, not any actor: the discriminating control. */
export const CONTROL_NAME = "__verify-actor-credentials-control__";
export const DEFAULT_WINDOW_DAYS = 45;

export type ToolResult = { isError: boolean; text: string };
export type ToolClient = {
	callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
	close(): Promise<void>;
};
/** Opens a session with the org bearer, plus the agent credential when given. */
export type Connect = (agentCredential?: string) => Promise<ToolClient>;

export type ProbeOp = {
	name: string;
	tool: string;
	/** String values equal to "$ACTOR" are replaced by the actor's exact server identifier. */
	args: Record<string, unknown>;
};

export type State = "clean" | "accused" | "could-not-judge";
export type OpResult = { name: string; ok: boolean; detail: string };
export type ActorVerdict = {
	/** Exactly as the server returned it. */
	id: string;
	state: State;
	proof1Resolves: boolean | null;
	proof2Operates: boolean | null;
	ops: OpResult[];
	findings: string[];
};
export type Report = {
	state: State;
	exit: 0 | 1 | 2;
	refusal?: string;
	actors: ActorVerdict[];
	excluded: { id: string; lastSeen: string }[];
	orphanCredentialKeys: string[];
};

class CouldNotJudge extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
// Derivation — from the server, by identifier
// ─────────────────────────────────────────────────────────────────────────────

export type DerivedActors = {
	actors: { id: string; lastSeen: string }[];
	excluded: { id: string; lastSeen: string }[];
	notes: string[];
};

const MAX_PAGES = 100;

/**
 * Reads every profile the org bearer may see (all pages) and returns the
 * identifiers verbatim. `windowDays` narrows by `lastSeen`; a profile whose
 * date cannot be read is INCLUDED (you cannot exclude what you cannot date) and
 * noted. Anything unparseable or empty refuses (CouldNotJudge).
 */
export async function deriveActors(
	client: ToolClient,
	opts: { windowDays: number | "all"; now: number },
): Promise<DerivedActors> {
	const byId = new Map<string, { id: string; lastSeen: string }>();
	const notes: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; ; page++) {
		if (page >= MAX_PAGES) {
			throw new CouldNotJudge(
				`list_peers still paging after ${MAX_PAGES} pages — cannot enumerate the actors`,
			);
		}
		const res = await client.callTool("list_peers", {
			limit: 200,
			fields: "lite",
			...(cursor ? { cursor } : {}),
		});
		if (res.isError) {
			throw new CouldNotJudge(`list_peers refused: ${res.text.slice(0, 200)}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(res.text);
		} catch {
			throw new CouldNotJudge(
				"list_peers did not return JSON (a truncated or non-list response) — cannot read the actors",
			);
		}
		const items: unknown = Array.isArray(parsed)
			? parsed
			: (parsed as { items?: unknown } | null)?.items;
		if (!Array.isArray(items)) {
			throw new CouldNotJudge("list_peers returned no item list");
		}
		for (const raw of items) {
			const row = raw as { id?: unknown; lastSeen?: unknown };
			if (typeof row?.id !== "string" || row.id === "") {
				throw new CouldNotJudge(
					"list_peers returned a profile without a string identifier",
				);
			}
			if (!byId.has(row.id)) {
				byId.set(row.id, {
					id: row.id,
					lastSeen: typeof row.lastSeen === "string" ? row.lastSeen : "",
				});
			}
		}
		const next = Array.isArray(parsed)
			? undefined
			: (parsed as { nextCursor?: unknown }).nextCursor;
		if (typeof next === "string" && next !== "") cursor = next;
		else break;
	}

	const actors: DerivedActors["actors"] = [];
	const excluded: DerivedActors["excluded"] = [];
	for (const p of byId.values()) {
		if (opts.windowDays === "all") {
			actors.push(p);
			continue;
		}
		const t = Date.parse(p.lastSeen);
		if (Number.isNaN(t)) {
			notes.push(
				`lastSeen of ${describeId(p.id)} is unreadable — included, not dated out`,
			);
			actors.push(p);
		} else if (opts.now - t <= opts.windowDays * 86_400_000) {
			actors.push(p);
		} else {
			excluded.push(p);
		}
	}
	if (actors.length === 0) {
		throw new CouldNotJudge(
			`the server returned ${byId.size} profile(s) and none is inside the ${String(opts.windowDays)}-day window — ` +
				"an empty actor list is a failure to read, not a clean result",
		);
	}
	return { actors, excluded, notes };
}

/** An identifier made legible: quoted, with code points when it is not plain ASCII. */
export function describeId(id: string): string {
	if (/^[\x20-\x7e]*$/.test(id)) return JSON.stringify(id);
	const cps = [...id]
		.map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
		.join(" ");
	return `${JSON.stringify(id)} [code points: ${cps}]`;
}

const fold = (s: string): string =>
	s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// Verification — one actor at a time
// ─────────────────────────────────────────────────────────────────────────────

const BOUNDARY_REFUSAL = /\b(401|403)\b|AGENT_CREDENTIAL|ORG_MISMATCH/;

function parsesAsDryRun(text: string): boolean {
	try {
		const j = JSON.parse(text) as { count?: unknown };
		return typeof j?.count === "number";
	} catch {
		return false;
	}
}

export function defaultOps(): ProbeOp[] {
	return [
		{
			name: "read own inbox (check_messages)",
			tool: "check_messages",
			args: { recipient: "$ACTOR" },
		},
	];
}

function substitute(
	args: Record<string, unknown>,
	id: string,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(args).map(([k, v]) => [k, v === "$ACTOR" ? id : v]),
	);
}

export async function verifyActor(
	id: string,
	secret: string,
	connect: Connect,
	ops: ProbeOp[],
	scrub: (s: string) => string,
): Promise<ActorVerdict> {
	const v: ActorVerdict = {
		id,
		state: "clean",
		proof1Resolves: null,
		proof2Operates: null,
		ops: [],
		findings: [],
	};
	const accuse = (msg: string): void => {
		v.state = "accused";
		v.findings.push(scrub(msg));
	};
	const cannot = (msg: string): void => {
		if (v.state !== "accused") v.state = "could-not-judge";
		v.findings.push(scrub(msg));
	};

	let client: ToolClient;
	try {
		client = await connect(secret);
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		if (BOUNDARY_REFUSAL.test(m)) {
			v.proof1Resolves = false;
			accuse(
				`the boundary refused this actor's credential: ${m.slice(0, 200)}`,
			);
		} else {
			cannot(`could not open a session for this actor: ${m.slice(0, 200)}`);
		}
		return v;
	}

	try {
		// The instrument must not run under the maintenance identity: that
		// exercises the bypass, not the control.
		const who = await client.callTool("whoami", {});
		if (!who.isError) {
			try {
				const w = JSON.parse(who.text) as { scope_profile_name?: string };
				if (w.scope_profile_name === "master") {
					cannot(
						`the presented bearer is MASTER — a proof under the maintenance identity exercises the bypass; use an ordinary org bearer`,
					);
					return v;
				}
			} catch {
				// whoami unreadable: proceed; the control below still discriminates.
			}
		}

		// PROOF 1 — resolves to exactly this identifier.
		const typed = await client.callTool("bulk_complete_tasks", {
			filter: { assignedTo: id },
			dryRun: true,
			callerOrchestrator: id,
		});
		const control = await client.callTool("bulk_complete_tasks", {
			filter: { assignedTo: id },
			dryRun: true,
			callerOrchestrator: CONTROL_NAME,
		});
		const controlRefused =
			control.isError && control.text.includes("AGENT_IDENTITY_MISMATCH");
		if (!controlRefused) {
			v.proof1Resolves = null;
			cannot(
				"the control (a name that is not this actor) was NOT refused AGENT_IDENTITY_MISMATCH — the server is not binding the presented credential, " +
					"so a served call proves nothing (is the credential-binding deployment live, and is the bearer ordinary?)",
			);
			return v;
		}
		if (typed.isError) {
			v.proof1Resolves = false;
			const m = /resolves to "([^"]*)"/.exec(typed.text);
			accuse(
				m
					? `the credential presented for ${describeId(id)} resolves to ${describeId(m[1])} — a different identifier`
					: `typing the actor's own identifier was refused: ${typed.text.slice(0, 200)}`,
			);
			return v;
		}
		if (!parsesAsDryRun(typed.text)) {
			v.proof1Resolves = null;
			cannot(
				"the acting-name dry-run returned no readable count — nothing was observed",
			);
			return v;
		}
		v.proof1Resolves = true;

		// PROOF 2 — the operations succeed under the credential.
		const operations: ProbeOp[] = [
			...ops,
			{
				name: "acting-name path, name OMITTED (must survive strict mode)",
				tool: "bulk_complete_tasks",
				args: { filter: { assignedTo: "$ACTOR" }, dryRun: true },
			},
		];
		let allOk = true;
		for (const op of operations) {
			let res: ToolResult;
			try {
				res = await client.callTool(op.tool, substitute(op.args, id));
			} catch (err) {
				res = {
					isError: true,
					text: err instanceof Error ? err.message : String(err),
				};
			}
			const ok =
				!res.isError &&
				res.text.trim() !== "" &&
				(op.tool !== "bulk_complete_tasks" || parsesAsDryRun(res.text));
			v.ops.push({
				name: op.name,
				ok,
				detail: ok ? "ok" : scrub(res.text.slice(0, 200)),
			});
			if (!ok) allOk = false;
		}
		v.proof2Operates = allOk;
		if (!allOk) {
			accuse(
				`the credential resolves but ${v.ops.filter((o) => !o.ok).length} operation(s) FAILED under it — the identity is proven, the work is not`,
			);
		}
	} catch (err) {
		cannot(
			`transport failure while verifying: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		await client.close().catch(() => {});
	}
	return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

export type RunDeps = {
	/** Session with the org bearer only (no agent credential): reads the actor list. */
	connect: Connect;
	/** identifier -> plaintext credential, keyed as the operator filed them. */
	credentials: Record<string, string>;
	/** Values to scrub from any output (bearer + every credential). */
	secrets: string[];
	windowDays: number | "all";
	now: number;
	opsFor?: (id: string) => ProbeOp[];
};

const refuse = (reason: string, partial?: Partial<Report>): Report => ({
	state: "could-not-judge",
	exit: 2,
	refusal: reason,
	actors: [],
	excluded: [],
	orphanCredentialKeys: [],
	...partial,
});

export async function runVerification(deps: RunDeps): Promise<Report> {
	const scrub = (s: string): string =>
		deps.secrets
			.filter((x) => x.length > 0)
			.reduce((acc, sec) => acc.split(sec).join("[redacted]"), s);

	let derived: DerivedActors;
	let reader: ToolClient | undefined;
	try {
		reader = await deps.connect(undefined);
		derived = await deriveActors(reader, {
			windowDays: deps.windowDays,
			now: deps.now,
		});
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		return refuse(
			scrub(`could not derive the actor list from the server: ${m}`),
		);
	} finally {
		await reader?.close().catch(() => {});
	}

	const actors: ActorVerdict[] = [];
	for (const a of derived.actors) {
		// EXACT identifier equality — never a folded or retyped comparison.
		if (!Object.hasOwn(deps.credentials, a.id)) {
			const near = Object.keys(deps.credentials).filter(
				(k) => k !== a.id && fold(k) === fold(a.id),
			);
			actors.push({
				id: a.id,
				state: "accused",
				proof1Resolves: false,
				proof2Operates: null,
				ops: [],
				findings: [
					`no credential is filed under the server identifier ${describeId(a.id)}` +
						(near.length > 0
							? ` — the credentials file has ${near.map(describeId).join(", ")}, which differs from it only by accents/case; ` +
								"that is a different string and would provision NOTHING. Re-key the entry to the exact server identifier."
							: ""),
				],
			});
			continue;
		}
		actors.push(
			await verifyActor(
				a.id,
				deps.credentials[a.id],
				deps.connect,
				(deps.opsFor?.(a.id) ?? []).length > 0
					? (deps.opsFor?.(a.id) ?? [])
					: defaultOps(),
				scrub,
			),
		);
	}

	const derivedIds = new Set(derived.actors.map((a) => a.id));
	const orphanCredentialKeys = Object.keys(deps.credentials).filter(
		(k) => !derivedIds.has(k),
	);

	const state: State = actors.some((a) => a.state === "accused")
		? "accused"
		: actors.some((a) => a.state === "could-not-judge")
			? "could-not-judge"
			: "clean";
	return {
		state,
		exit: state === "clean" ? 0 : state === "accused" ? 1 : 2,
		actors,
		excluded: derived.excluded,
		orphanCredentialKeys,
	};
}

export function renderReport(r: Report): string {
	const out: string[] = [];
	out.push(`VERDICT: ${r.state.toUpperCase()} (exit ${r.exit})`);
	if (r.refusal) out.push(`REFUSED: ${r.refusal}`);
	out.push(`actors derived from the server: ${r.actors.length}`);
	for (const a of r.actors) {
		out.push(
			`  ${a.state.toUpperCase().padEnd(15)} ${describeId(a.id)}  resolves=${String(a.proof1Resolves)} operates=${String(a.proof2Operates)}`,
		);
		for (const o of a.ops)
			out.push(
				`      ${o.ok ? "ok  " : "FAIL"} ${o.name}${o.ok ? "" : ` — ${o.detail}`}`,
			);
		for (const f of a.findings) out.push(`      ! ${f}`);
	}
	if (r.excluded.length > 0) {
		out.push(
			`outside the window (NOT verified, listed so none is hidden): ${r.excluded.length}`,
		);
		for (const e of r.excluded)
			out.push(`  ${describeId(e.id)} lastSeen=${e.lastSeen}`);
	}
	if (r.orphanCredentialKeys.length > 0) {
		out.push(
			"credentials filed under an identifier the server does not list (typed names?):",
		);
		for (const k of r.orphanCredentialKeys) out.push(`  ${describeId(k)}`);
	}
	return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — real transport
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
	windowDays: number | "all";
	opsFile?: string;
	json: boolean;
} {
	let windowDays: number | "all" = DEFAULT_WINDOW_DAYS;
	let opsFile: string | undefined;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--window-days") {
			const v = argv[++i];
			if (v === "all") windowDays = "all";
			else if (v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0)
				windowDays = Number(v);
			else
				throw new CouldNotJudge(
					`--window-days needs a positive number or "all", got ${JSON.stringify(v)}`,
				);
		} else if (a === "--ops-file") opsFile = argv[++i];
		else if (a === "--json") json = true;
		else throw new CouldNotJudge(`unknown argument ${JSON.stringify(a)}`);
	}
	return { windowDays, opsFile, json };
}

async function main(): Promise<number> {
	let report: Report;
	try {
		const args = parseArgs(process.argv.slice(2));
		const url = process.env[ENV_URL];
		const bearer = process.env[ENV_BEARER];
		const credFile = process.env[ENV_CREDENTIALS_FILE];
		const missing = [
			[ENV_URL, url],
			[ENV_BEARER, bearer],
			[ENV_CREDENTIALS_FILE, credFile],
		]
			.filter(([, v]) => !v)
			.map(([n]) => n);
		if (missing.length > 0 || !url || !bearer || !credFile) {
			throw new CouldNotJudge(`not configured: set ${missing.join(", ")}`);
		}
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			throw new CouldNotJudge(`${ENV_URL} is not a valid URL`);
		}
		if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
			throw new CouldNotJudge(`${ENV_URL} must be http(s)`);
		}
		let credentials: Record<string, string>;
		try {
			credentials = JSON.parse(readFileSync(credFile, "utf8")) as Record<
				string,
				string
			>;
		} catch (e) {
			throw new CouldNotJudge(
				`cannot read ${ENV_CREDENTIALS_FILE} as a JSON object: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		if (
			credentials === null ||
			typeof credentials !== "object" ||
			Array.isArray(credentials) ||
			Object.values(credentials).some((v) => typeof v !== "string" || v === "")
		) {
			throw new CouldNotJudge(
				`${ENV_CREDENTIALS_FILE} must be a JSON object of identifier -> non-empty secret`,
			);
		}
		let opsMap: Record<string, ProbeOp[]> = {};
		if (args.opsFile) {
			try {
				opsMap = JSON.parse(readFileSync(args.opsFile, "utf8")) as Record<
					string,
					ProbeOp[]
				>;
			} catch (e) {
				throw new CouldNotJudge(
					`cannot read --ops-file: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}

		const { Client } = await import(
			"@modelcontextprotocol/sdk/client/index.js"
		);
		const { StreamableHTTPClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/streamableHttp.js"
		);
		const connect: Connect = async (agentCredential) => {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${bearer}`,
			};
			if (agentCredential) headers[AGENT_CREDENTIAL_HEADER] = agentCredential;
			const client = new Client({
				name: "verify-actor-credentials",
				version: "1.0.0",
			});
			await client.connect(
				new StreamableHTTPClientTransport(parsedUrl, {
					requestInit: { headers },
				}),
			);
			return {
				async callTool(name, a) {
					const r = (await client.callTool({ name, arguments: a })) as {
						isError?: boolean;
						content?: { type: string; text?: string }[];
					};
					return {
						isError: r.isError === true,
						text: (r.content ?? []).map((c) => c.text ?? "").join("\n"),
					};
				},
				close: () => client.close(),
			};
		};

		report = await runVerification({
			connect,
			credentials,
			secrets: [bearer, ...Object.values(credentials)],
			windowDays: args.windowDays,
			now: Date.now(),
			opsFor: (id) => opsMap[id] ?? [],
		});
		console.log(
			args.json ? JSON.stringify(report, null, 2) : renderReport(report),
		);
		return report.exit;
	} catch (err) {
		// Anything unforeseen is a failure to judge, never a zero.
		console.error(
			`VERDICT: COULD-NOT-JUDGE (exit 2)\nREFUSED: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 2;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().then(
		(code) => process.exit(code),
		() => process.exit(2),
	);
}
