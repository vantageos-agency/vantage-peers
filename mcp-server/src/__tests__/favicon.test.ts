/**
 * The MCP origin carries the VantagePeers icon (task k17455xv7tzgdqr6ys861pd38h8habp5).
 * Measured on prod dbcfc2fc: https://mcp.vantagepeers.com/favicon.ico -> 404, and
 * Claude.ai showed a generic icon for the connector. The icon bytes are the ones
 * vantagepeers.com serves (no new artwork); serverInfo declares them (MCP
 * Implementation.icons).
 */

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
