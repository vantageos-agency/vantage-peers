/**
 * The MCP origin carries the VantagePeers icon (task k17455xv7tzgdqr6ys861pd38h8habp5).
 * Measured on prod dbcfc2fc: https://mcp.vantagepeers.com/favicon.ico -> 404, and
 * Claude.ai showed a generic icon for the connector. The icon bytes are the ones
 * vantagepeers.com serves (no new artwork); serverInfo declares them (MCP
 * Implementation.icons).
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app } from "../../server-http.js";
import { mcpImplementation } from "../brand.js";

describe("the MCP origin serves the brand icon", () => {
	it("GET /favicon.ico -> 200, an icon", async () => {
		const res = await app.request("http://localhost:3000/favicon.ico");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/^image\//);
		const bytes = new Uint8Array(await res.arrayBuffer());
		// ICO header: reserved 0, type 1
		expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0, 0, 1, 0]);
	});

	it("GET /icon.png -> 200, a PNG", async () => {
		const res = await app.request("http://localhost:3000/icon.png");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect([bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4e, 0x47]);
	});

	// The canonical logo (vantage-peers-site public/logo-v.svg), byte-identical to
	// what www.vantagepeers.com serves: a drift on either side fails here.
	it("serves the canonical V logo bytes", async () => {
		const expected: Record<string, string> = {
			"/favicon.ico":
				"e7a9c18610cae5dfcadf19a9a44fba0ebf50fa5af6462307a7efe78f1055c3a5",
			"/icon.png":
				"5f4b2a8a28d65c00a8e811236fb4caece91a3f5c83d3f8f3db7eea19089df6a5",
			"/apple-touch-icon.png":
				"ac6a3a795cc842e2a2afb0e49c1a3f79317131d35144920e775f1cdbd9d08bf3",
		};
		for (const [path, sha] of Object.entries(expected)) {
			const res = await app.request(`http://localhost:3000${path}`);
			const digest = createHash("sha256")
				.update(new Uint8Array(await res.arrayBuffer()))
				.digest("hex");
			expect([path, digest]).toEqual([path, sha]);
		}
	});

	it("the icons are public: no Authorization needed", async () => {
		const res = await app.request("http://localhost:3000/apple-touch-icon.png");
		expect(res.status).toBe(200);
	});
});

describe("serverInfo declares the icons", () => {
	it("names icons on the public origin, with their type and size", () => {
		const info = mcpImplementation("1.2.3", "https://mcp.example.com");
		expect(info.name).toBe("vantage-peers");
		expect(info.version).toBe("1.2.3");
		expect(info.icons).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					src: "https://mcp.example.com/icon.png",
					mimeType: "image/png",
					sizes: ["256x256"],
				}),
			]),
		);
	});

	it("without a public origin, the icon travels as a data URI", () => {
		const info = mcpImplementation("1.2.3", null);
		expect(info.icons?.[0]?.src.startsWith("data:image/png;base64,")).toBe(true);
	});
});
