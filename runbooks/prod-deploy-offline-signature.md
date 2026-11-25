# Runbook: prod-deploy authorisation by offline Ed25519 signature

Applies to the production deploy guard of this repository (`.claude/hooks/enforce-pi-authorization-before-prod-deploy.py`), for both VantagePeers Cloud and Self-host backend deploys made from a fleet station. Task `k176yhdtn9kbht75skevmhgwn18fb6wp`.

## Why

The guard used to decide by calling the identity provider over the network (sign-in ticket, session, JWT) and then reading the token task from Convex. A bot filter in front of the identity provider (HTTP 403, Cloudflare code 1010, on an unknown User-Agent) stopped every deploy of the fleet once. The authorisation path now has no network: the guard verifies a signature against public keys that live in the repository.

## What is signed

The authorising orchestrator signs a canonical payload (sorted-key compact JSON, UTF-8). The signature covers those exact bytes.

| Field | Meaning | The guard checks it against |
|---|---|---|
| `v` | payload version, `1` | constant |
| `purpose` | `PROD-DEPLOY-AUTHORIZED` | constant |
| `task` | the token task id | the `# pi-authorized: k<id>` marker |
| `floor` | authorised commit floor, full 40-hex SHA | the floor given to `convex-prod-deploy.sh`, else: an ancestor of this checkout's HEAD (local git) |
| `deployment` | target deployment name | the name in an inline `CONVEX_DEPLOY_KEY=prod:<name>\|` or a `<name>.convex.cloud` host, else this station's production deployment |
| `issuer` | the signing authority | the key list in `.claude/config/deploy-authority-pubkeys.json` |
| `orchestrator` | who may run it | `PI_AUTH_ORCHESTRATOR`, when the caller declares it |
| `iat` | issued-at, unix seconds | the window, `TASK_TTL_SEC` (120 minutes), measured on this signed value; more than 300 s in the future is refused |

The command carries it as shell comments on the deploy line:

```
npx convex deploy --yes # pi-authorized: k<task> # pi-auth-payload: <base64url json> # pi-auth-sig: <base64url signature>
```

## The three exits

- ALLOW: valid signature of a configured key of the issuer, in window, every field matches.
- BLOCK, each reason named in the audit line (`/tmp/pi-auth-prod-deploy.log`): `offline-signature-invalid` (absent fragment, undecodable, one changed byte, another key, non-canonical payload), `offline-signature-unknown-issuer`, `offline-signature-expired` (names the age), `offline-signature-field-mismatch` (names the `field`: task, orchestrator, deployment, floor).
- REFUSE TO JUDGE (`offline-signature-could-not-be-verified`, text `COULD NOT CHECK`): the public-key config is absent or malformed, the Ed25519 verifier cannot run, or the working directory is not a git checkout (floor). It is not a refusal of the token.

A signature that is present and fails decides alone. The legacy network path cannot rescue it.

The audit line names the verifier that ran (`verifier`: `cryptography` or `pure-python`). `VP_GUARD_ED25519_BACKEND` (`auto`, `cryptography`, `pure-python`) selects one; a named backend that cannot load is a refusal to judge, never a silent substitution.

## Create the signing key (once per issuer, and on rotation)

The private key goes from the generator straight into the vault. It is never shown, never written to a file, never pasted.

```
infisical secrets set --domain https://eu.infisical.com --projectId <ma-fabrique project id> \
  --env prod --path /shared \
  --file <(python3 .claude/scripts/sign-deploy-authorization.py --generate-keypair --issuer pi)
```

The generator writes one line, `DEPLOY_AUTHORITY_SIGNING_KEY_PI=<base64 32-byte seed>`, to stdout only (that is what the process substitution carries to the vault), and the public key to stderr. Add the public key to `.claude/config/deploy-authority-pubkeys.json` in a pull request:

```json
{ "pi": ["<base64 raw 32-byte public key>"] }
```

Rotation: add the new key to the issuer's list, merge, start signing with the new private key, then remove the old key in a later pull request. Both verify in between. Credential doctrine: `.claude/rules/credentials-come-from-infisical.md`.

## Sign (the authorising orchestrator, per deploy)

```
infisical run --domain https://eu.infisical.com --projectId <ma-fabrique project id> \
  --env prod --path /shared -- \
  python3 .claude/scripts/sign-deploy-authorization.py --issuer pi \
  --task k<token-task-id> --floor <40-hex commit> --deployment <deployment name> \
  --orchestrator <who deploys>
```

It prints one line, `# pi-auth-payload: ... # pi-auth-sig: ...`, to append after `# pi-authorized: k<task>`. The key is read only from `DEPLOY_AUTHORITY_SIGNING_KEY_<ISSUER>` in the environment (issuer upper-cased, `-` becomes `_`). There is no flag, file or argument that takes it. `--iat` exists for tests and defaults to now.

## Staged migration (same delivery)

- Phase 1 (`NETWORK_AUTH_PATH_ENABLED = True`): a command with signature fragments is judged by the signature alone. A command with only `# pi-authorized: k<id>` still takes the legacy network path.
- Phase 2: the network path is deleted (no `guard_identity`, no `_post_json`, no `read_task`); an unsigned marker is refused as `offline-signature-required`. The head that ships is the operator's decision, once the issuing station signs.

## Residue, stated

- `VP_GUARD_PUBKEYS_FILE` (hook process environment) overrides the key file, exactly as `VP_CONVEX_URL` overrides the deployment: whoever controls the hook's environment controls the keys. Same trust already placed in that environment.
- The signature proves the issuer authorised those fields at `iat`. It cannot be revoked inside the window other than by removing the key from the config.
- The floor check against HEAD runs when the command carries no floor; the deploy script, when given one, enforces ancestry against `origin/main` itself.
