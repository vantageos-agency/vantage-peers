/**
 * The consent / organisation picker wears the VantagePeers dashboard design
 * (vantage-peers-dashboard styles/presets/base.css): dark first, light under
 * prefers-color-scheme, one option card per organisation with its role, the
 * VantagePeers name above the title. It still loads no external asset: the
 * single inline style is the one hashed into the page CSP.
 */

import { describe, expect, it } from "vitest";
import {
	pickerContentSecurityPolicy,
	renderOrgPicker,
} from "../src/authorize.js";

const model = {
	state: "st",
	client: { clientId: "c", clientName: "Claude" },
	resource: "r",
	scope: "mcp:full",
	redirectOrigin: "https://claude.ai",
	organizations: [
		{ id: "org_1", slug: "a", name: "Alpha", role: "org:admin" },
		{ id: "org_2", slug: "b", name: "Beta <Corp>", role: "org:member" },
	],
	consentRequired: true,
	consentToken: "ct",
} as Parameters<typeof renderOrgPicker>[0];

describe("picker page design", () => {
	it("uses the VantagePeers dashboard tokens: dark first, light under prefers-color-scheme", () => {
		const html = renderOrgPicker(model);
		expect(html).toContain("--background:oklch(0.08 0.005 265)");
		expect(html).toContain("--card:oklch(0.11 0.005 265)");
		expect(html).toContain("@media (prefers-color-scheme:light)");
		expect(html).toContain("--background:oklch(0.98 0.003 265)");
		expect(html).toContain('<meta name="color-scheme" content="dark light">');
	});

	it("renders one option card per organisation, escaped, the role without its org: prefix", () => {
		const html = renderOrgPicker(model);
		expect(html.match(/<label class="org">/g)?.length).toBe(2);
		expect(html).toContain('<span class="role">admin</span>');
		expect(html).toContain('<span class="role">member</span>');
		expect(html).toContain("Beta &lt;Corp&gt;");
		expect(html).not.toContain("(org:admin)");
	});

	it("names VantagePeers above the title and keeps Approve as the primary action", () => {
		const html = renderOrgPicker(model);
		expect(html).toContain('<p class="brand">VantagePeers</p>');
		expect(html).toContain(
			'<button class="primary" type="submit" name="approved" value="true">',
		);
	});

	it("keeps the CSP hash equal to the one inline style the page carries", async () => {
		const html = renderOrgPicker(model);
		const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
			(m) => m[1],
		);
		expect(styles).toHaveLength(1);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(styles[0]),
		);
		const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
		expect(await pickerContentSecurityPolicy()).toContain(
			`style-src 'sha256-${hash}'`,
		);
		expect(html).not.toMatch(/ style="/);
	});
});
