#!/usr/bin/env bun
/**
 * OAuth client provisioning helper for VantagePeers.
 *
 * Calls POST /admin/oauth/clients against the deployed MCP server with the
 * master bearer token. The server generates clientId + clientSecret and
 * persists the hashed secret in Convex. The raw secret is returned to stdout
 * EXACTLY ONCE — capture it and deliver out-of-band (Telegram private, 1P, etc).
 *
 * Usage:
 *   bun run scripts/provision-oauth-client.ts \
 *     --name "alice-acme-hr" \
 *     --scope-profile "alice-acme-hr" \
 *     --redirect-uri "https://claude.ai/api/mcp/auth_callback" \
 *     --base-url "https://vantage-peers-production.up.railway.app" \
 *     --master-token "$BEARER_SECRET_MASTER"
 *
 * Flags:
 *   --name           (required) human label for the client
 *   --scope-profile  (required) profileId (seeded: master, alice-acme-hr, client-generic)
 *   --redirect-uri   (repeatable) allowed OAuth redirect URI
 *   --base-url       server URL (defaults to PUBLIC_BASE_URL env or Railway prod)
 *   --master-token   master bearer token (defaults to BEARER_SECRET_MASTER env)
 */

function parseArgs(argv: string[]): {
	name?: string;
	scopeProfile?: string;
	redirectUris: string[];
	baseUrl?: string;
	masterToken?: string;
} {
	const out: {
		name?: string;
		scopeProfile?: string;
		redirectUris: string[];
		baseUrl?: string;
		masterToken?: string;
	} = { redirectUris: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--name":
				out.name = argv[++i];
				break;
			case "--scope-profile":
				out.scopeProfile = argv[++i];
				break;
			case "--redirect-uri":
				out.redirectUris.push(argv[++i]);
				break;
			case "--base-url":
				out.baseUrl = argv[++i];
				break;
			case "--master-token":
				out.masterToken = argv[++i];
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				if (a.startsWith("--")) {
					console.error(`Unknown flag: ${a}`);
					process.exit(2);
				}
		}
	}
	return out;
}

function printHelp(): void {
	console.log(`Usage: bun run scripts/provision-oauth-client.ts \\
  --name "alice-acme-hr" \\
  --scope-profile "alice-acme-hr" \\
  --redirect-uri "https://claude.ai/api/mcp/auth_callback" \\
  [--base-url "https://vantage-peers-production.up.railway.app"] \\
  [--master-token "$BEARER_SECRET_MASTER"]
`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const baseUrl =
		args.baseUrl ??
		process.env.PUBLIC_BASE_URL ??
		"https://vantage-peers-production.up.railway.app";
	const masterToken = args.masterToken ?? process.env.BEARER_SECRET_MASTER;

	if (!args.name || !args.scopeProfile) {
		console.error("Error: --name and --scope-profile are required");
		printHelp();
		process.exit(2);
	}
	if (!masterToken) {
		console.error(
			"Error: master token missing. Pass --master-token or set BEARER_SECRET_MASTER env.",
		);
		process.exit(2);
	}

	const res = await fetch(`${baseUrl}/admin/oauth/clients`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${masterToken}`,
		},
		body: JSON.stringify({
			name: args.name,
			scope_profile: args.scopeProfile,
			redirect_uris: args.redirectUris,
		}),
	});

	const text = await res.text();
	if (!res.ok) {
		console.error(`HTTP ${res.status} ${res.statusText}`);
		console.error(text);
		process.exit(1);
	}

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(text);
	} catch {
		console.error("Unable to parse server response:", text);
		process.exit(1);
		return;
	}

	// Single-line JSON so it is easy to capture and pipe elsewhere.
	console.log(JSON.stringify(payload));
	console.error(
		"\nNOTE: client_secret is shown ONLY ONCE. Store it now (Telegram/1P/etc.).",
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
