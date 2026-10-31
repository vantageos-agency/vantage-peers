/**
 * onboard-person-core.mjs — the pure decision core of scripts/onboard-person.mjs
 * (VantagePeers Cloud, task k178xp66h7p0ds6vg69sqzw2vn8hbfrw).
 *
 * One person, one command: a Clerk organisation, an invitation that is RETURNED and never
 * emailed, the tenant mapping, and one agent per AI client and per account. Every effect goes
 * through the injected `io`, so the whole decision is testable without a network:
 *
 *   io.clerk.findOrg(slug)                         -> {id, slug} | null
 *   io.clerk.createOrg({name, slug})               -> {id, slug}
 *   io.clerk.findPendingInvitation(orgId, email)   -> {id, url} | null
 *   io.clerk.createInvitation(orgId, body)         -> {id, url}
 *   io.convex.run(fn, args)                        -> the function's JSON result
 *
 * READS (findOrg, findPendingInvitation, onboardPerson:readOrgState) happen in a dry run too;
 * every WRITE happens only with `send: true`.
 */

const LANGS = ["fr", "en"];
const CLIENT_TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const MAPPING_SCOPES = ["view-own-tasks", "view-own-missions"];

/** Same normalisation as convex/_helpers/normalizeOrchestratorId.ts. */
export const normalizeLabel = (s) => s.normalize("NFC").toLowerCase().trim();

/**
 * "Milo:claude,Sacha:chatgpt" -> [{label, client}]. A label is unique per org (compared
 * normalised); the client tag names the AI client the agent is for.
 */
