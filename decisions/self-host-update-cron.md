# Self-Host Update Mechanism — Railway Cron + Zero-Touch Redeploy

*VantageOS · 2026-05-08*

## Problem

Self-hosted clients (Cédric and future) deploy `vantage-peers-mcp` once and never update. They miss PATCH bugfixes and MINOR feature additions silently. We need zero-touch updates without requiring clients to log in and trigger redeploys manually.

## Solution: Railway Cron Redeploy

Railway services support a **Cron Schedule** field in service Settings. Setting it to `0 3 * * *` causes Railway to restart the service container at 03:00 UTC daily. Because the Railway template installs the package via `npx -y vantage-peers-mcp@latest` at container startup (nixpacks.toml), each daily restart automatically pulls the latest npm release.

Combined with the auto-migration system (`convex/migrationRunner.ts`), the upgrade path for PATCH and MINOR versions is fully zero-touch: new container → pulls latest npm → applies pending migrations → serves requests.

## Cron value

```
0 3 * * *
```

Runs at 03:00 UTC daily. Chosen because it is outside peak hours for EU (05:00 CEST) and US East (23:00 ET) clients.

## UI navigation (Railway dashboard)

1. Open your Railway project.
2. Click the **vantage-peers-mcp** service card.
3. Go to the **Settings** tab.
4. Scroll to the **Cron Schedule** field.
5. Enter `0 3 * * *`.
6. Click **Save**.

Railway will show the next scheduled restart time. No redeploy required to activate.

## Railway template config

For NEW Railway template deployments, the `railway.json` in the repo root includes `cronSchedule` in the `deploy` block (see `mcp-server/railway.json`). This pre-fills the cron for any fresh deployment from the template — clients get zero-touch updates automatically without any manual step.

## Cédric: one-time action required

Cédric deployed before this cron was introduced. He needs to set it once manually:

> Go to Railway service → **Settings** → **Cron Schedule** → enter `0 3 * * *` → Save.

After that single action, all future PATCH and MINOR upgrades are fully automatic.

## MAJOR versions

MAJOR versions (X.0.0) include breaking changes and require a manual upgrade. See `RELEASE.md` and the corresponding `docs/migrations/v<N>.md` guide. The cron will still redeploy daily, but the `applyPendingMigrations` startup check will log the migration steps it ran — clients should monitor Railway logs on MAJOR release days.

## Security note

The cron pulls `vantage-peers-mcp@latest` from npm. The npm-publish workflow (`.github/workflows/npm-publish-auto.yml`) publishes only on version bump to `main` after CI passes. The `--provenance=false` flag is set on publish per the known npm provenance issue on this runner. Clients can pin to a specific version by editing their Railway start command if they require more control.
