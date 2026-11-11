// Welcome email rendered by onboard-person (task k172sk173z6mw5cfc5refy1pz18hgaqa, scope 2).
// The script never sends mail: it returns the email the operator sends, in the person's language,
// carrying every step after sign-up so nobody improvises them.
import { describe, expect, it } from "vitest";
import { renderWelcomeEmail } from "../lib/welcome-email.mjs";

const INVITE = "https://accounts.vantagepeers.com/sign-up?__clerk_ticket=tkt_test";
const base = {
	personName: "Stéphane Lefèvre",
	orgName: "Immobilière Pujol",
	invitationUrl: INVITE,
	agents: [
		{ label: "Télémaque", client: "claude" },
		{ label: "Ulysse", client: "chatgpt" },
	],
};

describe("renderWelcomeEmail", () => {
	it("FR: subject and body carry the invitation link, the MCP URL and the check sentence", () => {
		const m = renderWelcomeEmail({ ...base, lang: "fr" });
		expect(m.subject).toContain("VantagePeers");
		expect(m.text).toContain(INVITE);
		expect(m.text).toContain("https://mcp.vantagepeers.com/mcp");
		expect(m.text).toContain("Qui suis-je sur VantagePeers ?");
		expect(m.text).toContain("https://www.vantagepeers.com/docs/fr/cloud/first-steps");
	});

	it("FR: names each agent with the exact steps of its assistant", () => {
		const m = renderWelcomeEmail({ ...base, lang: "fr" });
		expect(m.text).toContain("Télémaque");
		expect(m.text).toContain("Personnalisation > Plugins > Ajouter une marketplace");
		expect(m.text).toContain("vantageos-agency/vantage-peers-claude");
		expect(m.text).toContain("Ulysse");
		expect(m.text).toContain("Add custom MCP server");
	});

	it("EN: same content in English", () => {
		const m = renderWelcomeEmail({ ...base, lang: "en" });
		expect(m.text).toContain(INVITE);
		expect(m.text).toContain("Who am I on VantagePeers?");
		expect(m.text).toContain("Customize > Plugins > Add a marketplace");
		expect(m.text).toContain("https://www.vantagepeers.com/docs/cloud/first-steps");
		expect(m.text).not.toContain("Qui suis-je");
	});

	it("accented names survive intact, in NFC (a decomposed input is composed)", () => {
		const decomposed = "Stéphane";
		const m = renderWelcomeEmail({ ...base, personName: decomposed, lang: "fr" });
		expect(m.text).toContain("Stéphane");
		expect(m.text).not.toContain("é");
		expect(m.text.normalize("NFC")).toBe(m.text);
	});

	it("the invitation link is the only sign-up link: the MCP URL is never presented as the place to sign up", () => {
		const m = renderWelcomeEmail({ ...base, lang: "fr" });
		const signUpLines = m.text.split("\n").filter((l) => /inscri|créez votre compte/i.test(l));
		expect(signUpLines.length).toBeGreaterThan(0);
		for (const l of signUpLines) expect(l).not.toContain("mcp.vantagepeers.com");
	});

	it("Grok gets the connect page's steps, in both languages", () => {
		const agents = [{ label: "Alma", client: "grok" }];
		const en = renderWelcomeEmail({ ...base, agents, lang: "en" });
		expect(en.text).toContain("Connectors > New connector > Custom connector");
		const fr = renderWelcomeEmail({ ...base, agents, lang: "fr" });
		expect(fr.text).toContain("Connecteurs > Nouveau connecteur > Connecteur personnalisé");
		expect(fr.text).toContain("https://mcp.vantagepeers.com/mcp");
	});

	it("an assistant without written steps gets the generic MCP step, never an invented screen", () => {
		const m = renderWelcomeEmail({ ...base, agents: [{ label: "Alma", client: "opencode" }], lang: "en" });
		expect(m.text).toContain("Alma");
		expect(m.text).toContain("https://mcp.vantagepeers.com/mcp");
		expect(m.text).toContain("https://www.vantagepeers.com/docs/cloud/connect");
	});

	it("refuses an invitation URL on the Clerk frontend-API host and an unknown language", () => {
		expect(() =>
			renderWelcomeEmail({ ...base, invitationUrl: "https://clerk.vantagepeers.com/sign-up?__clerk_ticket=x", lang: "fr" }),
		).toThrow(/frontend API/);
		expect(() => renderWelcomeEmail({ ...base, lang: "de" })).toThrow(/fr or en/);
		expect(() => renderWelcomeEmail({ ...base, invitationUrl: null, lang: "fr" })).toThrow(/invitation URL/);
	});
});
