/**
 * S4.1 — Cross-tenant test fixtures.
 *
 * Three fictitious tenants (alpha, beta, gamma) each get isolated seed data.
 * All test data is namespaced/marked so teardown can find and remove it.
 *
 * Skip behaviour: if any of the three VP_TEST_TOKEN_<TENANT> env vars are
 * missing, resolveTenantEnv() returns null and tests skip — no real PROD
 * leakage check possible without three live tenant tokens.
 *
 * Companion plan: decisions/s41-cross-tenant-e2e-plan.md
 */

import { callTool, initSession, type McpEnv } from "./dummy-entity.js";

export type TenantSlug = "alpha" | "beta" | "gamma";

export type TenantSeed = {
	slug: TenantSlug;
	tenantId: string;
	tokenEnvVar: string;
	/** Namespace prefix — every seed memory uses `test-<slug>-*`. */
	nsPrefix: string;
	memories: Array<{ namespace: string; content: string; type: string }>;
	tasks: Array<{ title: string; assignedTo: string; status: string }>;
	briefingNotes: Array<{ topic: string; content: string }>;
	missions: Array<{ title: string; description: string }>;
};

const baseSeed = (slug: TenantSlug): TenantSeed => ({
	slug,
	tenantId: `test-${slug}-tenant`,
	tokenEnvVar: `VP_TEST_TOKEN_${slug.toUpperCase()}`,
	nsPrefix: `test-${slug}-`,
	memories: [
		{
			namespace: `test-${slug}-project-roadmap`,
			content: `${slug} Q1 roadmap signed off`,
			type: "decision",
		},
		{
			namespace: `test-${slug}-project-roadmap`,
			content: `${slug} sprint 12 retro notes`,
			type: "note",
		},
		{
			namespace: `test-${slug}-global`,
			content: `${slug} CEO prefers async standups`,
			type: "user",
		},
		{
			namespace: `test-${slug}-audit-soc2`,
			content: `${slug} SOC2 evidence batch 1`,
			type: "audit",
		},
		{
			namespace: `test-${slug}-feedback`,
			content: `${slug} customer ${slug.toUpperCase()}-001 reported login bug`,
			type: "feedback",
		},
	],
	tasks: [
		{ title: `${slug} task A1 — sigma`, assignedTo: "sigma", status: "open" },
		{
			title: `${slug} task A2 — theta`,
			assignedTo: "theta",
			status: "in_progress",
		},
		{ title: `${slug} task A3 — pi`, assignedTo: "pi", status: "review" },
	],
	briefingNotes: [
		{
			topic: `test-${slug}-brief-1`,
			content: `${slug} briefing on roadmap Q1`,
		},
		{ topic: `test-${slug}-brief-2`, content: `${slug} onboarding playbook` },
	],
	missions: [
		{
			title: `${slug} mission M1`,
			description: `${slug} north-star Q1 mission`,
		},
	],
});

export const TENANTS: Record<TenantSlug, TenantSeed> = {
	alpha: baseSeed("alpha"),
	beta: baseSeed("beta"),
	gamma: baseSeed("gamma"),
};

/**
 * Resolve a tenant's MCP env (URL + per-tenant bearer token).
 * Returns null when the tenant token env var is absent — caller should skip.
 */
export function resolveTenantEnv(slug: TenantSlug): McpEnv | null {
	const prodUrl = process.env.VP_MCP_PROD_URL;
	const tenant = TENANTS[slug];
	const bearerToken = process.env[tenant.tokenEnvVar];
	if (!prodUrl || !bearerToken) return null;
	return { prodUrl, bearerToken };
}

/**
 * Check all three tenant tokens are present. If any missing, return false
 * and the entire cross-tenant suite skips.
 */
export function hasAllTenantCreds(): boolean {
	return (
		resolveTenantEnv("alpha") !== null &&
		resolveTenantEnv("beta") !== null &&
		resolveTenantEnv("gamma") !== null
	);
}

/**
 * Idempotently seed one tenant. Safe to call multiple times: checks for a
 * marker memory; if found, skips re-seeding.
 *
 * NB: requires the tenant's bearer token to belong to a real tenantId.
 * Cross-tenant write attempts (positive seed for tenant alpha using beta's
 * token) are exactly what S41-022/045 tests verify get rejected — do NOT
 * call seedTenant with mismatched tokens.
 */
export async function seedTenant(env: McpEnv, seed: TenantSeed): Promise<void> {
	const sessionId = await initSession(env);

	// Marker check — if first seed memory already exists, assume full seed done.
	const existing = (await callTool(env, sessionId, "list_memories", {
		namespace: seed.memories[0].namespace,
		limit: 1,
	})) as { content?: Array<{ text?: string }> };
	const existingText = existing?.content?.[0]?.text ?? "";
	if (existingText.includes(seed.memories[0].content)) return;

	for (const m of seed.memories) {
		await callTool(env, sessionId, "store_memory", {
			namespace: m.namespace,
			content: m.content,
			type: m.type,
			createdBy: `test-${seed.slug}`,
		});
	}
	for (const t of seed.tasks) {
		await callTool(env, sessionId, "create_task", {
			title: t.title,
			assignedTo: t.assignedTo,
			status: t.status,
			createdBy: `test-${seed.slug}`,
		});
	}
	for (const b of seed.briefingNotes) {
		await callTool(env, sessionId, "create_briefing_note", {
			topic: b.topic,
			content: b.content,
			createdBy: `test-${seed.slug}`,
		});
	}
	for (const m of seed.missions) {
		await callTool(env, sessionId, "create_mission", {
			title: m.title,
			description: m.description,
			createdBy: `test-${seed.slug}`,
		});
	}
}

/**
 * Teardown — best-effort delete by namespace prefix.
 * Uses list_memories with the test prefix, then delete_memory per row.
 * NB: tasks/briefingNotes/missions have no delete tool yet → they accumulate
 * (acceptable for fictitious test-* tenants which are never user-facing).
 */
export async function teardownTenant(
	env: McpEnv,
	seed: TenantSeed,
): Promise<void> {
	const sessionId = await initSession(env);
	for (const m of seed.memories) {
		try {
			const res = (await callTool(env, sessionId, "list_memories", {
				namespace: m.namespace,
				limit: 50,
			})) as { content?: Array<{ text?: string }> };
			const text = res?.content?.[0]?.text ?? "";
			const idMatches = text.matchAll(/"_id"\s*:\s*"([^"]+)"/g);
			for (const match of idMatches) {
				await callTool(env, sessionId, "delete_memory", {
					id: match[1],
				}).catch(() => {});
			}
		} catch {
			// best-effort — never fail teardown
		}
	}
}
