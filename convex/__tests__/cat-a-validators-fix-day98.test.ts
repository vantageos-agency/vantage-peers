/// <reference types="vite/client" />
//
// Day 98 Cat A k17e611z4 — returns/args validator schema bug fixes
//
// Closes GitHub issues:
//   #655 ReturnsValidationError extra field `tenantId` on messages:listMessages
//   #644 same (duplicate auto-IRP)
//   #643 same (duplicate auto-IRP)
//   #642 ArgumentValidationError extra field `limit` on profiles:listProfiles
//
// Issue #642 is already fixed in convex/profiles.ts L264 (limit declared
// optional). This test guards against regression.
//
// Issue #655/#644/#643 fixed by adding `tenantId: v.optional(v.string())`
// to messages.listMessages returns shape.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

describe("Cat A — issues #655 #644 #643 — listMessages tenantId returns shape", () => {
	test("messages with tenantId pass through listMessages without ReturnsValidationError", async () => {
		const t = createTestConvex();
		// Insert a multi-tenant message — the production trigger row shape.
		await t.run(async (ctx) => {
			await ctx.db.insert("messages", {
				from: "sigma",
				fromInstanceId: "sigma-vps",
				channel: "Zoe",
				content: "ping",
				sessionDay: 98,
				createdAt: 1781100000000,
				tenantId: "project/acme-hr",
			});
		});

		// Pre-fix this call would throw:
		//   ReturnsValidationError: Object contains extra field `tenantId`
		// Post-fix it returns the row with tenantId preserved.
		const rows = await t.query(api.messages.listMessages, {});
		expect(rows.length).toBe(1);
		expect(rows[0].tenantId).toBe("project/acme-hr");
	});

	test("messages without tenantId still list cleanly (optional field)", async () => {
		const t = createTestConvex();
		await t.run(async (ctx) => {
			await ctx.db.insert("messages", {
				from: "sigma",
				fromInstanceId: "sigma-vps",
				channel: "sigma",
				content: "no-tenant message",
				sessionDay: 98,
				createdAt: 1781100000000,
			});
		});

		const rows = await t.query(api.messages.listMessages, {});
		expect(rows.length).toBe(1);
		expect(rows[0].tenantId).toBeUndefined();
	});
});

describe("Cat A — issue #642 — profiles.listProfiles accepts `limit`", () => {
	test("listProfiles with limit + fields=lite does NOT throw ArgumentValidationError", async () => {
		const t = createTestConvex();
		// No row insert needed — empty profiles is a valid state.
		// Pre-#642-fix the args validator would throw on `limit` field:
		//   ArgumentValidationError: Object contains extra field `limit`
		// Post-fix (v2.4.12 patch already shipped) the call accepts limit.
		const rows = await t.query(api.profiles.listProfiles, {
			fields: "lite",
			limit: 20,
		});
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBe(0);
	});

	test("listProfiles with limit alone does NOT throw", async () => {
		const t = createTestConvex();
		const rows = await t.query(api.profiles.listProfiles, { limit: 5 });
		expect(Array.isArray(rows)).toBe(true);
	});
});
