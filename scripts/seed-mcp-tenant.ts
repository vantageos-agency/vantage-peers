#!/usr/bin/env bun
/**
 * CLI helper to provision a new VIP MCP tenant.
 *
 * 1. Generates a cryptographically-secure 32-byte bearer token (hex).
 * 2. SHA-256 hashes it and stores the hash in Convex (raw token is never persisted).
 * 3. Creates the tenant in DISABLED state — run enableTenant separately.
 * 4. Prints the raw bearer token to stdout ONCE — save it immediately.
 *
 * Usage:
 *   bun run scripts/seed-mcp-tenant.ts \
 *     --tenant-name "vip-client-1" \
 *     --convex-url "https://clientxyz.convex.cloud" \
 *     --master-token "$BEARER_SECRET_MASTER"
 *
 * Optional:
 *   --deployment-url  Override the VantagePeers Convex deployment URL
 *                     (defaults to CONVEX_URL env var or .env.local)
 *   --enable          Also enable the tenant immediately after creation
 */

import { ConvexHttpClient } from "convex/browser";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api } from "../convex/_generated/api.js";

// ── Parse CLI args ──────────────────────────────────────────────────────────

function getArg(flag: string): string | undefined {
	const idx = process.argv.indexOf(flag);
	return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function requireArg(flag: string, envFallback?: string): string {
	const val = getArg(flag) ?? (envFallback ? process.env[envFallback] : undefined);
	if (!val) {
		console.error(`Error: ${flag} is required (or set ${envFallback ?? "the env var"})`);
		process.exit(1);
	}
	return val;
}

const tenantName = requireArg("--tenant-name");
const convexUrl = requireArg("--convex-url");
const masterToken = requireArg("--master-token", "BEARER_SECRET_MASTER");
const enableImmediately = process.argv.includes("--enable");

// ── Resolve VantagePeers deployment URL ──────────────────────────────────────

function resolveDeploymentUrl(): string {
	// 1. Explicit flag
	const explicit = getArg("--deployment-url");
	if (explicit) return explicit;

	// 2. Environment variable
	if (process.env.CONVEX_URL) return process.env.CONVEX_URL;

	// 3. .env.local file in project root
	const envLocalPath = resolve(import.meta.dir, "..", ".env.local");
	if (existsSync(envLocalPath)) {
		const lines = readFileSync(envLocalPath, "utf-8").split("\n");
		for (const line of lines) {
			const match = line.match(/^CONVEX_URL\s*=\s*"?([^"\n]+)"?/);
			if (match) return match[1].trim();
		}
	}

	// 4. convex/.env file
	const convexEnvPath = resolve(import.meta.dir, "..", "convex", ".env");
	if (existsSync(convexEnvPath)) {
		const lines = readFileSync(convexEnvPath, "utf-8").split("\n");
		for (const line of lines) {
			const match = line.match(/^CONVEX_URL\s*=\s*"?([^"\n]+)"?/);
			if (match) return match[1].trim();
		}
	}

	console.error(
		"Error: Could not resolve VantagePeers Convex deployment URL.\n" +
		"Set CONVEX_URL env var or pass --deployment-url."
	);
	process.exit(1);
}

const deploymentUrl = resolveDeploymentUrl();

// ── Generate token + hash ────────────────────────────────────────────────────

const rawTokenBytes = randomBytes(32);
const rawToken = rawTokenBytes.toString("hex"); // 64-char hex string
const tokenHash = createHash("sha256").update(rawToken).digest("hex");

// ── Call Convex ──────────────────────────────────────────────────────────────

const client = new ConvexHttpClient(deploymentUrl);

console.error(`[seed-mcp-tenant] Connecting to ${deploymentUrl}`);
console.error(`[seed-mcp-tenant] Creating tenant: ${tenantName}`);
console.error(`[seed-mcp-tenant] Target Convex URL: ${convexUrl}`);

try {
	const tenantId = await client.mutation(api.mcpTenants.createTenant, {
		callerToken: masterToken,
		tokenHash,
		tenantName,
		convexUrl,
	});

	console.error(`[seed-mcp-tenant] Tenant created: ${tenantId} (disabled)`);

	if (enableImmediately) {
		await client.mutation(api.mcpTenants.enableTenant, {
			callerToken: masterToken,
			tenantId,
		});
		console.error(`[seed-mcp-tenant] Tenant enabled.`);
	}

	// ── Output ─────────────────────────────────────────────────────────────
	// Print ONLY the raw token to stdout — caller can capture with $()
	// All other output goes to stderr to avoid contamination.
	process.stdout.write(rawToken + "\n");

	console.error("");
	console.error("─────────────────────────────────────────────────────────");
	console.error(`  Tenant ID   : ${tenantId}`);
	console.error(`  Tenant Name : ${tenantName}`);
	console.error(`  Convex URL  : ${convexUrl}`);
	console.error(`  Status      : ${enableImmediately ? "ENABLED" : "DISABLED (run enableTenant to activate)"}`);
	console.error("  Bearer token printed to stdout — save it now, it will");
	console.error("  not be shown again.");
	console.error("─────────────────────────────────────────────────────────");
} catch (err) {
	console.error(`[seed-mcp-tenant] Error: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
