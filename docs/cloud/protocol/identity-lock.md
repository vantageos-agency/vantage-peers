# The identity lock — `requireAgentCredentialMatch`

VantagePeers Cloud only. Derived from `convex/lib/auth.ts:387-496`, `convex/tasks.ts`, `convex/messages.ts` on `origin/main` at `a9d441c` (`git rev-parse HEAD`).

## What it enforces

`requireAgentCredentialMatch(ctx, agentCredentialSecret, assertedName, targetOrgSlug)` derives the ACTING AGENT from the per-agent credential presented on the call — never from the caller-declared name alone (`convex/lib/auth.ts:388-393`). It reuses `resolveAgentCredentialCore`, the same hashing+lookup `agentCredentials.ts` exposes publicly as `resolveAgentCredential` (see `credential-lifecycle.md`).

## The two poles, both directions

- Holder acting under its OWN name (`resolved.agentName === assertedName`) → passes, call proceeds unchanged.
- Holder acting under ANOTHER agent's name, or a credential that resolves to nothing at all (unknown secret / org-only token / rotated-out secret) → refused with `AGENT_IDENTITY_MISMATCH`.

(`convex/lib/auth.ts:402-407`.)

## The refusal codes

### `AGENT_IDENTITY_MISMATCH` (name)

Two distinct triggers, same code:

1. The presented credential resolves to nothing — `convex/lib/auth.ts:479-483`:
   > "presented agent credential does not resolve to any active per-agent identity — an org-only/shared token is not accepted at this agent-named surface, no compatibility window"
2. The presented credential resolves to a DIFFERENT agent than the one asserted — `convex/lib/auth.ts:485-489`:
   > "presented credential resolves to agent \"X\" but the call asserts name \"Y\" — a credential holder may only act under its own resolved identity"

### `ORG_MISMATCH` (org bind)

`convex/lib/auth.ts:491-495` — a same-named agent from a DIFFERENT organisation is refused even though the name matches:
> "presented credential resolves to agent \"X\" in org \"A\" but this call targets org \"B\" … a same-named agent from a DIFFERENT organisation may never act here, defence in depth on top of the surrounding org scope"

This is defence-in-depth on top of (never a replacement for) the surrounding `withOrgScope` scoping — Pi ruling `k1746tn3jy22k0jphbx48vzmvd8d0y50`, cited in the code comment (`convex/lib/auth.ts:435-448`). `targetOrgSlug === null` (the true internal/master caller, no org attached) is a no-op for this specific check — there is no target org for a fleet-wide caller to bind against.

### `AGENT_CREDENTIAL_REQUIRED` (conditional)

Triggered only when the declared sender resolves to an existing `agents` row for the target org, and no credential was presented (`convex/lib/auth.ts:463-473`):
> "sender \"X\" resolves to a registered agent in org \"Y\" — this surface requires a per-agent credential (agentCredentialSecret) once the sender is a known agent identity, no fallback"

If the asserted name does **not** resolve to a registered `agents` row (a legacy orchestrator / non-agent sender), the pre-lock no-op path is unchanged — until the migration task `k17573xwj0g0kf1fsfntrn3h2d8d30y8` registers every sender as an agent (`convex/lib/auth.ts:424-427`, comment). This is the CONDITIONAL-SECRET doctrine from Pi ruling `k1746tn3jy22k0jphbx48vzmvd8d0y50`: "CLOSE it for agents, TRACE it for the rest."

`assertedName === undefined` is a no-op unconditionally — there is no declared name to compare, and none to look up (`convex/lib/auth.ts:456`).

## No compatibility window — explicitly

There is no exemption path and no fallback flag for a shared org-only token at an agent-named surface. An org-only/shared token that authenticates the ORGANISATION but not a single agent simply does not satisfy this check, ever, once the declared sender resolves to a registered agent (`convex/lib/auth.ts:395-400`).

## The 11 lock-guarded surfaces

Verified call-site count (`grep -c "await requireAuthenticatedCaller(" convex/tasks.ts` → 10 call sites — the bare `grep -n "requireAuthenticatedCaller("` returns 11 because the helper's own definition at `:140` also matches, so the `await` form isolates the callers; `grep -c "requireAgentCredentialMatch(" convex/messages.ts` → 1 site):

`convex/tasks.ts`'s `requireAuthenticatedCaller` helper (`convex/tasks.ts:140-183`) wraps `requireAgentCredentialMatch` and is called from 10 mutations:

1. `tasks.create` (`convex/tasks.ts:406`, call at `:414`)
2. `tasks.update` (`:1147`, call at `:1177`)
3. `tasks.attachReviewArtifact` (`:1326`, call at `:1341`)
4. `tasks.blockTask` (`:1513`, call at `:1530`)
5. `tasks.complete` (`:1640`, call at `:1652`)
6. `tasks.failTask` (`:1890`, call at `:1902`)
7. `tasks.start` (`:1970`, call at `:1981`)
8. `tasks.checkout` (`:2055`, call at `:2067`)
9. `tasks.deleteTask` (`:2096`, call at `:2107`)
10. `tasks.bulkComplete` (`:2674`, call at `:2715`)

Plus `messages.sendMessage` (`convex/messages.ts:38`, direct call to `requireAgentCredentialMatch` at `:62`) — the 11th surface.

That is every surface where a caller asserts an agent-named identity (`callerOrchestrator` in tasks, `from` in messages) while mutating VantagePeers state.

## Org-bind reuse, never re-derived

Every call site threads through `scope.orgSlug` — the org already derived by the surrounding `withOrgScope` call earlier in the same request — as `targetOrgSlug`. No call site re-derives a second org value (`convex/tasks.ts:161-171`, comment).
