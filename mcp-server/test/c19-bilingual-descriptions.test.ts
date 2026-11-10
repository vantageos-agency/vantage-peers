/**
 * C-19 (mcp-standard, served tool descriptions): every description the server
 * SERVES over tools/list carries both languages in one string, "<English> /
 * <French>" (task k17adhp6pnh5sg64thkqjrn76x8hwwqz).
 *
 * The bilingual shape is the one mcp-doctor reads,
 * `src/detectors/c19-served-descriptions.ts` @39a5d0adce `BILINGUAL_SPLIT_RE`,
 * copied here verbatim so this suite fails where the doctor would.
 *
 * The English half is pinned BYTE FOR BYTE to what the server served at
 * 7887206c (fixture `c19-served-english-7887206c.json`, read from the built
 * stdio server's tools/list): composing the French half must never edit the
 * English one. The French half is pinned to the one map it comes from.
 *
 * Not covered here, on purpose: the doctor's trigger-phrase clause
 * ("use this whenever ... even if they don't say"), which would change the
 * English half. No C-13 per-tool ceiling (`CONTEXT_CEILING` /
 * `contextCeiling`) is declared in this repository, so C-19's budget half
 * has no bound to check.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { NO_PERSON_DOOR_NOTE } from "../src/registerTool.js";
import { registerTools } from "../src/tools.js";

const BILINGUAL_SPLIT_RE = /^(.{10,})\s\/\s(.{10,})$/;
const SEPARATOR = " / ";

const ENGLISH_AT_7887206C: Record<string, string> = JSON.parse(
	readFileSync(
		join(__dirname, "fixtures", "c19-served-english-7887206c.json"),
		"utf-8",
	),
);

type ServedTool = { name: string; description?: string };

async function servedTools(): Promise<ServedTool[]> {
	const server = new McpServer({ name: "t", version: "0.0.0" });
	const convex = {
		query: async () => null,
		mutation: async () => null,
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, {
		clientId: "m",
		userId: "m",
		scopes: [],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3600_000,
		isMaster: true,
	} as OAuthContext);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools as ServedTool[];
}

/** The French half: what follows the English pinned at 7887206c and " / ". */
function frenchHalf(t: ServedTool): string | undefined {
	const english = ENGLISH_AT_7887206C[t.name];
	const served = t.description ?? "";
	if (english === undefined || !served.startsWith(`${english}${SEPARATOR}`))
		return undefined;
	return served.slice(english.length + SEPARATOR.length);
}

let tools: ServedTool[] = [];
beforeAll(async () => {
	tools = await servedTools();
});

describe("C-19 — served descriptions carry English and French", () => {
	it("serves the 93 tools of the pinned snapshot, no more, no fewer", () => {
		expect(tools.map((t) => t.name).sort()).toEqual(
			Object.keys(ENGLISH_AT_7887206C).sort(),
		);
		expect(tools).toHaveLength(93);
	});

	it("every served description matches the doctor's <en> / <fr> split", () => {
		const mono = tools
			.filter((t) => !BILINGUAL_SPLIT_RE.test(t.description ?? ""))
			.map((t) => t.name);
		expect(mono).toEqual([]);
	});

	it("the English half is byte-identical to what 7887206c served", () => {
		const edited = tools
			.filter((t) => frenchHalf(t) === undefined)
			.map((t) => t.name);
		expect(edited).toEqual([]);
	});

	it("each French half is non-empty, single-line and not the English copied", () => {
		const bad = tools
			.filter((t) => {
				const fr = frenchHalf(t);
				const en = ENGLISH_AT_7887206C[t.name] ?? "";
				return (
					fr === undefined ||
					fr.trim().length < 10 ||
					fr.includes("\n") ||
					fr === en ||
					fr.includes(en)
				);
			})
			.map((t) => t.name);
		expect(bad).toEqual([]);
	});

	it("every served tool has exactly one French entry, and no entry names an unserved tool", async () => {
		const { TOOL_DESCRIPTIONS_FR } = await import("../src/descriptionsFr.js");
		expect(Object.keys(TOOL_DESCRIPTIONS_FR).sort()).toEqual(
			tools.map((t) => t.name).sort(),
		);
	});

	it("the French half is the map's entry, with the French person-door note exactly where the English one is", async () => {
		const { TOOL_DESCRIPTIONS_FR, NO_PERSON_DOOR_NOTE_FR } = await import(
			"../src/descriptionsFr.js"
		);
		const wrong = tools
			.filter((t) => {
				const en = ENGLISH_AT_7887206C[t.name] ?? "";
				const note = en.endsWith(NO_PERSON_DOOR_NOTE)
					? NO_PERSON_DOOR_NOTE_FR
					: "";
				return frenchHalf(t) !== `${TOOL_DESCRIPTIONS_FR[t.name]}${note}`;
			})
			.map((t) => t.name);
		expect(wrong).toEqual([]);
	});
});
