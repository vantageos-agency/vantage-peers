/**
 * Silent-filter-drop detector, both poles (task k17cv03wd3g60gz3p498879f2d8hx4pv).
 *
 * Pole 1 (the instrument): fixtures shaped like the defect are flagged and the
 * same shapes, fixed, are not. Pole 2 (the tree): the real read paths of this
 * repo carry no drop. At 56425010 pole 2 fails on exactly two sites,
 * messages:listMessages (master path: sessionDay branch drops `from`) and the
 * MCP list_issues handler (assignedTo branch drops `project`).
 *
 * The detector is a repo-local test and lives here; the @vantageos/backend-doctor
 * package is not edited by this change.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findFilterDrops } from "../lib/filter-drop-detector.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const DROP_CONVEX = `
export const list = query({ handler: async (ctx, args) => {
  let rows;
  if (args.sessionDay !== undefined) {
    rows = await ctx.db.query("m").withIndex("by_day", (q) => q.eq("d", args.sessionDay)).take(5);
  } else if (args.from !== undefined) {
    rows = await ctx.db.query("m").withIndex("by_from", (q) => q.eq("f", args.from)).take(5);
  } else {
    rows = await ctx.db.query("m").take(5);
  }
  return rows;
}});`;

const COMPOSED_CONVEX = `
export const list = query({ handler: async (ctx, args) => {
  let rows;
  if (args.sessionDay !== undefined && args.from !== undefined) {
    rows = await ctx.db.query("m").withIndex("by_from_day", (q) => q.eq("f", args.from).eq("d", args.sessionDay)).take(5);
  } else if (args.sessionDay !== undefined) {
    rows = await ctx.db.query("m").withIndex("by_day", (q) => q.eq("d", args.sessionDay)).take(5);
  } else if (args.from !== undefined) {
    rows = await ctx.db.query("m").withIndex("by_from", (q) => q.eq("f", args.from)).take(5);
  } else {
    rows = await ctx.db.query("m").take(5);
  }
  return rows;
}});`;

const GUARDED_CONVEX = `
export const list = query({ handler: async (ctx, args) => {
  if (args.a !== undefined && args.b !== undefined) {
    throw new Error("a and b cannot be combined");
  }
  let rows;
  if (args.a !== undefined) {
    rows = await ctx.db.query("m").withIndex("by_a", (q) => q.eq("a", args.a)).take(5);
  } else if (args.b !== undefined) {
    rows = await ctx.db.query("m").withIndex("by_b", (q) => q.eq("b", args.b)).take(5);
  } else {
    rows = await ctx.db.query("m").take(5);
  }
  return rows;
}});`;

const NARROWED_AFTER_CONVEX = `
export const list = query({ handler: async (ctx, args) => {
  let rows;
  if (args.a !== undefined) {
    rows = await ctx.db.query("m").withIndex("by_a", (q) => q.eq("a", args.a)).take(5);
  } else if (args.b !== undefined) {
    rows = await ctx.db.query("m").withIndex("by_b", (q) => q.eq("b", args.b)).take(5);
  } else {
    rows = await ctx.db.query("m").take(5);
  }
  if (args.b !== undefined) rows = rows.filter((r) => r.b === args.b);
  return rows;
}});`;

const DROP_MCP = `
async ({ assignedTo, project, status }) => {
  let results;
  if (assignedTo) {
    results = await convex.query("issues:listByOrchestrator", { assignedOrchestrator: assignedTo, status });
  } else if (project) {
    results = await convex.query("issues:listByProject", { project, status });
  } else {
    results = await convex.query("issues:listByStatus", { status });
  }
}`;

const GUARDED_MCP = `
async ({ assignedTo, project, status }) => {
  if (assignedTo && project) {
    return mcpError("assignedTo and project cannot be combined");
  }
  let results;
  if (assignedTo) {
    results = await convex.query("issues:listByOrchestrator", { assignedOrchestrator: assignedTo, status });
  } else if (project) {
    results = await convex.query("issues:listByProject", { project, status });
  } else {
    results = await convex.query("issues:listByStatus", { status });
  }
}`;

describe("filter-drop detector — the instrument, both poles", () => {
	it("flags a Convex chain whose first branch drops a later filter", () => {
		const { hits } = findFilterDrops(DROP_CONVEX);
		expect(hits.map((h) => `${h.branch}:${h.dropped}`)).toEqual(["0:from"]);
	});

	it("flags an MCP handler chain whose first branch drops a later filter", () => {
		const { hits } = findFilterDrops(DROP_MCP, { bare: true });
		expect(hits.map((h) => `${h.branch}:${h.dropped}`)).toEqual(["0:project"]);
	});

	it("passes a chain that composes the two filters first", () => {
		expect(findFilterDrops(COMPOSED_CONVEX).hits).toEqual([]);
	});

	it("passes a chain whose pair is refused before it", () => {
		expect(findFilterDrops(GUARDED_CONVEX).hits).toEqual([]);
		expect(findFilterDrops(GUARDED_MCP, { bare: true }).hits).toEqual([]);
	});

	it("passes a filter that is narrowed after the chain (Convex)", () => {
		expect(findFilterDrops(NARROWED_AFTER_CONVEX).hits).toEqual([]);
	});

	it("ignores a commented-out chain", () => {
		const commented = DROP_CONVEX.split("\n")
			.map((l) => `// ${l}`)
			.join("\n");
		expect(findFilterDrops(commented).hits).toEqual([]);
	});
});

describe("filter-drop detector — the tree", () => {
	const convexDir = join(REPO, "convex");
	const files = readdirSync(convexDir)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
		.map((f) => ({ file: `convex/${f}`, bare: false }));
	files.push({ file: "mcp-server/src/tools.ts", bare: true });

	it("no read path in convex/*.ts or mcp-server/src/tools.ts drops a caller's filter", () => {
		const found = [];
		for (const { file, bare } of files) {
			const { hits } = findFilterDrops(readFileSync(join(REPO, file), "utf8"), {
				file,
				bare,
			});
			for (const h of hits) found.push(`${h.file}:${h.line} branch ${h.branch} drops ${h.dropped}`);
		}
		expect(found).toEqual([]);
	});

	it("the scan reads real chains (a detector that reads nothing proves nothing)", () => {
		let chains = 0;
		for (const { file, bare } of files) {
			const src = readFileSync(join(REPO, file), "utf8");
			chains += findFilterDrops(src, { file, bare }).chains;
		}
		// mandates:list (a compound five-branch chain, guarded) alone is one.
		expect(chains).toBeGreaterThanOrEqual(3);
	});
});