export function parseAgents(text) {
	const entries = String(text ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (entries.length === 0) throw new Error("--agents needs at least one label:client entry");
	const seen = new Set();
	return entries.map((entry) => {
		const i = entry.lastIndexOf(":");
		if (i <= 0 || i === entry.length - 1) {
			throw new Error(`agent "${entry}" must be label:client (for example Milo:claude)`);
		}
		const label = entry.slice(0, i).trim();
		const client = entry.slice(i + 1).trim().toLowerCase();
		if (!label || /^user:/i.test(label)) throw new Error(`agent label "${label}" is not allowed`);
		if (!CLIENT_TAG.test(client)) throw new Error(`client tag "${client}" must be lowercase letters, digits or dashes`);
		const key = normalizeLabel(label);
		if (seen.has(key)) throw new Error(`agent labels must be unique per organisation: "${label}" appears twice`);
		seen.add(key);
		return { label, client };
	});
}

function flag(argv, name) {
	const i = argv.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
	return value;
}

/** argv + env -> options for onboardPerson. Throws a plain Error naming the bad input. */
export function parseArgs(argv, env = {}) {
	const need = (name) => {
		const value = flag(argv, name);
		if (!value) throw new Error(`--${name} is required`);
		return value;
	};
	const slug = need("org-slug");
	if (!SLUG.test(slug)) throw new Error(`--org-slug "${slug}" must be lowercase letters, digits or dashes`);
	const email = need("email").trim().toLowerCase();
	if (!EMAIL.test(email)) throw new Error(`--email "${email}" is not an email address`);
	const lang = flag(argv, "lang") ?? "fr";
	if (!LANGS.includes(lang)) throw new Error(`--lang must be fr or en, got "${lang}"`);
	let redirectUrl = flag(argv, "redirect-url") ?? env.ONBOARD_REDIRECT_URL;
	if (!redirectUrl && env.CLERK_DOMAIN) redirectUrl = `${env.CLERK_DOMAIN.replace(/\/+$/, "")}/sign-up`;
	if (!redirectUrl) {
		throw new Error(
			"no redirect URL: pass --redirect-url (a Clerk-hosted sign-up page that consumes __clerk_ticket) or set CLERK_DOMAIN",
		);
	}
	let parsed;
	try {
		parsed = new URL(redirectUrl);
	} catch {
		throw new Error(`redirect URL "${redirectUrl}" is not a URL`);
	}
	if (parsed.protocol !== "https:") throw new Error(`redirect URL must be https, got "${parsed.protocol}"`);
	return {
		org: { slug, name: need("org-name") },
		person: { name: need("name"), email },
		agents: parseAgents(need("agents")),
		lang,
		redirectUrl,
		send: argv.includes("--send"),
	};
}

/** The stored label of an agent: the existing row's name when there is one, else the requested label. */
const exactName = (a, byLabel) => byLabel.get(normalizeLabel(a.label))?.name ?? a.label;

/**
 * Runs (send) or plans (dry run) the onboarding. Returns `{mode, plan, result}`; `plan` is a list of
 * human-readable lines, `result` is what the operator needs back (invitation URL, ids).
 */
export async function onboardPerson(options, io) {
	const { org, person, agents, lang, redirectUrl, send } = options;
	const email = person.email.trim().toLowerCase();
	const plan = [];
	const step = (s) => plan.push(s);

	// ── observe (reads only) ────────────────────────────────────────────────
	const state = await io.convex.run("onboardPerson:readOrgState", { clerkOrgSlug: org.slug });
	const mapping = state.mapping;
	let clerkOrg = await io.clerk.findOrg(org.slug);
	if (clerkOrg && mapping?.clerkOrgId && mapping.clerkOrgId !== clerkOrg.id) {
		throw new Error(
			`mapping "${org.slug}" carries ${mapping.clerkOrgId} but Clerk's org "${org.slug}" is ${clerkOrg.id}; refusing to continue`,
		);
	}
	if (mapping?.clerkOrgId && !clerkOrg) {
		throw new Error(`mapping "${org.slug}" carries ${mapping.clerkOrgId} but Clerk has no org "${org.slug}"; refusing to continue`);
	}
	let invitation = clerkOrg ? await io.clerk.findPendingInvitation(clerkOrg.id, email) : null;

	const byLabel = new Map(state.agents.map((a) => [normalizeLabel(a.name), a]));
	for (const a of agents) {
		const held = byLabel.get(normalizeLabel(a.label));
		if (held && !held.isActive) {
			throw new Error(`agent label "${a.label}" is held by inactive agent ${held.id}; reactivate or choose another label`);
		}
		if (held && held.clerkOrgId === null) {
			throw new Error(`agent "${a.label}" (${held.id}) carries no clerkOrgId, so the consent screen would never offer it; fix the row first`);
		}
	}

	// ── plan ────────────────────────────────────────────────────────────────
	step(clerkOrg ? `clerk org ${org.slug}: exists (${clerkOrg.id})` : `clerk org ${org.slug}: create (no created_by)`);
	step(
		invitation
			? `invitation for ${email}: pending, reuse`
			: `invitation for ${email}: create (org:admin, notify:false, lang ${lang}, redirect ${redirectUrl})`,
	);
	step(mapping ? `mapping ${org.slug}: exists (${mapping.id})` : `mapping ${org.slug}: seed`);
	step(mapping?.orgKind === "client" ? "orgKind: client already" : "orgKind: set client");
	step(mapping?.clerkOrgId ? "clerkOrgId on mapping: already set" : "clerkOrgId on mapping: set (before any agent)");
	const toCreate = agents.filter((a) => !byLabel.has(normalizeLabel(a.label)));
	for (const a of agents) {
		step(`agent ${a.label} (${a.client}): ${byLabel.has(normalizeLabel(a.label)) ? "exists" : "create"}`);
	}

	if (!send) {
		return { mode: "dry-run", plan, result: null };
	}

	// ── execute (writes), in the order the data requires ─────────────────────
	if (!clerkOrg) {
		// No created_by: the operator must not join a client organisation.
		clerkOrg = await io.clerk.createOrg({ name: org.name, slug: org.slug });
	}
	if (!invitation) {
		invitation = await io.clerk.createInvitation(clerkOrg.id, {
			email_address: email,
			role: "org:admin",
			notify: false,
			redirect_url: redirectUrl,
			public_metadata: { onboarding: { lang } },
		});
	}
	let mappingId = mapping?.id;
	if (!mapping) {
		mappingId = await io.convex.run("tenantOrgSeed:seedClientOrgMapping", {
			clerkOrgSlug: org.slug,
			displayName: org.name,
			allowedOrchestrators: agents.map((a) => a.label),
			scopes: MAPPING_SCOPES,
		});
	}
	if (mapping?.orgKind !== "client") {
		await io.convex.run("clientOrgMapping:setOrgKind", { clerkOrgSlug: org.slug, orgKind: "client" });
	}
	if (mapping?.clerkOrgId !== clerkOrg.id) {
		// BEFORE the agents: a row seeded without it is never offered on the consent screen.
		await io.convex.run("clientOrgMapping:setClerkOrgId", { clerkOrgSlug: org.slug, clerkOrgId: clerkOrg.id });
	}

	const ids = new Map(state.agents.map((a) => [normalizeLabel(a.name), a.id]));
	const rosterIds = new Set(mapping?.allowedAgentIds ?? []);
	if (toCreate.length > 0) {
		// seedSeatAgents REPLACES allowedAgentIds with (new ids + agentIds passed): one call, and every
		// id already on the roster rides along as the keep-list (trap F14).
		const keep = [...new Set([...(mapping?.allowedAgentIds ?? []), ...state.agents.filter((a) => a.isActive).map((a) => a.id)])];
		const seeded = await io.convex.run("clientOrgMapping:seedSeatAgents", {
			mappingId,
			names: toCreate.map((a) => a.label),
			...(keep.length > 0 ? { agentIds: keep } : {}),
		});
		toCreate.forEach((a, i) => ids.set(normalizeLabel(a.label), seeded[i]));
		rosterIds.clear();
		for (const id of seeded) rosterIds.add(id);
	}
	const allIds = agents.map((a) => ids.get(normalizeLabel(a.label)));
	// The LABEL roster is compared case-sensitively by the scope filter and writes are attributed to the
	// agent's STORED label, so the roster must hold the exact stored name. addRosterMembers appends the
	// normalised name, which never matches: labels go through tenantOrgSeed:setOrgRoster (existing entries kept).
	const labels = [...(mapping?.allowedOrchestrators ?? [])];
	if (!mapping) labels.push(...agents.map((a) => a.label));
	const labelsAdded = agents.filter((a) => !labels.includes(exactName(a, byLabel)));
	for (const a of labelsAdded) labels.push(exactName(a, byLabel));
	const idsMissing = allIds.some((id) => !rosterIds.has(id));
	if (labelsAdded.length > 0 || idsMissing) {
		await io.convex.run("tenantOrgSeed:setOrgRoster", {
			clerkOrgSlug: org.slug,
			allowedOrchestrators: labels,
			...(idsMissing ? { allowedAgentIds: [...new Set([...allIds, ...rosterIds])] } : {}),
		});
	}
	// Person tokens snapshot the label roster at mint: a roster that grew after the person connected
	// does not reach the tokens they already hold.
	const reconnectNeeded = Boolean(mapping) && (toCreate.length > 0 || labelsAdded.length > 0);

	for (const a of agents) {
		const held = byLabel.get(normalizeLabel(a.label));
		const id = ids.get(normalizeLabel(a.label));
		if (held?.personalAgentOf) continue; // already bound to a person: nothing to invite
		if (held?.invite?.email === email) continue; // already recorded
		await io.convex.run("agents:recordPersonalAgentInvite", { agentId: id, email, lang, aiClient: a.client });
	}

	return {
		mode: "send",
		plan,
		result: {
			orgId: clerkOrg.id,
			orgSlug: org.slug,
			mappingId,
			invitationUrl: invitation.url ?? null,
			lang,
			email,
			reconnectNeeded,
			agents: agents.map((a) => ({
				label: a.label,
				client: a.client,
				id: ids.get(normalizeLabel(a.label)),
				created: !byLabel.has(normalizeLabel(a.label)),
				bound: Boolean(byLabel.get(normalizeLabel(a.label))?.personalAgentOf),
			})),
		},
	};
}
