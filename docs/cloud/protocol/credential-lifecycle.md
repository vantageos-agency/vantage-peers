# The per-agent credential — minting, storage, rotation, resolution

VantagePeers Cloud only. Derived from `convex/agentCredentials.ts` and `convex/schema.ts` on `origin/main` at `a9d441c` (`git rev-parse HEAD`).

## Why this table exists

Before this table, the token identified the ORGANISATION and the agent wrote its own name into the call — agents of one client shared a token, and nothing compared the declared name to the token presented. A right written "this specialist only" was a label, not a lock. Each agent being its own deployment, it can carry its own key. `convex/agentCredentials.ts` mints that key; the identity-lock doc (`identity-lock.md`) covers the enforcement that turns it into a lock. Governing cap: `analysis/le-cap/le-cap.md @ e3c1ffd6` §6, the `### VP` subsection, item 4, first half ("VP.4" is our shorthand; the cap numbers the items without the "VP." prefix).

## Minting — `mintAgentCredential`, org-admin gated

Source: `convex/agentCredentials.ts:63-125`, exported as `export const mintAgentCredential = mutation(...)`.

- Gated to the organisation administrator via `requireOrgAdmin` — the same gate `registerAgent` and `linkChild` use.
- Refuses to mint for an agent name that has no `agents` row in this org — `AGENT_NOT_FOUND` — a credential is issued to an agent that already exists as an entity, never to an arbitrary string.
- The raw secret is 32 random bytes → 64-char hex (`crypto.getRandomValues`, `convex/agentCredentials.ts:104-108`) — the same shape as this codebase's existing OAuth client secrets and bearer tokens.

## The once-only plaintext return

`mintAgentCredential`'s return validator:

```
const mintResultValidator = v.object({
	secret: v.string(),
	mintedAt: v.number(),
});
```

The plaintext secret is returned exactly once, in this mutation's result — it is never written to the database and never re-derivable afterward (`convex/agentCredentials.ts:121-123`). No value from this table is reproduced anywhere in this documentation set — only the environment-variable NAME an agent would hold it under (e.g. `AGENT_CREDENTIAL_SECRET`), never a value.

## Hashed storage

Source: `convex/schema.ts:1375-1383`.

```
agent_credentials: defineTable({
	orgSlug: v.string(),      // client_org_mapping.clerkOrgSlug — the org this credential's agent belongs to
	agentName: v.string(),    // agents.name within orgSlug — the credential's OWN identity, never caller-declared
	secretHash: v.string(),   // sha256 hex of the minted secret — raw secret NEVER stored
	isActive: v.boolean(),    // false once rotated out by a later mint
	createdAt: v.number(),
})
	.index("by_org_agent", ["orgSlug", "agentName"])
	.index("by_secret_hash", ["secretHash"])
```

Hashing reuses the same sha256-hex pattern already used for tokens elsewhere in this codebase (`convex/credentials.ts`'s exported `sha256Hex`; `convex/oauth.ts`'s local mirror of the same helper) — `convex/agentCredentials.ts:19-24`.

## Rotation — `isActive` flip, never a delete

On a second `mintAgentCredential` call for the same `(orgSlug, agentName)`, every prior row is patched to `isActive: false` before the new row is inserted (`convex/agentCredentials.ts:87-100`). Rows are never deleted — the audit trail of past mints is preserved. Only the latest mint's plaintext resolves afterward; the previous plaintext stops authenticating immediately.

## Resolution — `resolveAgentCredential`

Source: `convex/agentCredentials.ts:143-149`, exported as `export const resolveAgentCredential = query(...)`.

```
const resolvedIdentityValidator = v.object({
	orgSlug: v.string(),
	agentName: v.string(),
});
```

The only argument is the presented secret (`presentedSecret: v.string()`); the identity returned comes solely from which row's `secretHash` matches via the `by_secret_hash` index — never from an argument the caller could set. This is the property the identity lock (`requireAgentCredentialMatch`, see `identity-lock.md`) depends on: the credential holder is authenticated by presenting the secret, not by declaring who it is. A rotated-out (`isActive: false`) row's old plaintext no longer resolves, even though the row itself still exists for audit purposes.

Deliberately no `requireOrgAdmin` gate on `resolveAgentCredential` — the credential itself is the proof of identity being verified; requiring a separate org-admin identity on the same call would defeat the point of an agent authenticating as itself (`convex/agentCredentials.ts:138-141`).

## Authorization split — two different identities, deliberately

- **Mint**: gated by `requireOrgAdmin` — only an org:admin of the agent's own org may mint or rotate its credential.
- **Resolution**: trusts no caller-declared name — the presented secret alone determines the resolved `(orgSlug, agentName)`.

(`convex/agentCredentials.ts:26-35`.)
