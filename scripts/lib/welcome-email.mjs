/**
 * welcome-email.mjs — the one email a person receives when onboarded onto VantagePeers Cloud
 * (task k172sk173z6mw5cfc5refy1pz18hgaqa, scope 2). onboard-person never sends mail: it returns
 * this text, and the operator sends it. Every step after sign-up is here, so nobody improvises.
 *
 * Screen labels are the ones measured on the connect page (docs/cloud/connect, 2026-10-31):
 * the French Claude labels are measured, the English ones are as published there. An assistant
 * with no written steps gets the generic MCP step and the connect page, never an invented screen.
 */

const MCP_URL = "https://mcp.vantagepeers.com/mcp";
const MARKETPLACE = "https://github.com/vantageos-agency/vantage-peers-claude";
const LANGS = ["fr", "en"];

const DOCS = {
	fr: {
		connect: "https://www.vantagepeers.com/docs/fr/cloud/connect",
		firstSteps: "https://www.vantagepeers.com/docs/fr/cloud/first-steps",
	},
	en: {
		connect: "https://www.vantagepeers.com/docs/cloud/connect",
		firstSteps: "https://www.vantagepeers.com/docs/cloud/first-steps",
	},
};

const STEPS = {
	claude: {
		fr: [
			`Dans Claude, ouvrez Personnalisation > Plugins > Ajouter une marketplace, saisissez ${MARKETPLACE}, puis installez Vantage peers.`,
			"Ouvrez Personnalisation > Plugins > Vantage peers, onglet Connecteurs, et cliquez sur Se connecter.",
			"Dans une conversation, vérifiez dans + > Connecteurs que vantage-peers est activé.",
			"Avec Claude Free, VantagePeers occupe votre seul connecteur personnalisé : Claude en refuse un second.",
		],
		en: [
			`In Claude, open Customize > Plugins > Add a marketplace, enter ${MARKETPLACE}, then install Vantage peers.`,
			"Open Customize > Plugins > Vantage peers, tab Connectors, and click Connect.",
			"In a chat, check under + > Connectors that vantage-peers is enabled.",
			"On Claude Free, VantagePeers takes your one custom connector: Claude refuses a second one.",
		],
	},
	chatgpt: {
		fr: [
			"Dans ChatGPT, ouvrez Plugins, cliquez sur +, puis choisissez Add custom MCP server.",
			`Nom : VantagePeers. URL : ${MCP_URL}. Authentification : OAuth.`,
			"Cochez la case d'avertissement, puis cliquez sur Create as plugin.",
		],
		en: [
			"In ChatGPT, open Plugins, click +, then choose Add custom MCP server.",
			`Name: VantagePeers. URL: ${MCP_URL}. Authentication: OAuth.`,
			"Tick the warning checkbox, then click Create as plugin.",
		],
	},
};

const GENERIC = {
	fr: (connect) => [
		`Dans votre assistant, ajoutez un serveur MCP avec l'adresse ${MCP_URL} et l'authentification OAuth.`,
		`Le détail pour chaque assistant est sur ${connect}.`,
	],
	en: (connect) => [
		`In your assistant, add an MCP server with the address ${MCP_URL} and OAuth authentication.`,
		`The details for each assistant are on ${connect}.`,
	],
};

const TEXT = {
	fr: {
		subject: (org) => `Votre accès à VantagePeers : ${org}`,
		hello: (name) => `Bonjour ${name},`,
		intro: (org) =>
			`Une invitation vous attend dans l'espace VantagePeers « ${org} ». VantagePeers donne à vos assistants une mémoire, des tâches et des messages partagés au sein de votre organisation.`,
		step1: "1. Créez votre compte",
		signUp: (url) => `Inscrivez-vous en ouvrant ce lien d'invitation (il ne sert qu'une fois) : ${url}`,
		step2: "2. Connectez chaque assistant",
		agentLine: (label, client) => `Agent « ${label} » (${client}) :`,
		consent:
			"À la fin, la page de consentement s'ouvre : choisissez votre organisation, puis l'agent indiqué ci-dessus, et approuvez.",
		step3: "3. Vérifiez",
		check: "Dans une conversation, dites : « Qui suis-je sur VantagePeers ? ». L'assistant répond avec le nom de votre agent et votre organisation.",
		next: (url) => `Pour la suite, cinq phrases simples à essayer : ${url}`,
		bye: "Bonne découverte,",
	},
	en: {
		subject: (org) => `Your VantagePeers access for ${org}`,
		hello: (name) => `Hello ${name},`,
		intro: (org) =>
			`You are invited to the VantagePeers space of ${org}. VantagePeers gives your assistants a shared memory, tasks and messages within your organisation.`,
		step1: "1. Create your account",
		signUp: (url) => `Sign up by opening this invitation link (it works once): ${url}`,
		step2: "2. Connect each assistant",
		agentLine: (label, client) => `Agent "${label}" (${client}):`,
		consent:
			"At the end, the consent page opens: choose your organisation, then the agent named above, and approve.",
		step3: "3. Check",
		check: 'In a chat, say: "Who am I on VantagePeers?". The assistant answers with your agent\'s name and your organisation.',
		next: (url) => `Next, five plain sentences to try: ${url}`,
		bye: "Enjoy,",
	},
};

/**
 * @param {{lang: string, personName: string, orgName: string, invitationUrl: string,
 *          agents: {label: string, client: string}[]}} input
 * @returns {{subject: string, text: string}}
 */
export function renderWelcomeEmail(input) {
	const { lang, invitationUrl } = input;
	if (!LANGS.includes(lang)) throw new Error(`welcome email language must be fr or en, got "${lang}"`);
	if (!invitationUrl) throw new Error("welcome email needs the invitation URL returned by Clerk");
	let host;
	try {
		host = new URL(invitationUrl).hostname;
	} catch {
		throw new Error(`invitation URL "${invitationUrl}" is not a URL`);
	}
	if (host.startsWith("clerk.")) {
		throw new Error(`invitation URL is on the Clerk frontend API host (${host}), which answers 404 on /sign-up`);
	}
	const nfc = (s) => String(s).normalize("NFC");
	const t = TEXT[lang];
	const docs = DOCS[lang];
	const lines = [
		t.hello(nfc(input.personName)),
		"",
		t.intro(nfc(input.orgName)),
		"",
		t.step1,
		t.signUp(invitationUrl),
		"",
		t.step2,
	];
	for (const a of input.agents) {
		lines.push("", t.agentLine(nfc(a.label), a.client));
		const steps = STEPS[a.client]?.[lang] ?? GENERIC[lang](docs.connect);
		for (const s of steps) lines.push(`- ${s}`);
	}
	lines.push("", t.consent, "", t.step3, t.check, "", t.next(docs.firstSteps), "", t.bye);
	return { subject: nfc(t.subject(nfc(input.orgName))), text: lines.join("\n").normalize("NFC") };
}
