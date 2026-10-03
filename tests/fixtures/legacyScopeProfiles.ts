// Frozen snapshot of the scope-profile catalog as it stood at origin/main d440b95
// (convex/oauth.ts seedDefaultProfiles `defaults`), extracted by script, not retyped.
// TEST FIXTURE ONLY: client data lives in the oauth_scope_profiles table, never in product code.
// The operator seeds the same rows with migrations/seed_client_scope_profiles (args = this shape).

import type { TestConvex } from "convex-test";
import { internal } from "../../convex/_generated/api";
import type schema from "../../convex/schema";

/** Seed the client rows the way an operator does: the migration, apply mode. */
export async function seedLegacyClientProfiles(
	t: TestConvex<typeof schema>,
): Promise<void> {
	await t.mutation(
		internal.migrations.seed_client_scope_profiles.seedClientScopeProfiles,
		{ profiles: LEGACY_CLIENT_PROFILES, apply: true },
	);
}

export interface ProfileSnapshot {
	profileId: string;
	description: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
	clerkOrgSlug?: string;
	selfRegistrable?: boolean;
}

export const LEGACY_CLIENT_PROFILES: ProfileSnapshot[] = [
	{
		"profileId": "marie-iris-rh",
		"description": "Marie (the onboarding client) — send_message as 'marie' only; read/write bounded to her own organisation's namespaces: orchestrator/marie + orchestrator/victor (her own second orchestrator seat) + project/marie. Leak fix (task k173wamy80xmz2z9761d616ybh87zhf7, reworked per operator countermand): removed only the fleet-common `global` prefix — VantagePeers is sold multi-organisation and a client profile must never read/write the shared global namespace. `orchestrator/victor` is KEPT — it is this same client's own orchestrator seat, not another org's namespace, and removing it would have cut the client from their own orchestrator.",
		"fromAllowList": [
			"marie"
		],
		"namespaceReadPrefixes": [
			"orchestrator/marie",
			"orchestrator/victor",
			"project/marie"
		],
		"namespaceWritePrefixes": [
			"orchestrator/marie",
			"orchestrator/victor",
			"project/marie"
		]
	},
	{
		"profileId": "clio-iris-rh",
		"description": "Clio (the onboarding client's ChatGPT orchestrator persona) — send/check as Clio + cross-persona read of Hélios + Victor inboxes; read/write the shared project workspace + the other two personas' orchestrator namespaces.",
		"fromAllowList": [
			"Clio",
			"clio",
			"Hélios",
			"Helios",
			"helios",
			"hélios",
			"Victor",
			"victor"
		],
		"namespaceReadPrefixes": [
			"orchestrator/Clio",
			"orchestrator/clio",
			"orchestrator/Hélios",
			"orchestrator/Helios",
			"orchestrator/helios",
			"orchestrator/hélios",
			"orchestrator/Victor",
			"orchestrator/victor",
			"project/iris-rh"
		],
		"namespaceWritePrefixes": [
			"orchestrator/Clio",
			"orchestrator/clio",
			"orchestrator/Hélios",
			"orchestrator/Helios",
			"orchestrator/helios",
			"orchestrator/hélios",
			"orchestrator/Victor",
			"orchestrator/victor",
			"project/iris-rh"
		]
	},
	{
		"profileId": "helios-iris-rh",
		"description": "Hélios (the onboarding client's Claude.ai orchestrator persona) — send/check as Hélios + cross-persona read of Clio + Victor inboxes; read/write the shared project workspace + the other two personas' orchestrator namespaces.",
		"fromAllowList": [
			"Hélios",
			"Helios",
			"helios",
			"hélios",
			"Clio",
			"clio",
			"Victor",
			"victor"
		],
		"namespaceReadPrefixes": [
			"orchestrator/Hélios",
			"orchestrator/Helios",
			"orchestrator/helios",
			"orchestrator/hélios",
			"orchestrator/Clio",
			"orchestrator/clio",
			"orchestrator/Victor",
			"orchestrator/victor",
			"project/iris-rh"
		],
		"namespaceWritePrefixes": [
			"orchestrator/Hélios",
			"orchestrator/Helios",
			"orchestrator/helios",
			"orchestrator/hélios",
			"orchestrator/Clio",
			"orchestrator/clio",
			"orchestrator/Victor",
			"orchestrator/victor",
			"project/iris-rh"
		]
	}
];

export const LEGACY_GENERIC_PROFILES: ProfileSnapshot[] = [
	{
		"profileId": "master",
		"description": "Full admin access — reserved for Pi and internal ops.",
		"fromAllowList": [
			"*"
		],
		"namespaceReadPrefixes": [
			"*"
		],
		"namespaceWritePrefixes": [
			"*"
		]
	},
	{
		"profileId": "client-generic",
		"description": "Deny-by-default template for new clients. MUST be overridden before issuing tokens.",
		"fromAllowList": [],
		"namespaceReadPrefixes": [],
		"namespaceWritePrefixes": [],
		"selfRegistrable": true
	},
	{
		"profileId": "public-readonly",
		"description": "Minimum-read scope for anonymous DCR clients — read global/* only, no write, no tenant access.",
		"fromAllowList": [
			"external"
		],
		"namespaceReadPrefixes": [
			"global"
		],
		"namespaceWritePrefixes": [],
		"selfRegistrable": true
	}
];

export const LEGACY_CATALOG: ProfileSnapshot[] = [...LEGACY_GENERIC_PROFILES.slice(0, 1), ...LEGACY_CLIENT_PROFILES, ...LEGACY_GENERIC_PROFILES.slice(1)];
