# @vantage/data-lake

Convex Component: RAG + embeddings + intake générique substrate for VantagePeers,
Vantage Immo, and downstream BUs.

## Install

```bash
pnpm add @vantage/data-lake
```

## Usage

In your consumer's `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import dataLake from "@vantage/data-lake/convex.config.js";

const app = defineApp();
app.use(dataLake, { name: "dataLake" });
export default app;
```

Then call from your Convex functions:

```ts
const result = await ctx.runQuery(components.dataLake.memoriesV1.validateIds, {
  ids: ["memory_id_1", "memory_id_2"],
});
```

API surface defined in [decisions/c1-namespacing-convention-2026-05-21.md](../../decisions/c1-namespacing-convention-2026-05-21.md).
Test contract in [decisions/c1-contract-tests-spec-2026-05-21.md](../../decisions/c1-contract-tests-spec-2026-05-21.md).

## Status

Phase A scaffold (Day 77 2026-05-21). Empty schema, no exposed APIs yet.
Phase B will move tables + handlers from `convex/` of the host repo into
`component/`.

## License

FSL-1.1-Apache-2.0 — see `LICENSE` at repo root.
