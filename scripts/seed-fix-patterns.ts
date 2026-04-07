#!/usr/bin/env bun
/**
 * Seed fixPatterns from MyReelDream GitHub issues.
 * Fetches all issues, extracts symptoms/root causes, creates patterns.
 *
 * Usage: bun scripts/seed-fix-patterns.ts
 *
 * Idempotent: checks for existing patterns by sourceProject before inserting.
 */

import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "fs";
import { resolve } from "path";
import { api } from "../convex/_generated/api.js";

const REPO = "myreeldream-ai/MyShortReel-beta";
const PROJECT = "myreeldream";

// ── Load Convex URL ─────────────────────────────────────────────────────────

function loadConvexUrl(): string {
	if (process.env.CONVEX_URL) return process.env.CONVEX_URL;
	const envPath = resolve(import.meta.dirname ?? __dirname, "../.env.local");
	const raw = readFileSync(envPath, "utf-8");
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("CONVEX_URL=")) {
			return trimmed.slice("CONVEX_URL=".length).split("#")[0].trim();
		}
	}
	throw new Error("CONVEX_URL not found");
}

const convex = new ConvexHttpClient(loadConvexUrl());

// ── GitHub helpers ──────────────────────────────────────────────────────────

interface GhIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: Array<{ name: string }>;
	comments: Array<{ body: string; author: { login: string } }>;
}

