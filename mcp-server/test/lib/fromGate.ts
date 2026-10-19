/**
 * The `from` gate of a tool, measured through the REAL registration path.
 *
 * Task k1778c2hvae8e8vz9f5bbbbbb98g62hw slice 1 deleted the local predicate
 * `checkFromAllowed`. What decides an acting name now is defineTool itself
 * (src/registerTool.ts): `bindActingNames` binds the name to the credential's
 * actor (`checkActorBinding`), then the `from` scope kind applies the roster
 * through `@vantageos/cloud-identity` `passesScopeFilter`. This helper
 * registers one probe tool declared `{ kind: "from", fromArg: "from" }` on a
 * stub server and calls its guarded handler, so a test reads the exact
 * refusal a real `from`-scoped tool returns, before any handler body runs.
 *
 * Returns the refusal text, or null when the probe handler was reached.
 * `mode` sets VANTAGE_ACTOR_CREDENTIAL_MODE for the call: "permissive" lets a
 * caller with no agent credential through the actor gate, so the ROSTER is
 * the gate being measured.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	ACTOR_CREDENTIAL_MODE_ENV,
	type OAuthContext,
} from "../../src/auth.js";
import { defineTool } from "../../src/registerTool.js";

type Probe = (
	args: Record<string, unknown>,
	extra: unknown,
) => Promise<{ isError?: boolean; content?: { text?: string }[] }>;

export async function fromGate(
	ctx: OAuthContext | undefined,
	from: string | undefined,
	mode: "strict" | "permissive" = "strict",
): Promise<string | null> {
	let probe: Probe | undefined;
	const server = {
		registerTool: (...a: unknown[]) => {
			probe = a[a.length - 1] as Probe;
			return {};
		},
	} as unknown as McpServer;
	const reached = { value: false };
	defineTool(
		server,
		{ oauthCtx: ctx },
		{ kind: "from", fromArg: "from" },
		"from_gate_probe",
		"probe",
		{ from: z.string().optional() },
		{ readOnlyHint: true },
		async () => {
			reached.value = true;
			return { content: [{ type: "text", text: "reached" }] };
		},
	);
	if (!probe) throw new Error("probe tool was not registered");
	const previous = process.env[ACTOR_CREDENTIAL_MODE_ENV];
	process.env[ACTOR_CREDENTIAL_MODE_ENV] = mode;
	try {
		const result = await probe(from === undefined ? {} : { from }, {});
		if (result.isError === true) return result.content?.[0]?.text ?? "";
		if (!reached.value)
			throw new Error("probe passed without reaching handler");
		return null;
	} finally {
		if (previous === undefined) delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
		else process.env[ACTOR_CREDENTIAL_MODE_ENV] = previous;
	}
}
