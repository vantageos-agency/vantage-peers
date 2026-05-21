# @vantage/agent-protocol

Convex Component: multi-agent coordination protocol (tasks, missions, messages,
briefing notes, diary, profiles, peers, recurring tasks, mission templates).

Substrate for orchestrator swarms — used by VantagePeers, Vantage Immo, and
downstream BUs.

## Install

```bash
pnpm add @vantage/agent-protocol
```

## Usage

In your consumer's `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import agentProtocol from "@vantage/agent-protocol/convex.config.js";

const app = defineApp();
app.use(agentProtocol, { name: "agentProtocol" });
export default app;
```

Then from your Convex functions:

```ts
const result = await ctx.runMutation(
  components.agentProtocol.missionsV1.createFromTemplate,
  {
    templateName: "irp-bug-fix",
    callerOrchestrator: "system",
    params: {
      title: "[#42] Webhook bug",
      sourcePayload: {
        type: "github_webhook",
        payload: { action: "opened", issueNumber: 42 },
      },
    },
  },
);
```

API surface defined in [decisions/c1-namespacing-convention-2026-05-21.md](../../decisions/c1-namespacing-convention-2026-05-21.md).
Test contract in [decisions/c1-contract-tests-spec-2026-05-21.md](../../decisions/c1-contract-tests-spec-2026-05-21.md).

## Status

Phase A scaffold (Day 77 2026-05-21). Empty schema, no exposed APIs yet.
Phase B will move tables + handlers from `convex/` of the host repo into
`component/`.

## License

FSL-1.1-Apache-2.0 — see `LICENSE` at repo root.