async function fetchIssue(num: number): Promise<GhIssue> {
	const proc = Bun.spawn(
		[
			"gh",
			"issue",
			"view",
			String(num),
			"--repo",
			REPO,
			"--json",
			"number,title,body,state,labels,comments",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	return JSON.parse(text);
}

async function fetchAllIssueNumbers(): Promise<number[]> {
	const proc = Bun.spawn(
		[
			"gh",
			"issue",
			"list",
			"--repo",
			REPO,
			"--state",
			"all",
			"--limit",
			"200",
			"--json",
			"number",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	return JSON.parse(text).map((i: { number: number }) => i.number);
}

// ── Extract pattern data from issue ──────────────────────────────────────────

function extractSeverity(
	labels: string[],
): "critical" | "major" | "minor" {
	if (labels.some((l) => l.includes("P0") || l.includes("CRITICAL"))) return "critical";
	if (labels.some((l) => l.includes("P1") || l.includes("High"))) return "major";
	return "minor";
}

function extractTags(title: string, body: string, labels: string[]): string[] {
	const tags = new Set<string>();

	// From labels
	for (const l of labels) {
		if (l === "bug") tags.add("bug");
		if (l.includes("enhancement")) tags.add("enhancement");
		if (l.includes("feature")) tags.add("feature");
	}

	// From content keywords
	const text = `${title} ${body}`.toLowerCase();
	if (text.includes("credit") || text.includes("coin")) tags.add("credit-system");
	if (text.includes("music") || text.includes("audio")) tags.add("audio");
	if (text.includes("narration") || text.includes("voice")) tags.add("narration");
	if (text.includes("video") || text.includes("reel")) tags.add("video");
	if (text.includes("ai director") || text.includes("story")) tags.add("ai-director");
	if (text.includes("chat") || text.includes("message")) tags.add("chat");
	if (text.includes("upload") || text.includes("download")) tags.add("file-handling");
	if (text.includes("login") || text.includes("auth") || text.includes("sign")) tags.add("auth");
	if (text.includes("mobile") || text.includes("responsive")) tags.add("mobile");
	if (text.includes("convex")) tags.add("convex-subscription");
	if (text.includes("hydra")) tags.add("react-hydration");
	if (text.includes("i18n") || text.includes("translation") || text.includes("language")) tags.add("i18n");
	if (text.includes("payment") || text.includes("polar") || text.includes("subscri")) tags.add("payment");
	if (text.includes("fal.ai") || text.includes("fal ")) tags.add("fal-ai");
	if (text.includes("generation") || text.includes("generat")) tags.add("generation");
	if (text.includes("script") || text.includes("premiere")) tags.add("script-editor");

	return [...tags];
}

function extractStack(body: string): string[] {
	const stack = new Set<string>(["next.js", "convex"]);
	const text = body.toLowerCase();

	if (text.includes("clerk")) stack.add("clerk");
	if (text.includes("polar")) stack.add("polar");
	if (text.includes("fal.ai") || text.includes("fal ")) stack.add("fal-ai");
	if (text.includes("openai") || text.includes("gpt")) stack.add("openai");
	if (text.includes("stripe")) stack.add("stripe");

	return [...stack];
}

function extractFixInfo(comments: GhIssue["comments"]): {
	attempts: Array<{
		description: string;
		worked: boolean;
		why: string;
		commit?: string;
	}>;
	validatedFix?: string;
} {
	const attempts: Array<{
		description: string;
		worked: boolean;
		why: string;
		commit?: string;
	}> = [];

	for (const comment of comments) {
		const body = comment.body;
		// Look for fix-related comments
		if (
			body.includes("fix") ||
			body.includes("resolved") ||
			body.includes("patch") ||
			body.includes("commit") ||
			body.includes("deploy")
		) {
			// Extract commit hash if present
			const commitMatch = body.match(/\b([0-9a-f]{7,40})\b/);
			const commit = commitMatch ? commitMatch[1] : undefined;

			const worked =
				body.includes("resolved") ||
				body.includes("fixed") ||
				body.includes("deployed") ||
				body.includes("verified");

			attempts.push({
				description: body.slice(0, 500),
				worked,
				why: worked
					? "Fix verified and deployed"
					: "Attempt made, status unclear",
				commit,
			});
		}
	}

	const validatedFix = attempts.find((a) => a.worked)?.description;
	return { attempts, validatedFix };
}

// ── Main seeding logic ──────────────────────────────────────────────────────

async function main() {
	console.log("Fetching existing patterns to check for duplicates...");

	// Check for existing patterns
	const existing = await convex.query(api.fixPatterns.listByProject, {
		sourceProject: PROJECT,
		limit: 200,
	});
	const existingIssueIds = new Set<string>();
	for (const p of existing) {
		for (const id of p.linkedIssueIds ?? []) {
			existingIssueIds.add(id);
		}
	}
	console.log(`Found ${existing.length} existing patterns (${existingIssueIds.size} linked issues)`);

	console.log("Fetching all issue numbers...");
	const numbers = await fetchAllIssueNumbers();
	console.log(`Found ${numbers.length} issues to process`);

	let created = 0;
	let skipped = 0;
	let errors = 0;

	for (const num of numbers) {
		const issueKey = `${REPO}#${num}`;

		if (existingIssueIds.has(issueKey)) {
			skipped++;
			continue;
		}

		try {
			console.log(`Processing #${num}...`);
			const issue = await fetchIssue(num);

			const labels = issue.labels.map((l) => l.name);
			const body = issue.body || "";
			const severity = extractSeverity(labels);
			const tags = extractTags(issue.title, body, labels);
			const stack = extractStack(body);
			const { attempts, validatedFix } = extractFixInfo(issue.comments);

			// Create the pattern
			const symptom = `#${num}: ${issue.title}${body ? `\n${body.slice(0, 300)}` : ""}`;
			const rootCause =
				issue.state === "CLOSED" && validatedFix
					? `Issue was resolved. ${validatedFix.slice(0, 200)}`
					: `Issue reported: ${issue.title}. ${body ? body.slice(0, 200) : "No details provided."}`;

			const patternId = await convex.mutation(api.fixPatterns.create, {
				symptom,
				rootCause,
				validatedFix: validatedFix?.slice(0, 500),
				tags,
				stack,
				sourceProject: PROJECT,
				linkedIssueIds: [issueKey],
				createdBy: "sigma",
				severity,
			});

			// Add fix attempts
			for (const attempt of attempts) {
				await convex.mutation(api.fixPatterns.addAttempt, {
					patternId,
					description: attempt.description,
					worked: attempt.worked,
					why: attempt.why,
					createdBy: "sigma",
					commit: attempt.commit,
				});
			}

			created++;
			// Throttle to avoid rate limiting
			if (created % 10 === 0) {
				console.log(`  Progress: ${created} created, ${skipped} skipped, ${errors} errors`);
				await Bun.sleep(1000);
			}
		} catch (err) {
			console.error(`  Error processing #${num}:`, err);
			errors++;
		}
	}

	console.log(`\nDone! Created: ${created}, Skipped: ${skipped}, Errors: ${errors}`);
}

main().catch(console.error);
